const $ = (id) => document.getElementById(id);
const el = {
  list: $("list"), detail: $("detail"), menu: $("menu"),
  addr: $("address"), addrText: $("address-text"),
  search: $("search"), toast: $("toast"), live: $("live"),
  settings: $("settings"), settingsBody: $("settings-body"),
  offline: $("offline"), demoChip: $("demo-chip"),
  boxSwitch: $("box-switch"), boxTitle: $("box-title"), boxCount: $("box-count"), more: $("more"),
  bulk: $("bulk"), pickAll: $("pick-all"), bulkLabel: $("bulk-label"), bulkActions: $("bulk-actions"),
  liveText: $("live-text"),
};

let accounts = [];          // [{ id, address, label, unread, total }]
let serverCurrent = null;   // the mailbox the CLI acts on
let box = "all";            // the mailbox being viewed, or "all"
let messages = [];
let currentId = null;
// The message on screen, whole. `messages` only holds what mail.tm's list returns: no body,
// no links, and a code only when the subject or the preview happens to show it.
let openMessage = null;
let address = "";
let filter = "";
let demoMode = false;
// Ticked in the list, as in Gmail. Separate from the open message, which stays on screen
// while rows are ticked; a click only opens a mail again once nothing is ticked.
const picked = new Set();
// The mailbox where "Select" was chosen: rows tick on click, even with none ticked yet. Holding
// the mailbox and not a flag means it also ends when the mailbox goes away from under it.
let selectingIn = null;
const isSelecting = () => selectingIn === box;
let anchor = null;          // the last row ticked, where a shift-click range starts
// Deleted, but still inside the undo window. Kept out of the list until the delete is
// sent, so a refresh in the meantime does not bring them back.
const hiddenIds = new Set();
let pendingDelete = null;   // { items, timer }
// Set by the macOS app before this script runs. It posts its own notifications, natively.
const inApp = Boolean(window.catchboxApp);

/* --- motion --------------------------------------------------------------- */
// The list is rebuilt from scratch on every render, so a plain CSS animation would start
// over each time. Instead every animated row remembers when it started, and a rebuild
// hands it a negative delay that resumes it where it was.
const motion = {
  known: null,             // ids in the mailbox at the last refresh; null = show it entering
  entrance: 0,             // when the current mailbox came into view
  arrivals: new Map(),     // id -> when it arrived
  ticked: null,            // { id, at } — the tick that just landed
  unread: new Map(),       // mailbox id -> unread count last drawn, to bump when it rises
};
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// Rows slide out and fold shut before the list closes over them.
const leave = (ids) => {
  const rows = [...el.list.querySelectorAll("li[data-id]")].filter((li) => ids.has(li.dataset.id));
  if (!rows.length || reducedMotion() || !Element.prototype.animate) return Promise.resolve();
  return Promise.all(rows.map((li) => {
    const { paddingTop, paddingBottom } = getComputedStyle(li);
    const h = `${li.offsetHeight}px`;
    li.style.overflow = "hidden";
    return li.animate([
      { opacity: 1, transform: "none", height: h, paddingTop, paddingBottom },
      { opacity: 0, transform: "translateX(-28px)", height: h, paddingTop, paddingBottom, offset: 0.45 },
      { opacity: 0, transform: "translateX(-28px)", height: "0px", paddingTop: "0px", paddingBottom: "0px" },
    ], { duration: 340, easing: "cubic-bezier(.2, .8, .2, 1)", fill: "forwards" }).finished.catch(() => {});
  }));
};

/* --- helpers -------------------------------------------------------------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const when = (iso) => {
  const d = new Date(iso);
  const mins = (Date.now() - d) / 60000;
  if (mins < 1) return "now";
  if (mins < 60) return `${Math.floor(mins)}m`;
  if (d.toDateString() === new Date().toDateString())
    return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};

const bytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB`
  : n > 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

const localPart = (a) => String(a ?? "").split("@")[0];
const nameOf = (acc) => acc?.label || localPart(acc?.address) || "mailbox";

// Mailboxes take colours in a fixed order, picked to sit far apart on the wheel.
const BOX_HUES = [25, 155, 300, 75, 200, 340, 120, 250];
const boxHue = (acc) => BOX_HUES[Math.max(accounts.indexOf(acc), 0) % BOX_HUES.length];

const host = (u) => { try { return new URL(u).host; } catch { return u; } };
const rest = (u) => { try { const x = new URL(u); return x.pathname + x.search + x.hash; } catch { return ""; } };

const icon = {
  copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>`,
  raw: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/></svg>`,
  back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m15 5-7 7 7 7"/></svg>`,
  clip: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L14.5 7"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>`,
  dash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 12h12"/></svg>`,
  unread: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h13M3 6v12h18v-6"/><path d="m3 6 9 7 3-2.3"/><circle cx="19" cy="6" r="3" fill="currentColor" stroke="none"/></svg>`,
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
};

let toastTimer;
// A toast can carry one action — Undo, after a delete — and then stays up long enough to reach it.
const toast = (msg, { action = null, onAction = null, ms = action ? 6000 : 1800 } = {}) => {
  el.toast.textContent = msg;
  if (action) {
    const b = document.createElement("button");
    b.textContent = action;
    b.onclick = () => { el.toast.classList.remove("on"); onAction?.(); };
    el.toast.append(b);
  }
  el.toast.classList.toggle("has-action", Boolean(action));
  el.toast.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("on"), ms);
};

// Resolves to whether it worked, so nothing can claim a copy that did not happen.
const copy = async (text, what = "Copied") => {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} to clipboard`);
    return true;
  } catch {
    // The Clipboard API needs a secure context; localhost qualifies, but be graceful anyway.
    toast("Could not copy — select and copy manually");
    return false;
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
const COLORWAYS = [
  ["airmail", "Airmail"], ["classic", "Classic"], ["kraft", "Kraft"],
  ["wax", "Wax"], ["stamp", "Stamp"], ["carbon", "Carbon"],
];

const DEFAULTS = {
  theme: "dark",
  colorway: "airmail",
  contrast: "normal",
  density: "comfortable",
  autoOpen: true,
  notify: false,
  sound: false,
  // Not html: mail opens by itself and anyone can send it, and a rendered mail fetches its
  // images from the sender. Clicking the HTML tab once makes it the default, by your choice.
  defaultTab: "text",
};

// Only what you changed is stored, so a new default reaches everyone who never touched
// that setting. `accent` and `v` come from before the colorways, and are dropped here.

const readSettings = () => {
  try {
    const stored = JSON.parse(localStorage.getItem("testmail.settings") || "{}");
    delete stored.accent;
    delete stored.v;
    if (!COLORWAYS.some(([id]) => id === stored.colorway)) delete stored.colorway;
    return { ...DEFAULTS, ...stored };
  } catch {
    return { ...DEFAULTS };
  }
};

let settings = readSettings();

const applySettings = () => {
  const r = document.documentElement;
  r.dataset.theme = settings.theme;
  r.dataset.cw = settings.colorway;
  r.dataset.contrast = settings.contrast;
  r.dataset.density = settings.density;
  const changed = Object.fromEntries(Object.entries(settings).filter(([k, v]) => DEFAULTS[k] !== v));
  try { localStorage.setItem("testmail.settings", JSON.stringify(changed)); } catch {}
};

const set = (key, value) => {
  settings[key] = value;
  applySettings();
  if (!el.settings.hidden) renderSettings();
  refreshMenu();
};

/* --- popover menu --------------------------------------------------------- */
// One element, filled by whatever opened it. `build` is kept so the menu can redraw while
// open: a swatch moves its ring, and an unread count changes under your eyes.
let menuAnchor = null;
let menuBuild = null;

// Back to the corner first: a fixed box shrinks to the room left of its old position, so the
// last menu's place would set this one's width. offset*, not getBoundingClientRect: that
// would measure the entrance animation, which starts out scaled down.
const placeMenu = () => {
  el.menu.style.left = el.menu.style.top = "0";
  const a = menuAnchor.getBoundingClientRect();
  const m = { width: el.menu.offsetWidth, height: el.menu.offsetHeight };
  const fitsBelow = a.bottom + m.height + 12 <= innerHeight;
  el.menu.style.left = `${Math.max(12, Math.min(a.left, innerWidth - m.width - 12))}px`;
  el.menu.style.top = `${fitsBelow ? a.bottom + 6 : Math.max(12, a.top - m.height - 6)}px`;
};

// Only what is on screen: focus cannot land on an item this window size hides, and the arrows
// would stop there.
const menuItems = () => [...el.menu.querySelectorAll("button:not(:disabled), a")].filter((i) => i.getClientRects().length);

const closeMenu = () => {
  if (el.menu.contains(document.activeElement)) menuAnchor?.focus({ preventScroll: true });
  el.menu.hidden = true;
  menuAnchor?.setAttribute("aria-expanded", "false");
  menuAnchor = menuBuild = null;
};

const openMenu = (anchor, build) => {
  if (menuAnchor === anchor) return closeMenu();
  closeMenu();
  menuAnchor = anchor;
  menuBuild = build;
  anchor.setAttribute("aria-expanded", "true");
  el.menu.innerHTML = build();
  el.menu.hidden = false;
  placeMenu();
  menuItems()[0]?.focus({ preventScroll: true });
};

// The menu sits at the end of the page, so Tab would walk through the list before reaching
// it: focus moves in when it opens, the arrows move through it, and Tab leaves it.
const menuKey = (e) => {
  if (e.key === "Escape" || e.key === "Tab") { closeMenu(); return e.key === "Escape"; }
  const items = menuItems();
  const at = items.indexOf(document.activeElement);
  const to = { ArrowDown: at + 1, ArrowRight: at + 1, ArrowUp: at - 1, ArrowLeft: at - 1, Home: 0, End: items.length - 1 }[e.key];
  if (to === undefined || !items.length) return el.menu.contains(e.target);
  e.preventDefault();
  items[(to + items.length) % items.length].focus({ preventScroll: true });
  return true;
};

const refreshMenu = () => {
  if (el.menu.hidden || !menuBuild) return;
  if (!menuAnchor.isConnected) return closeMenu();
  // A redraw replaces the buttons, and focus would fall out to the page with them.
  const at = menuItems().indexOf(document.activeElement);
  el.menu.innerHTML = menuBuild();
  placeMenu();
  if (at >= 0) { const items = menuItems(); items[Math.min(at, items.length - 1)]?.focus({ preventScroll: true }); }
};

// A menu opened from the reader belongs to the message on screen.
const closeReaderMenu = () => { if (el.detail.contains(menuAnchor)) closeMenu(); };

const menuItem = (act, label, hint = "", cls = "") =>
  `<button role="menuitem" class="${cls}" data-act="${act}"><span class="label">${label}</span>${hint ? `<kbd>${hint}</kbd>` : ""}</button>`;

// Every mailbox, with its unread count.
const boxesMenu = () => {
  const many = accounts.length > 1;
  const entry = (id, name, hue, unread, title = "") => `
    <button role="menuitem" data-box="${esc(id)}" aria-current="${box === id}" title="${esc(title)}">
      <i class="sw${hue === null ? " all" : ""}"${hue === null ? "" : ` style="--h:${hue}"`}></i>
      <span class="label">${esc(name)}</span>
      ${many && id === serverCurrent ? `<span class="cli" title="The mailbox the catchbox command reads">&gt;_</span>` : ""}
      ${unread ? `<span class="hint">${unread}</span>` : ""}
    </button>`;
  const total = accounts.reduce((n, a) => n + a.unread, 0);
  return [
    many ? entry("all", "All mailboxes", null, total, "All mailboxes ( g a )") : "",
    ...accounts.map((a, i) => entry(a.id, nameOf(a), boxHue(a), a.unread, `${a.address}${i < 9 ? ` ( ${i + 1} )` : ""}`)),
    "<hr>",
    menuItem("new-box", "New mailbox"),
  ].join("");
};

const moreMenu = () => {
  const visible = messages.filter(matches);
  const inbox = [
    visible.length ? menuItem("select", "Select", "x") : "",
    visible.some((m) => !m.seen) ? menuItem("all-seen", "Mark all read") : "",
    // "Delete all" means the whole mailbox, so it is not offered while a filter narrows the
    // list: then "select all" and delete is the way, and it only takes what you can see.
    messages.length && !filter ? menuItem("empty", "Delete all", "", "danger") : "",
    address ? menuItem("copy-address", "Copy address", "y", "narrow-only") : "",
  ].join("");
  return `${inbox}${inbox ? "<hr>" : ""}
    <p class="caption">Colorway</p>
    ${colorwayChips()}
    <p class="caption">Theme</p>
    ${segment("theme", THEMES)}
    <hr>
    ${menuItem("settings", "Settings", ",")}`;
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

/* --- mailbox title -------------------------------------------------------- */
// " bump" when a count went up since it was last drawn — once, not on every redraw.
const bumped = (id, n) => {
  const before = motion.unread.get(id);
  motion.unread.set(id, n);
  return before !== undefined && n > before ? " bump" : "";
};

// What the title bar says about the mailboxes. The list of them lives in the popover, so
// the total unread stays in sight: mail landing elsewhere must not go unnoticed.
const renderTitle = () => {
  const total = accounts.reduce((n, a) => n + a.unread, 0);
  const acc = accounts.find((a) => a.id === box);
  el.boxTitle.textContent = box === "all" ? "All mailboxes" : nameOf(acc);
  el.boxCount.textContent = total || "";
  el.boxCount.className = `count${bumped("all", total)}`;
  el.boxCount.title = total ? `${total} unread across all mailboxes` : "";
  refreshMenu();
};

// The highlight and the inbox must always agree. So the switch is only kept if the new
// mailbox actually loads — otherwise it rolls back, instead of leaving the title
// naming one mailbox while the list shows another.
const switchBox = async (next) => {
  if (next !== box) {
    const previous = { box, currentId };
    box = next;
    currentId = null;
    picked.clear();
    selectingIn = null;
    motion.known = null;
    renderTitle();
    try {
      await refresh();
    } catch (e) {
      box = previous.box;
      currentId = previous.currentId;
      renderTitle();
      return handleError(e);
    }
    try { localStorage.setItem("testmail.box", next); } catch {}
    emptyDetail();
  }

  // Switching in the UI also switches the mailbox the CLI reads, so `catchbox code`
  // and the inbox you are looking at can never drift apart.
  if (next !== "all" && next !== serverCurrent) {
    serverCurrent = next;
    renderTitle();
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

// The bar over the list only exists while selecting. What applies to the whole inbox lives in
// the ⋯ menu, so the list keeps its room the rest of the time.
const renderBulk = () => {
  const visible = messages.filter(matches);
  const n = picked.size;
  const all = visible.length > 0 && visible.every((m) => picked.has(m.id));
  const on = (n > 0 || isSelecting()) && messages.length > 0;
  el.bulk.hidden = !on;
  el.list.classList.toggle("picking", on);
  if (!on) return;
  el.pickAll.setAttribute("aria-checked", n === 0 ? "false" : all ? "true" : "mixed");
  el.pickAll.innerHTML = n && !all ? icon.dash : icon.check;
  el.pickAll.title = all ? "Select none ( Esc )" : "Select all ( ⌘A )";
  el.bulkLabel.textContent = n ? `${n} selected` : "Select all";

  const btn = (act, label, extra = "", title = "") =>
    `<button class="btn ghost small ${extra}" data-bulk="${act}"${title ? ` title="${title}"` : ""}>${label}</button>`;
  const anyUnread = messages.some((m) => picked.has(m.id) && !m.seen);
  el.bulkActions.innerHTML = [
    !n ? "" : anyUnread ? btn("seen", "Mark read", "", "Mark read ( ⇧I )") : btn("unseen", "Mark unread", "", "Mark unread ( ⇧U )"),
    n ? btn("delete", "Delete", "danger", "Delete ( # or ⌫ )") : "",
    `<button class="icon-btn" data-bulk="none" title="Stop selecting ( Esc )" aria-label="Stop selecting">${icon.close}</button>`,
  ].join("");
};

const renderList = () => {
  renderBulk();
  refreshMenu();
  document.body.classList.toggle("no-mail", !messages.length);
  const visible = messages.filter(matches);

  if (!visible.length) {
    el.list.innerHTML = messages.length ? `<li class="list-empty">Nothing matches “${esc(filter)}”.</li>` : "";
    return;
  }

  const now = performance.now();
  const sinceEntrance = now - motion.entrance;
  const animation = (m, i) => {
    const arrived = motion.arrivals.get(m.id);
    if (arrived !== undefined) {
      if (now - arrived < 2400) return ["arrive", now - arrived];
      motion.arrivals.delete(m.id);
    }
    // Only the first screenful staggers in; further down nobody sees it, and waiting on it would feel slow.
    if (i < 14 && sinceEntrance < i * 28 + 400) return ["enter", sinceEntrance - i * 28];
    return null;
  };
  const tickedNow = motion.ticked && now - motion.ticked.at < 300 ? motion.ticked.id : null;

  el.list.innerHTML = visible.map((m, i) => {
    const acc = accounts.find((a) => a.id === m.account);
    const trail = m.code ? `<span class="row-code" title="Code — press c to copy">${esc(m.code)}</span>`
      : m.hasAttachments || m.attachments.length ? `<span title="Has attachments">${icon.clip}</span>` : "";

    const isPicked = picked.has(m.id);
    const anim = animation(m, i);
    const cls = [m.seen ? "" : "unread", isPicked ? "picked" : "",
      isPicked && m.id === tickedNow ? "ticked" : "", anim?.[0] ?? ""].filter(Boolean).join(" ");
    return `<li role="option" tabindex="0" data-id="${esc(m.id)}" data-account="${esc(m.account ?? "")}"
        aria-selected="${m.id === currentId}" class="${cls}"${anim ? ` style="--d:${Math.round(-anim[1])}ms"` : ""}>
      <span class="pick" role="checkbox" aria-checked="${isPicked}" aria-label="Select this message" title="Select ( x )">
        <span class="tick" aria-hidden="true">${icon.check}</span>
      </span>
      <span class="who">${esc(m.fromName || m.from || "unknown")}</span>
      <span class="when">${box === "all" && acc ? `<i class="sw" style="--h:${boxHue(acc)}" title="${esc(nameOf(acc))}"></i>` : ""}${when(m.date)}</span>
      <span class="subj">${esc(m.subject || "(no subject)")}</span>
      <span class="trail">${trail}</span>
    </li>`;
  }).join("");
};

/* --- detail --------------------------------------------------------------- */
const emptyDetail = () => {
  // On a narrow screen "reading" hides the list and the mailboxes, and the only way back
  // lives in a message's toolbar. With no message on screen there is nothing to go back
  // from, so show the list instead of an empty page with no way out.
  document.body.classList.remove("reading");
  closeReaderMenu();
  if (messages.length) {
    el.detail.innerHTML = `<div class="empty"><div class="inner">
      <h2>No message selected</h2>
      <p>Press <kbd>?</kbd> for settings and shortcuts.</p>
    </div></div>`;
    return;
  }
  el.detail.innerHTML = `<div class="empty"><div class="inner">
    <div class="beat"></div>
    <h2>Waiting for mail</h2>
    <p>It shows up here by itself.</p>
    ${address ? `<div class="send-to">
        <code>${esc(address)}</code>
        <button class="btn primary" data-copy="${esc(address)}" data-what="Address copied">${icon.copy}Copy</button>
      </div>
      <code class="cli-hint">catchbox code --wait</code>` : ""}
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
    <div class="headers-wrap"><table class="headers">
      ${d.headers.map((h) => `<tr><td>${esc(h.name)}</td><td>${esc(h.value)}</td></tr>`).join("")}
    </table></div>`;
};

const renderDetail = async (m) => {
  openMessage = m;
  closeReaderMenu();
  document.body.classList.add("reading");
  const acc = accounts.find((a) => a.id === m.account);

  const link = m.actionableLinks?.[0];
  const code = m.code ? String(m.code) : "";
  const others = m.links.filter((u) => u !== link);

  const answer = [
    code ? `<div class="a-code">
        <button class="otp${code.length === 6 ? " six" : ""}${code.length > 10 ? " long" : ""}" data-copy="${esc(code)}" data-what="Code copied" title="Click to copy ( c )">
          ${code.length > 10 ? `<span>${esc(code)}</span>` : [...code].map((ch, i) => `<span style="--i:${i}">${esc(ch)}</span>`).join("")}
        </button>
        <button class="btn primary" data-copy="${esc(code)}" data-what="Code copied" title="Copy the code ( c )">${icon.copy}Copy</button>
      </div>` : "",
    link ? `<div class="a-link">
        <a class="url" href="${esc(link)}" target="_blank" rel="noopener" title="${esc(link)}"><b>${esc(host(link))}</b>${esc(rest(link))}</a>
        ${others.length ? `<button class="more" data-more-links title="${plural(others.length, "more link")}">+${others.length}</button>` : ""}
        <button class="icon-btn" data-copy="${esc(link)}" data-what="Link copied" title="Copy the link" aria-label="Copy the link">${icon.copy}</button>
        <button class="btn${code ? "" : " primary"}" data-open="${esc(link)}" title="Open the link ( o )">Open</button>
      </div>` : others.length ? `<div class="a-link">
        <button class="more" data-more-links>${plural(others.length, "link")} — tracking and unsubscribe only</button>
      </div>` : "",
  ].filter(Boolean).join("");

  el.detail.innerHTML = `
    <article class="letter">
      <header class="r-head">
        <button class="icon-btn back" data-back aria-label="Back to the list">${icon.back}</button>
        <div class="r-title">
          <h1>${esc(m.subject || "(no subject)")}</h1>
          <p class="meta">
            <b>${esc(m.fromName || m.from || "unknown")}</b>
            ${m.fromName && m.from ? `<span class="from">${esc(m.from)}</span><span class="sep">·</span>` : `<span class="sep">·</span>`}
            <span title="${esc(m.to?.[0] ?? acc?.address ?? "")}">${esc(acc && accounts.length > 1 ? nameOf(acc) : m.to?.[0] ?? acc?.address ?? "")}</span>
            <span class="sep">·</span>
            <time datetime="${esc(m.date)}">${new Date(m.date).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</time>
          </p>
        </div>
        <div class="tools">
          <button class="icon-btn" id="mark-unread" title="Mark unread ( ⇧U )" aria-label="Mark unread">${icon.unread}</button>
          <button class="icon-btn" id="copy-eml" title="Copy the raw .eml source" aria-label="Copy the raw source">${icon.raw}</button>
          <button class="icon-btn danger" id="del" title="Delete ( # or ⌫ )" aria-label="Delete">${icon.trash}</button>
        </div>
      </header>
      ${answer ? `<section class="answer" aria-label="Taken from this mail">${answer}</section>` : ""}
      ${m.attachments.length ? `<div class="attachments">${m.attachments.map((a) => `
          <a class="attachment" href="${esc(a.url)}" download>${icon.clip}${esc(a.filename)} <small>${bytes(a.size)}</small></a>`).join("")}</div>` : ""}
      <div class="tabs" id="tabs" role="tablist">
        ${m.html ? `<button data-tab="html" title="Sandboxed: scripts never run">HTML</button>` : ""}
        <button data-tab="text">Text</button>
        <button data-tab="headers" title="Deliverability and every header">Headers</button>
        <button data-tab="raw">Raw</button>
      </div>
      <div id="pane"></div>
    </article>`;

  el.detail.querySelector("[data-more-links]")?.addEventListener("click", (e) =>
    openMenu(e.currentTarget, () => others.map((u) =>
      `<a class="url" role="menuitem" href="${esc(u)}" target="_blank" rel="noopener" title="${esc(u)}"><span class="label">${esc(u)}</span></a>`).join("")));

  const pane = $("pane");
  let source = null; // fetched lazily — the raw body is large and usually not needed
  const loadSource = async () =>
    (source ??= await api(withBox(`/api/message/${encodeURIComponent(m.id)}/source`, m.account)));

  const show = async (tab, { remember = false } = {}) => {
    for (const b of $("tabs").children) b.ariaSelected = String(b.dataset.tab === tab);
    if (tab === "html") {
      // No allow-scripts, ever: anyone can mail this address. Popups are allowed so the
      // button in the mail — usually the very thing under test — opens in a tab of its own.
      pane.innerHTML = `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe>`;
      pane.firstChild.srcdoc = `<base target="_blank">${m.html}`;
    } else if (tab === "text") {
      pane.innerHTML = `<pre class="text">${esc(m.text || "(no plain text part)")}</pre>`;
    } else {
      pane.innerHTML = `<p class="pane-note" style="padding-top:10px">Loading raw source…</p>`;
      await loadSource();
      pane.innerHTML = tab === "headers"
        ? renderHeaders(source.deliverability)
        : `<pre class="raw">${esc(source.raw)}</pre>`;
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

  $("del").onclick = () => removeMessages([m]);
  $("mark-unread").onclick = () => markSeen(messages.filter((x) => x.id === m.id), false);

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

/* --- selection and bulk actions ------------------------------------------ */
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const itemsOf = (list) => list.map((m) => ({ id: m.id, account: m.account }));
const pickedMessages = () => messages.filter((m) => picked.has(m.id));

const bulk = (action, items) => api("/api/messages", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ action, items }),
});

const togglePick = (id) => {
  if (picked.has(id)) picked.delete(id); else picked.add(id);
  anchor = id;
  motion.ticked = { id, at: performance.now() };
  renderList();
};

// Shift-click ticks everything between the last row ticked and this one, as in Gmail and Mail.
const pickRange = (id) => {
  const visible = messages.filter(matches);
  const from = visible.findIndex((m) => m.id === anchor);
  const to = visible.findIndex((m) => m.id === id);
  if (from === -1 || to === -1) return togglePick(id);
  for (const m of visible.slice(Math.min(from, to), Math.max(from, to) + 1)) picked.add(m.id);
  anchor = id;
  renderList();
};

const pickAll = () => {
  const visible = messages.filter(matches);
  const all = visible.length && visible.every((m) => picked.has(m.id));
  picked.clear();
  if (!all) for (const m of visible) picked.add(m.id);
  renderList();
};

const pickNone = () => { picked.clear(); anchor = null; selectingIn = null; renderList(); };

// Whatever was ticked but is no longer in the list — deleted elsewhere, filtered away.
const prunePicked = () => {
  const here = new Set(messages.filter(matches).map((m) => m.id));
  for (const id of picked) if (!here.has(id)) picked.delete(id);
};

// mail.tm has no bin to restore from, so the undo lives here: the messages leave the list
// at once, and the delete itself is only sent when the undo window closes.
const removeMessages = async (list) => {
  if (!list.length) return;
  if (demoMode) return toast("Demo mode — nothing is deleted here");
  flushDelete(); // a second delete commits the first, so there is only ever one to undo

  // Hidden at once, so a refresh during the animation cannot bring them back; and
  // forgotten, so an undo brings them back in with the arrival animation.
  const ids = new Set(list.map((m) => m.id));
  for (const id of ids) { hiddenIds.add(id); picked.delete(id); motion.known?.delete(id); }
  selectingIn = null;
  await leave(ids);
  messages = messages.filter((m) => !hiddenIds.has(m.id));
  if (currentId && hiddenIds.has(currentId)) currentId = null;
  renderList();
  if (!currentId) emptyDetail();

  const items = itemsOf(list);
  pendingDelete = { items, timer: setTimeout(flushDelete, 6000) };
  toast(list.length === 1 ? "Message deleted" : `${plural(list.length, "message")} deleted`,
    { action: "Undo", onAction: undoDelete });
};

const flushDelete = async () => {
  const p = pendingDelete;
  if (!p) return;
  pendingDelete = null;
  clearTimeout(p.timer);
  try {
    const r = await bulk("delete", p.items);
    if (r.failed) toast(`${plural(r.failed, "message")} could not be deleted`);
  } catch (e) {
    handleError(e); // they are still there, and the refresh below puts them back in view
  }
  for (const i of p.items) hiddenIds.delete(i.id);
  await refresh().catch(handleError);
};

const undoDelete = () => {
  const p = pendingDelete;
  if (!p) return toast("Nothing to undo");
  pendingDelete = null;
  clearTimeout(p.timer);
  for (const i of p.items) hiddenIds.delete(i.id);
  refresh().catch(handleError);
  toast(p.items.length === 1 ? "Message restored" : `${plural(p.items.length, "message")} restored`);
};

// A delete still waiting out its undo window is sent anyway when the page goes away —
// closing the tab is not an undo.
window.addEventListener("pagehide", () => {
  if (!pendingDelete) return;
  navigator.sendBeacon?.("/api/messages", JSON.stringify({ action: "delete", items: pendingDelete.items }));
  pendingDelete = null;
});

// Optimistic, like the delete: the list changes at once and is put back if mail.tm says no.
const markSeen = async (list, seen) => {
  const targets = list.filter((m) => m.seen !== seen);
  if (!targets.length) return toast(seen ? "Already read" : "Already unread");
  if (demoMode) return toast("Demo mode — nothing is changed here");
  for (const m of targets) m.seen = seen;
  renderList();
  try {
    const r = await bulk(seen ? "seen" : "unseen", itemsOf(targets));
    if (r.failed) {
      toast(`${plural(r.failed, "message")} could not be updated`);
      await refresh();
    } else {
      toast(`${plural(targets.length, "message")} marked ${seen ? "read" : "unread"}`);
    }
  } catch (e) {
    for (const m of targets) m.seen = !seen;
    renderList();
    handleError(e);
  }
};

// Every message in the mailbox, not just the page on screen. The address stays.
const emptyBox = async () => {
  if (demoMode) return toast("Demo mode — nothing is deleted here");
  const where = box === "all" ? "every mailbox" : nameOf(accounts.find((a) => a.id === box));
  if (!confirm(`Delete all mail in ${where}?\nThe address${box === "all" ? "es stay" : " stays"}; the messages are gone for good.`)) return;
  await flushDelete();
  toast("Deleting…", { ms: 30000 });
  try {
    const r = await api(withBox("/api/inbox"), { method: "DELETE" });
    const problems = [
      r.failed ? `${plural(r.failed, "message")} could not be deleted` : "",
      r.unreachable ? `${plural(r.unreachable, "mailbox", "mailboxes")} could not be reached` : "",
    ].filter(Boolean).join(", ");
    toast(`${r.deleted ? `${plural(r.deleted, "message")} deleted` : "Nothing deleted"}${problems ? ` — ${problems}` : ""}`,
      problems ? { ms: 5000 } : {});
  } catch (e) {
    handleError(e);
  }
  picked.clear();
  selectingIn = null;
  currentId = null;
  await refresh().catch(handleError);
  emptyDetail();
};

el.bulk.onclick = (e) => {
  if (e.target.closest("#pick-all")) return pickAll();
  const b = e.target.closest("[data-bulk]");
  if (!b) return;
  switch (b.dataset.bulk) {
    case "none": return pickNone();
    case "delete": return removeMessages(pickedMessages());
    case "seen": return markSeen(pickedMessages(), true);
    case "unseen": return markSeen(pickedMessages(), false);
  }
};

/* --- settings page -------------------------------------------------------- */
const segment = (key, options) => `
  <div class="segment" data-set="${key}">
    ${options.map(([v, label]) =>
      `<button data-value="${v}" aria-pressed="${settings[key] === v}">${label}</button>`).join("")}
  </div>`;

const THEMES = [["dark", "Dark"], ["light", "Light"], ["auto", "Auto"]];

// Each chip carries its own colorway and theme, so it shows itself and not the active one.
const colorwayChips = () => `
  <div class="swatches" data-set="colorway">
    ${COLORWAYS.map(([id, name]) =>
      `<button class="cw-chip" data-value="${id}" data-cw="${id}" data-theme="${settings.theme}" title="${name}"
        aria-pressed="${settings.colorway === id}" aria-label="${name}"></button>`).join("")}
  </div>`;

const toggle = (key) => `
  <label class="switch"><input type="checkbox" data-toggle="${key}" ${settings[key] ? "checked" : ""}><span></span></label>`;

const field = (title, note, control, key = null) => `
  <div class="field${key ? " switchable" : ""}"${key ? ` data-field="${key}"` : ""}>
    <div class="text"><b>${title}</b><span>${note}</span></div>
    <div class="control">${control}</div>
  </div>`;

const renderSettings = () => {
  el.settingsBody.innerHTML = `
    <h2 class="card-title">Appearance</h2>
    <div class="card">
      ${field("Colorway", "The paper, the primary button and the code.", `
        ${colorwayChips()}
        <div class="cw-name">${COLORWAYS.find(([id]) => id === settings.colorway)[1]}</div>`)}
      ${field("Theme", "Auto follows your system setting.", segment("theme", THEMES))}
      ${field("Contrast", "High darkens secondary text and strengthens lines.",
        segment("contrast", [["normal", "Normal"], ["high", "High"]]))}
      ${field("Density", "Compact fits more messages on screen.",
        segment("density", [["comfortable", "Comfortable"], ["compact", "Compact"]]))}
    </div>

    <h2 class="card-title">Mailboxes</h2>
    <div class="card">
      <div class="boxes">
        ${accounts.map((a) => `
          <div class="box-row" data-id="${esc(a.id)}">
            <i class="sw" style="--h:${boxHue(a)}"></i>
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
        <div><kbd>x</kbd> select a message, <kbd>⇧</kbd>-click a range</div>
        <div><kbd>⌘</kbd> <kbd>A</kbd> select all</div>
        <div><kbd>#</kbd> or <kbd>⌫</kbd> delete, <kbd>z</kbd> undo</div>
        <div><kbd>⇧</kbd> <kbd>I</kbd> / <kbd>⇧</kbd> <kbd>U</kbd> mark read / unread</div>
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

const openSettings = () => { el.settings.classList.remove("closing"); el.settings.hidden = false; renderSettings(); };
const closeSettings = () => {
  if (el.settings.hidden || el.settings.classList.contains("closing")) return;
  const done = () => {
    if (!el.settings.classList.contains("closing")) return; // reopened in the meantime
    el.settings.hidden = true;
    el.settings.classList.remove("closing");
  };
  if (reducedMotion()) return done();
  el.settings.classList.add("closing");
  setTimeout(done, 160);
};

// A click on the dimmed backdrop closes Settings — but only when it also started there.
// Pressing inside the card and releasing outside it (say, drag-selecting a name) reports
// the click on the backdrop too, and must not throw the edit away.
let pressedOnBackdrop = false;
el.settings.addEventListener("mousedown", (e) => { pressedOnBackdrop = e.target === el.settings; });

el.settings.onclick = async (e) => {
  if (e.target === el.settings && pressedOnBackdrop) return closeSettings();
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
  renderTitle();
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

  renderTitle();
};

const refresh = async () => {
  const data = await api(withBox("/api/inbox"));
  address = data.address ?? "";
  el.addrText.textContent = address;
  el.addr.hidden = !address;
  messages = data.messages.filter((m) => !hiddenIds.has(m.id));
  // First load of a mailbox: the rows stagger in. After that, anything not seen before arrives.
  const now = performance.now();
  if (!motion.known) motion.entrance = now;
  else for (const m of messages) if (!motion.known.has(m.id)) motion.arrivals.set(m.id, now);
  motion.known = new Set(messages.map((m) => m.id));
  if (!messages.length) selectingIn = null;
  prunePicked();
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
    const otp = c.dataset.what === "Code copied" && el.detail.querySelector(".otp");
    copy(c.dataset.copy, c.dataset.what || "Copied").then((ok) => {
      if (!ok || !otp) return;
      otp.classList.add("flash");
      setTimeout(() => otp.classList.remove("flash"), 900);
    });
    return;
  }
  const o = e.target.closest("[data-open]");
  if (o) return window.open(o.dataset.open, "_blank", "noopener");
  if (e.target.closest("[data-back]")) document.body.classList.remove("reading");
};

el.list.onclick = (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li) return;
  if (e.shiftKey && anchor) return pickRange(li.dataset.id);
  if (isSelecting() || picked.size || e.metaKey || e.ctrlKey) return togglePick(li.dataset.id);
  select(li.dataset.id, li.dataset.account || undefined);
};
// A shift-click selects rows, not the text in them.
el.list.addEventListener("mousedown", (e) => { if (e.shiftKey) e.preventDefault(); });

// Tab reaches the rows; Enter does what a click would. j/k remain the fast path.
el.list.onkeydown = (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const li = e.target.closest("li[data-id]");
  if (!li) return;
  e.preventDefault();
  if (isSelecting() || picked.size) return togglePick(li.dataset.id);
  select(li.dataset.id, li.dataset.account || undefined);
};

el.boxSwitch.onclick = () => openMenu(el.boxSwitch, boxesMenu);
el.more.onclick = () => openMenu(el.more, moreMenu);
$("add-box").onclick = () => createBox(null);

el.menu.onclick = (e) => {
  const seg = e.target.closest("[data-set] [data-value]");
  if (seg) return set(seg.closest("[data-set]").dataset.set, seg.dataset.value);

  const mailbox = e.target.closest("[data-box]");
  if (mailbox) { closeMenu(); return switchBox(mailbox.dataset.box); }

  const act = e.target.closest("[data-act]")?.dataset.act;
  if (!act) { if (e.target.closest("a")) closeMenu(); return; }
  closeMenu();
  switch (act) {
    case "new-box": return createBox(null);
    case "select": selectingIn = box; return renderList();
    case "all-seen": return markSeen(messages.filter(matches), true);
    case "empty": return emptyBox();
    case "copy-address": return address && copy(address, "Address copied");
    case "settings": return openSettings();
  }
};

// composedPath, not contains(): a swatch redraws the menu before this runs, so the element
// that was clicked is no longer in the document, and would look like a click outside.
// A click inside the mail's iframe never reaches this document; it only blurs the window.
document.addEventListener("click", (e) => {
  const path = e.composedPath();
  if (!el.menu.hidden && !path.includes(el.menu) && !path.includes(menuAnchor)) closeMenu();
});
window.addEventListener("blur", closeMenu);
window.addEventListener("resize", closeMenu);

el.addr.onclick = () => address && copy(address, "Address copied");
$("settings-close").onclick = closeSettings;

el.search.oninput = () => { filter = el.search.value.trim(); prunePicked(); renderList(); refreshMenu(); };

let pendingG = false;

// In the merged view there is no single address, so the shortcuts fall back to the
// mailbox the CLI is on — the one `catchbox code` would read.
const activeAccount = () => accounts.find((a) => a.id === (box === "all" ? serverCurrent : box));
const activeAddress = () => address || activeAccount()?.address || "";

document.addEventListener("keydown", (e) => {
  const typing = e.target.matches("input, textarea, select") || e.target.isContentEditable;

  // ⌘A / Ctrl+A ticks every message, as in Mail — but not while typing, or after clicking
  // into an open message: there it still selects the text, for ⌘A ⌘C on a plain-text body.
  const inReader = el.detail.contains(e.target) || el.detail.contains(document.getSelection()?.anchorNode ?? null);
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "a" && !typing && !inReader && el.settings.hidden) {
    e.preventDefault();
    return pickAll();
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (!el.menu.hidden && menuKey(e)) return;

  // Typing always wins over shortcuts.
  if (typing) {
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

  // For c and o. Loaded only when nothing is open, and it counts as reading the mail.
  const full = current && current.id === openMessage?.id ? openMessage : null;
  const load = (m, use) => api(withBox(`/api/message/${encodeURIComponent(m.id)}`, m.account)).then((whole) => {
    m.seen = true;
    renderList();
    use(whole);
  }).catch(handleError);
  const copyCode = (m) => (m.code ? copy(m.code, "Code copied") : toast("No code in this message"));
  const openLink = (m) => (m.actionableLinks?.[0]
    ? window.open(m.actionableLinks[0], "_blank", "noopener") : toast("No action link in this message"));

  // What a bulk shortcut acts on: the ticked messages, or else the open one.
  const targets = () => (picked.size ? pickedMessages()
    : messages.filter((m) => m.id === currentId));

  switch (e.key) {
    case "g": pendingG = true; break;

    case "x": {
      const row = e.target.closest?.("li[data-id]");
      const id = row?.dataset.id ?? currentId ?? visible[0]?.id;
      id ? togglePick(id) : toast("This inbox is empty");
      break;
    }

    case "#": case "Delete": case "Backspace": {
      e.preventDefault();
      const list = targets();
      list.length ? removeMessages(list) : toast("Select a message to delete");
      break;
    }

    case "I": case "U": {
      const list = targets();
      list.length ? markSeen(list, e.key === "I") : toast("Select a message first");
      break;
    }

    case "z": undoDelete(); break;

    case "j": case "ArrowDown": e.preventDefault(); step(1); break;
    case "k": case "ArrowUp": e.preventDefault(); step(-1); break;

    case "c":
      if (!current) toast("This inbox is empty");
      else if (full || current.code) copyCode(full ?? current);
      else load(current, copyCode);
      break;

    case "o":
      if (!current) toast("This inbox is empty");
      else if (full) openLink(full);
      else load(current, openLink);
      break;

    case "y": {
      const a = activeAddress();
      a ? copy(a, "Address copied") : toast("No mailbox yet");
      break;
    }

    case "/": e.preventDefault(); el.search.focus(); break;
    case ",": case "?": e.preventDefault(); openSettings(); break;
    case "Escape":
      if (picked.size || isSelecting()) pickNone();
      else document.body.classList.remove("reading");
      break;
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
