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
      headers: { get: () => "application/json" },
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
  const { api, store } = sandbox([labelled], (url) => {
    if (url.endsWith("/token")) {
      // The first refresh is for the dead mailbox; the second is for the new one.
      return store.list().some((a) => a.id === "a1") ? { status: 401 } : { status: 200, body: { token: "new" } };
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
