import { load, save, remove, list, setCurrent } from "./store.js";

const API = "https://api.mail.tm";

export class ApiError extends Error {
  constructor(status, statusText, body) {
    super(`${status} ${statusText} ${body.slice(0, 200)}`.trim());
    this.status = status;
  }
}

const request = async (p, opts = {}, token) => {
  const res = await fetch(`${API}${p}`, {
    ...opts,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
  });
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

// mail.tm expires both JWTs and whole accounts (the latter on inactivity). Rather than
// making every caller handle that, recover in place: mint a new token first, and only
// fall back to a brand-new account when the credentials themselves stopped working.
export const withToken = async (fn, accountId = null) => {
  let account = load(accountId) ?? (await createAccount());
  try {
    return await fn(account, account.token?.token);
  } catch (e) {
    if (e.status !== 401 && e.status !== 404) throw e;
    try {
      const { token } = await request("/token", {
        method: "POST",
        body: JSON.stringify({ address: account.address, password: account.password }),
      });
      account.token = { ...account.token, token };
      save(account, { activate: false });
      return await fn(account, token);
    } catch {
      // The mailbox itself is gone. Replace it in place, keeping its label and its
      // position as the active one, so the caller does not end up on a different inbox.
      const wasCurrent = load()?.id === account.id;
      remove(account.id);
      const fresh = await createAccount({ label: account.label, activate: wasCurrent });
      return fn(fresh, fresh.token.token);
    }
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

export const markSeen = (id, token) =>
  request(`/messages/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/merge-patch+json" },
    body: JSON.stringify({ seen: true }),
  }, token).catch(() => null);

export const deleteMessage = (id, token) =>
  request(`/messages/${encodeURIComponent(id)}`, { method: "DELETE" }, token).catch(() => null);

export const deleteAccount = async (accountId = null) => {
  const account = load(accountId);
  if (!account) return null;
  await withToken(
    (acc, token) => request(`/accounts/${acc.id}`, { method: "DELETE" }, token).catch(() => null),
    account.id
  );
  remove(account.id);
  return account.address;
};

export const currentAddress = async () => (load() ?? (await createAccount())).address;

export { list as listAccounts, load as getAccount, setCurrent };
