import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "catchbox-server-"));
const STORE = path.join(home, ".config/testmail/accounts.json");
fs.mkdirSync(path.dirname(STORE), { recursive: true });
process.env.HOME = home;
process.env.TESTMAIL_MAILSY_STORE = path.join(home, "mailsy.json");

const ACCOUNT = { id: "a1", address: "keepme@example.com", password: "pw", token: { token: "t1" } };
fs.writeFileSync(STORE, JSON.stringify({ version: 2, current: "a1", accounts: [ACCOUNT] }));

// Every request to mail.tm goes through here. Listing the inbox is slow on purpose, so
// rounds that are allowed to overlap actually do.
const realFetch = global.fetch;
let inFlight = 0;
let maxInFlight = 0;
let listCalls = 0;
// The Mercure push stream: open until the server aborts it; push() sends an event down it.
const streams = new Set();
const push = (data) => {
  for (const c of streams) c.enqueue(new TextEncoder().encode(`id: x\ndata: ${JSON.stringify(data)}\n\n`));
};
global.fetch = async (url, opts) => {
  if (String(url).startsWith("https://mercure.mail.tm")) {
    let ctl;
    const body = new ReadableStream({ start(c) { ctl = c; streams.add(c); } });
    opts?.signal?.addEventListener("abort", () => { streams.delete(ctl); try { ctl.error(new Error("aborted")); } catch {} });
    return { ok: true, status: 200, body };
  }
  if (!String(url).startsWith("https://api.mail.tm")) return realFetch(url, opts);
  if (/\/messages\?page=/.test(url)) {
    listCalls++;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 80));
    inFlight--;
  }
  return {
    ok: true, status: 200, statusText: "OK",
    headers: { get: () => "application/json" },
    json: async () => ({ "hydra:member": [] }),
    text: async () => "{}",
  };
};

const { serve } = await import("../src/server.js");

test("polls never overlap, however often they are asked for", async () => {
  const server = await serve({ port: 0 });
  const { port } = server.address();
  try {
    // Each DELETE awaits a poll of its own, on top of the one serve() starts.
    await Promise.all(
      Array.from({ length: 4 }, () =>
        realFetch(`http://127.0.0.1:${port}/api/message/m1?account=a1`, { method: "DELETE" }))
    );
    assert.equal(maxInFlight, 1);
  } finally {
    server.close();
  }
});

test("a port that is taken is reported, not thrown as a stack trace", async () => {
  const first = await serve({ port: 0 });
  const { port } = first.address();
  try {
    await assert.rejects(serve({ port }), /already in use/);
  } finally {
    first.close();
  }
});

const until = async (fn, ms = 2000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20)))
    if (fn()) return;
  throw new Error("timed out");
};

test("the inbox is served from the cache while the push stream is up", async () => {
  const server = await serve({ port: 0 });
  const { port } = server.address();
  try {
    await until(() => streams.size > 0);
    await realFetch(`http://127.0.0.1:${port}/api/inbox?account=a1`).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 150)); // the refresh a fresh stream starts
    const before = listCalls;
    for (let i = 0; i < 5; i++) {
      const r = await realFetch(`http://127.0.0.1:${port}/api/inbox?account=all`).then((r) => r.json());
      assert.deepEqual(r.messages, []);
    }
    await realFetch(`http://127.0.0.1:${port}/api/inbox?account=a1`).then((r) => r.json());
    assert.equal(listCalls, before, "no request to mail.tm for an inbox the stream keeps current");
  } finally {
    server.close();
  }
});

test("a burst of push events refreshes the mailbox once", async () => {
  const server = await serve({ port: 0 });
  try {
    await until(() => streams.size > 0);
    await new Promise((r) => setTimeout(r, 150));
    const before = listCalls;
    for (let i = 0; i < 5; i++) push({ "@type": "Message", id: `m${i}` });
    await until(() => listCalls > before);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(listCalls, before + 1);
  } finally {
    server.close();
  }
});
