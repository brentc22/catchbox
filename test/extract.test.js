// Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCode, extractLinks, unwrapUrl, deliverability , htmlToText } from "../src/extract.js";

test("finds the code after a keyword", () => {
  assert.equal(extractCode("Your verification code is 482910. It expires in 10 minutes."), "482910");
  assert.equal(extractCode("Code: 5821"), "5821");
  assert.equal(extractCode("Use one-time password A3F9K2 to continue"), "A3F9K2");
});

test("finds the code before a keyword", () => {
  assert.equal(extractCode("123456 is your Acme login code"), "123456");
});

test("finds a code on a line of its own", () => {
  assert.equal(extractCode("Hier is je code\n\n  920174  \n\nGeldig tot morgen."), "920174");
});

test("reads the subject too", () => {
  assert.equal(extractCode("", "Your code: 665544"), "665544");
});

test("handles non-English keywords", () => {
  assert.equal(extractCode("Je verificatiecode is 774412"), "774412");
  assert.equal(extractCode("Ihr Bestätigungscode lautet 338211"), "338211");
});

test("returns null rather than guessing", () => {
  assert.equal(extractCode("Copyright 2026 Acme Inc. All rights reserved."), null);
  assert.equal(extractCode("Your order of €1250 has shipped."), null);
  assert.equal(extractCode("Call us on +32 475 123456 for help"), null);
  assert.equal(extractCode("Welcome! Click the link below to get started."), null);
});

test("a word is never a code", () => {
  // The candidate pattern runs case-insensitively, so "verification" itself can match.
  assert.equal(extractCode("Please complete verification"), null);
  assert.equal(extractCode("Enter your password to continue"), null);
});

test("unwraps click trackers", () => {
  assert.equal(
    unwrapUrl("https://www.google.com/url?q=https%3A%2F%2Freal.example.com%2Fmagic%3Ft%3D1"),
    "https://real.example.com/magic?t=1"
  );
  assert.equal(unwrapUrl("https://plain.example.com/x"), "https://plain.example.com/x");
});

test("ranks actionable links above unsubscribe and assets", () => {
  const links = extractLinks(`
    https://x.com/unsubscribe?u=9
    https://app.example.com/verify?token=abc
    https://cdn.example.com/logo.png
  `);
  assert.equal(links[0], "https://app.example.com/verify?token=abc");
  assert.equal(links.at(-1), "https://cdn.example.com/logo.png");
});

test("strips trailing punctuation from links", () => {
  assert.deepEqual(extractLinks("Go to https://example.com/a."), ["https://example.com/a"]);
});

test("reads auth results out of raw headers", () => {
  const raw = [
    "Received-SPF: pass (example.com: domain of a@b.com designates 1.2.3.4)",
    "Authentication-Results: mx.example.com; spf=pass; dkim=pass; dmarc=fail",
    "Message-ID: <abc@example.com>",
    "List-Unsubscribe: <https://example.com/u>",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "body",
  ].join("\n");
  const d = deliverability(raw);
  assert.equal(d.spf, "pass");
  assert.equal(d.dkim, "pass");
  assert.equal(d.dmarc, "fail");
  assert.equal(d.messageId, "<abc@example.com>");
  assert.equal(d.listUnsubscribe, "<https://example.com/u>");
  assert.equal(d.hasPlainText, true);
});

test("unfolds continuation header lines", () => {
  const { headers } = deliverability("Subject: a very\n long subject\n\nbody");
  assert.equal(headers[0].value, "a very long subject");
});

test("a hex colour in the markup never beats the real code", () => {
  // HTML-only mail is exactly what this tool tells you to fix, so it is also exactly the
  // mail whose code gets read out of the markup. #A3F912 is uppercase, has digits and sits
  // next to the word "code" — it outscored the six digits in the next cell.
  const html = '<td class="code" bgcolor="#A3F912">Your sign-in code</td><td>731204</td>';
  assert.equal(extractCode(htmlToText(html), ""), "731204");
  assert.equal(extractCode(htmlToText('<p style="background:#FFEE00">Nothing here</p>'), ""), null);
});
