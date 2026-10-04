const $ = (id) => document.getElementById(id);
const el = {
  list: $("list"), detail: $("detail"), rail: $("rail"),
  addr: $("address"), addrText: $("address-text"),
  search: $("search"), toast: $("toast"), live: $("live"),
  settings: $("settings"), settingsBody: $("settings-body"),
  offline: $("offline"), demoChip: $("demo-chip"),
  boxTitle: $("box-title"), boxCount: $("box-count"), liveText: $("live-text"),
};

let accounts = [];          // [{ id, address, label, unread, total }]
let serverCurrent = null;   // the mailbox the CLI acts on
let box = "all";            // the mailbox being viewed, or "all"
let messages = [];
let currentId = null;
let address = "";
let filter = "";
let demoMode = false;
// Set by the macOS app before this script runs. It posts its own notifications, natively.
const inApp = Boolean(window.catchboxApp);

/* --- helpers -------------------------------------------------------------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const when = (iso) => {
  const d = new Date(iso);
  const mins = (Date.now() - d) / 60000;
  if (mins < 1) return "just now";
  if (mins < 60) return `${Math.floor(mins)}m ago`;
  if (d.toDateString() === new Date().toDateString())
    return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};

const bytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB`
  : n > 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

const localPart = (a) => String(a ?? "").split("@")[0];
const nameOf = (acc) => acc?.label || localPart(acc?.address) || "mailbox";
const initials = (acc) => nameOf(acc).replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "?";

// A stable colour per sender and per mailbox, the way Gmail colours its labels: the same
// sender always gets the same avatar, so a familiar mail is recognisable at a glance.
const hash = (s) => [...String(s ?? "")].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const HUES = [250, 155, 25, 300, 200, 75, 340, 120];
const senderHue = (m) => HUES[hash((m.fromName || m.from || "").toLowerCase()) % HUES.length];
// Mailboxes take colours in a fixed order, picked to sit far apart on the wheel.
const BOX_HUES = [25, 155, 300, 75, 200, 340, 120, 250];
const boxHue = (acc) => BOX_HUES[Math.max(accounts.indexOf(acc), 0) % BOX_HUES.length];
const senderInitial = (m) =>
  (m.fromName || m.from || "?").replace(/[^\p{L}\p{N}]/gu, "").charAt(0).toUpperCase() || "?";

const host = (u) => { try { return new URL(u).host; } catch { return u; } };
const rest = (u) => { try { const x = new URL(u); return x.pathname + x.search + x.hash; } catch { return ""; } };

// A short preview of the body, as Mail and Gmail show under the subject.
const snippet = (m) => String(m.text ?? "").replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 160);

const icon = {
  tray: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5.5 5h13L21 13v6H3v-6z"/></svg>`,
  stack: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`,
  open: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>`,
  raw: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/></svg>`,
  back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m15 5-7 7 7 7"/></svg>`,
  link: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>`,
  clip: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L14.5 7"/></svg>`,
  file: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4"/></svg>`,
  mail: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18v12H3z"/><path d="m3 6 9 7 9-7"/></svg>`,
};

let toastTimer;
const toast = (msg) => {
  el.toast.textContent = msg;
  el.toast.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("on"), 1800);
};

const copy = async (text, what = "Copied") => {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} to clipboard`);
  } catch {
    // The Clipboard API needs a secure context; localhost qualifies, but be graceful anyway.
    toast("Could not copy — select and copy manually");
  }
};

const api = async (path, opts) => {
  const res = await fetch(path, opts);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
};

// The mailbox is always named explicitly — including "all", which the server treats as a
// merged view. Leaving it off would silently fall back to whatever the CLI made active.
// fetch() rejects with a TypeError when there is nothing listening. That is a different
// problem from a 500, and it deserves a different answer than a toast that fades away.
const isNetworkError = (e) =>
  e instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(e.message ?? "");

let retryTimer = null;

const setOffline = (down) => {
  el.offline.hidden = !down;
  el.live.classList.toggle("off", down);
  el.live.title = down ? "server not reachable" : "live";
  el.liveText.textContent = down ? "Offline" : "Listening for mail";
  if (down) {
    $("offline-origin").textContent = location.host;
    retryTimer ??= setInterval(() => boot(), 3000);
  } else if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
};

const handleError = (e) => {
  if (isNetworkError(e)) setOffline(true);
  else toast(`Error: ${e.message}`);
};

const withBox = (path, accountId) => {
  const id = accountId ?? box;
  return id ? `${path}${path.includes("?") ? "&" : "?"}account=${encodeURIComponent(id)}` : path;
};

/* --- settings ------------------------------------------------------------- */
const DEFAULTS = {
  theme: "auto",
  accent: "blue",
  density: "comfortable",
  autoOpen: true,
  notify: false,
  sound: false,
  defaultTab: "text",
};

const readSettings = () => {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("testmail.settings") || "{}") }; }
  catch { return { ...DEFAULTS }; }
};

let settings = readSettings();

const applySettings = () => {
  const r = document.documentElement;
  r.dataset.theme = settings.theme;
  r.dataset.accent = settings.accent;
  r.dataset.density = settings.density;
  try { localStorage.setItem("testmail.settings", JSON.stringify(settings)); } catch {}
};

const set = (key, value) => {
  settings[key] = value;
  applySettings();
  if (!el.settings.hidden) renderSettings();
};

applySettings();

/* --- notifications -------------------------------------------------------- */
const beep = () => {
  if (!settings.sound) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain).connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.14, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
    osc.start();
    osc.stop(ctx.currentTime + 0.24);
    setTimeout(() => ctx.close(), 400);
  } catch { /* audio is a nicety, never a failure */ }
};

const notify = (m, acc) => {
  if (!settings.notify || window.Notification?.permission !== "granted") return;
  try {
    const n = new Notification(m.subject || "(no subject)", {
      body: `${m.fromName || m.from}${acc ? ` → ${nameOf(acc)}` : ""}${m.code ? `\nCode: ${m.code}` : ""}`,
      tag: m.id,
    });
    n.onclick = () => { window.focus(); select(m.id, m.account); n.close(); };
  } catch {}
};

/* --- mailbox rail --------------------------------------------------------- */
const renderRail = () => {
  const many = accounts.length > 1;
  const rows = accounts.map((a, i) => `
    <button class="mailbox" data-box="${esc(a.id)}" aria-current="${box === a.id}" title="${esc(a.address)}${i < 9 ? ` ( ${i + 1} )` : ""}">
      <span class="mb-icon" style="--hue-color:oklch(var(--l) var(--c) ${boxHue(a)})">${icon.tray}</span>
      <span class="mb-body">
        <span class="mb-name">${esc(nameOf(a))}</span>
        <span class="mb-sub">${esc(a.address)}</span>
      </span>
      ${a.id === serverCurrent && many ? `<span class="cli-pin" title="The mailbox the catchbox command reads">CLI</span>` : ""}
      ${a.unread ? `<span class="badge">${a.unread}</span>` : ""}
    </button>`).join("");

  const total = accounts.reduce((n, a) => n + a.unread, 0);
  const all = many ? `
    <button class="mailbox all" data-box="all" aria-current="${box === "all"}" title="All mailboxes ( g a )">
      <span class="mb-icon" style="--hue-color:var(--muted)">${icon.stack}</span>
      <span class="mb-body"><span class="mb-name">All mailboxes</span></span>
      ${total ? `<span class="badge">${total}</span>` : ""}
    </button>` : "";

  el.rail.innerHTML = `
    ${all}
    ${many ? "<h2>Mailboxes</h2>" : ""}
    ${rows}
    <div class="rail-foot">
      <p class="hint">${demoMode
        ? "Demo mode. These mailboxes are made up and nothing here touches the network."
        : box === "all"
          ? "Viewing every inbox at once. Pick one to make it the mailbox the CLI uses."
          : `<code>catchbox</code> reads <b>${esc(nameOf(accounts.find((a) => a.id === serverCurrent)))}</b>.`}</p>
    </div>`;

  const acc = accounts.find((a) => a.id === box);
  el.boxTitle.textContent = box === "all" ? "All mailboxes" : nameOf(acc);
};

// The highlight and the inbox must always agree. So the switch is only kept if the new
// mailbox actually loads — otherwise it rolls back, instead of leaving the sidebar
// pointing at one mailbox while the list shows another.
const switchBox = async (next) => {
  if (next !== box) {
    const previous = { box, currentId };
    box = next;
    currentId = null;
    renderRail();
    try {
      await refresh();
    } catch (e) {
      box = previous.box;
      currentId = previous.currentId;
      renderRail();
      return handleError(e);
    }
    try { localStorage.setItem("testmail.box", next); } catch {}
    emptyDetail();
  }

  // Switching in the UI also switches the mailbox the CLI reads, so `catchbox code`
  // and the inbox you are looking at can never drift apart.
  if (next !== "all" && next !== serverCurrent) {
    serverCurrent = next;
    renderRail();
    api(`/api/accounts/${encodeURIComponent(next)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ current: true }),
    }).catch(() => {});
  }
};

/* --- inbox list ----------------------------------------------------------- */
const matches = (m) => {
  if (!filter) return true;
  const q = filter.toLowerCase();
  return [m.from, m.fromName, m.subject, m.code, m.text].some((v) => String(v ?? "").toLowerCase().includes(q));
};

const renderCount = () => {
  const unread = messages.filter((m) => !m.seen).length;
  el.boxCount.textContent = !messages.length ? ""
    : unread ? `${unread} unread` : `${messages.length} message${messages.length > 1 ? "s" : ""}`;
};

const renderList = () => {
  renderCount();
  const visible = messages.filter(matches);

  if (!visible.length) {
    el.list.innerHTML = `<li class="list-empty">${messages.length
      ? `Nothing matches “${esc(filter)}”.`
      : "No mail yet. New messages appear here by themselves."}</li>`;
    return;
  }

  el.list.innerHTML = visible.map((m) => {
    const acc = accounts.find((a) => a.id === m.account);
    const chips = [
      m.code ? `<span class="tag code" title="Code — press c to copy">${esc(m.code)}</span>` : "",
      m.links.length ? `<span class="tag">${icon.link}${m.links.length}</span>` : "",
      m.attachments.length ? `<span class="tag">${icon.clip}${m.attachments.length}</span>` : "",
      box === "all" && acc ? `<span class="tag box" style="--h:${boxHue(acc)}">${esc(nameOf(acc))}</span>` : "",
    ].filter(Boolean).join("");
    const preview = snippet(m);

    return `<li role="option" tabindex="0" data-id="${esc(m.id)}" data-account="${esc(m.account ?? "")}"
        aria-selected="${m.id === currentId}" class="${m.seen ? "" : "unread"}">
      <span class="avatar" style="--h:${senderHue(m)}" aria-hidden="true">${esc(senderInitial(m))}</span>
      <div class="row-main">
        <div class="row">
          <span class="who">${esc(m.fromName || m.from || "unknown")}</span>
          <span class="when">${when(m.date)}</span>
        </div>
        <div class="subj">${esc(m.subject || "(no subject)")}</div>
        ${preview ? `<div class="snippet">${esc(preview)}</div>` : ""}
        ${chips ? `<div class="tags">${chips}</div>` : ""}
      </div>
    </li>`;
  }).join("");
};

/* --- detail --------------------------------------------------------------- */
const emptyDetail = () => {
  if (messages.length) {
    el.detail.innerHTML = `<div class="empty"><div class="inner">
      <div class="pulse still">${icon.mail}</div>
      <h2>No message selected</h2>
      <p>Pick one from the list, or drive it from the keyboard.</p>
      <div class="keys">
        <span><kbd>j</kbd><kbd>k</kbd></span><span>move through the list</span>
        <span><kbd>c</kbd></span><span>copy the code of the newest message</span>
        <span><kbd>o</kbd></span><span>open its action link</span>
        <span><kbd>y</kbd></span><span>copy the address</span>
        <span><kbd>/</kbd></span><span>search</span>
      </div>
    </div></div>`;
    return;
  }
  el.detail.innerHTML = `<div class="empty"><div class="inner">
    <div class="pulse">${icon.mail}</div>
    <h2>Waiting for mail</h2>
    <p>Send something to this address. It shows up here by itself — no refreshing.</p>
    ${address ? `<div class="send-to">
        <code>${esc(address)}</code>
        <button class="btn primary small" data-copy="${esc(address)}" data-what="Address copied">${icon.copy}Copy</button>
      </div>
      <span class="cli"><b>catchbox code --wait</b>&nbsp; prints the code the moment it lands</span>`
      : box === "all" ? "" : `<div class="send-to"><code>…</code></div>`}
  </div></div>`;
};

const verdictClass = (v) => (v === "pass" ? "pass" : v === null || v === undefined ? "unknown"
  : v === "fail" ? "fail" : "warn");

const check = (label, state, value) =>
  `<div class="check ${state}"><b>${esc(label)}</b> <span class="verdict">${esc(value)}</span></div>`;

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
    ${notes.map((n) => `<p class="pane-note">${esc(n)}</p>`).join("")}
    <table class="headers">
      ${d.headers.map((h) => `<tr><td>${esc(h.name)}</td><td>${esc(h.value)}</td></tr>`).join("")}
    </table>`;
};

const renderDetail = async (m) => {
  document.body.classList.add("reading");
  const acc = accounts.find((a) => a.id === m.account);

  const link = m.actionableLinks?.[0];
  const code = m.code ? String(m.code) : "";
  const findings = [
    code ? `<div class="finding code">
        <div class="value">
          <span class="label">Verification code</span>
          <button class="otp${code.length > 10 ? " long" : ""}" data-copy="${esc(code)}" data-what="Code copied" title="Click to copy">
            ${code.length > 10 ? `<span>${esc(code)}</span>` : [...code].map((ch) => `<span>${esc(ch)}</span>`).join("")}
          </button>
        </div>
        <span class="actions"><button class="btn primary" data-copy="${esc(code)}" data-what="Code copied">${icon.copy}Copy <kbd>c</kbd></button></span>
      </div>` : "",
    link ? `<div class="finding link">
        <div class="value">
          <span class="label">Action link</span>
          <span class="link-host">${esc(host(link))}</span>
          <a class="link-path" href="${esc(link)}" target="_blank" rel="noopener" title="${esc(link)}">${esc(rest(link) || link)}</a>
        </div>
        <span class="actions">
          <button class="btn" data-copy="${esc(link)}" data-what="Link copied">${icon.copy}Copy</button>
          <button class="btn ${code ? "" : "primary"}" data-open="${esc(link)}">${icon.open}Open <kbd>o</kbd></button>
        </span>
      </div>` : "",
  ].filter(Boolean).join("");

  const others = m.links.filter((u) => u !== link);
  const moreLinks = !others.length ? "" : `<details class="more-links"><summary>${link
      ? `${others.length} more link${others.length > 1 ? "s" : ""}`
      : `${others.length} link${others.length > 1 ? "s" : ""} — tracking and unsubscribe only`}</summary>
      <div class="link-list">${others.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>`).join("")}</div>
    </details>`;

  el.detail.innerHTML = `
    <div class="toolbar">
      <button class="btn ghost back" data-back>${icon.back}Inbox</button>
      <span class="grow"></span>
      <button class="btn ghost small" id="copy-eml" title="Copy the raw .eml source">${icon.raw}Copy raw</button>
      <button class="btn ghost small danger" id="del" title="Delete this message">${icon.trash}Delete</button>
    </div>
    <article class="letter">
      <div class="sender">
        <span class="avatar" style="--h:${senderHue(m)}" aria-hidden="true">${esc(senderInitial(m))}</span>
        <div class="sender-text">
          <div class="sender-name">
            <b>${esc(m.fromName || m.from || "unknown")}</b>
            ${m.fromName && m.from ? `<span class="from">&lt;${esc(m.from)}&gt;</span>` : ""}
          </div>
          <div class="sender-to">
            to <code>${esc(m.to?.[0] ?? acc?.address ?? "")}</code>
            ${acc && accounts.length > 1 ? `<span class="tag box" style="--h:${boxHue(acc)}">${esc(nameOf(acc))}</span>` : ""}
          </div>
        </div>
        <time datetime="${esc(m.date)}">${new Date(m.date).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</time>
      </div>
      <h1>${esc(m.subject || "(no subject)")}</h1>
      ${findings ? `<div class="findings">${findings}</div>` : ""}
      ${moreLinks}
      ${m.attachments.length ? `<div class="attachments">${m.attachments.map((a) => `
          <a class="attachment" href="${esc(a.url)}" download>
            <span class="file-ic">${icon.file}</span>
            <span><b>${esc(a.filename)}</b><span class="size">${bytes(a.size)}</span></span>
          </a>`).join("")}</div>` : ""}
      <div class="view-bar">
        <div class="tabs" id="tabs" role="tablist">
          ${m.html ? `<button data-tab="html">HTML</button>` : ""}
          <button data-tab="text">Text</button>
          <button data-tab="headers">Headers</button>
          <button data-tab="raw">Raw</button>
        </div>
        <span class="view-note" id="view-note"></span>
      </div>
      <div id="pane"></div>
    </article>`;

  const pane = $("pane");
  let source = null; // fetched lazily — the raw body is large and usually not needed
  const loadSource = async () =>
    (source ??= await api(withBox(`/api/message/${encodeURIComponent(m.id)}/source`, m.account)));

  const show = async (tab, { remember = false } = {}) => {
    for (const b of $("tabs").children) b.ariaSelected = String(b.dataset.tab === tab);
    $("view-note").textContent = tab === "html" ? "Sandboxed — scripts never run"
      : tab === "headers" ? "Deliverability and every header" : "";
    if (tab === "html") {
      // No allow-scripts, ever: anyone can mail this address. Popups are allowed so the
      // button in the mail — usually the very thing under test — opens in a tab of its own.
      pane.innerHTML = `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe>`;
      pane.firstChild.srcdoc = `<base target="_blank">${m.html}`;
    } else if (tab === "text") {
      pane.innerHTML = `<pre class="body">${esc(m.text || "(no plain text part)")}</pre>`;
    } else {
      pane.innerHTML = `<p class="pane-note">Loading raw source…</p>`;
      await loadSource();
      pane.innerHTML = tab === "headers"
        ? renderHeaders(source.deliverability)
        : `<pre class="body">${esc(source.raw)}</pre>`;
    }
    if (remember) set("defaultTab", tab);
  };

  $("tabs").onclick = (e) => {
    const b = e.target.closest("[data-tab]");
    if (b) show(b.dataset.tab, { remember: true });
  };

  $("copy-eml").onclick = async () => {
    try {
      await loadSource();
      copy(source.raw, "Raw message copied");
    } catch (e) { handleError(e); }
  };

  $("del").onclick = async () => {
    try {
      await api(withBox(`/api/message/${encodeURIComponent(m.id)}`, m.account), { method: "DELETE" });
    } catch (e) {
      return handleError(e); // the message is still there, so say so instead of "deleted"
    }
    currentId = null;
    document.body.classList.remove("reading");
    await refresh().catch(handleError);
    emptyDetail();
    toast("Message deleted");
  };

  let preferred = settings.defaultTab;
  if (preferred === "html" && !m.html) preferred = "text";
  show(preferred);
};

const select = async (id, accountId) => {
  if (!id) return;
  const previous = currentId;
  currentId = id;
  renderList();
  try {
    const m = await api(withBox(`/api/message/${encodeURIComponent(id)}`, accountId));
    const stale = messages.find((x) => x.id === id);
    if (stale) stale.seen = true;
    renderList();
    await renderDetail(m);
  } catch (e) {
    currentId = previous;
    renderList();
    handleError(e);
  }
};

/* --- settings page -------------------------------------------------------- */
const segment = (key, options) => `
  <div class="segment" data-set="${key}">
    ${options.map(([v, label]) =>
      `<button data-value="${v}" aria-pressed="${settings[key] === v}">${label}</button>`).join("")}
  </div>`;

const toggle = (key) => `
  <label class="switch"><input type="checkbox" data-toggle="${key}" ${settings[key] ? "checked" : ""}><span></span></label>`;

const field = (title, note, control, key = null) => `
  <div class="field${key ? " switchable" : ""}"${key ? ` data-field="${key}"` : ""}>
    <div class="text"><b>${title}</b><span>${note}</span></div>
    <div class="control">${control}</div>
  </div>`;

const ACCENTS = [
  ["blue", "#0071e3"], ["indigo", "#5e5ce6"], ["teal", "#0e8a82"], ["green", "#248a3d"],
  ["amber", "#c25e00"], ["rose", "#e0244d"], ["violet", "#8944ab"], ["slate", "#48484d"],
];

const renderSettings = () => {
  el.settingsBody.innerHTML = `
    <h2 class="card-title">Appearance</h2>
    <div class="card">
      ${field("Theme", "Auto follows your system setting.",
        segment("theme", [["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]]))}
      ${field("Accent", "Used for the active mailbox, codes and primary buttons.", `
        <div class="swatches" data-set="accent">
          ${ACCENTS.map(([v, c]) =>
            `<button class="swatch" data-value="${v}" style="--c:${c}" title="${v}" aria-pressed="${settings.accent === v}" aria-label="${v}"></button>`).join("")}
        </div>`)}
      ${field("Density", "Compact fits about a third more messages on screen.",
        segment("density", [["comfortable", "Comfortable"], ["compact", "Compact"]]))}
    </div>

    <h2 class="card-title">Mailboxes</h2>
    <div class="card">
      <div class="boxes">
        ${accounts.map((a) => `
          <div class="box-row" data-id="${esc(a.id)}">
            <span class="mb-icon" style="--hue-color:oklch(var(--l) var(--c) ${boxHue(a)})">${icon.tray}</span>
            <div class="info">
              <input class="label-input" value="${esc(a.label ?? "")}" placeholder="${esc(localPart(a.address))}"
                     aria-label="Name for ${esc(a.address)}">
              <div class="addr">${esc(a.address)}${a.total ? ` · ${a.total} message${a.total > 1 ? "s" : ""}` : ""}</div>
            </div>
            <div class="acts">
              <button class="btn small" data-copy-addr="${esc(a.address)}">Copy</button>
              ${a.id === serverCurrent
                ? `<button class="btn small activate" disabled>CLI uses this</button>`
                : `<button class="btn small activate" data-activate="${esc(a.id)}">Use in CLI</button>`}
              <button class="btn small danger" data-delete="${esc(a.id)}">Delete</button>
            </div>
          </div>`).join("")}
      </div>
      <div class="new-box">
        <input id="new-label" placeholder="Name, e.g. “Signup flow”" aria-label="Name for the new mailbox">
        <button class="btn primary" id="create-box">Create mailbox</button>
      </div>
    </div>

    <h2 class="card-title">When mail arrives</h2>
    <div class="card">
      ${field("Open it automatically", "Only when you are not already reading something else.", toggle("autoOpen"), "autoOpen")}
      ${inApp ? "" : field("Desktop notification", "Shows the sender, the subject and the code.", toggle("notify"), "notify")}
      ${field("Play a sound", "A short beep, so you can look away while you wait.", toggle("sound"), "sound")}
      ${field("Open messages on", "Which tab a message opens on.",
        segment("defaultTab", [["text", "Text"], ["html", "HTML"], ["headers", "Headers"]]))}
    </div>

    <h2 class="card-title">Keyboard</h2>
    <div class="card">
      <div class="shortcuts">
        <div><kbd>j</kbd> <kbd>k</kbd> move through the list</div>
        <div><kbd>c</kbd> copy the code of the open or newest message</div>
        <div><kbd>o</kbd> open the action link</div>
        <div><kbd>y</kbd> copy the active address</div>
        <div><kbd>/</kbd> filter</div>
        <div><kbd>1</kbd>…<kbd>9</kbd> switch mailbox</div>
        <div><kbd>g</kbd> then <kbd>a</kbd> all mailboxes</div>
        <div><kbd>,</kbd> or <kbd>?</kbd> settings</div>
        <div><kbd>Esc</kbd> back</div>
      </div>
    </div>

    <h2 class="card-title">About</h2>
    <div class="card">
      <div class="about">
        Mailboxes live at <code>~/.config/testmail/accounts.json</code>. The active one is also
        written to the file <code>mailsy</code> reads, so both tools stay on the same inbox.
        The command is <code>catchbox</code>, and <code>testmail</code> still works.<br>
        These addresses are public — anyone who guesses one can read it. Fine for testing,
        not for anything you mind other people seeing.<br>
        <a href="https://github.com/brentc22/catchbox" target="_blank" rel="noopener">github.com/brentc22/catchbox</a>
      </div>
    </div>`;
};

const openSettings = () => { el.settings.hidden = false; renderSettings(); };
const closeSettings = () => { el.settings.hidden = true; };

el.settings.onclick = async (e) => {
  if (e.target === el.settings) return closeSettings(); // a click on the dimmed backdrop
  const seg = e.target.closest("[data-set] [data-value]");
  if (seg) return set(seg.closest("[data-set]").dataset.set, seg.dataset.value);

  const copyAddr = e.target.closest("[data-copy-addr]");
  if (copyAddr) return copy(copyAddr.dataset.copyAddr, "Address copied");

  const activate = e.target.closest("[data-activate]");
  if (activate) {
    await switchBox(activate.dataset.activate);
    return renderSettings();
  }

  const del = e.target.closest("[data-delete]");
  if (del) {
    if (demoMode) return toast("Demo mode — nothing is deleted here");
    const acc = accounts.find((a) => a.id === del.dataset.delete);
    if (!confirm(`Delete ${acc?.address}?\nThe mailbox and everything in it is gone for good.`)) return;
    try {
      await api(`/api/accounts/${encodeURIComponent(del.dataset.delete)}`, { method: "DELETE" });
    } catch (e) {
      return handleError(e);
    }
    if (box === del.dataset.delete) box = "all";
    await loadAccounts();
    await refresh().catch(handleError);
    renderSettings();
    return toast("Mailbox deleted");
  }

  if (e.target.id === "create-box") return createBox($("new-label").value);

  const row = e.target.closest(".field.switchable");
  if (row && !e.target.closest("input")) {
    const input = row.querySelector("[data-toggle]");
    input.checked = !input.checked;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
};

el.settings.addEventListener("change", async (e) => {
  const t = e.target.closest("[data-toggle]");
  if (!t) return;
  const key = t.dataset.toggle;
  if (key === "notify" && t.checked && !window.Notification) {
    t.checked = false;
    return toast("This browser has no desktop notifications");
  }
  if (key === "notify" && t.checked && Notification.permission !== "granted") {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { t.checked = false; return toast("Notifications were blocked by the browser"); }
  }
  set(key, t.checked);
});

el.settings.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.id === "new-label") createBox(e.target.value);
});

el.settings.addEventListener("change", async (e) => {
  const input = e.target.closest(".label-input");
  if (!input) return;
  const id = input.closest(".box-row").dataset.id;
  try {
    await api(`/api/accounts/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: input.value }),
    });
    await loadAccounts();
  } catch (e) {
    return handleError(e);
  }
  renderRail();
  toast("Mailbox renamed");
});

const createBox = async (label) => {
  if (demoMode) return toast("Demo mode — mailboxes are not created here");
  toast("Creating a mailbox…");
  let acc;
  try {
    acc = await api("/api/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: label?.trim() || null }),
    });
  } catch (e) {
    return handleError(e);
  }
  await loadAccounts();
  await switchBox(acc.id);
  if (!el.settings.hidden) renderSettings();
  copy(acc.address, "New address copied");
};

/* --- data ----------------------------------------------------------------- */
const loadAccounts = async () => {
  const data = await api("/api/accounts");
  accounts = data.accounts;
  serverCurrent = data.current;
  demoMode = Boolean(data.demo);
  el.demoChip.hidden = !demoMode;

  let stored = null;
  try { stored = localStorage.getItem("testmail.box"); } catch {}
  const known = (id) => id === "all" || accounts.some((a) => a.id === id);
  if (!known(box)) box = known(stored) ? stored : serverCurrent ?? accounts[0]?.id ?? "all";
  if (box === "all" && accounts.length < 2) box = accounts[0]?.id ?? "all";

  renderRail();
};

const refresh = async () => {
  const data = await api(withBox("/api/inbox"));
  address = data.address ?? "";
  el.addrText.textContent = address || `${accounts.length} inboxes, newest first`;
  el.addr.disabled = !address;
  messages = data.messages;
  renderList();
  if (!currentId) emptyDetail();
};

// One place that loads everything and knows what to do when it cannot. Also the retry:
// once the server is back, the page picks up where it was without a reload.
const boot = async () => {
  try {
    await loadAccounts();
    await refresh();
    setOffline(false);
    return true;
  } catch (e) {
    handleError(e);
    return false;
  }
};

/* --- live updates --------------------------------------------------------- */
const connect = () => {
  const es = new EventSource("/api/events");
  es.onopen = () => { setOffline(false); boot(); };
  es.onerror = () => {
    el.live.classList.add("off");
    el.live.title = "reconnecting…";
    el.liveText.textContent = "Reconnecting…";
  };
  es.onmessage = async (ev) => {
    const { type, account } = JSON.parse(ev.data);
    if (type === "accounts" || type === "counts") return loadAccounts();

    await loadAccounts(); // unread badges first, so a mailbox you are not viewing still lights up
    if (box !== "all" && account !== box) {
      const acc = accounts.find((a) => a.id === account);
      beep();
      return toast(`New mail in ${nameOf(acc)}`);
    }

    const before = messages.length;
    await refresh().catch(handleError);
    if (messages.length <= before) return;
    const newest = messages[0];
    toast(`New mail: ${newest.subject || "(no subject)"}`);
    beep();
    notify(newest, accounts.find((a) => a.id === newest.account));
    // Nothing selected yet? Open it — that is almost always what you were waiting for.
    if (settings.autoOpen && !currentId) select(newest.id, newest.account);
  };
};

/* --- interaction ---------------------------------------------------------- */
el.detail.onclick = (e) => {
  const c = e.target.closest("[data-copy]");
  if (c) {
    copy(c.dataset.copy, c.dataset.what || "Copied");
    const otp = el.detail.querySelector(".otp");
    if (otp && c.dataset.what === "Code copied") {
      otp.classList.add("flash");
      setTimeout(() => otp.classList.remove("flash"), 700);
    }
    return;
  }
  const o = e.target.closest("[data-open]");
  if (o) return window.open(o.dataset.open, "_blank", "noopener");
  if (e.target.closest("[data-back]")) document.body.classList.remove("reading");
};

el.list.onclick = (e) => {
  const li = e.target.closest("li[data-id]");
  if (li) select(li.dataset.id, li.dataset.account || undefined);
};

// Tab reaches the rows; Enter opens one, like a click. j/k remain the fast path.
el.list.onkeydown = (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const li = e.target.closest("li[data-id]");
  if (!li) return;
  e.preventDefault();
  select(li.dataset.id, li.dataset.account || undefined);
};

el.rail.onclick = (e) => {
  const mb = e.target.closest("[data-box]");
  if (mb) return switchBox(mb.dataset.box);
};
$("add-box").onclick = () => createBox(null);

el.addr.onclick = () => address && copy(address, "Address copied");
$("settings-open").onclick = openSettings;
$("settings-close").onclick = closeSettings;

$("theme").onclick = () => {
  const order = ["auto", "light", "dark"];
  const next = order[(order.indexOf(settings.theme) + 1) % order.length];
  set("theme", next);
  toast(`Theme: ${next}`);
};

el.search.oninput = () => { filter = el.search.value.trim(); renderList(); };

let pendingG = false;

// In the merged view there is no single address, so the shortcuts fall back to the
// mailbox the CLI is on — the one `catchbox code` would read.
const activeAccount = () => accounts.find((a) => a.id === (box === "all" ? serverCurrent : box));
const activeAddress = () => address || activeAccount()?.address || "";

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  // Typing always wins over shortcuts.
  if (e.target.matches("input, textarea, select") || e.target.isContentEditable) {
    if (e.key === "Escape") {
      e.target.blur();
      if (e.target === el.search) { el.search.value = ""; filter = ""; renderList(); }
    }
    return;
  }

  if (!el.settings.hidden) {
    if (e.key === "Escape" || e.key === "," || e.key === "?") { e.preventDefault(); closeSettings(); }
    return;
  }

  if (pendingG) {
    pendingG = false;
    if (e.key === "a") {
      e.preventDefault();
      return accounts.length > 1 ? switchBox("all") : toast("There is only one mailbox");
    }
  }

  if (/^[1-9]$/.test(e.key)) {
    e.preventDefault();
    const acc = accounts[Number(e.key) - 1];
    return acc ? switchBox(acc.id) : toast(`There is no mailbox ${e.key}`);
  }

  const visible = messages.filter(matches);
  const at = visible.findIndex((m) => m.id === currentId);
  // The open message, even when the filter has since hidden it. Nothing open yet falls
  // back to the newest, so `c` and `o` work the moment mail lands.
  const current = messages.find((m) => m.id === currentId) ?? visible[0];

  const step = (delta) => {
    if (!visible.length) return;
    const next = at === -1 ? visible[0] : visible[Math.min(Math.max(at + delta, 0), visible.length - 1)];
    select(next.id, next.account);
  };

  switch (e.key) {
    case "g": pendingG = true; break;

    case "j": case "ArrowDown": e.preventDefault(); step(1); break;
    case "k": case "ArrowUp": e.preventDefault(); step(-1); break;

    case "c":
      if (!current) toast("This inbox is empty");
      else if (current.code) copy(current.code, "Code copied");
      else toast("No code in this message");
      break;

    case "o":
      if (!current) toast("This inbox is empty");
      else if (current.actionableLinks?.[0]) window.open(current.actionableLinks[0], "_blank", "noopener");
      else toast("No action link in this message");
      break;

    case "y": {
      const a = activeAddress();
      a ? copy(a, "Address copied") : toast("No mailbox yet");
      break;
    }

    case "/": e.preventDefault(); el.search.focus(); break;
    case ",": case "?": e.preventDefault(); openSettings(); break;
    case "Escape": document.body.classList.remove("reading"); break;
  }
});

// The app asks for a message this way when one of its notifications is clicked.
window.addEventListener("catchbox:open", async (e) => {
  const { id, account } = e.detail ?? {};
  if (!id) return;
  if (box !== "all" && account && account !== box) await switchBox(account);
  select(id, account || undefined);
});

boot().then(connect);
setInterval(renderList, 60000); // keep the relative timestamps honest
