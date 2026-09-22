import { extractLinks, actionableLinks, extractCode, htmlToText } from "./extract.js";

// The one place that says what a message looks like. It used to live twice — once in the
// CLI and once in the server — and the two had already drifted: the server added `account`
// and the CLI never got it, so `--json` and the UI disagreed about the same mail.
export const enrichMessage = (m, accountId = null) => {
  const html = (m.html || []).join("\n");
  const text = m.text || "";
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
    code: extractCode(text, m.subject || "") ?? extractCode(htmlToText(html), m.subject || ""),
    attachments: (m.attachments || []).map((a) => ({
      id: a.id, filename: a.filename, contentType: a.contentType, size: a.size,
    })),
  };
};
