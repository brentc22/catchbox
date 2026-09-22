import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Every case gets its own HOME, so the tests never see — or touch — the real mailboxes.
const sandbox = async (setup) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "testmail-store-"));
  fs.mkdirSync(path.join(home, ".config/testmail"), { recursive: true });
  process.env.HOME = home;
  process.env.TESTMAIL_MAILSY_STORE = path.join(home, "mailsy.json");
  setup?.(path.join(home, ".config/testmail"));
  // A fresh module instance per case: the paths are resolved at import time.
  const store = await import(`../src/store.js?${Math.random()}`);
  return { home, store, dir: path.join(home, ".config/testmail") };
};

const ACCOUNT = { id: "a1", address: "one@example.com", password: "pw", token: { token: "t" } };

test("a single-mailbox account.json is adopted, not discarded", async () => {
  const { store } = await sandbox((dir) =>
    fs.writeFileSync(path.join(dir, "account.json"), JSON.stringify(ACCOUNT))
  );
  const data = store.readAll();
  assert.equal(data.accounts.length, 1);
  assert.equal(data.current, "a1");
  assert.equal(store.load().address, "one@example.com");
});

test("a second mailbox does not replace the first", async () => {
  const { store } = await sandbox();
  store.save(ACCOUNT);
  store.save({ id: "a2", address: "two@example.com", password: "pw2" });
  assert.deepEqual(store.list().map((a) => a.id), ["a1", "a2"]);
  assert.equal(store.load().id, "a2", "the new one becomes active");
});

test("refreshing a token leaves the active mailbox alone", async () => {
  const { store } = await sandbox();
  store.save(ACCOUNT);
  store.save({ id: "a2", address: "two@example.com", password: "pw2" });
  store.save({ ...ACCOUNT, token: { token: "fresh" } }, { activate: false });
  assert.equal(store.load().id, "a2");
  assert.equal(store.load("a1").token.token, "fresh");
});

test("deleting the active mailbox falls back to another one", async () => {
  const { store } = await sandbox();
  store.save(ACCOUNT);
  store.save({ id: "a2", address: "two@example.com", password: "pw2" });
  store.remove("a2");
  assert.equal(store.load().id, "a1");
});

test("the active mailbox is mirrored to the file mailsy reads", async () => {
  const { store, home } = await sandbox();
  store.save(ACCOUNT);
  const mirrored = JSON.parse(fs.readFileSync(path.join(home, "mailsy.json"), "utf8"));
  assert.equal(mirrored.address, "one@example.com");
  store.save({ id: "a2", address: "two@example.com", password: "pw2" });
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "mailsy.json"), "utf8")).address, "two@example.com");
});

test("renaming keeps the address and the token", async () => {
  const { store } = await sandbox();
  store.save(ACCOUNT);
  const renamed = store.rename("a1", "  Signup flow  ");
  assert.equal(renamed.label, "Signup flow");
  assert.equal(store.load("a1").token.token, "t");
});

test("an unreadable store is never silently replaced by the legacy single mailbox", async () => {
  const { store, dir } = await sandbox((d) => {
    // A torn write, plus the old single-mailbox file still lying next to it.
    fs.writeFileSync(path.join(d, "accounts.json"), '{"version":2,"accounts":[{"id":"a1"');
    fs.writeFileSync(path.join(d, "account.json"), JSON.stringify(ACCOUNT));
  });
  assert.throws(() => store.readAll(), /could not be read/);
  // And the damaged file is still there to rescue by hand.
  assert.match(fs.readFileSync(path.join(dir, "accounts.json"), "utf8"), /"a1"/);
});

test("removing the last mailbox leaves mailsy's own account file alone", async () => {
  const { store, home } = await sandbox();
  const mailsy = path.join(home, "mailsy.json");
  store.save(ACCOUNT);
  fs.writeFileSync(mailsy, JSON.stringify({ id: "m1", address: "mailsy-own@example.com" }));
  store.remove("a1");
  assert.equal(JSON.parse(fs.readFileSync(mailsy, "utf8")).address, "mailsy-own@example.com");
});
