// Everything we pull out of a message so you don't have to read it yourself:
// the links worth clicking, the one-time code, and what the headers say about
// whether this mail would survive a real inbox.

const REDIRECTORS = ["q", "url", "u", "target", "redirect", "link"];

// Gmail, Outlook and most ESPs wrap links in a click tracker. Show where it really goes.
export const unwrapUrl = (raw) => {
  try {
    const url = new URL(raw);
    for (const key of REDIRECTORS) {
      const inner = url.searchParams.get(key);
      if (inner?.startsWith("http")) return unwrapUrl(inner);
    }
    return raw;
  } catch {
    return raw;
  }
};

const URL_RE = /https?:\/\/[^\s<>"')\]}]+/g;

// Unsubscribe and tracking-pixel links are noise when you are testing a signup flow,
// so they sort last rather than getting dropped — sometimes the unsubscribe link IS
// the thing under test.
const linkRank = (url) => {
  const u = url.toLowerCase();
  if (/(verify|confirm|activate|magic|login|signin|reset|invite|token|auth)/.test(u)) return 0;
  if (/(unsubscribe|opt-?out|preferences|privacy|terms)/.test(u)) return 2;
  // ESP open-tracking pixels (Brevo /tr/op/, Mailchimp /o/, generic beacons) are not links
  // you would ever click; a /tr/cl/ click-redirect is, so only the open path sinks.
  if (/\/tr\/op\/|\/o\/open|\/open\.(gif|png)|beacon|pixel/.test(u)) return 3;
  if (/\.(png|gif|jpe?g|webp|css|js)(\?|$)/.test(u)) return 3;
  return 1;
};

const rankedLinks = (sources) => {
  const found = new Map();
  for (const text of sources) {
    for (const raw of String(text ?? "").match(URL_RE) || []) {
      const url = unwrapUrl(raw.replace(/[.,;:]+$/, ""));
      if (!found.has(url)) found.set(url, { url, rank: linkRank(url) });
    }
  }
  return [...found.values()].sort((a, b) => a.rank - b.rank);
};

export const extractLinks = (...sources) => rankedLinks(sources).map((l) => l.url);

/**
 * Links worth offering as "the" link. A mail whose only URLs are an open-tracking pixel
 * and an unsubscribe footer has no action link, and saying so beats handing over a pixel
 * that does nothing when you click it.
 */
export const actionableLinks = (...sources) =>
  rankedLinks(sources).filter((l) => l.rank < 2).map((l) => l.url);

const CODE_WORDS =
  "code|otp|pin|token|passcode|password|verification|verify|confirm|confirmation|security|authenticat\\w*|one[- ]?time|2fa|mfa|" +
  "verificatiecode|bevestigingscode|beveiligingscode|logincode|" + // nl
  "bestätigungscode|sicherheitscode|" + // de
  "code de vérification|code de confirmation"; // fr

const CANDIDATE = "[0-9]{4,8}|[A-Za-z0-9]{6,8}|[A-Za-z0-9]{3,4}-[A-Za-z0-9]{3,4}";

// The candidate pattern has to run case-insensitively to sit next to the context words,
// which means it also matches plain words — "verification" yields "FICATION". A real code
// is either all digits, or upper-case with at least one digit in it.
const isCodeShaped = (raw) =>
  /^[0-9]{4,8}$/.test(raw) ||
  (/^[A-Z0-9]{6,8}$/.test(raw) && /[0-9]/.test(raw)) ||
  (/^[A-Z0-9]{3,4}-[A-Z0-9]{3,4}$/.test(raw) && /[0-9]/.test(raw));

// A bare 4-digit number is usually a year, a price or part of an address.
const isNoise = (code, context) => {
  if (/^(19|20)\d{2}$/.test(code)) return true;                  // year
  if (/^0+$/.test(code)) return true;                            // 0000
  if (new RegExp(`[$\u20ac\u00a3]\\s*${code}|${code}\\s*(eur|usd|gbp)`, "i").test(context)) return true;
  if (new RegExp(`\\+\\d[\\d\\s-]*${code}`).test(context)) return true; // phone number
  return false;
};

/**
 * Find the one-time code in a message.
 *
 * Scored rather than first-match: a mail often contains several number groups, and the
 * one next to the word "code" beats one that merely happens to be six digits long.
 * Returns null instead of guessing when nothing scores high enough — a wrong code
 * costs more than no code.
 */
export const extractCode = (text = "", subject = "") => {
  const body = `${subject}\n${text}`;
  const candidates = [];
  const consider = (raw, score, index) => {
    if (!isCodeShaped(raw)) return;
    const context = body.slice(Math.max(0, index - 40), index + 60);
    if (isNoise(raw, context)) return;
    candidates.push({ code: raw, score: score + (raw.length === 6 ? 2 : 0) });
  };

  const CAND_RE = new RegExp(`(?:${CANDIDATE})`, "g");
  const WORD_RE = new RegExp(`(?:${CODE_WORDS})`, "gi");

  // Look at every candidate inside the window after a context word, not just the first.
  // "one-time password A3F9K2" matches the word "password" as a candidate first; taking
  // only that one and moving on would lose the real code sitting right behind it.
  for (const word of body.matchAll(WORD_RE)) {
    const from = word.index + word[0].length;
    const window = body.slice(from, from + 30).split("\n")[0];
    for (const m of window.matchAll(CAND_RE)) consider(m[0], 10, from + m.index);
  }

  // The code can also come first: "123456 is your Acme login code".
  for (const word of body.matchAll(WORD_RE)) {
    const to = word.index;
    const window = body.slice(Math.max(0, to - 40), to).split("\n").pop();
    const base = to - window.length;
    for (const m of window.matchAll(CAND_RE)) consider(m[0], 9, base + m.index);
  }

  // A code on a line of its own — the "big number in the middle of the email" layout.
  let offset = 0;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (new RegExp(`^(?:${CANDIDATE})$`).test(trimmed)) consider(trimmed, 6, offset);
    offset += line.length + 1;
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].code;
};

// Headers carrying non-ASCII are encoded per RFC 2047 ("=?utf-8?q?Bestelling...?="),
// which is unreadable in a header table. Decode both the Q and B forms.
const decodeHeader = (value = "") =>
  String(value).replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, charset, enc, text) => {
    try {
      if (enc.toLowerCase() === "b") {
        return new TextDecoder(charset).decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)));
      }
      const bytes = [];
      text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})|([\s\S])/g, (_m, hex, chr) => {
        bytes.push(hex ? parseInt(hex, 16) : chr.charCodeAt(0));
        return "";
      });
      return new TextDecoder(charset).decode(Uint8Array.from(bytes));
    } catch {
      return whole;
    }
  });

/** Parse RFC822 headers, handling folded (continuation) lines. */
const parseHeaders = (raw = "") => {
  const head = String(raw).split(/\r?\n\r?\n/)[0] ?? "";
  const headers = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^\s/.test(line) && headers.length) {
      headers[headers.length - 1].value += " " + line.trim();
      continue;
    }
    const at = line.indexOf(":");
    if (at > 0) headers.push({ name: line.slice(0, at).trim(), value: line.slice(at + 1).trim() });
  }
  return headers.map((h) => ({ ...h, value: decodeHeader(h.value) }));
};

const headerValue = (headers, name) =>
  headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;

/**
 * What the receiving server concluded about this mail. This is the fastest way to
 * answer "why did my mail land in spam" without setting up a real mailbox first.
 */
const domainOf = (value = "") => {
  const m = /@([A-Za-z0-9.-]+)/.exec(value);
  return m ? m[1].toLowerCase().replace(/[>\s;,]+$/, "") : null;
};

// DMARC passes when SPF or DKIM passes *and* the domain lines up with the From header.
// Relaxed alignment (the default) accepts an organisational-domain match, so
// mail.brand.com aligns with brand.com but not with esp.net.
const aligned = (a, b) => {
  if (!a || !b) return null;
  if (a === b) return true;
  const org = (d) => d.split(".").slice(-2).join(".");
  return org(a) === org(b);
};

/**
 * What the headers say about whether this mail survives a real inbox.
 *
 * mail.tm's own MTA does not add an Authentication-Results header, so there are usually
 * no SPF/DKIM verdicts to read. Rather than shrugging, derive what is derivable: whether
 * the message carries a DKIM signature at all, and whether its domains line up with the
 * From header — which is exactly the check DMARC performs.
 */
export const deliverability = (raw = "") => {
  const headers = parseHeaders(raw);
  const get = (name) => headerValue(headers, name);

  const auth = headers
    .filter((h) => /^(authentication-results|received-spf|arc-authentication-results)$/i.test(h.name))
    .map((h) => h.value)
    .join(" ");
  const verdict = (mech) => {
    const m = new RegExp(`${mech}=(\\w+)`, "i").exec(auth);
    return m ? m[1].toLowerCase() : null;
  };

  const dkimRaw = get("DKIM-Signature");
  const dkim = dkimRaw
    ? {
        domain: (/\bd=([^;\s]+)/.exec(dkimRaw) || [])[1]?.toLowerCase() ?? null,
        selector: (/\bs=([^;\s]+)/.exec(dkimRaw) || [])[1] ?? null,
        algorithm: (/\ba=([^;\s]+)/.exec(dkimRaw) || [])[1] ?? null,
      }
    : null;

  const fromDomain = domainOf(get("From"));
  const returnPathDomain = domainOf(get("Return-Path"));

  return {
    spf: verdict("spf"),
    dkim: verdict("dkim"),
    dmarc: verdict("dmarc"),
    authResultsPresent: Boolean(auth),

    signature: dkim,
    fromDomain,
    returnPathDomain,
    dkimAligned: aligned(dkim?.domain, fromDomain),
    spfAligned: aligned(returnPathDomain, fromDomain),

    messageId: get("Message-ID") ?? get("Message-Id"),
    listUnsubscribe: get("List-Unsubscribe"),
    oneClickUnsubscribe: /one-click/i.test(get("List-Unsubscribe-Post") ?? ""),
    replyTo: get("Reply-To"),
    returnPath: get("Return-Path"),
    // A marketing mail without a plaintext alternative is the classic reason iCloud
    // and Outlook downrank it, so it is worth surfacing next to the auth results.
    hasPlainText: /content-type:\s*text\/plain/i.test(raw),
    hasHtml: /content-type:\s*text\/html/i.test(raw),
    headers,
  };
};
