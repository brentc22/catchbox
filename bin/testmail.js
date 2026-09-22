#!/usr/bin/env node
// testmail — a disposable inbox for developers.
// Grab an address, catch the mail, pull out the link or the code.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  createAccount, withToken, listMessages, getMessage, getSource,
  markSeen, deleteMessage, deleteAccount, currentAddress,
} from "../src/api.js";
import { extractLinks, actionableLinks, extractCode, deliverability } from "../src/extract.js";
import { load } from "../src/store.js";
import { serve } from "../src/server.js";

const die = (msg) => { console.error(msg); process.exit(1); };

const flag = (argv, name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? true);
};
const has = (argv, name) => argv.includes(name);
const positional = (argv) => argv.filter((a) => !a.startsWith("--") &&
  !(argv[argv.indexOf(a) - 1]?.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--open"));

const copy = (s) => {
  const cmd = process.platform === "darwin" ? "pbcopy"
    : process.platform === "win32" ? "clip" : "xclip";
  try { execFileSync(cmd, process.platform === "linux" ? ["-selection", "clipboard"] : [], { input: s }); return true; }
  catch { return false; }
};

const openExternal = (target) => {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start" : "xdg-open";
  try { execFileSync(cmd, [target]); return true; } catch { return false; }
};

const fmtDate = (s) => new Date(s).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });

const enrich = async (m, token, { withSource = false } = {}) => {
  const html = (m.html || []).join("\n");
  const source = withSource ? await getSource(m.id, token).catch(() => null) : null;
  const raw = typeof source === "string" ? source : source?.data ?? "";
  return {
    id: m.id,
    from: m.from?.address ?? null,
    fromName: m.from?.name || null,
    to: (m.to || []).map((t) => t.address),
    subject: m.subject || "",
    date: m.createdAt,
    seen: m.seen,
    text: m.text || "",
    html,
    links: extractLinks(m.text, html),
    actionableLinks: actionableLinks(m.text, html),
    code: extractCode(m.text || "", m.subject || "") ?? extractCode(html, m.subject || ""),
    hasAttachments: Boolean(m.hasAttachments),
    attachments: (m.attachments || []).map((a) => ({
      id: a.id, filename: a.filename, contentType: a.contentType, size: a.size,
    })),
    ...(raw ? { raw, deliverability: deliverability(raw) } : {}),
  };
};

// Most commands act on "the newest message", optionally waiting for it to arrive first.
// That is the whole loop of testing an email flow, so it gets one shared implementation.
const resolveMessage = async (token, { index = 0, wait = 0, grace = 90 } = {}) => {
  const cutoff = Date.now() - grace * 1000;
  const started = Date.now();
  for (;;) {
    const msgs = await listMessages(token);
    const pool = wait ? msgs.filter((m) => new Date(m.createdAt).getTime() >= cutoff) : msgs;
    if (pool[index]) return getMessage(pool[index].id, token);
    if (!wait || Date.now() - started >= wait * 1000) return null;
    await new Promise((r) => setTimeout(r, 2000));
  }
};

const printMessage = (m) => {
  console.log(`From:     ${m.fromName ? `${m.fromName} <${m.from}>` : m.from}`);
  console.log(`To:       ${m.to.join(", ")}`);
  console.log(`Subject:  ${m.subject || "(none)"}`);
  console.log(`Date:     ${fmtDate(m.date)}`);
  if (m.code) console.log(`Code:     ${m.code}`);
  console.log(`\n${m.text.trim() || "(no plain text part — try: testmail open)"}\n`);
  if (m.links.length) {
    console.log("Links:");
    m.links.forEach((u) => console.log(`  ${u}`));
  }
  if (m.attachments.length) {
    console.log("\nAttachments:");
    m.attachments.forEach((a) => console.log(`  ${a.filename} (${a.contentType}, ${a.size} bytes)`));
  }
};

const commands = {
  async addr() {
    const address = await currentAddress();
    console.log(address + (copy(address) ? "  (copied)" : ""));
  },

  async new() {
    await deleteAccount();
    const { address } = await createAccount();
    console.log(address + (copy(address) ? "  (copied)" : ""));
  },

  async list(argv) {
    await withToken(async (acc, token) => {
      const msgs = await listMessages(token);
      if (has(argv, "--json")) return console.log(JSON.stringify({ address: acc.address, messages: msgs }, null, 2));
      if (!msgs.length) return console.log(`Inbox empty (${acc.address})`);
      console.log(`${acc.address} — ${msgs.length} message(s)\n`);
      msgs.forEach((m, i) =>
        console.log(`[${i}] ${m.seen ? " " : "•"} ${fmtDate(m.createdAt)}  ${m.from?.address ?? "?"}  ${m.subject || "(no subject)"}`)
      );
    });
  },

  async show(argv) {
    const index = Number(positional(argv)[0] ?? 0);
    await withToken(async (_acc, token) => {
      const raw = await resolveMessage(token, { index });
      if (!raw) die(`No message at index ${index}.`);
      const m = await enrich(raw, token);
      await markSeen(m.id, token);
      if (has(argv, "--json")) return console.log(JSON.stringify(m, null, 2));
      printMessage(m);
    });
  },

  last: (argv) => commands.show(argv),

  async wait(argv) {
    const seconds = Number(positional(argv)[0] ?? 120);
    const grace = Number(flag(argv, "--grace") ?? 90);
    await withToken(async (acc, token) => {
      if (!has(argv, "--json")) process.stderr.write(`Waiting for mail to ${acc.address} (${seconds}s, grace ${grace}s)…\n`);
      const raw = await resolveMessage(token, { wait: seconds, grace });
      if (!raw) die(`No new mail within ${seconds}s.`);
      const m = await enrich(raw, token);
      await markSeen(m.id, token);
      if (has(argv, "--json")) return console.log(JSON.stringify(m, null, 2));
      printMessage(m);
    });
  },

  // The two shortcuts that replace "read the mail and copy the thing out of it".
  async code(argv) {
    const seconds = Number(flag(argv, "--wait") ?? 0) || (has(argv, "--wait") ? 120 : 0);
    await withToken(async (_acc, token) => {
      const raw = await resolveMessage(token, { wait: seconds, grace: Number(flag(argv, "--grace") ?? 90) });
      if (!raw) die(seconds ? `No mail within ${seconds}s.` : "Inbox is empty.");
      const m = await enrich(raw, token);
      if (!m.code) die(`No code found in "${m.subject}". Try: testmail show`);
      console.log(m.code + (copy(m.code) ? "  (copied)" : ""));
    });
  },

  async link(argv) {
    const seconds = Number(flag(argv, "--wait") ?? 0) || (has(argv, "--wait") ? 120 : 0);
    await withToken(async (_acc, token) => {
      const raw = await resolveMessage(token, { wait: seconds, grace: Number(flag(argv, "--grace") ?? 90) });
      if (!raw) die(seconds ? `No mail within ${seconds}s.` : "Inbox is empty.");
      const m = await enrich(raw, token);
      if (!m.links.length) die(`No links in "${m.subject}".`);
      if (!m.actionableLinks.length)
        die(`Only tracking and unsubscribe links in "${m.subject}" — nothing to click.\nSee them all with: testmail show`);
      const url = m.actionableLinks[0];
      if (has(argv, "--open")) { openExternal(url); console.log(url); return; }
      console.log(url + (copy(url) ? "  (copied)" : ""));
    });
  },

  // Why did this land in spam? The answer is in the headers, which the parsed
  // message endpoint does not return — this fetches the raw source for them.
  async headers(argv) {
    const index = Number(positional(argv)[0] ?? 0);
    await withToken(async (_acc, token) => {
      const raw = await resolveMessage(token, { index });
      if (!raw) die(`No message at index ${index}.`);
      const m = await enrich(raw, token, { withSource: true });
      if (!m.deliverability) die("Could not fetch the raw source for this message.");
      if (has(argv, "--json")) return console.log(JSON.stringify(m.deliverability, null, 2));
      const d = m.deliverability;
      const yn = (v) => (v === true ? "yes" : v === false ? "NO" : "unknown");

      console.log(`Subject:      ${m.subject}`);
      console.log(`From domain:  ${d.fromDomain ?? "?"}`);
      console.log("");

      if (d.authResultsPresent) {
        console.log(`SPF:          ${d.spf ?? "not stated"}`);
        console.log(`DKIM:         ${d.dkim ?? "not stated"}`);
        console.log(`DMARC:        ${d.dmarc ?? "not stated"}`);
      } else {
        // mail.tm does not verify on receipt, so there is no verdict to report. What the
        // headers still allow is the alignment check DMARC itself performs.
        console.log("No Authentication-Results header — this inbox does not verify on receipt.");
        console.log("Checking domain alignment instead, which is what DMARC evaluates:");
      }
      console.log("");
      console.log(`DKIM signature: ${d.signature ? `${d.signature.domain} (selector ${d.signature.selector})` : "MISSING — unsigned mail fails DMARC"}`);
      console.log(`DKIM aligned:   ${yn(d.dkimAligned)}${d.dkimAligned === false ? `  (signed by ${d.signature?.domain}, sent as ${d.fromDomain})` : ""}`);
      console.log(`SPF aligned:    ${yn(d.spfAligned)}${d.spfAligned === false ? `  (bounces to ${d.returnPathDomain} — normal via an ESP, DKIM has to carry DMARC)` : ""}`);
      console.log("");
      console.log(`Plain text part: ${d.hasPlainText ? "yes" : "NO  — HTML-only mail is downranked by iCloud and Outlook"}`);
      console.log(`List-Unsubscribe: ${d.listUnsubscribe ? (d.oneClickUnsubscribe ? "yes, one-click" : "yes") : "none"}`);
      console.log(`Reply-To:     ${d.replyTo ?? "none"}`);
      console.log(`Message-ID:   ${d.messageId ?? "none"}`);

      if (has(argv, "--all")) {
        console.log("\nAll headers:");
        d.headers.forEach((h) => console.log(`  ${h.name}: ${h.value}`));
      }
    });
  },

  async open(argv) {
    const index = Number(positional(argv)[0] ?? 0);
    await withToken(async (_acc, token) => {
      const raw = await resolveMessage(token, { index });
      if (!raw) die(`No message at index ${index}.`);
      const m = await enrich(raw, token);
      const file = path.join(os.tmpdir(), `testmail-${m.id}.html`);
      fs.writeFileSync(file, m.html || `<pre>${m.text}</pre>`);
      openExternal(file);
      console.log(file);
    });
  },

  async eml(argv) {
    const index = Number(positional(argv)[0] ?? 0);
    await withToken(async (_acc, token) => {
      const raw = await resolveMessage(token, { index });
      if (!raw) die(`No message at index ${index}.`);
      const m = await enrich(raw, token, { withSource: true });
      const file = flag(argv, "--out") || path.join(process.cwd(), `${m.id}.eml`);
      fs.writeFileSync(file, m.raw ?? "");
      console.log(file);
    });
  },

  async rm(argv) {
    const index = positional(argv)[0];
    if (index !== undefined) {
      return withToken(async (_acc, token) => {
        const msgs = await listMessages(token);
        if (!msgs[Number(index)]) die(`No message at index ${index}.`);
        await deleteMessage(msgs[Number(index)].id, token);
        console.log(`Deleted message ${index}.`);
      });
    }
    const address = await deleteAccount();
    console.log(address ? `Deleted ${address}` : "No account to delete.");
  },

  async ui(argv) {
    const port = Number(positional(argv)[0] ?? 7337);
    const address = (load() ?? (await createAccount())).address;
    await serve({ port });
    console.log(`Inbox:    http://localhost:${port}`);
    console.log(`Address:  ${address}`);
    console.log(`\nStop with Ctrl-C.`);
    if (!process.env.TESTMAIL_NO_OPEN) openExternal(`http://localhost:${port}`);
  },

  help() {
    console.log(`testmail — a disposable inbox for developers

  testmail                  show the current address and copy it
  testmail new              new address (deletes the old one), copied
  testmail ui [port]        open the inbox in your browser (default 7337)

Catching mail
  testmail wait [sec]       block until mail arrives, then print it
  testmail list             list the inbox
  testmail show [n]         print message n (0 = newest)
  testmail open [n]         render message n as HTML in your browser

Pulling things out
  testmail code             the one-time code, copied to your clipboard
  testmail link --open      the most likely action link, opened in your browser
  testmail headers [n]      SPF / DKIM / DMARC and what would hurt deliverability
  testmail eml [n]          save the raw .eml

Cleaning up
  testmail rm [n]           delete message n, or the whole account if n is omitted

Flags
  --wait [sec]              on code/link: wait for the mail first (default 120)
  --grace <sec>             also count mail from the last N seconds (default 90)
  --json                    machine-readable output, for scripts and CI
  --all                     on headers: print every header
  --open                    on link: open it instead of copying it
  --out <file>              on eml: where to write

Shares its mailbox with \`mailsy\`, so \`mailsy me\` keeps working.`);
  },
};

const aliases = { "-h": "help", "--help": "help", ls: "list", otp: "code", url: "link", delete: "rm" };
const [raw = "addr", ...argv] = process.argv.slice(2);
const name = aliases[raw] ?? raw;
const fn = commands[name];
if (!fn) die(`Unknown command: ${raw}\nTry: testmail help`);
Promise.resolve(fn(argv)).catch((e) => die(`Error: ${e.message}`));
