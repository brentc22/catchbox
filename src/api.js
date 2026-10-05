import { load, save, remove, list, setCurrent } from "./store.js";

const API = "https://api.mail.tm";

class ApiError extends Error {
  constructor(status, statusText, body) {
    super(`${status} ${statusText} ${body.slice(0, 200)}`.trim());
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// mail.tm allows about 8 requests a second per IP, and the inbox polls every mailbox on top
// of whatever the page asks for — so a 429 is routine, not exceptional. Wait it out a few
// times (Retry-After when given, else a growing backoff) before letting it reach the caller.
export const RATE_LIMIT_RETRIES = 3;

const request = async (p, opts = {}, token, attempt = 0) => {
  const res = await fetch(`${API}${p}`, {
    ...opts,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
  });
  if (res.status === 429 && attempt < RATE_LIMIT_RETRIES) {
    const after = Number(res.headers.get?.("retry-after"));
    await sleep(after > 0 ? Math.min(after, 10) * 1000 : 500 * 2 ** attempt);
    return request(p, opts, token, attempt + 1);
  }
  if (!res.ok) throw new ApiError(res.status, res.statusText, await res.text().catch(() => ""));
  if (res.status === 204) return null;
  const type = res.headers.get("content-type") || "";
  return type.includes("json") ? res.json() : res.text();
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
  const { token } = await request("/token", {
    method: "POST",
    body: JSON.stringify({ address, password }),
  });

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
      // caller does not quietly end up on a different inbox.
      const wasCurrent = load()?.id === account.id;
      remove(account.id);
      const fresh = await createAccount({ label: account.label, activate: wasCurrent });
      return fn(fresh, fresh.token.token);
    }

    account.token = { ...account.token, token };
    save(account, { activate: false });
    return fn(account, token);
  }
};

export const listMessages = (token, page = 1) =>
  request(`/messages?page=${page}`, {}, token).then((d) => d["hydra:member"]);

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
