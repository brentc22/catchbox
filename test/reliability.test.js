import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "catchbox-reliability-"));
const STORE = path.join(home, ".config/testmail/accounts.json");
fs.mkdirSync(path.dirname(STORE), { recursive: true });
process.env.HOME = home;
process.env.TESTMAIL_MAILSY_STORE = path.join(home, "mailsy.json");
process.env.CATCHBOX_HTTP_TIMEOUT_MS = "150";

const ACCOUNT = { id: "a1", address: "keepme@example.com", password: "pw", label: "signup", token: { token: "t1" } };
beforeEach(() => {
  fs.writeFileSync(STORE, JSON.stringify({ version: 2, current: "a1", accounts: [ACCOUNT] }));
  upstream = hang;
});

// A mail.tm whose answer each test decides. By default it never answers — the connection
// that hangs rather than fails. Whatever it does, an abort on the signal ends the request,
// as it does with the real fetch.
const hang = () => new Promise(() => {});
let upstream = hang;
const reply = (status, body = {}) => ({
  ok: status < 400, status, statusText: String(status),
  headers: { get: () => "application/json" },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const realFetch = global.fetch;
global.fetch = (url, opts = {}) => {
  if (!/^https:\/\/(api|mercure)\.mail\.tm/.test(String(url))) return realFetch(url, opts);
  return new Promise((resolve, reject) => {
    opts.signal?.addEventListener("abort", () => reject(opts.signal.reason));
    Promise.resolve(upstream(String(url), opts)).then(resolve, reject);
  });
};

const { serve } = await import("../src/server.js");
const { listMessages, withToken, getAttachment, openStream } = await import("../src/api.js");

// Everything the event stream says within `ms`.
const listen = async (port, ms) => {
  const controller = new AbortController();
  const res = await realFetch(`http://127.0.0.1:${port}/api/events`, { signal: controller.signal });
  const reader = res.body.getReader();
  let seen = "";
  const stop = new Promise((r) => setTimeout(r, ms));
  for (;;) {
    const next = await Promise.race([reader.read(), stop.then(() => null)]);
    if (!next || next.done) break;
    seen += new TextDecoder().decode(next.value);
  }
  controller.abort();
  return seen;
};

// A server of its own in a child process, on a store that will not parse. An unhandled
// rejection there ends the process, which is exactly what is being tested for.
const brokenServer = (script) => {
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), "catchbox-broken-"));
  const store = path.join(broken, ".config/testmail/accounts.json");
  fs.mkdirSync(path.dirname(store), { recursive: true });
  fs.writeFileSync(store, '{"version":2,"accou');
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    const { serve } = await import(${JSON.stringify(path.join(ROOT, "src/server.js"))});
    const server = await serve({ port: 0, tickMs: 50 });
    const { port } = server.address();
    ${script}
    console.log("alive");
    process.exit(0);
  `], { env: { ...process.env, HOME: broken, TESTMAIL_MAILSY_STORE: path.join(broken, "m.json") } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  return new Promise((r) => child.on("exit", (code) => r({ code, stdout, stderr })));
};

test("a mail.tm request that hangs gives up instead of waiting forever", async () => {
  const started = Date.now();
  await assert.rejects(listMessages("t1"));
  assert.ok(Date.now() - started < 2000);
});

test("a token refresh that times out does not cost you the mailbox", async () => {
  const expired = Object.assign(new Error("401"), { status: 401 });
  await assert.rejects(withToken(() => { throw expired; }, "a1"));
  const { accounts } = JSON.parse(fs.readFileSync(STORE, "utf8"));
  assert.deepEqual(accounts.map((a) => a.address), ["keepme@example.com"]);
});

test("a dead mailbox is only dropped once its replacement exists", async () => {
  // The credentials are refused for good, and mail.tm will not make a new mailbox right now.
  upstream = (url) => (url.endsWith("/token") ? reply(401) : hang());
  const expired = Object.assign(new Error("401"), { status: 401 });
  await assert.rejects(withToken(() => { throw expired; }, "a1"));
  const { current, accounts } = JSON.parse(fs.readFileSync(STORE, "utf8"));
  assert.equal(current, "a1");
  assert.deepEqual(accounts.map((a) => [a.address, a.label]), [["keepme@example.com", "signup"]]);
});

test("a timeout that is set to nonsense falls back to the default", async () => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    const { TIMEOUT } = await import(${JSON.stringify(path.join(ROOT, "src/api.js"))});
    console.log(TIMEOUT);
  `], { env: { ...process.env, CATCHBOX_HTTP_TIMEOUT_MS: "-1" } });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  await new Promise((r) => child.on("exit", r));
  assert.equal(out.trim(), "20000");
});

test("a slow attachment download is not cut off by the timeout", async () => {
  // mail.tm answers at once, then takes longer than the timeout to send the body.
  upstream = (url, opts) => {
    if (!url.includes("/attachment/")) return hang();
    return {
      ok: true, status: 200, statusText: "OK",
      headers: { get: () => "text/plain" },
      arrayBuffer: () => new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve(new TextEncoder().encode("hello").buffer), 600);
        opts.signal.addEventListener("abort", () => { clearTimeout(t); reject(opts.signal.reason); });
      }),
    };
  };
  const server = await serve({ port: 0 });
  const { port } = server.address();
  try {
    const res = await realFetch(`http://127.0.0.1:${port}/api/message/m1/attachment/x1?account=a1`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "hello");
  } finally {
    server.close();
  }
});

test("passing a signal of your own keeps the timeout", async () => {
  const started = Date.now();
  await assert.rejects(getAttachment("m1", "x1", "t1", { signal: new AbortController().signal }));
  assert.ok(Date.now() - started < 2000);
});

test("aborting your own signal stops the request", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("nobody is waiting")), 10);
  await assert.rejects(getAttachment("m1", "x1", "t1", { signal: controller.signal }), /nobody is waiting/);
});

test("an idle event stream is kept alive, so clients do not time out on it", async () => {
  const server = await serve({ port: 0, heartbeat: 50 });
  try {
    assert.match(await listen(server.address().port, 300), /^: ping$/m);
  } finally {
    server.close();
  }
});

test("a heartbeat of 0 does not turn into a busy loop", async () => {
  const server = await serve({ port: 0, heartbeat: 0 });
  try {
    assert.doesNotMatch(await listen(server.address().port, 150), /ping/);
  } finally {
    server.close();
  }
});

test("a store that cannot be read does not take the server down", async () => {
  const { code, stdout, stderr } = await brokenServer("await new Promise((r) => setTimeout(r, 400));");
  assert.equal(code, 0, stderr);
  assert.match(stdout, /alive/);
});

test("a store that cannot be read is reported once, not every round", async () => {
  // Several ticks of 50 ms, every one of them reading the broken store.
  const { code, stderr } = await brokenServer("await new Promise((r) => setTimeout(r, 400));");
  assert.equal(code, 0, stderr);
  assert.equal(stderr.match(/could not be read/g)?.length, 1, stderr);
});

test("a push stream that hangs while connecting gives up, so it can be retried", async () => {
  const started = Date.now();
  await assert.rejects(openStream("a1", "t1", new AbortController().signal));
  assert.ok(Date.now() - started < 2000);
});

test("waiting out a 429 is not mistaken for mail.tm being slow", async () => {
  // Rate-limited once, with a Retry-After longer than the timeout; then an answer.
  let calls = 0;
  upstream = () => (calls++ === 0
    ? { ...reply(429), headers: { get: (h) => (h === "retry-after" ? "1" : "application/json") } }
    : reply(200, { "hydra:member": [{ id: "m1" }] }));
  assert.deepEqual(await listMessages("t1"), [{ id: "m1" }]);
  assert.equal(calls, 2);
});
