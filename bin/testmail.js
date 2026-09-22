#!/usr/bin/env node
// catchbox — disposable inboxes for developers.
// Grab an address, catch the mail, pull out the link or the code.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  createAccount, withToken, listMessages, getMessage, getSource,
  markSeen, deleteMessage, deleteAccount, currentAddress, listAccounts, setCurrent,
} from "../src/api.js";
import { extractLinks, actionableLinks, extractCode, deliverability } from "../src/extract.js";
import { load, rename } from "../src/store.js";
import { serve } from "../src/server.js";

// This ships as both `catchbox` and `testmail`. Hints should name the command you actually
// typed — pointing someone at the other name is a small papercut, and argv[1] keeps the
// symlink you invoked, so there is no reason to guess.
const CMD = (process.argv[1] ? path.basename(process.argv[1], ".js") : "catchbox") || "catchbox";
const OTHER = CMD === "testmail" ? "catchbox" : "testmail";

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


// Every reading command may be pointed at another mailbox with `--box`, so you can check
// one inbox without switching the one the rest of your session is using.
const resolveBox = (selector) => {
  if (!selector || selector === true) return null;
  const boxes = listAccounts();
  if (!boxes.length) die(`No mailboxes yet. Run: ${CMD} add`);
  if (/^\d+$/.test(selector) && boxes[Number(selector)]) return boxes[Number(selector)].id;
  const needle = String(selector).toLowerCase();
  const hit =
    boxes.find((b) => b.id === selector) ??
    boxes.find((b) => b.address.toLowerCase() === needle) ??
    boxes.find((b) => (b.label ?? "").toLowerCase() === needle) ??
    boxes.find((b) => b.address.toLowerCase().startsWith(needle)) ??
    boxes.find((b) => (b.label ?? "").toLowerCase().includes(needle));
  if (!hit) die(`No mailbox matches "${selector}". See them with: ${CMD} boxes`);
  return hit.id;
};

const boxOf = (argv) => resolveBox(flag(argv, "--box"));

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
  console.log(`\n${m.text.trim() || `(no plain text part — try: ${CMD} open)`}\n`);
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
    const label = load()?.label;
    console.log(`${address}${label ? `  (${label})` : ""}${copy(address) ? "  (copied)" : ""}`);
  },

  async new() {
    await deleteAccount();
    const { address } = await createAccount();
    console.log(address + (copy(address) ? "  (copied)" : ""));
  },

  // --- mailboxes ----------------------------------------------------------
  // Several inboxes at once is the difference between testing one flow and testing
  // a product: signup, billing and invites all land somewhere you can tell apart.
  async add(argv) {
    const label = positional(argv).join(" ") || null;
    const { address, label: name } = await createAccount({ label, prefix: flag(argv, "--prefix") });
    console.log(`${address}${name ? `  (${name})` : ""}${copy(address) ? "  (copied)" : ""}`);
  },

  async boxes(argv) {
    const boxes = listAccounts();
    const active = load()?.id;
    if (has(argv, "--json")) return console.log(JSON.stringify(boxes.map((b) => ({ ...b, active: b.id === active })), null, 2));
    if (!boxes.length) return console.log(`No mailboxes yet. Run: ${CMD} add`);
    boxes.forEach((b, i) =>
      console.log(`[${i}] ${b.id === active ? "*" : " "} ${b.address}${b.label ? `  ${b.label}` : ""}`)
    );
    console.log(`\n* = the mailbox every other command uses. Switch with: ${CMD} use <n|name>`);
  },

  async use(argv) {
    const id = resolveBox(positional(argv)[0] ?? die(`Which mailbox? Try: ${CMD} boxes`));
    const acc = setCurrent(id);
    console.log(`${acc.address}${acc.label ? `  (${acc.label})` : ""}${copy(acc.address) ? "  (copied)" : ""}`);
  },

  async name(argv) {
    const label = positional(argv).join(" ");
    if (!label) die(`Give it a name. Try: ${CMD} name "Signup flow"`);
    const target = boxOf(argv) ?? load()?.id;
    if (!target) die(`No mailbox to name. Run: ${CMD} add`);
    const acc = rename(target, label);
    console.log(`${acc.address} is now "${acc.label}"`);
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
    }, boxOf(argv));
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
    }, boxOf(argv));
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
    }, boxOf(argv));
  },

  // The two shortcuts that replace "read the mail and copy the thing out of it".
  async code(argv) {
    const seconds = Number(flag(argv, "--wait") ?? 0) || (has(argv, "--wait") ? 120 : 0);
    await withToken(async (_acc, token) => {
      const raw = await resolveMessage(token, { wait: seconds, grace: Number(flag(argv, "--grace") ?? 90) });
      if (!raw) die(seconds ? `No mail within ${seconds}s.` : "Inbox is empty.");
      const m = await enrich(raw, token);
      if (!m.code) die(`No code found in "${m.subject}". Try: ${CMD} show`);
      console.log(m.code + (copy(m.code) ? "  (copied)" : ""));
    }, boxOf(argv));
  },

  async link(argv) {
    const seconds = Number(flag(argv, "--wait") ?? 0) || (has(argv, "--wait") ? 120 : 0);
    await withToken(async (_acc, token) => {
      const raw = await resolveMessage(token, { wait: seconds, grace: Number(flag(argv, "--grace") ?? 90) });
      if (!raw) die(seconds ? `No mail within ${seconds}s.` : "Inbox is empty.");
      const m = await enrich(raw, token);
      if (!m.links.length) die(`No links in "${m.subject}".`);
      if (!m.actionableLinks.length)
        die(`Only tracking and unsubscribe links in "${m.subject}" — nothing to click.\nSee them all with: ${CMD} show`);
      const url = m.actionableLinks[0];
      if (has(argv, "--open")) { openExternal(url); console.log(url); return; }
      console.log(url + (copy(url) ? "  (copied)" : ""));
    }, boxOf(argv));
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
    }, boxOf(argv));
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
    }, boxOf(argv));
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
    }, boxOf(argv));
  },

  async rm(argv) {
    const index = positional(argv)[0];
    if (index !== undefined) {
      return withToken(async (_acc, token) => {
        const msgs = await listMessages(token);
        if (!msgs[Number(index)]) die(`No message at index ${index}.`);
        await deleteMessage(msgs[Number(index)].id, token);
        console.log(`Deleted message ${index}.`);
      }, boxOf(argv));
    }
    const address = await deleteAccount(boxOf(argv));
    console.log(address ? `Deleted ${address}` : "No mailbox to delete.");
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
    console.log(`${CMD} — disposable inboxes for developers

  ${CMD}                  show the active address and copy it
  ${CMD} ui [port]        open the inbox in your browser (default 7337)

Mailboxes — keep as many as you have flows to test
  ${CMD} add [name]       new mailbox, kept alongside the others
  ${CMD} boxes            list them; * marks the active one
  ${CMD} use <n|name>     make one active
  ${CMD} name <text>      name the active mailbox
  ${CMD} new              replace the active mailbox with a fresh one

Catching mail
  ${CMD} wait [sec]       block until mail arrives, then print it
  ${CMD} list             list the inbox
  ${CMD} show [n]         print message n (0 = newest)
  ${CMD} open [n]         render message n as HTML in your browser

Pulling things out
  ${CMD} code             the one-time code, copied to your clipboard
  ${CMD} link --open      the most likely action link, opened in your browser
  ${CMD} headers [n]      SPF / DKIM / DMARC and what would hurt deliverability
  ${CMD} eml [n]          save the raw .eml

Cleaning up
  ${CMD} rm [n]           delete message n, or the whole mailbox if n is omitted

Flags
  --box <n|name|address>    act on another mailbox without switching to it
  --wait [sec]              on code/link: wait for the mail first (default 120)
  --grace <sec>             also count mail from the last N seconds (default 90)
  --json                    machine-readable output, for scripts and CI
  --all                     on headers: print every header
  --open                    on link: open it instead of copying it
  --out <file>              on eml: where to write

Also installed as \`${OTHER}\`. The active mailbox is shared with \`mailsy\`, so
\`mailsy me\` keeps working.`);
  },
};

const aliases = { "-h": "help", "--help": "help", ls: "list", otp: "code", url: "link",
                  delete: "rm", mailboxes: "boxes", switch: "use", label: "name" };
const [raw = "addr", ...argv] = process.argv.slice(2);
const name = aliases[raw] ?? raw;
const fn = commands[name];
if (!fn) die(`Unknown command: ${raw}\nTry: ${CMD} help`);
Promise.resolve(fn(argv)).catch((e) => die(`Error: ${e.message}`));
