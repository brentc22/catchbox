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
global.fetch = async (url, opts) => {
  if (!String(url).startsWith("https://api.mail.tm")) return realFetch(url, opts);
  if (/\/messages\?page=/.test(url)) {
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
