const $ = (id) => document.getElementById(id);
const el = { list: $("list"), detail: $("detail"), addr: $("address"), addrText: $("address-text"),
             search: $("search"), toast: $("toast"), live: $("live"), app: $("app") };

let messages = [];
let currentId = null;
let address = "";
let filter = "";

/* --- helpers -------------------------------------------------------------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const when = (iso) => {
  const d = new Date(iso);
  const mins = (Date.now() - d) / 60000;
  if (mins < 1) return "just now";
  if (mins < 60) return `${Math.floor(mins)}m ago`;
  if (d.toDateString() === new Date().toDateString())
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

const bytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB`
  : n > 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

let toastTimer;
const toast = (msg) => {
  el.toast.textContent = msg;
  el.toast.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("on"), 1600);
};

const copy = async (text, what = "Copied") => {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} to clipboard`);
  } catch {
    // Clipboard API needs a secure context; localhost qualifies, but be graceful anyway.
    toast("Could not copy — select and copy manually");
  }
};

const api = async (path, opts) => {
  const res = await fetch(path, opts);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
};

/* --- theme ---------------------------------------------------------------- */
const THEMES = ["auto", "light", "dark"];
const readTheme = () => { try { return localStorage.getItem("testmail.theme") || "auto"; } catch { return "auto"; } };
const applyTheme = (t) => {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("testmail.theme", t); } catch {}
};
applyTheme(readTheme());
$("theme").onclick = () => {
  const next = THEMES[(THEMES.indexOf(readTheme()) + 1) % THEMES.length];
  applyTheme(next);
  toast(`Theme: ${next}`);
};

/* --- inbox list ----------------------------------------------------------- */
const matches = (m) => {
  if (!filter) return true;
  const q = filter.toLowerCase();
  return [m.from, m.fromName, m.subject, m.code, m.text].some((v) => String(v ?? "").toLowerCase().includes(q));
};

const renderList = () => {
  const visible = messages.filter(matches);

  if (!visible.length) {
    el.list.innerHTML = `<li class="empty" style="height:auto;padding:28px 18px">
      <div class="inner">
        <p>${messages.length ? "Nothing matches that filter." : "Inbox is empty."}</p>
      </div></li>`;
    return;
  }

  el.list.innerHTML = visible.map((m) => `
    <li role="option" data-id="${esc(m.id)}" aria-selected="${m.id === currentId}" class="${m.seen ? "" : "unread"}">
      <div class="row">
        <span class="who">${esc(m.fromName || m.from || "unknown")}</span>
        <span class="when">${when(m.date)}</span>
      </div>
      <div class="subj">${esc(m.subject || "(no subject)")}</div>
      ${m.code || m.links.length || m.attachments.length ? `<div class="tags">
        ${m.code ? `<span class="tag code">${esc(m.code)}</span>` : ""}
        ${m.links.length ? `<span class="tag">${m.links.length} link${m.links.length > 1 ? "s" : ""}</span>` : ""}
        ${m.attachments.length ? `<span class="tag">${m.attachments.length} file${m.attachments.length > 1 ? "s" : ""}</span>` : ""}
      </div>` : ""}
    </li>`).join("");
};

/* --- detail --------------------------------------------------------------- */
const emptyDetail = () => {
  el.detail.innerHTML = `<div class="empty"><div class="inner">
    <h2>${messages.length ? "Pick a message" : "Waiting for mail"}</h2>
    <p>${messages.length
      ? "Use <kbd>j</kbd> and <kbd>k</kbd> to move, <kbd>c</kbd> to copy the code, <kbd>o</kbd> to open the link."
      : "Send something to the address above. It shows up here by itself — no refreshing."}</p>
    ${messages.length ? "" : `<code>${esc(address)}</code>`}
  </div></div>`;
};

const verdictClass = (v) => (v === "pass" ? "pass" : v === null || v === undefined ? "unknown"
  : v === "fail" ? "fail" : "warn");

const check = (label, state, value, note) => `
  <div class="check ${state}">
    <b>${label}</b> <span class="verdict">${esc(value)}</span>
  </div>${note ? `<!-- ${esc(note)} -->` : ""}`;

const renderHeaders = (d) => {
  const yn = (v) => (v === true ? "aligned" : v === false ? "not aligned" : "unknown");
  const state = (v) => (v === true ? "pass" : v === false ? "fail" : "unknown");

  // When the receiving server did verify, report its verdict. mail.tm does not, so fall
  // back to the alignment checks DMARC itself performs — derivable from the headers alone.
  const auth = d.authResultsPresent
    ? ["spf", "dkim", "dmarc"].map((k) =>
        check(k.toUpperCase(), verdictClass(d[k]), d[k] ?? "not stated")).join("")
    : [
        check("DKIM signature", d.signature ? "pass" : "fail",
              d.signature ? `${d.signature.domain} · ${d.signature.selector}` : "missing"),
        check("DKIM alignment", state(d.dkimAligned), yn(d.dkimAligned)),
        check("SPF alignment", d.spfAligned === false ? "warn" : state(d.spfAligned), yn(d.spfAligned)),
      ].join("");

  const notes = [];
  if (!d.authResultsPresent)
    notes.push("This inbox does not verify on receipt, so there is no SPF/DKIM verdict to read. What is shown instead is domain alignment — the check DMARC performs.");
  if (!d.signature)
    notes.push("Unsigned mail fails DMARC at any receiver that enforces it.");
  if (d.dkimAligned === false)
    notes.push(`Signed by ${d.signature?.domain}, sent as ${d.fromDomain}. DMARC needs one of the two to line up with the From domain.`);
  if (d.spfAligned === false && d.dkimAligned)
    notes.push(`Bounces go to ${d.returnPathDomain}, which is normal when an ESP sends for you — DKIM carries DMARC in that setup.`);
  if (!d.hasPlainText)
    notes.push("HTML-only mail is downranked by iCloud and Outlook. Send a plain-text alternative alongside it.");

  return `
    <div class="checks">
      ${auth}
      ${check("Plain text part", d.hasPlainText ? "pass" : "warn", d.hasPlainText ? "yes" : "missing")}
      ${check("List-Unsubscribe", d.listUnsubscribe ? "pass" : "unknown",
              d.listUnsubscribe ? (d.oneClickUnsubscribe ? "one-click" : "present") : "none")}
    </div>
    ${notes.map((n) => `<p class="meta" style="margin:-6px 0 12px">${esc(n)}</p>`).join("")}
    <table class="headers">
      ${d.headers.map((h) => `<tr><td>${esc(h.name)}</td><td>${esc(h.value)}</td></tr>`).join("")}
    </table>`;
};

const renderDetail = async (m) => {
  el.app.classList.add("reading");

  const findings = [
    m.code ? `<div class="finding code">
        <span class="label">Code</span>
        <span class="value">${esc(m.code)}</span>
        <span class="actions"><button class="btn" data-copy="${esc(m.code)}">Copy</button></span>
      </div>` : "",
    m.actionableLinks?.[0] ? `<div class="finding link">
        <span class="label">Link</span>
        <span class="value"><a href="${esc(m.actionableLinks[0])}" target="_blank" rel="noopener">${esc(m.actionableLinks[0])}</a></span>
        <span class="actions">
          <button class="btn" data-copy="${esc(m.actionableLinks[0])}">Copy</button>
          <button class="btn primary" data-open="${esc(m.actionableLinks[0])}">Open</button>
        </span>
      </div>` : "",
  ].filter(Boolean).join("");

  el.detail.innerHTML = `
    <div class="meta">
      <span>${esc(m.fromName ? `${m.fromName} <${m.from}>` : m.from || "unknown")}</span>
      <span>·</span><span>${new Date(m.date).toLocaleString()}</span>
      <span class="spacer" style="flex:1"></span>
      <button class="btn danger" id="del">Delete</button>
    </div>
    <h1>${esc(m.subject || "(no subject)")}</h1>
    ${findings ? `<div class="findings">${findings}</div>` : ""}
    ${(() => {
      const primary = m.actionableLinks?.[0];
      const rest = m.links.filter((u) => u !== primary);
      if (!rest.length) return "";
      const label = primary ? `${rest.length} more link${rest.length > 1 ? "s" : ""}`
        : `${rest.length} link${rest.length > 1 ? "s" : ""} — tracking and unsubscribe only`;
      return `<details class="more-links"><summary>${label}</summary>
        ${rest.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>`).join("")}
      </details>`;
    })()}
    ${m.attachments.length ? `<div class="attachments">${m.attachments.map((a) => `
        <a class="attachment" href="${esc(a.url)}" download>
          <span>${esc(a.filename)}</span><span class="size">${bytes(a.size)}</span>
        </a>`).join("")}</div>` : ""}
    <div class="tabs" id="tabs">
      ${m.html ? `<button data-tab="html">HTML</button>` : ""}
      <button data-tab="text">Text</button>
      <button data-tab="headers">Headers</button>
      <button data-tab="raw">Raw</button>
    </div>
    <div id="pane"></div>`;

  const pane = $("pane");
  let source = null; // fetched lazily — the raw body is large and usually not needed

  const show = async (tab) => {
    for (const b of $("tabs").children) b.ariaSelected = String(b.dataset.tab === tab);
    if (tab === "html") {
      pane.innerHTML = `<iframe sandbox referrerpolicy="no-referrer"></iframe>`;
      pane.firstChild.srcdoc = m.html;
    } else if (tab === "text") {
      pane.innerHTML = `<pre class="body">${esc(m.text || "(no plain text part)")}</pre>`;
    } else {
      pane.innerHTML = `<p class="meta">Loading raw source…</p>`;
      source ??= await api(`/api/message/${encodeURIComponent(m.id)}/source`);
      pane.innerHTML = tab === "headers"
        ? renderHeaders(source.deliverability)
        : `<pre class="body">${esc(source.raw)}</pre>`;
    }
    try { localStorage.setItem("testmail.tab", tab); } catch {}
  };

  $("tabs").onclick = (e) => { const b = e.target.closest("[data-tab]"); if (b) show(b.dataset.tab); };
  $("del").onclick = async () => {
    await fetch(`/api/message/${encodeURIComponent(m.id)}`, { method: "DELETE" });
    currentId = null;
    await refresh();
    emptyDetail();
    toast("Message deleted");
  };
  el.detail.onclick = (e) => {
    const c = e.target.closest("[data-copy]");
    if (c) return copy(c.dataset.copy, c.dataset.copy.length > 40 ? "Link copied" : "Code copied");
    const o = e.target.closest("[data-open]");
    if (o) window.open(o.dataset.open, "_blank", "noopener");
  };

  let preferred = "text";
  try { preferred = localStorage.getItem("testmail.tab") || "text"; } catch {}
  if (preferred === "html" && !m.html) preferred = "text";
  show(preferred);
};

const select = async (id) => {
  if (!id) return;
  currentId = id;
  renderList();
  const m = await api(`/api/message/${encodeURIComponent(id)}`);
  const stale = messages.find((x) => x.id === id);
  if (stale) stale.seen = true;
  renderList();
  await renderDetail(m);
};

/* --- data ----------------------------------------------------------------- */
const refresh = async () => {
  try {
    const data = await api("/api/inbox");
    address = data.address;
    el.addrText.textContent = address;
    messages = data.messages;
    renderList();
    if (!currentId) emptyDetail();
  } catch (e) {
    toast(`Error: ${e.message}`);
  }
};

/* --- live updates --------------------------------------------------------- */
const connect = () => {
  const es = new EventSource("/api/events");
  es.onopen = () => { el.live.classList.remove("off"); el.live.title = "live"; };
  es.onerror = () => { el.live.classList.add("off"); el.live.title = "reconnecting…"; };
  es.onmessage = async (ev) => {
    const { type } = JSON.parse(ev.data);
    if (type !== "mail") return;
    const before = messages.length;
    await refresh();
    if (messages.length > before) {
      const newest = messages[0];
      toast(`New mail: ${newest.subject || "(no subject)"}`);
      // Nothing selected yet? Open it — that is almost always what you were waiting for.
      if (!currentId) select(newest.id);
    }
  };
};

/* --- interaction ---------------------------------------------------------- */
el.list.onclick = (e) => {
  const li = e.target.closest("li[data-id]");
  if (li) select(li.dataset.id);
};

el.addr.onclick = () => copy(address, "Address copied");

$("rotate").onclick = async () => {
  if (!confirm("Throw this address away and get a new one?\nThe current inbox is deleted.")) return;
  const { address: next } = await api("/api/rotate", { method: "POST" });
  address = next; currentId = null;
  toast("New address");
  await refresh();
  emptyDetail();
};

$("back").onclick = () => { el.app.classList.remove("reading"); };

el.search.oninput = () => { filter = el.search.value.trim(); renderList(); };

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea")) {
    if (e.key === "Escape") { el.search.value = ""; filter = ""; renderList(); el.search.blur(); }
    return;
  }
  const visible = messages.filter(matches);
  const at = visible.findIndex((m) => m.id === currentId);
  const current = visible[at];

  switch (e.key) {
    case "j": case "ArrowDown":
      e.preventDefault(); select(visible[Math.min(at + 1, visible.length - 1)]?.id ?? visible[0]?.id); break;
    case "k": case "ArrowUp":
      e.preventDefault(); select(visible[Math.max(at - 1, 0)]?.id ?? visible[0]?.id); break;
    case "c":
      if (current?.code) copy(current.code, "Code copied"); else toast("No code in this message");
      break;
    case "o":
      if (current?.actionableLinks?.[0]) window.open(current.actionableLinks[0], "_blank", "noopener");
      else toast("No action link in this message");
      break;
    case "y": copy(address, "Address copied"); break;
    case "/": e.preventDefault(); el.search.focus(); break;
    case "Escape": el.app.classList.remove("reading"); break;
  }
});

refresh().then(connect);
setInterval(renderList, 60000); // keep the relative timestamps honest
