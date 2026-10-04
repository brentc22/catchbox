import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/args.js";

test("a boolean flag does not swallow the positional behind it", () => {
  // `show --json 2` used to show message 0: the 2 was read as the value of --json.
  assert.deepEqual(parseArgs(["--json", "2"]).positional, ["2"]);
  assert.equal(parseArgs(["--json", "2"]).has("--json"), true);
  assert.deepEqual(parseArgs(["--all", "1"]).positional, ["1"]);
  assert.deepEqual(parseArgs(["--open"]).positional, []);
});

test("a value flag takes the next argument, and only that one", () => {
  const args = parseArgs(["Signup", "flow", "--box", "1", "--prefix", "su"]);
  assert.deepEqual(args.positional, ["Signup", "flow"]);
  assert.equal(args.value("--box"), "1");
  assert.equal(args.value("--prefix"), "su");
});

test("a positional equal to a flag's value is still a positional", () => {
  // The old filter looked up each argument with indexOf, so `show 1 --box 1` lost track.
  const args = parseArgs(["1", "--box", "1"]);
  assert.deepEqual(args.positional, ["1"]);
  assert.equal(args.value("--box"), "1");
});

test("a bare value flag falls back to its default", () => {
  const args = parseArgs(["--wait", "--json"]);
  assert.equal(args.has("--wait"), true);
  assert.equal(args.value("--wait", 120), 120);
  assert.equal(args.value("--grace", 90), 90); // not given at all
  assert.equal(args.has("--json"), true);
});

test("a bare --wait does not eat the flag behind it", () => {
  assert.equal(parseArgs(["--wait", "30"]).value("--wait", 120), "30");
  assert.equal(parseArgs(["--wait", "--grace", "5"]).value("--grace", 90), "5");
});

test("seconds() refuses what is not a number instead of waiting zero seconds", () => {
  assert.equal(parseArgs(["--wait", "30"]).seconds("--wait", 120), 30);
  assert.equal(parseArgs([]).seconds("--wait", 120), 120);
  assert.throws(() => parseArgs(["--wait", "soon"]).seconds("--wait", 120), /--wait/);
});
