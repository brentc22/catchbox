const $ = (id) => document.getElementById(id);
const el = {
  list: $("list"), detail: $("detail"), rail: $("rail"),
  addr: $("address"), addrText: $("address-text"),
  search: $("search"), toast: $("toast"), live: $("live"),
  settings: $("settings"), settingsBody: $("settings-body"),
  offline: $("offline"), demoChip: $("demo-chip"),
};

let accounts = [];          // [{ id, address, label, unread, total }]
let serverCurrent = null;   // the mailbox the CLI acts on
let box = "all";            // the mailbox being viewed, or "all"
let messages = [];
let currentId = null;
let address = "";
let filter = "";
let demoMode = false;

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

const localPart = (a) => String(a ?? "").split("@")[0];
const nameOf = (acc) => acc?.label || localPart(acc?.address) || "mailbox";
const initials = (acc) => nameOf(acc).replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "?";

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
  accent: "indigo",
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
  if (!settings.notify || Notification?.permission !== "granted") return;
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
  const rows = accounts.map((a) => `
    <button class="mailbox" data-box="${esc(a.id)}" aria-current="${box === a.id}" title="${esc(a.address)}">
      <span class="mb-avatar">${esc(initials(a))}</span>
      <span class="mb-body">
        <span class="mb-name">${esc(nameOf(a))}</span>
        <span class="mb-sub">${esc(a.address)}</span>
      </span>
      ${a.unread ? `<span class="badge">${a.unread}</span>` : ""}
    </button>`).join("");

  const total = accounts.reduce((n, a) => n + a.unread, 0);
  const all = many ? `
    <button class="mailbox all" data-box="all" aria-current="${box === "all"}">
      <span class="mb-avatar">∗</span>
      <span class="mb-body">
        <span class="mb-name">All mailboxes</span>
        <span class="mb-sub">${accounts.length} inboxes</span>
      </span>
      ${total ? `<span class="badge">${total}</span>` : ""}
    </button>` : "";

  el.rail.innerHTML = `
    <h2>Mailboxes</h2>
    ${all}
    ${rows}
    <button class="btn ghost" id="add-box">＋ New mailbox</button>
    <div class="rail-foot">
      <p class="hint">${demoMode
        ? "Demo mode. These mailboxes are made up and nothing here touches the network."
        : box === "all"
          ? "Viewing every inbox at once. Pick one to make it the mailbox the CLI uses."
          : `<code>catchbox</code> uses <b>${esc(nameOf(accounts.find((a) => a.id === serverCurrent)))}</b>.`}</p>
    </div>`;
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

const renderList = () => {
  const visible = messages.filter(matches);

  if (!visible.length) {
    el.list.innerHTML = `<li class="empty" style="height:auto;padding:28px 18px"><div class="inner">
      <p>${messages.length ? "Nothing matches that filter." : "This inbox is empty."}</p>
    </div></li>`;
    return;
  }

  el.list.innerHTML = visible.map((m) => {
    const acc = accounts.find((a) => a.id === m.account);
    const chips = [
      m.code ? `<span class="tag code">${esc(m.code)}</span>` : "",
      m.links.length ? `<span class="tag">${m.links.length} link${m.links.length > 1 ? "s" : ""}</span>` : "",
      m.attachments.length ? `<span class="tag">${m.attachments.length} file${m.attachments.length > 1 ? "s" : ""}</span>` : "",
      box === "all" && acc ? `<span class="tag box">${esc(nameOf(acc))}</span>` : "",
    ].filter(Boolean).join("");

    return `<li role="option" data-id="${esc(m.id)}" data-account="${esc(m.account ?? "")}"
        aria-selected="${m.id === currentId}" class="${m.seen ? "" : "unread"}">
      <div class="row">
        <span class="who">${esc(m.fromName || m.from || "unknown")}</span>
        <span class="when">${when(m.date)}</span>
      </div>
      <div class="subj">${esc(m.subject || "(no subject)")}</div>
      ${chips ? `<div class="tags">${chips}</div>` : ""}
    </li>`;
  }).join("");
};

/* --- detail --------------------------------------------------------------- */
const emptyDetail = () => {
  el.detail.innerHTML = `<div class="empty"><div class="inner">
    <h2>${messages.length ? "Pick a message" : "Waiting for mail"}</h2>
    <p>${messages.length
      ? "Use <kbd>j</kbd> and <kbd>k</kbd> to move, <kbd>c</kbd> to copy the code, <kbd>o</kbd> to open the link."
      : "Send something to the address above. It shows up here by itself — no refreshing."}</p>
    ${messages.length || !address ? "" : `<code>${esc(address)}</code>`}
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
    ${notes.map((n) => `<p class="meta" style="margin:-6px 0 12px">${esc(n)}</p>`).join("")}
    <table class="headers">
      ${d.headers.map((h) => `<tr><td>${esc(h.name)}</td><td>${esc(h.value)}</td></tr>`).join("")}
    </table>`;
};

const renderDetail = async (m) => {
  document.body.classList.add("reading");
  const acc = accounts.find((a) => a.id === m.account);

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
      ${acc ? `<span>·</span><span class="tag box">${esc(nameOf(acc))}</span>` : ""}
      <span class="grow"></span>
      <button class="btn ghost small" id="copy-eml">Copy raw</button>
      <button class="btn ghost small danger" id="del">Delete</button>
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
  const loadSource = async () =>
    (source ??= await api(withBox(`/api/message/${encodeURIComponent(m.id)}/source`, m.account)));

  const show = async (tab, { remember = false } = {}) => {
    for (const b of $("tabs").children) b.ariaSelected = String(b.dataset.tab === tab);
    if (tab === "html") {
      pane.innerHTML = `<iframe sandbox referrerpolicy="no-referrer"></iframe>`;
      pane.firstChild.srcdoc = m.html;
    } else if (tab === "text") {
      pane.innerHTML = `<pre class="body">${esc(m.text || "(no plain text part)")}</pre>`;
    } else {
      pane.innerHTML = `<p class="meta">Loading raw source…</p>`;
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
    await loadSource();
    copy(source.raw, "Raw message copied");
  };

  $("del").onclick = async () => {
    await fetch(withBox(`/api/message/${encodeURIComponent(m.id)}`, m.account), { method: "DELETE" });
    currentId = null;
    await refresh().catch(handleError);
    emptyDetail();
    toast("Message deleted");
  };

  el.detail.onclick = (e) => {
    const c = e.target.closest("[data-copy]");
    if (c) return copy(c.dataset.copy, c.dataset.copy.length > 40 ? "Link copied" : "Code copied");
    const o = e.target.closest("[data-open]");
    if (o) window.open(o.dataset.open, "_blank", "noopener");
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
  ["indigo", "#6366f1"], ["blue", "#2f7ae5"], ["teal", "#0d9488"], ["green", "#15803d"],
  ["amber", "#b45309"], ["rose", "#e11d48"], ["violet", "#7c3aed"], ["slate", "#475569"],
];

const renderSettings = () => {
  el.settingsBody.innerHTML = `
    <div class="card">
      <h2>Appearance</h2>
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

    <div class="card">
      <h2>Mailboxes</h2>
      <div class="boxes">
        ${accounts.map((a) => `
          <div class="box-row" data-id="${esc(a.id)}">
            <div class="info">
              <input class="label-input" value="${esc(a.label ?? "")}" placeholder="${esc(localPart(a.address))}"
                     aria-label="Name for ${esc(a.address)}">
              <div class="addr">${esc(a.address)}${a.total ? ` · ${a.total} message${a.total > 1 ? "s" : ""}` : ""}</div>
            </div>
            <div class="acts">
              <button class="btn small" data-copy-addr="${esc(a.address)}">Copy</button>
              ${a.id === serverCurrent
                ? `<button class="btn small" disabled>Active</button>`
                : `<button class="btn small" data-activate="${esc(a.id)}">Make active</button>`}
              <button class="btn small danger" data-delete="${esc(a.id)}">Delete</button>
            </div>
          </div>`).join("")}
      </div>
      <div class="new-box">
        <input id="new-label" placeholder="Name, e.g. “Signup flow”" aria-label="Name for the new mailbox">
        <button class="btn primary" id="create-box">Create mailbox</button>
      </div>
    </div>

    <div class="card">
      <h2>When mail arrives</h2>
      ${field("Open it automatically", "Only when you are not already reading something else.", toggle("autoOpen"), "autoOpen")}
      ${field("Desktop notification", "Shows the sender, the subject and the code.", toggle("notify"), "notify")}
      ${field("Play a sound", "A short beep, so you can look away while you wait.", toggle("sound"), "sound")}
      ${field("Open messages on", "Which tab a message opens on.",
        segment("defaultTab", [["text", "Text"], ["html", "HTML"], ["headers", "Headers"]]))}
    </div>

    <div class="card">
      <h2>Keyboard</h2>
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

    <div class="card">
      <h2>About</h2>
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
    await api(`/api/accounts/${encodeURIComponent(del.dataset.delete)}`, { method: "DELETE" });
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
  if (key === "notify" && t.checked && Notification?.permission !== "granted") {
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
  await api(`/api/accounts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: input.value }),
  });
  await loadAccounts();
  renderRail();
  toast("Mailbox renamed");
});

const createBox = async (label) => {
  if (demoMode) return toast("Demo mode — mailboxes are not created here");
  toast("Creating a mailbox…");
  const acc = await api("/api/accounts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: label?.trim() || null }),
  });
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
  el.addrText.textContent = address || `All mailboxes (${accounts.length})`;
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
  es.onerror = () => { el.live.classList.add("off"); el.live.title = "reconnecting…"; };
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
el.list.onclick = (e) => {
  const li = e.target.closest("li[data-id]");
  if (li) select(li.dataset.id, li.dataset.account || undefined);
};

el.rail.onclick = (e) => {
  const mb = e.target.closest("[data-box]");
  if (mb) return switchBox(mb.dataset.box);
  if (e.target.closest("#add-box")) return createBox(null);
};

el.addr.onclick = () => address && copy(address, "Address copied");
$("settings-open").onclick = openSettings;
$("settings-close").onclick = closeSettings;
$("back").onclick = () => document.body.classList.remove("reading");

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

boot().then(connect);
setInterval(renderList, 60000); // keep the relative timestamps honest
