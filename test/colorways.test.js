import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (file) => readFileSync(new URL(`../src/ui/${file}`, import.meta.url), "utf8");
const css = read("colorways.css");
const app = read("app.js");
const html = read("index.html");

const offered = [...app.match(/const COLORWAYS = \[([\s\S]*?)\];/)[1].matchAll(/\["(\w+)", "\w+"\]/g)].map((m) => m[1]);
const blockOf = (id) => css.match(new RegExp(`\\[data-cw="${id}"\\] \\{([^}]*)\\}`))?.[1];
const REQUIRED = ["--bl-l", "--bc-l", "--bh-l", "--bl-d", "--bc-d", "--bh-d", "--ah", "--al-l", "--ac-l", "--on-l",
  "--al-d", "--ac-d", "--on-d", "--ch", "--cc", "--cl-l", "--cl-d", "--th", "--tc", "--tl"];

test("offers the six colorways", () => {
  assert.deepEqual(offered, ["airmail", "classic", "kraft", "wax", "stamp", "carbon"]);
});

test("every colorway sets every input, because a missing one silently breaks all its colours", () => {
  for (const id of offered) {
    const block = blockOf(id);
    assert.ok(block, `no block for ${id}`);
    for (const input of REQUIRED) assert.match(block, new RegExp(`${input}:`), `${id} misses ${input}`);
  }
});

test("the first paint matches the defaults, so there is no flash before the settings load", () => {
  const defaults = app.match(/const DEFAULTS = \{([\s\S]*?)\};/)[1];
  const value = (key) => defaults.match(new RegExp(`${key}: "(\\w+)"`))[1];
  assert.match(html, new RegExp(`<html[^>]*data-theme="${value("theme")}"`));
  assert.match(html, new RegExp(`<html[^>]*data-cw="${value("colorway")}"`));
  assert.equal(value("colorway"), "airmail");
  assert.equal(value("theme"), "dark");
});

test("the stylesheet only uses tokens that exist", () => {
  const defined = new Set([...`${css}${read("style.css")}`.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  // Only var(--x) with no fallback: --h, --i and --d are set inline per element and have one.
  const used = new Set([...read("style.css").matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]));
  for (const token of used) assert.ok(defined.has(token), `${token} is not defined`);
});
