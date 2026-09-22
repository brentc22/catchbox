import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  withToken, listMessages, getMessage, getSource, markSeen,
  deleteMessage, deleteAccount, createAccount, listAccounts, getAccount, setCurrent,
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

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });

export async function serve({ port = 7337, host = "127.0.0.1" } = {}) {
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
  const state = new Map(); // id -> { newest, unread, total }

  const poll = async () => {
    const accounts = listAccounts();
    for (const id of [...state.keys()]) if (!accounts.some((a) => a.id === id)) state.delete(id);

    await Promise.all(
      accounts.map(async (acc) => {
        try {
          const msgs = await withToken((_a, token) => listMessages(token), acc.id);
          const prev = state.get(acc.id);
          const next = {
            newest: msgs[0]?.id ?? null,
            unread: msgs.filter((m) => !m.seen).length,
            total: msgs.length,
          };
          state.set(acc.id, next);
          if (next.newest && prev && next.newest !== prev.newest)
            broadcast({ type: "mail", account: acc.id, id: next.newest });
          else if (!prev) broadcast({ type: "accounts" });
          else if (next.unread !== prev.unread) broadcast({ type: "counts" });
        } catch {
          /* transient network trouble must not kill the poll loop */
        }
      })
    );
  };

  const timer = DEMO ? null : setInterval(poll, 4000);
  timer?.unref?.();
  if (!DEMO) poll();

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

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${host}:${port}`);
    const send = (data, status = 200) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
    };
    const wanted = url.searchParams.get("account");

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
          await poll();
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
          state.delete(id);
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

      // --- data ---------------------------------------------------------
      if (url.pathname === "/api/inbox") {
        if (DEMO) return send(demo.inbox(wanted ?? demo.current()));

        if (wanted === "all") {
          const accounts = listAccounts();
          const lists = await Promise.all(
            accounts.map((acc) =>
              withToken((_a, token) => listMessages(token), acc.id)
                .then((msgs) => msgs.map((m) => enrich(m, acc.id)))
                .catch(() => [])
            )
          );
          const messages = lists.flat().sort((a, b) => new Date(b.date) - new Date(a.date));
          return send({ accountId: "all", address: null, messages });
        }

        return withToken(async (acc, token) => {
          const msgs = await listMessages(token);
          send({ accountId: acc.id, address: acc.address, messages: msgs.map((m) => enrich(m, acc.id)) });
        }, wanted);
      }

      const msgMatch = url.pathname.match(/^\/api\/message\/([^/]+)(?:\/(source|attachment\/([^/]+)))?$/);
      if (msgMatch) {
        const [, id, kind, attachmentId] = msgMatch;
        if (DEMO) {
          if (kind === "source") return send({ raw: demo.source, deliverability: deliverability(demo.source) });
          const m = demo.message(id);
          return m ? send(m) : send({ error: "not found" }, 404);
        }
        return withToken(async (acc, token) => {
          if (req.method === "DELETE") {
            await deleteMessage(id, token);
            await poll();
            return send({ ok: true });
          }
          if (kind === "source") {
            const source = await getSource(id, token);
            const raw = typeof source === "string" ? source : source?.data ?? "";
            return send({ raw, deliverability: deliverability(raw) });
          }
          if (attachmentId) {
            const upstream = await fetch(
              `https://api.mail.tm/messages/${encodeURIComponent(id)}/attachment/${encodeURIComponent(attachmentId)}`,
              { headers: { authorization: `Bearer ${token}` } }
            );
            res.writeHead(upstream.status, {
              "content-type": upstream.headers.get("content-type") || "application/octet-stream",
              "content-disposition": upstream.headers.get("content-disposition") || "attachment",
            });
            return res.end(Buffer.from(await upstream.arrayBuffer()));
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
        state.delete(previous?.id);
        await poll();
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
      send({ error: e.message }, 500);
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  return server;
}
