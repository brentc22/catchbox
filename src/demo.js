// A fixed inbox for screenshots and for looking around before you use the tool for real.
// Enabled with TESTMAIL_DEMO=1; nothing here ever touches the network.
const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();

const messages = () => [
  {
    id: "demo-1", from: "no-reply@acme.dev", fromName: "Acme",
    to: ["test-k3f9qz1p@uberip.com"], subject: "Your Acme verification code",
    date: ago(2), seen: false,
    text: "Hi there,\n\nYour verification code is 482910\n\nIt expires in 10 minutes. If you did not request this, you can ignore this email.\n\nOr sign in directly:\nhttps://app.acme.dev/magic?token=7f3a9c2e1b\n\nAcme Inc.\nUnsubscribe: https://acme.dev/unsubscribe?u=99",
    html: "<div style=\"font-family:system-ui;max-width:480px;margin:0 auto;padding:32px\"><h2>Verify your email</h2><p>Your verification code is</p><p style=\"font-size:32px;letter-spacing:.2em;font-weight:700\">482910</p><p><a href=\"https://app.acme.dev/magic?token=7f3a9c2e1b\">Or sign in directly</a></p></div>",
    links: ["https://app.acme.dev/magic?token=7f3a9c2e1b", "https://acme.dev/unsubscribe?u=99"],
    actionableLinks: ["https://app.acme.dev/magic?token=7f3a9c2e1b"],
    code: "482910", attachments: [],
  },
  {
    id: "demo-2", from: "billing@example.com", fromName: "Example Billing",
    to: ["test-k3f9qz1p@uberip.com"], subject: "Invoice INV-2041 is ready",
    date: ago(26), seen: false,
    text: "Your invoice is attached.\n\nView it online: https://example.com/invoices/2041",
    html: "", links: ["https://example.com/invoices/2041"],
    actionableLinks: ["https://example.com/invoices/2041"], code: null,
    attachments: [{ id: "a1", filename: "invoice-2041.pdf", contentType: "application/pdf", size: 84213, url: "#" }],
  },
  {
    id: "demo-3", from: "no-reply@example.com", fromName: "Example",
    to: ["test-k3f9qz1p@uberip.com"], subject: "Reset your password",
    date: ago(95), seen: true,
    text: "Click to choose a new password:\nhttps://example.com/reset?t=aa91f2\n\nThis link is valid for one hour.",
    html: "", links: ["https://example.com/reset?t=aa91f2"],
    actionableLinks: ["https://example.com/reset?t=aa91f2"], code: null, attachments: [],
  },
  {
    id: "demo-4", from: "team@example.com", fromName: "Example Team",
    to: ["test-k3f9qz1p@uberip.com"], subject: "Welcome aboard",
    date: ago(240), seen: true,
    text: "Thanks for signing up. Here is how to get started.\n\nhttps://example.com/docs/start",
    html: "", links: ["https://example.com/docs/start"],
    actionableLinks: ["https://example.com/docs/start"], code: null, attachments: [],
  },
];

const RAW = [
  "Delivered-To: test-k3f9qz1p@uberip.com",
  "Return-Path: <bounces@mail.acme.dev>",
  "DKIM-Signature: v=1; a=rsa-sha256; d=acme.dev; s=sel1; b=abc123",
  "From: \"Acme\" <no-reply@acme.dev>",
  "To: <test-k3f9qz1p@uberip.com>",
  "Subject: Your Acme verification code",
  "List-Unsubscribe: <https://acme.dev/unsubscribe?u=99>",
  "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
  "Message-ID: <demo-1@acme.dev>",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Your verification code is 482910",
].join("\n");

export const demo = {
  address: "test-k3f9qz1p@uberip.com",
  inbox: () => ({ address: demo.address, messages: messages() }),
  message: (id) => messages().find((m) => m.id === id) ?? null,
  source: RAW,
};
