import { load, save, clear } from "./store.js";

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

export const createAccount = async ({ prefix = "test" } = {}) => {
  const domains = await request("/domains?page=1");
  const domain = domains["hydra:member"].filter((d) => d.isActive)[0]?.domain;
  if (!domain) throw new Error("mail.tm has no active domains right now");

  const address = `${prefix}-${randomId()}@${domain}`;
  const password = randomId() + randomId();
  const account = await request("/accounts", {
    method: "POST",
    body: JSON.stringify({ address, password }),
  });
  const { token } = await request("/token", {
    method: "POST",
    body: JSON.stringify({ address, password }),
  });

  const full = { ...account, password, token: { token, id: account.id } };
  save(full);
  return full;
};

// mail.tm expires both JWTs and whole accounts (the latter on inactivity). Rather than
// making every caller handle that, recover in place: mint a new token first, and only
// fall back to a brand-new account when the credentials themselves stopped working.
export const withToken = async (fn) => {
  let account = load() ?? (await createAccount());
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
      save(account);
      return await fn(account, token);
    } catch {
      const fresh = await createAccount();
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

export const deleteAccount = async () => {
  const account = load();
  if (!account) return null;
  await withToken((acc, token) =>
    request(`/accounts/${acc.id}`, { method: "DELETE" }, token).catch(() => null)
  );
  clear();
  return account.address;
};

export const currentAddress = async () => (load() ?? (await createAccount())).address;
