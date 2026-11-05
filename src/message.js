import { extractLinks, actionableLinks, extractCode, htmlToText } from "./extract.js";

// The one place that says what a message looks like. It used to live twice — once in the
// CLI and once in the server — and the two had already drifted: the server added `account`
// and the CLI never got it, so `--json` and the UI disagreed about the same mail.
export const enrichMessage = (m, accountId = null) => {
  const html = (m.html || []).join("\n");
  const text = m.text || "";
  // mail.tm's list has no body or attachments, only `intro` and `hasAttachments`; the code a
  // list row shows has to come from those. A preview is cut off, and can cut a code in half,
  // so it is only ever used when there is no body at all.
  const preview = text || html ? "" : m.intro || "";
  return {
    id: m.id,
    account: accountId,
    from: m.from?.address ?? null,
    fromName: m.from?.name || null,
    to: (m.to || []).map((t) => t.address),
    subject: m.subject || "",
    date: m.createdAt,
    seen: m.seen,
    text,
    html,
    links: extractLinks(text, html),
    actionableLinks: actionableLinks(text, html),
    code: extractCode(text || preview, m.subject || "") ?? extractCode(htmlToText(html), m.subject || ""),
    hasAttachments: Boolean(m.hasAttachments || m.attachments?.length),
    attachments: (m.attachments || []).map((a) => ({
      id: a.id, filename: a.filename, contentType: a.contentType, size: a.size,
    })),
  };
};
