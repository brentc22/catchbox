import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// One sandbox HOME for the whole file, set before anything is imported. Salting the import
// specifier does not work here: a fresh `api.js?x` still resolves its own `./store.js` to
// the instance that was cached first, which would pin every case to the first HOME.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "catchbox-api-"));
const STORE = path.join(home, ".config/testmail/accounts.json");
fs.mkdirSync(path.dirname(STORE), { recursive: true });
process.env.HOME = home;
process.env.TESTMAIL_MAILSY_STORE = path.join(home, "mailsy.json");

const api = await import("../src/api.js");
const store = await import("../src/store.js");

// The store reads from disk on every call, so resetting it between cases is a file write.
const sandbox = (accounts, handler) => {
  fs.writeFileSync(STORE, JSON.stringify({ version: 2, current: accounts[0].id, accounts }));
  global.fetch = async (url, opts = {}) => {
    const res = handler(String(url), opts);
    return {
      ok: res.status < 400,
      status: res.status,
      statusText: String(res.status),
      // A tiny Retry-After, so the 429 cases do not sit out the real backoff.
      headers: { get: (h) => (h === "retry-after" ? "0.01" : "application/json") },
      json: async () => res.body ?? {},
      text: async () => JSON.stringify(res.body ?? {}),
    };
  };
  return { api, store };
};

const ACCOUNT = { id: "a1", address: "keepme@example.com", password: "pw", token: { token: "t1" } };

test("a 404 from the request leaves the mailbox alone", async () => {
  // A message that mail.tm has expired, or that another tab deleted. The mailbox is fine.
  const { api, store } = sandbox([ACCOUNT], () => ({ status: 404 }));
  await assert.rejects(
    api.withToken(async (_acc, token) => {
      const res = await fetch("https://api.mail.tm/messages/gone", { headers: { authorization: token } });
      if (!res.ok) { const e = new Error("404"); e.status = 404; throw e; }
    }),
    /404/
  );
  assert.deepEqual(store.list().map((a) => a.address), ["keepme@example.com"]);
});

test("an expired token is refreshed without changing the mailbox", async () => {
  let refreshed = false;
  const { api, store } = sandbox([ACCOUNT], (url) => {
    if (url.endsWith("/token")) { refreshed = true; return { status: 200, body: { token: "t2" } }; }
    return { status: 200, body: { "hydra:member": [] } };
  });

  let attempts = 0;
  const result = await api.withToken(async (_acc, token) => {
    if (attempts++ === 0) { const e = new Error("401"); e.status = 401; throw e; }
    return token;
  });

  assert.equal(refreshed, true);
  assert.equal(result, "t2");
  assert.deepEqual(store.list().map((a) => a.address), ["keepme@example.com"]);
  assert.equal(store.load("a1").token.token, "t2", "the new token is kept");
});

test("a rate-limited refresh must not cost you the mailbox", async () => {
  const { api, store } = sandbox([ACCOUNT], (url) =>
    url.endsWith("/token") ? { status: 429 } : { status: 200, body: {} }
  );
  await assert.rejects(
    api.withToken(async () => { const e = new Error("401"); e.status = 401; throw e; }),
    /429/
  );
  assert.deepEqual(store.list().map((a) => a.address), ["keepme@example.com"]);
});

test("only dead credentials replace the mailbox, and the label survives", async () => {
  const labelled = { ...ACCOUNT, label: "Signup flow" };
  const { api, store } = sandbox([labelled], (url, opts) => {
    if (url.endsWith("/token")) {
      // The dead mailbox's credentials are refused; the new one's are not.
      return JSON.parse(opts.body).address === labelled.address
        ? { status: 401 } : { status: 200, body: { token: "new" } };
    }
    if (url.includes("/domains")) return { status: 200, body: { "hydra:member": [{ domain: "example.com", isActive: true }] } };
    if (url.endsWith("/accounts")) return { status: 200, body: { id: "a2", address: "fresh@example.com" } };
    return { status: 200, body: {} };
  });

  await api.withToken(async (_acc, token) => {
    if (token === "t1") { const e = new Error("401"); e.status = 401; throw e; }
    return token;
  });

  const [only] = store.list();
  assert.equal(store.list().length, 1);
  assert.equal(only.address, "fresh@example.com");
  assert.equal(only.label, "Signup flow", "the replacement keeps the name you gave it");
});

test("asking for a mailbox that does not exist is an error, not a new mailbox", async () => {
  const { api, store } = sandbox([ACCOUNT], () => ({ status: 200, body: {} }));
  await assert.rejects(api.withToken(async () => "never", "does-not-exist"), /does-not-exist/);
  assert.equal(store.list().length, 1, "nothing was created");
});

test("deleting a message reports failure instead of claiming success", async () => {
  const { api } = sandbox([ACCOUNT], () => ({ status: 500 }));
  await assert.rejects(api.deleteMessage("m1", "t1"), /500/);
});

test("deleting a message that is already gone is not an error", async () => {
  const { api } = sandbox([ACCOUNT], () => ({ status: 404 }));
  assert.equal(await api.deleteMessage("m1", "t1"), null);
});

test("a mailbox that failed to get its token keeps its password, so no orphan is left behind", async () => {
  const dead = { id: "dead", address: "dead@example.com", password: "pw", label: "flow", token: { token: "old" } };
  let accountsMade = 0;
  let tokenCalls = 0;
  const { api, store } = sandbox([dead], (url, opts) => {
    if (url.endsWith("/domains?page=1")) return { status: 200, body: { "hydra:member": [{ domain: "example.com", isActive: true }] } };
    if (url.endsWith("/accounts") && opts.method === "POST") { accountsMade++; return { status: 201, body: { id: "fresh", address: JSON.parse(opts.body).address } }; }
    // The dead mailbox's credentials are refused; the new one's token request is limited.
    if (url.endsWith("/token")) { tokenCalls++; return tokenCalls === 1 ? { status: 401 } : { status: 429 }; }
    return { status: 200, body: {} };
  });

  await assert.rejects(api.withToken(async () => { const e = new Error("401"); e.status = 401; throw e; }, "dead"));

  const [kept, ...others] = store.list();
  assert.equal(others.length, 0, "the dead entry is replaced, not kept next to it");
  assert.equal(kept.label, "flow");
  assert.equal(accountsMade, 1);
  assert.ok(store.load(kept.id).password, "the password survived");
});

const mail = (id) => ({ id, createdAt: new Date().toISOString() });

test("waiting for mail survives a failed poll", async () => {
  let polls = 0;
  const { api } = sandbox([ACCOUNT], (url) => {
    if (url.includes("/messages?page=")) {
      polls++;
      if (polls === 1) return { status: 503 };
      return { status: 200, body: { "hydra:member": [mail("m1")] } };
    }
    return { status: 200, body: mail("m1") };
  });
  const m = await api.resolveMessage("t1", { wait: 5, pollMs: 1 });
  assert.equal(m.id, "m1");
  assert.equal(polls, 2);
});

test("waiting for mail hands a 401 to withToken instead of sitting it out", async () => {
  const { api } = sandbox([ACCOUNT], () => ({ status: 401 }));
  await assert.rejects(api.resolveMessage("t1", { wait: 5, pollMs: 1 }), (e) => e.status === 401);
});

test("without waiting, a failed poll is simply the answer", async () => {
  const { api } = sandbox([ACCOUNT], () => ({ status: 503 }));
  await assert.rejects(api.resolveMessage("t1"), (e) => e.status === 503);
});

test("a transient failure still surfaces once the time is up", async () => {
  const { api } = sandbox([ACCOUNT], () => ({ status: 503 }));
  await assert.rejects(api.resolveMessage("t1", { wait: 0.01, pollMs: 1 }), (e) => e.status === 503);
});
