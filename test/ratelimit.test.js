import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "catchbox-ratelimit-"));
const STORE = path.join(home, ".config/testmail/accounts.json");
fs.mkdirSync(path.dirname(STORE), { recursive: true });
process.env.HOME = home;
process.env.TESTMAIL_MAILSY_STORE = path.join(home, "mailsy.json");
process.env.TESTMAIL_DEMO = "0";

const ACCOUNT = { id: "a1", address: "keepme@example.com", password: "pw", token: { token: "t1" } };
fs.writeFileSync(STORE, JSON.stringify({ version: 2, current: "a1", accounts: [ACCOUNT] }));

// mail.tm answers 429 to the first `limited` requests, then 200. Retry-After is tiny so the
// retries do not slow the suite down.
const realFetch = global.fetch;
let limited = 0;
let calls = 0;
global.fetch = async (url, opts) => {
  if (!String(url).startsWith("https://api.mail.tm")) return realFetch(url, opts);
  calls++;
  const status = limited > 0 ? (limited--, 429) : 200;
  return {
    ok: status < 400, status, statusText: status === 429 ? "Too Many Requests" : "OK",
    headers: { get: (h) => (h === "retry-after" ? "0.01" : "application/json") },
    json: async () => ({ "hydra:member": [] }),
    text: async () => "{}",
  };
};

const { listMessages, RATE_LIMIT_RETRIES } = await import("../src/api.js");
const { serve } = await import("../src/server.js");

test("a 429 is waited out instead of failing the request", async () => {
  limited = 2;
  calls = 0;
  assert.deepEqual(await listMessages("t1"), []);
  assert.equal(calls, 3);
});

test("a 429 that persists reaches the caller as a 429", async () => {
  limited = RATE_LIMIT_RETRIES + 1;
  await assert.rejects(listMessages("t1"), (e) => e.status === 429);
  limited = 0;
});

test("a rate-limited inbox request answers 429 and leaves the server running", async () => {
  // The crash this guards against: `return withToken(...)` without `await` let the 429 slip
  // past the handler's catch, and the unhandled rejection took the whole process down.
  const server = await serve({ port: 0 });
  const { port } = server.address();
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    for (const p of ["/api/inbox?account=a1", "/api/message/m1?account=a1"]) {
      limited = 100;
      const res = await realFetch(`http://127.0.0.1:${port}${p}`);
      assert.equal(res.status, 429, p);
    }
    limited = 0;
    const ok = await realFetch(`http://127.0.0.1:${port}/api/inbox?account=a1`);
    assert.equal(ok.status, 200);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    limited = 0;
    server.close();
  }
});
