// A fixed inbox for screenshots and for looking around before you use the tool for real.
// Enabled with TESTMAIL_DEMO=1; nothing here ever touches the network.
const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();

const ACCOUNTS = [
  { id: "demo-a", address: "signup-k3f9qz1p@uberip.com", label: "Signup flow", createdAt: ago(600) },
  { id: "demo-b", address: "billing-7t2mvx04@uberip.com", label: "Billing", createdAt: ago(320) },
];

const messages = () => [
  {
    account: "demo-a",
    id: "demo-1", from: "no-reply@acme.dev", fromName: "Acme",
    to: ["signup-k3f9qz1p@uberip.com"], subject: "Your Acme verification code",
    date: ago(2), seen: false,
    text: "Hi there,\n\nYour verification code is 482910\n\nIt expires in 10 minutes. If you did not request this, you can ignore this email.\n\nOr sign in directly:\nhttps://app.acme.dev/magic?token=7f3a9c2e1b\n\nAcme Inc.\nUnsubscribe: https://acme.dev/unsubscribe?u=99",
    html: "<div style=\"font-family:system-ui;max-width:480px;margin:0 auto;padding:32px\"><h2>Verify your email</h2><p>Your verification code is</p><p style=\"font-size:32px;letter-spacing:.2em;font-weight:700\">482910</p><p><a href=\"https://app.acme.dev/magic?token=7f3a9c2e1b\">Or sign in directly</a></p></div>",
    links: ["https://app.acme.dev/magic?token=7f3a9c2e1b", "https://acme.dev/unsubscribe?u=99"],
    actionableLinks: ["https://app.acme.dev/magic?token=7f3a9c2e1b"],
    code: "482910", attachments: [],
  },
  {
    account: "demo-b",
    id: "demo-2", from: "billing@example.com", fromName: "Example Billing",
    to: ["billing-7t2mvx04@uberip.com"], subject: "Invoice INV-2041 is ready",
    date: ago(26), seen: false,
    text: "Your invoice is attached.\n\nView it online: https://example.com/invoices/2041",
    html: "", links: ["https://example.com/invoices/2041"],
    actionableLinks: ["https://example.com/invoices/2041"], code: null,
    attachments: [{ id: "a1", filename: "invoice-2041.pdf", contentType: "application/pdf", size: 84213, url: "#" }],
  },
  {
    account: "demo-a",
    id: "demo-3", from: "no-reply@example.com", fromName: "Example",
    to: ["signup-k3f9qz1p@uberip.com"], subject: "Reset your password",
    date: ago(95), seen: true,
    text: "Click to choose a new password:\nhttps://example.com/reset?t=aa91f2\n\nThis link is valid for one hour.",
    html: "", links: ["https://example.com/reset?t=aa91f2"],
    actionableLinks: ["https://example.com/reset?t=aa91f2"], code: null, attachments: [],
  },
  {
    account: "demo-b",
    id: "demo-4", from: "dunning@example.com", fromName: "Example Billing",
    to: ["billing-7t2mvx04@uberip.com"], subject: "Payment failed — card ending 4242",
    date: ago(180), seen: false,
    text: "We could not charge your card.\n\nUpdate it here: https://example.com/billing/card",
    html: "", links: ["https://example.com/billing/card"],
    actionableLinks: ["https://example.com/billing/card"], code: null, attachments: [],
  },
  {
    account: "demo-a",
    id: "demo-5", from: "team@example.com", fromName: "Example Team",
    to: ["signup-k3f9qz1p@uberip.com"], subject: "Welcome aboard",
    date: ago(240), seen: true,
    text: "Thanks for signing up. Here is how to get started.\n\nhttps://example.com/docs/start",
    html: "", links: ["https://example.com/docs/start"],
    actionableLinks: ["https://example.com/docs/start"], code: null, attachments: [],
  },
];

const RAW = [
  "Delivered-To: signup-k3f9qz1p@uberip.com",
  "Return-Path: <bounces@mail.acme.dev>",
  "DKIM-Signature: v=1; a=rsa-sha256; d=acme.dev; s=sel1; b=abc123",
  "From: \"Acme\" <no-reply@acme.dev>",
  "To: <signup-k3f9qz1p@uberip.com>",
  "Subject: Your Acme verification code",
  "List-Unsubscribe: <https://acme.dev/unsubscribe?u=99>",
  "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
  "Message-ID: <demo-1@acme.dev>",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Your verification code is 482910",
].join("\n");

const unread = (id) => messages().filter((m) => m.account === id && !m.seen).length;

export const demo = {
  accounts: () =>
    ACCOUNTS.map((a) => ({ ...a, unread: unread(a.id), total: messages().filter((m) => m.account === a.id).length })),
  current: () => ACCOUNTS[0].id,
  inbox: (accountId) => {
    const all = accountId === "all";
    const acc = ACCOUNTS.find((a) => a.id === accountId) ?? ACCOUNTS[0];
    return {
      address: all ? null : acc.address,
      accountId: all ? "all" : acc.id,
      messages: messages().filter((m) => all || m.account === acc.id),
    };
  },
  message: (id) => messages().find((m) => m.id === id) ?? null,
  source: RAW,
};
