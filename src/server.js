import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  withToken, listMessages, getMessage, getSource, markSeen, setSeen, emptyInbox, getAttachment,
  deleteMessage, deleteAccount, createAccount, listAccounts, getAccount, setCurrent, openStream,
} from "./api.js";
import { deliverability } from "./extract.js";
import { enrichMessage } from "./message.js";
import { readAll, rename } from "./store.js";
import { demo } from "./demo.js";

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

// The attachment URL is the only thing the browser needs that the CLI does not.
const enrich = (m, accountId) => {
  const message = enrichMessage(m, accountId);
  return {
    ...message,
    attachments: message.attachments.map((a) => ({
      ...a,
      url: `/api/message/${m.id}/attachment/${a.id}?account=${encodeURIComponent(accountId)}`,
    })),
  };
};

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// This server has no authentication — it does not need any, because it only ever listens on
// the loopback interface. What it does need is to refuse requests that a *browser* was
// tricked into sending on someone else's behalf:
//
//   - A page on evil.com can POST to http://127.0.0.1:7337/api/rotate with mode:'no-cors'.
//     That is a simple request, so there is no preflight to save us, and the mailbox you
//     just pasted into a signup form is gone. The Origin header gives it away.
//   - DNS rebinding points evil.com at 127.0.0.1, which makes the request same-origin as
//     far as the browser is concerned. Origin then looks fine, but Host still says evil.com.
//
// So both headers are checked, and Sec-Fetch-Site is honoured where the browser sends it.
const sameOrigin = (req, port) => {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (!LOOPBACK.has(host)) return false;

  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return false;

  const origin = req.headers.origin;
  if (!origin) return true; // curl, the CLI, and same-origin GETs send none
  try {
    const u = new URL(origin);
    return LOOPBACK.has(u.hostname) && u.port === String(port);
  } catch {
    return false;
  }
};

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });

export async function serve({ port = 7337, host = "127.0.0.1", heartbeat = 20_000, tickMs = 20_000 } = {}) {
  const DEMO = process.env.TESTMAIL_DEMO === "1";

  // Every open tab gets pushed new mail instead of polling for it. Without this the
  // inbox lags a refresh interval behind, which is exactly the moment you are staring at it.
  const clients = new Set();
  const broadcast = (event) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) res.write(payload);
  };

  // Per-mailbox state, so the switcher can show an unread badge for inboxes you are
  // not looking at — the reason to keep more than one open in the first place.
  // The message list is kept too: the inbox is served from it, so opening the page or the
  // "All mailboxes" view costs no requests to mail.tm while its push stream is up.
  // checkedAt is when the list was *asked for*, not when it came back: a change that lands
  // while the request is in flight may be missing from it.
  const state = new Map(); // id -> { newest, unread, total, messages, account, checkedAt }
  const idOf = (id) => id ?? getAccount(null)?.id ?? null;
  const known = (id) => listAccounts().some((a) => a.id === id);

  const TICK_MS = tickMs; // safety-net interval, and how long a list counts as fresh
  const PER_TICK = 3; // at most this many safety-net checks per tick
  const LIVE_EVERY_MS = 5 * 60_000; // safety-net check for a mailbox whose stream is up
  const DEBOUNCE_MS = 1000; // one refresh for a burst of events, e.g. emptying an inbox
  const IDLE_MS = 75_000; // Mercure sends a keep-alive every 30 s; silence this long = dead
  const RENEW_EVERY_MS = 5 * 60_000; // a 401 from Mercure renews the token at most this often

  const lanes = new Map(); // id -> { running, queued, since }
  const streams = new Map(); // id -> { ctl, live, downSince }
  const pending = new Map(); // id -> debounce timer
  const lastEvent = new Map(); // id -> when the last push event arrived
  const tried = new Map(); // id -> when the last safety-net check started

  // Everything kept per mailbox, gone with it — the LaunchAgent runs for weeks.
  const forget = (id) => {
    state.delete(id);
    lanes.delete(id);
    tried.delete(id);
    lastEvent.delete(id);
    clearTimeout(pending.get(id));
    pending.delete(id);
  };

  // Has a check started at or after `t`? One that is still running counts too.
  const checkedSince = (id, t) => {
    const lane = lanes.get(id);
    return (state.get(id)?.checkedAt ?? 0) >= t || Boolean(lane?.running && lane.since >= t);
  };

  const refreshOnce = async (id) => {
    const startedAt = Date.now();
    const { acc, msgs } = await withToken(
      async (acc, token) => ({ acc, msgs: await listMessages(token) }), id);
    // Deleted while this was in flight: bringing its state back would resurrect it.
    if (!known(acc.id)) throw Object.assign(new Error(`No mailbox with id ${acc.id}`), { status: 404 });
    // mail.tm had expired it and withToken put a new one in its place: drop the old one's
    // stream and state, and give the new one a stream of its own.
    if (id !== acc.id) { forget(id); syncStreams(); }
    const prev = state.get(acc.id);
    const next = {
      newest: msgs[0]?.id ?? null,
      unread: msgs.filter((m) => !m.seen).length,
      total: msgs.length,
      messages: msgs,
      account: { id: acc.id, address: acc.address },
      checkedAt: startedAt,
    };
    state.set(acc.id, next);
    if (next.newest && prev && next.newest !== prev.newest)
      broadcast({ type: "mail", account: acc.id, id: next.newest });
    else if (!prev) broadcast({ type: "accounts" });
    else if (next.unread !== prev.unread || next.total !== prev.total) broadcast({ type: "counts" });
    return next;
  };

  // One refresh per mailbox at a time. Two that both find a mailbox expired would each
  // replace it, leaving you with two fresh addresses and the wrong one active. A call that
  // arrives mid-refresh gets one follow-up, so it still sees whatever it just changed.
  const refresh = (id) => {
    id = idOf(id);
    if (!lanes.has(id)) lanes.set(id, { running: null, queued: null, since: 0 });
    const lane = lanes.get(id);
    if (!lane.running) {
      lane.since = Date.now();
      return (lane.running = refreshOnce(id).finally(() => { lane.running = null; }));
    }
    return (lane.queued ??= lane.running.catch(() => {}).then(() => { lane.queued = null; return refresh(id); }));
  };

  // Transient network trouble or a 429 must not reject the caller of a background refresh.
  const poll = (ids = listAccounts().map((a) => a.id)) => {
    for (const id of [...state.keys()]) if (!known(id)) forget(id);
    return Promise.all(ids.map((id) => refresh(id).catch(() => null)));
  };

  // --- push from mail.tm --------------------------------------------------
  // One Mercure stream per mailbox. An event only says "something changed", so it triggers a
  // refresh of that one mailbox — debounced, and skipped when a check already started after
  // the event: every change the server makes itself (delete, mark read) refreshes on the
  // spot, and its echo from Mercure would otherwise cost a second request.
  const changed = (id) => {
    lastEvent.set(id, Date.now());
    clearTimeout(pending.get(id));
    const t = setTimeout(() => {
      pending.delete(id);
      if (!checkedSince(id, lastEvent.get(id))) refresh(id).catch(() => null);
    }, DEBOUNCE_MS);
    t.unref?.();
    pending.set(id, t);
  };

  const pause = (ms, signal) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

  // Reads a stream until it ends, calling `onEvent` for every event that carries data.
  // Parsed per line, not per chunk: TCP may split a keep-alive in two, and half of ":\n"
  // must not read as an event.
  const readEvents = async (body, onEvent, onBytes) => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of body) {
      onBytes();
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      if (lines.some((l) => l.startsWith("data:"))) onEvent();
    }
  };

  const watch = (id) => {
    const s = { ctl: new AbortController(), live: false, downSince: Date.now() };
    streams.set(id, s);
    const { signal } = s.ctl;
    (async () => {
      let backoff = 2000;
      let renewedAt = 0;
      let failing = false;
      while (!signal.aborted) {
        // One controller per connection, so the idle watchdog can drop this one without
        // stopping the stream for good. (AbortSignal.any would do, but needs Node 20.)
        const attempt = new AbortController();
        const stop = () => attempt.abort();
        signal.addEventListener("abort", stop, { once: true });
        let idle = null;
        try {
          const res = await openStream(id, getAccount(id)?.token?.token, attempt.signal);
          if (!res.ok || !res.body) {
            res.body?.cancel().catch(() => {});
            // An expired token is renewed by a REST refresh — but not on every reconnect:
            // if Mercure keeps refusing a token REST accepts, renewing again fixes nothing.
            if (res.status === 401 && Date.now() - renewedAt > RENEW_EVERY_MS) {
              renewedAt = Date.now();
              await refresh(id);
            }
            throw new Error(`HTTP ${res.status}`);
          }
          s.live = true;
          backoff = 2000;
          if (failing) console.error(`catchbox: push stream for ${id} is back`);
          failing = false;
          // Whatever arrived while it was down — unless a check started since it went down.
          if (!checkedSince(id, s.downSince)) refresh(id).catch(() => null);
          // A socket killed by sleep or a network switch can hang without an error or an end.
          const kick = () => {
            clearTimeout(idle);
            idle = setTimeout(stop, IDLE_MS);
            idle.unref?.();
          };
          kick();
          await readEvents(res.body, () => changed(id), kick);
          throw new Error("ended");
        } catch (e) {
          if (signal.aborted) break;
          // Once per outage, not once per retry: says why the inbox is back to polling.
          if (!failing) console.error(`catchbox: push stream for ${id} down (${e.message}); polling it until it is back`);
          failing = true;
        } finally {
          clearTimeout(idle);
          signal.removeEventListener("abort", stop);
        }
        if (s.live) { s.live = false; s.downSince = Date.now(); }
        await pause(backoff, signal);
        backoff = Math.min(backoff * 2, 60_000);
      }
    })();
  };

  function syncStreams() {
    const ids = new Set(listAccounts().map((a) => a.id));
    for (const id of ids) if (!streams.has(id)) watch(id);
    for (const [id, s] of streams) if (!ids.has(id)) { s.ctl.abort(); streams.delete(id); forget(id); }
  }
  const isLive = (id) => streams.get(id)?.live === true;

  // The store is read on every tick, and a throw out of a timer callback ends the process:
  // one round that could not read accounts.json used to take the whole server down. Now it
  // costs the round, and is said once rather than every tick — but said: otherwise the
  // inbox just goes quiet.
  let storeError = null;
  const guarded = (fn) => () => {
    try {
      fn();
      storeError = null;
    } catch (e) {
      if (storeError !== e.message) console.error(`catchbox: ${e.message}`);
      storeError = e.message;
    }
  };

  // The safety net. A mailbox with a live stream is checked every few minutes in case an
  // event got lost; one without is checked more often. Never more than a few per tick, so
  // ten mailboxes with Mercure down still stay well inside mail.tm's 30 a minute.
  // A failed check counts as a check: a mailbox that keeps getting 429s must wait its turn
  // like the rest, not jump the queue every tick and keep the limit hit.
  const tick = guarded(() => {
    syncStreams();
    const now = Date.now();
    const due = listAccounts()
      .map((a) => ({ id: a.id, at: Math.max(state.get(a.id)?.checkedAt ?? 0, tried.get(a.id) ?? 0) }))
      // A live stream only vouches for a list it has one to keep current: a mailbox whose
      // first check failed (a 429 at start-up) is retried on the short interval.
      // (The second of slack: a check made on the previous tick is due on this one, even
      // when the timer fires a hair early.)
      .filter(({ id, at }) => now - at >= (isLive(id) && state.has(id) ? LIVE_EVERY_MS : TICK_MS) - 1000)
      .sort((a, b) => a.at - b.at)
      .slice(0, PER_TICK);
    for (const { id } of due) tried.set(id, now);
    if (due.length) poll(due.map((d) => d.id));
  });

  const timer = DEMO ? null : setInterval(tick, TICK_MS);
  timer?.unref?.();
  if (!DEMO) guarded(() => { syncStreams(); poll(); })();

  // A quiet stream looks dead: the app's URLSession gives up on it after 60 seconds without
  // a byte, and mail that lands while it reconnects never becomes a notification. A comment
  // line every so often is ignored by every client and keeps the connection open. Demo mode
  // pushes nothing, so it has nothing to keep alive; an interval of 0 or NaN would write to
  // every open tab in a busy loop, so anything that small falls back to the default.
  const every = Number.isFinite(heartbeat) && heartbeat >= 10 ? heartbeat : 20_000;
  const ping = DEMO ? null : setInterval(() => { for (const res of clients) res.write(": ping\n\n"); }, every);
  ping?.unref?.();
  const stopStreams = () => {
    for (const s of streams.values()) s.ctl.abort();
    streams.clear();
    for (const t of pending.values()) clearTimeout(t);
  };

  // What the inbox shows: the cached list while the push stream keeps it current or it was
  // just fetched, a fresh one otherwise — without the second condition, a Mercure outage
  // would turn every page load into a request per mailbox, the very 429 this avoids.
  // Throws for the single mailbox you are looking at: a 429 or a missing mailbox must reach
  // the page, not show up as an empty inbox. Resolves to the state entry, whose `account` is
  // the mailbox actually listed — withToken may have replaced an expired one.
  const inboxOf = async (id) => {
    const cached = state.get(id);
    if (cached && (isLive(id) || Date.now() - cached.checkedAt < TICK_MS)) return cached;
    return refresh(id);
  };

  const accountsPayload = () => {
    if (DEMO) return { demo: true, current: demo.current(), accounts: demo.accounts() };
    const { current, accounts } = readAll();
    return {
      demo: false,
      current,
      accounts: accounts.map((a) => ({
        id: a.id,
        address: a.address,
        label: a.label ?? null,
        createdAt: a.createdAt,
        unread: state.get(a.id)?.unread ?? 0,
        total: state.get(a.id)?.total ?? 0,
      })),
    };
  };

  const handle = async (req, res) => {
    const url = new URL(req.url, `http://${host}:${port}`);
    const send = (data, status = 200) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
    };
    const wanted = url.searchParams.get("account");

    if (!sameOrigin(req, port)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      return res.end("catchbox only answers requests from its own page on this machine.\n");
    }

    try {
      // --- live updates -------------------------------------------------
      if (url.pathname === "/api/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write("retry: 3000\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }

      // --- mailboxes ----------------------------------------------------
      if (url.pathname === "/api/accounts") {
        if (req.method === "POST") {
          if (DEMO) return send({ error: "demo mode is read-only" }, 400);
          const { label = null, prefix = null } = await readBody(req);
          const acc = await createAccount({ label, prefix });
          syncStreams();
          await refresh(acc.id).catch(() => null);
          broadcast({ type: "accounts" });
          return send({ id: acc.id, address: acc.address, label: acc.label });
        }
        return send(accountsPayload());
      }

      const accMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)$/);
      if (accMatch) {
        const id = decodeURIComponent(accMatch[1]);
        if (DEMO) {
          // Switching mailbox is a view change, so let it through; anything that would
          // write to mail.tm is refused.
          const body = req.method === "PATCH" ? await readBody(req) : {};
          if (req.method === "PATCH" && Object.keys(body).length === 1 && body.current)
            return send(accountsPayload());
          return send({ error: "demo mode is read-only" }, 400);
        }
        if (req.method === "DELETE") {
          await deleteAccount(id);
          forget(id);
          syncStreams();
          broadcast({ type: "accounts" });
          return send(accountsPayload());
        }
        if (req.method === "PATCH") {
          const body = await readBody(req);
          if (body.label !== undefined) rename(id, body.label);
          if (body.current) setCurrent(id);
          broadcast({ type: "accounts" });
          return send(accountsPayload());
        }
      }

      // Several messages at once, possibly across mailboxes: the selection in the list.
      // One at a time per mailbox, because mail.tm rate-limits, and every failure is
      // counted rather than thrown — half a selection deleted must not read as none.
      if (url.pathname === "/api/messages" && req.method === "POST") {
        if (DEMO) return send({ error: "demo mode is read-only" }, 400);
        const { action, items } = await readBody(req);
        const run = { delete: deleteMessage, seen: (id, t) => setSeen(id, t, true),
                      unseen: (id, t) => setSeen(id, t, false) }[action];
        if (!run || !Array.isArray(items)) return send({ error: "expected an action and a list of messages" }, 400);

        const byAccount = new Map();
        for (const { id, account } of items) {
          if (!id) continue;
          const key = account ?? null;
          byAccount.set(key, [...(byAccount.get(key) ?? []), String(id)]);
        }

        // A 401 is rethrown so withToken can refresh the token and run the mailbox again —
        // which is why each run counts from zero. Deleting or marking twice is harmless.
        const results = await Promise.all([...byAccount].map(([accountId, ids]) =>
          withToken(async (_acc, token) => {
            let done = 0;
            for (const id of ids) {
              try { await run(id, token); done++; } catch (e) {
                if (e.status === 401) throw e;
              }
            }
            return { done, failed: ids.length - done };
          }, accountId).catch(() => ({ done: 0, failed: ids.length }))
        ));
        const done = results.reduce((n, r) => n + r.done, 0);
        const failed = results.reduce((n, r) => n + r.failed, 0);
        await poll([...byAccount.keys()]);
        return send({ ok: failed === 0, done, failed });
      }

      // Empty a mailbox, or every mailbox, and keep the addresses.
      if (url.pathname === "/api/inbox" && req.method === "DELETE") {
        if (DEMO) return send({ error: "demo mode is read-only" }, 400);
        const ids = wanted === "all" ? listAccounts().map((a) => a.id) : [wanted ?? null];
        // Per mailbox, like the bulk route: one that fails must not hide what the others did.
        const results = await Promise.all(ids.map((id) =>
          withToken((_acc, token) => emptyInbox(token), id)
            .catch(() => ({ deleted: 0, failed: 1, broken: true }))));
        const deleted = results.reduce((n, r) => n + r.deleted, 0);
        const failed = results.reduce((n, r) => n + r.failed, 0);
        const unreachable = results.filter((r) => r.broken).length;
        await poll(ids);
        return send({ ok: failed === 0, deleted, failed: failed - unreachable, unreachable });
      }

      // --- data ---------------------------------------------------------
      if (url.pathname === "/api/inbox") {
        if (DEMO) return send(demo.inbox(wanted ?? demo.current()));

        if (wanted === "all") {
          const accounts = listAccounts();
          const lists = await Promise.all(
            accounts.map((acc) =>
              inboxOf(acc.id)
                .then(({ messages, account }) => messages.map((m) => enrich(m, account.id)))
                .catch(() => [])
            )
          );
          const messages = lists.flat().sort((a, b) => new Date(b.date) - new Date(a.date));
          return send({ accountId: "all", address: null, messages });
        }

        const { messages, account } = await inboxOf(idOf(wanted));
        return send({ accountId: account.id, address: account.address,
                      messages: messages.map((m) => enrich(m, account.id)) });
      }

      const msgMatch = url.pathname.match(/^\/api\/message\/([^/]+)(?:\/(source|attachment\/([^/]+)))?$/);
      if (msgMatch) {
        const [, id, kind, attachmentId] = msgMatch;
        if (DEMO) {
          if (kind === "source") return send({ raw: demo.source, deliverability: deliverability(demo.source) });
          const m = demo.message(id);
          return m ? send(m) : send({ error: "not found" }, 404);
        }
        return await withToken(async (acc, token) => {
          if (req.method === "DELETE") {
            await deleteMessage(id, token);
            await refresh(acc.id).catch(() => null);
            return send({ ok: true });
          }
          if (kind === "source") {
            const source = await getSource(id, token);
            const raw = typeof source === "string" ? source : source?.data ?? "";
            return send({ raw, deliverability: deliverability(raw) });
          }
          if (attachmentId) {
            // A download nobody is waiting for any more is stopped, not finished.
            const left = new AbortController();
            res.on("close", () => left.abort());
            const upstream = await getAttachment(id, attachmentId, token, { signal: left.signal });
            // The whole body before the first header byte: once headers are out, a failed
            // download can no longer be turned into an error response.
            const body = Buffer.from(await upstream.arrayBuffer());
            // Anyone can mail this address an attachment, so nothing upstream says about
            // how to display it is trustworthy on our own origin. Always a download, never
            // sniffed into something executable.
            res.writeHead(200, {
              "content-type": upstream.headers.get("content-type") || "application/octet-stream",
              "content-disposition": "attachment",
              "x-content-type-options": "nosniff",
            });
            return res.end(body);
          }
          const m = await getMessage(id, token);
          await markSeen(id, token);
          send(enrich(m, acc.id));
        }, wanted);
      }

      // Kept for the shape the CLI and older bookmarks expect: throw the active
      // mailbox away and take a fresh one in its place.
      if (url.pathname === "/api/rotate" && req.method === "POST") {
        if (DEMO) return send({ error: "demo mode is read-only" }, 400);
        const previous = getAccount(wanted);
        await deleteAccount(previous?.id ?? null);
        const acc = await createAccount({ label: previous?.label ?? null });
        if (previous) forget(previous.id);
        syncStreams();
        await refresh(acc.id).catch(() => null);
        broadcast({ type: "accounts" });
        return send({ id: acc.id, address: acc.address });
      }

      // --- static UI ----------------------------------------------------
      const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const full = path.join(UI_DIR, file);
      if (!full.startsWith(UI_DIR) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
        res.writeHead(404, { "content-type": "text/plain" });
        return res.end("not found");
      }
      res.writeHead(200, { "content-type": MIME[path.extname(full)] ?? "application/octet-stream" });
      return res.end(fs.readFileSync(full));
    } catch (e) {
      // Answering twice throws, and a throw out of this async handler is an unhandled
      // rejection — which takes the whole server down, not just this one request.
      if (res.headersSent) return res.destroy();
      send({ error: e.message }, [404, 429].includes(e.status) ? e.status : 500);
    }
  };

  // The handler is async, and http.createServer ignores the promise it returns — so anything
  // that escapes it is an unhandled rejection, which ends the process. Inside the try that
  // takes `return await`, never a bare `return promise` (that settles after the try is left;
  // one 429 from mail.tm used to crash the server that way). This is the backstop for the
  // next one that slips through: it costs that request, never the server, and always answers.
  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(`catchbox: ${req.method} ${req.url} failed: ${e?.stack ?? e}`);
      if (res.headersSent) return res.destroy();
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: String(e?.message ?? e) }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", (e) => {
      clearInterval(timer);
      clearInterval(ping);
      stopStreams();
      reject(e.code === "EADDRINUSE"
        ? Object.assign(new Error(`Port ${port} is already in use — is catchbox ui already running? Try another: catchbox ui ${port + 1}`), { code: e.code })
        : e);
    });
    server.listen(port, host, resolve);
  });
  // Stop on close() itself, not on the "close" event: before Node 19 that waits for every
  // keep-alive connection to time out, and the streams would run on until then.
  const close = server.close.bind(server);
  server.close = (cb) => { clearInterval(timer); clearInterval(ping); stopStreams(); return close(cb); };
  return server;
}
