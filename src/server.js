import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  withToken, listMessages, getMessage, getSource, markSeen,
  deleteMessage, deleteAccount, createAccount,
} from "./api.js";
import { extractLinks, actionableLinks, extractCode, deliverability } from "./extract.js";
import { load } from "./store.js";
import { demo } from "./demo.js";

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

const enrich = (m) => {
  const html = (m.html || []).join("\n");
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
    attachments: (m.attachments || []).map((a) => ({
      id: a.id, filename: a.filename, contentType: a.contentType, size: a.size,
      url: `/api/message/${m.id}/attachment/${a.id}`,
    })),
  };
};

export async function serve({ port = 7337, host = "127.0.0.1" } = {}) {
  const DEMO = process.env.TESTMAIL_DEMO === "1";
  // Every open tab gets pushed new mail instead of polling for it. Without this the
  // inbox lags a refresh interval behind, which is exactly the moment you are staring at it.
  const clients = new Set();
  let lastSeenId = null;

  const poll = async () => {
    try {
      await withToken(async (_acc, token) => {
        const msgs = await listMessages(token);
        const newest = msgs[0]?.id ?? null;
        if (newest && newest !== lastSeenId) {
          lastSeenId = newest;
          const payload = `data: ${JSON.stringify({ type: "mail", id: newest })}\n\n`;
          for (const res of clients) res.write(payload);
        }
      });
    } catch { /* transient network trouble must not kill the server */ }
  };
  const timer = DEMO ? null : setInterval(poll, 3000);
  timer?.unref?.();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${host}:${port}`);
    const send = (data, status = 200) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
    };

    try {
      // --- live updates -------------------------------------------------
      if (url.pathname === "/api/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write("retry: 3000\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }

      // --- data ---------------------------------------------------------
      if (url.pathname === "/api/inbox") {
        if (DEMO) return send(demo.inbox());
        return withToken(async (acc, token) => {
          const msgs = await listMessages(token);
          send({ address: acc.address, messages: msgs.map(enrich) });
        });
      }

      const msgMatch = url.pathname.match(/^\/api\/message\/([^/]+)(?:\/(source|attachment\/([^/]+)))?$/);
      if (msgMatch) {
        const [, id, kind, attachmentId] = msgMatch;
        if (DEMO) {
          if (kind === "source") return send({ raw: demo.source, deliverability: deliverability(demo.source) });
          const m = demo.message(id);
          return m ? send(m) : send({ error: "not found" }, 404);
        }
        return withToken(async (_acc, token) => {
          if (req.method === "DELETE") {
            await deleteMessage(id, token);
            return send({ ok: true });
          }
          if (kind === "source") {
            const source = await getSource(id, token);
            const raw = typeof source === "string" ? source : source?.data ?? "";
            return send({ raw, deliverability: deliverability(raw) });
          }
          if (attachmentId) {
            const acc = load();
            const upstream = await fetch(
              `https://api.mail.tm/messages/${encodeURIComponent(id)}/attachment/${encodeURIComponent(attachmentId)}`,
              { headers: { authorization: `Bearer ${acc.token.token}` } }
            );
            res.writeHead(upstream.status, {
              "content-type": upstream.headers.get("content-type") || "application/octet-stream",
              "content-disposition": upstream.headers.get("content-disposition") || "attachment",
            });
            const buf = Buffer.from(await upstream.arrayBuffer());
            return res.end(buf);
          }
          const m = await getMessage(id, token);
          await markSeen(id, token);
          send(enrich(m));
        });
      }

      if (url.pathname === "/api/rotate" && req.method === "POST") {
        await deleteAccount();
        const acc = await createAccount();
        lastSeenId = null;
        return send({ address: acc.address });
      }

      // --- static UI ----------------------------------------------------
      const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const full = path.join(UI_DIR, file);
      if (!full.startsWith(UI_DIR) || !fs.existsSync(full)) {
        res.writeHead(404, { "content-type": "text/plain" });
        return res.end("not found");
      }
      res.writeHead(200, { "content-type": MIME[path.extname(full)] ?? "application/octet-stream" });
      return res.end(fs.readFileSync(full));
    } catch (e) {
      send({ error: e.message }, 500);
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  return server;
}
