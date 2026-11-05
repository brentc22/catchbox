import { load, save, remove, list, setCurrent } from "./store.js";

const API = "https://api.mail.tm";

class ApiError extends Error {
  constructor(status, statusText, body) {
    super(`${status} ${statusText} ${body.slice(0, 200)}`.trim());
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// mail.tm allows 30 requests a minute per IP (`ratelimit-policy: 30; w=60`), shared by every
// catchbox process on the machine — the app and `catchbox ui` each run a server — so a 429
// is routine, not exceptional. Wait it out a few times (Retry-After when given, else a
// growing backoff) before letting it reach the caller. The jitter matters: a start-up
// check asks for every mailbox at once, and without it all of those retries would come
// back as one burst and be limited again together. A Retry-After longer
// than we are willing to wait is answered at once — retrying sooner is a guaranteed 429.
export const RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_AFTER_S = 10;

// fetch has no deadline of its own, and a mail.tm connection that hangs rather than fails
// used to hold a refresh — and everything waiting on it — for minutes. A timeout has no
// status, so withToken treats it as transient and never replaces a mailbox over it.
const fromEnv = Number(process.env.CATCHBOX_HTTP_TIMEOUT_MS);
export const TIMEOUT = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 20_000;

// A controller that also aborts when the caller's signal does, so passing a signal of your
// own never drops a deadline. (AbortSignal.any would do, but needs Node 20.)
const follow = (caller) => {
  const ctl = new AbortController();
  if (caller?.aborted) ctl.abort(caller.reason);
  else caller?.addEventListener("abort", () => ctl.abort(caller.reason), { once: true });
  return ctl;
};

// Gives `ctl` TIMEOUT to get somewhere; call what it returns once it has.
const within = (ctl) => {
  const t = setTimeout(() => ctl.abort(new DOMException("mail.tm did not answer in time", "TimeoutError")), TIMEOUT);
  return () => clearTimeout(t);
};

// The deadline is per attempt and ends with the headers: waiting out a 429 is not mail.tm
// being slow, and a body — an attachment on a slow line — takes as long as it takes, unless
// the caller's signal says nobody is waiting for it any more.
const fetchMailTm = async (url, opts = {}) => {
  for (let attempt = 0; ; attempt++) {
    const ctl = follow(opts.signal);
    const clear = within(ctl);
    let res;
    try { res = await fetch(url, { ...opts, signal: ctl.signal }); } finally { clear(); }
    if (res.status !== 429 || attempt >= RATE_LIMIT_RETRIES) return res;
    const after = Number(res.headers.get?.("retry-after"));
    if (after > MAX_RETRY_AFTER_S) return res;
    await sleep(after > 0 ? after * 1000 : 500 * 2 ** attempt * (0.5 + Math.random()));
  }
};

const request = async (p, opts = {}, token) => {
  // A JSON answer is small: reading it gets a deadline of its own.
  const body = follow(opts.signal);
  const res = await fetchMailTm(`${API}${p}`, {
    ...opts,
    signal: body.signal,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
  });
  const clear = within(body);
  try {
    if (!res.ok) throw new ApiError(res.status, res.statusText, await res.text().catch(() => ""));
    if (res.status === 204) return null;
    const type = res.headers.get("content-type") || "";
    return await (type.includes("json") ? res.json() : res.text());
  } finally {
    clear();
  }
};

// The response itself, for the caller to buffer or stream. A failure throws with its
// status, so withToken can refresh an expired token and try again, the same as every other
// request; passing a 401 through used to hand the browser a broken file.
export const getAttachment = async (id, attachmentId, token, { signal } = {}) => {
  const res = await fetchMailTm(
    `${API}/messages/${encodeURIComponent(id)}/attachment/${encodeURIComponent(attachmentId)}`,
    { headers: { authorization: `Bearer ${token}` }, signal }
  );
  if (!res.ok) throw new ApiError(res.status, res.statusText, await res.text().catch(() => ""));
  return res;
};

const randomId = () => Math.random().toString(36).slice(2, 10);

const slug = (s) =>
  String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);

export const createAccount = async ({ prefix, label = null, activate = true } = {}) => {
  const domains = await request("/domains?page=1");
  const domain = domains["hydra:member"].filter((d) => d.isActive)[0]?.domain;
  if (!domain) throw new Error("mail.tm has no active domains right now");

  // A labelled mailbox gets that label in its address, so you can tell which is which
  // in a log line or a signup form without looking it up.
  const head = slug(prefix || label || "test") || "test";
  const address = `${head}-${randomId()}@${domain}`;
  const password = randomId() + randomId();
  const account = await request("/accounts", {
    method: "POST",
    body: JSON.stringify({ address, password }),
  });
  // From here on the account exists on mail.tm, and the password exists nowhere else. So a
  // failure to get its token must not lose it: withToken fetches one on the first 401. Throwing
  // here left a dead mailbox trying again every round, adding an orphan account each time.
  const token = await request("/token", {
    method: "POST",
    body: JSON.stringify({ address, password }),
  }).then((r) => r.token, () => null);

  return save({ ...account, password, label, token: { token, id: account.id } }, { activate });
};

// mail.tm expires both JWTs and whole accounts (the latter on inactivity). Recovering from
// that in one place keeps it out of every caller — but the two failures have to stay apart.
//
// A 404 from `fn` means the *message* is gone, not the mailbox. This used to catch it too,
// and any second failure then landed in the "replace the mailbox" branch: one stale message
// id was enough to delete a working inbox, password and all, and mint a different address.
// Only a 401 on the credentials themselves means the mailbox is really gone.
export const withToken = async (fn, accountId = null) => {
  const account = load(accountId) ?? (accountId ? null : await createAccount());
  if (!account) throw new ApiError(404, "Not Found", `No mailbox with id ${accountId}`);

  try {
    return await fn(account, account.token?.token);
  } catch (e) {
    if (e.status !== 401) throw e;

    let token;
    try {
      ({ token } = await request("/token", {
        method: "POST",
        body: JSON.stringify({ address: account.address, password: account.password }),
      }));
    } catch (refreshError) {
      // Anything other than "these credentials are not valid" is a transient problem —
      // rate limiting, no network — and must never cost you a mailbox.
      if (refreshError.status !== 401) throw refreshError;

      // Replace it in place, keeping its label and its position as the active one, so the
      // caller does not quietly end up on a different inbox. The new one first: if mail.tm
      // will not make one right now, the old entry stays and the next round tries again,
      // rather than leaving you with no mailbox at all.
      const wasCurrent = load()?.id === account.id;
      const fresh = await createAccount({ label: account.label, activate: wasCurrent });
      remove(account.id);
      return fresh.token.token ? fn(fresh, fresh.token.token) : withToken(fn, fresh.id);
    }

    account.token = { ...account.token, token };
    save(account, { activate: false });
    return fn(account, token);
  }
};

export const listMessages = (token, page = 1) =>
  request(`/messages?page=${page}`, {}, token).then((d) => d["hydra:member"]);

// The message at `index`, waiting up to `wait` seconds for one that arrived no earlier than
// `grace` seconds ago. While waiting, mail.tm having a bad moment is not the answer anyone
// asked for: a timeout, a 429 or a 5xx costs one poll. Anything else, a 401 above all, goes
// to the caller, and so does the last transient failure when the time is up.
const isTransient = (e) => !e.status || e.status === 429 || e.status >= 500;

export const resolveMessage = async (token, { index = 0, wait = 0, grace = 90, pollMs = 2000 } = {}) => {
  const cutoff = Date.now() - grace * 1000;
  const started = Date.now();
  const expired = () => Date.now() - started >= wait * 1000;
  for (;;) {
    try {
      const msgs = await listMessages(token);
      const pool = wait ? msgs.filter((m) => new Date(m.createdAt).getTime() >= cutoff) : msgs;
      if (pool[index]) return await getMessage(pool[index].id, token);
      if (!wait || expired()) return null;
    } catch (e) {
      if (!wait || expired() || !isTransient(e)) throw e;
    }
    await sleep(pollMs);
  }
};

// mail.tm pushes every change to a mailbox — new mail, a message read or deleted — over
// Mercure, a server-sent event stream on its own host. It does not count against the REST
// rate limit (30 requests a minute per IP), which polling ten mailboxes every few seconds
// used up five times over, so that a click on a message got a 429 instead of the message.
export const MERCURE = "https://mercure.mail.tm/.well-known/mercure";

// Connecting gets a deadline too: the idle watchdog only starts once the stream is open, so
// a connect that hangs would otherwise leave that mailbox without a stream for good.
export const openStream = async (accountId, token, signal) => {
  const ctl = follow(signal);
  const clear = within(ctl);
  try {
    return await fetch(`${MERCURE}?topic=${encodeURIComponent(`/accounts/${accountId}`)}`, {
      headers: { accept: "text/event-stream", authorization: `Bearer ${token}` },
      signal: ctl.signal,
    });
  } finally {
    clear();
  }
};

export const getMessage = (id, token) =>
  request(`/messages/${encodeURIComponent(id)}`, {}, token);

// The raw RFC822 source. This is what makes header inspection possible —
// SPF/DKIM/DMARC results, List-Unsubscribe, Message-ID — none of which the
// parsed message endpoint returns.
export const getSource = (id, token) =>
  request(`/sources/${encodeURIComponent(id)}`, {}, token);

// Opening a message marks it read on the side; failing that is no reason to fail the open.
// Marking read or unread on purpose goes through setSeen, which does report failure.
export const setSeen = (id, token, seen = true) =>
  request(`/messages/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/merge-patch+json" },
    body: JSON.stringify({ seen }),
  }, token);

export const markSeen = (id, token) => setSeen(id, token, true).catch(() => null);

// A message that is already gone is deleted, as far as anyone asking is concerned. Anything
// else — an expired token, no network — must surface: `rm` used to say "Deleted" regardless.
export const deleteMessage = (id, token) =>
  request(`/messages/${encodeURIComponent(id)}`, { method: "DELETE" }, token).catch((e) => {
    if (e.status !== 404) throw e;
    return null;
  });

// Empty a mailbox but keep the address. mail.tm hands out a page at a time, so keep taking
// pages until there is nothing left to try. A message that will not delete is counted and
// stepped over rather than ending the run, and every id is tried once — so a message mail.tm
// keeps listing after deleting it can neither loop this nor inflate the count.
export const emptyInbox = async (token, { maxRounds = 50 } = {}) => {
  const tried = new Set();
  let deleted = 0;
  let failed = 0;
  let page = 1;
  for (let round = 0; round < maxRounds; round++) {
    const listed = await listMessages(token, page);
    if (!listed.length) break;
    const fresh = listed.filter((m) => !tried.has(m.id));
    // Everything here was tried already: the ones that would not go fill this page, so
    // whatever is left lives on the next one.
    if (!fresh.length) { page++; continue; }
    for (const m of fresh) {
      tried.add(m.id);
      try {
        await deleteMessage(m.id, token);
        deleted++;
      } catch (e) {
        if (e.status === 401) throw e; // withToken refreshes the token and starts over
        failed++;
      }
    }
  }
  return { deleted, failed };
};

export const deleteAccount = async (accountId = null) => {
  const account = load(accountId);
  if (!account) return null;
  // Swallowing the upstream error here reported "Deleted <address>" while the mailbox was
  // still alive and receiving. For a tool whose whole point is disposability, that is the
  // wrong direction to fail in — let the error surface and leave the entry in place.
  await withToken((acc, token) =>
    request(`/accounts/${acc.id}`, { method: "DELETE" }, token), account.id);
  remove(account.id);
  return account.address;
};

export const currentAddress = async () => (load() ?? (await createAccount())).address;

export { list as listAccounts, load as getAccount, setCurrent };
