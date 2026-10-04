import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "catchbox-bulk-"));
const STORE = path.join(home, ".config/testmail/accounts.json");
fs.mkdirSync(path.dirname(STORE), { recursive: true });
process.env.HOME = home;
process.env.TESTMAIL_MAILSY_STORE = path.join(home, "mailsy.json");

const ACCOUNTS = [
  { id: "a1", address: "one@example.com", password: "pw", token: { token: "t1" } },
  { id: "a2", address: "two@example.com", password: "pw", token: { token: "t2" } },
  { id: "a3", address: "down@example.com", password: "pw", token: { token: "down" } },
];
fs.writeFileSync(STORE, JSON.stringify({ version: 2, current: "a1", accounts: ACCOUNTS }));

// A small mail.tm: messages per token, a page size of 3 so emptying has to go round more
// than once, a message that always fails to delete, a "ghost" that is still listed after it
// is gone, and a mailbox whose listing is down.
const PAGE = 3;
let boxes;
const reset = () => {
  boxes = {
    t1: Array.from({ length: 7 }, (_, i) => ({ id: `m${i}`, seen: false })),
    t2: [{ id: "n0", seen: false }, { id: "broken", seen: false }, { id: "ghost", seen: false }],
    t3: [
      ...["b1", "b2", "b3"].map((id) => ({ id, broken: true })),
      ...["k1", "k2"].map((id) => ({ id })),
    ],
  };
};

const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  if (!String(url).startsWith("https://api.mail.tm")) return realFetch(url, opts);
  const token = opts.headers?.authorization?.replace("Bearer ", "");
  const box = boxes[token] ?? [];
  const reply = (status, data) => ({
    ok: status < 400, status, statusText: String(status),
    headers: { get: () => "application/json" },
    json: async () => data,
    text: async () => JSON.stringify(data ?? {}),
  });

  const { pathname, searchParams } = new URL(url);
  if (token === "down") return reply(503, {});
  if (pathname === "/messages") {
    const page = Number(searchParams.get("page") ?? 1);
    return reply(200, { "hydra:member": box.slice((page - 1) * PAGE, page * PAGE) });
  }
  const id = decodeURIComponent(pathname.split("/")[2] ?? "");
  const at = box.findIndex((m) => m.id === id);
  if (id === "broken" || box[at]?.broken) return reply(500, {});
  if (id === "ghost" && opts.method === "DELETE") return reply(404, {});
  if (at === -1) return reply(404, {});
  if (opts.method === "DELETE") { box.splice(at, 1); return reply(204, null); }
  if (opts.method === "PATCH") { Object.assign(box[at], JSON.parse(opts.body)); return reply(200, box[at]); }
  return reply(200, box[at]);
};

const { serve } = await import("../src/server.js");
const { emptyInbox } = await import("../src/api.js");

const withServer = async (fn) => {
  const server = await serve({ port: 0 });
  const { port } = server.address();
  try {
    await fn((p, opts) => realFetch(`http://127.0.0.1:${port}${p}`, opts).then((r) => r.json()));
  } finally {
    server.close();
  }
};

const post = (body) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(reset);

test("emptyInbox keeps going past the first page", async () => {
  assert.deepEqual(await emptyInbox("t1"), { deleted: 7, failed: 0 });
  assert.equal(boxes.t1.length, 0);
});

test("a message that will not delete is stepped over, not the end of the run", async () => {
  assert.deepEqual(await emptyInbox("t2"), { deleted: 2, failed: 1 });
  assert.deepEqual(boxes.t2.map((m) => m.id), ["broken", "ghost"]);
});

test("a page full of messages that will not delete does not hide the next page", async () => {
  assert.deepEqual(await emptyInbox("t3"), { deleted: 2, failed: 3 });
  assert.deepEqual(boxes.t3.map((m) => m.id), ["b1", "b2", "b3"]);
});

test("a bulk delete spans mailboxes and reports what it could not do", async () => {
  await withServer(async (call) => {
    const r = await call("/api/messages", post({
      action: "delete",
      items: [
        { id: "m0", account: "a1" }, { id: "m1", account: "a1" },
        { id: "n0", account: "a2" }, { id: "broken", account: "a2" },
      ],
    }));
    assert.deepEqual(r, { ok: false, done: 3, failed: 1 });
    assert.deepEqual(boxes.t1.map((m) => m.id), ["m2", "m3", "m4", "m5", "m6"]);
    assert.deepEqual(boxes.t2.map((m) => m.id), ["broken", "ghost"]);
  });
});

test("marking read and unread in bulk", async () => {
  await withServer(async (call) => {
    const items = [{ id: "m0", account: "a1" }, { id: "m1", account: "a1" }];
    assert.equal((await call("/api/messages", post({ action: "seen", items }))).done, 2);
    assert.deepEqual(boxes.t1.slice(0, 3).map((m) => m.seen), [true, true, false]);
    await call("/api/messages", post({ action: "unseen", items: items.slice(0, 1) }));
    assert.deepEqual(boxes.t1.slice(0, 3).map((m) => m.seen), [false, true, false]);
  });
});

test("an unknown action is refused", async () => {
  await withServer(async (call) => {
    const r = await call("/api/messages", post({ action: "archive", items: [] }));
    assert.match(r.error, /expected an action/);
  });
});

test("emptying one mailbox leaves the others alone", async () => {
  await withServer(async (call) => {
    const r = await call("/api/inbox?account=a1", { method: "DELETE" });
    assert.equal(r.deleted, 7);
    assert.equal(boxes.t1.length, 0);
    assert.equal(boxes.t2.length, 3);
  });
});

test("emptying every mailbox reports what it did, even when one is down", async () => {
  await withServer(async (call) => {
    const r = await call("/api/inbox?account=all", { method: "DELETE" });
    assert.equal(r.error, undefined);
    // a1: 7, a2: n0 and the ghost (once), a3: unreachable
    assert.deepEqual(r, { ok: false, deleted: 9, failed: 1, unreachable: 1 });
    assert.equal(boxes.t1.length, 0);
  });
});
