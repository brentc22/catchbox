import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DIR = path.join(os.homedir(), ".config/testmail");
const STORE = path.join(DIR, "accounts.json");

// Where a single-mailbox testmail (and `mailsy`) keeps its account. We keep writing the
// active mailbox to both, so `mailsy m` and any script written against the old layout
// still talk to the same inbox you are looking at.
const LEGACY = path.join(DIR, "account.json");
const MAILSY = process.env.TESTMAIL_MAILSY_STORE ?? "/opt/homebrew/lib/node_modules/mailsy/data/account.json";

const readJson = (p) => {
  try {
    const raw = fs.readFileSync(p, "utf8").trim();
    return raw && raw !== "null" ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const writeJson = (p, value) => {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(value, null, 2));
    return true;
  } catch {
    return false; // mailsy may not be installed, or the path may not be writable
  }
};

const normalise = (a) => ({
  id: a.id,
  address: a.address,
  password: a.password,
  token: a.token ?? null,
  label: a.label ?? null,
  createdAt: a.createdAt ?? new Date().toISOString(),
});

const empty = () => ({ version: 2, current: null, accounts: [] });

// The file is read on every call rather than cached: the CLI and the UI server are
// separate processes, and a mailbox switched in one must be visible in the other.
export const readAll = () => {
  const data = readJson(STORE);
  if (data?.version === 2 && Array.isArray(data.accounts)) return data;

  const old = readJson(LEGACY) ?? readJson(MAILSY);
  if (!old?.address) return empty();
  const acc = normalise(old);
  return { version: 2, current: acc.id, accounts: [acc] };
};

const syncLegacy = (acc) => {
  writeJson(LEGACY, acc ?? null);
  writeJson(MAILSY, acc ?? null);
};

const writeAll = (data) => {
  writeJson(STORE, data);
  syncLegacy(data.accounts.find((a) => a.id === data.current) ?? null);
  return data;
};

export const list = () => readAll().accounts;

export const load = (id = null) => {
  const data = readAll();
  const wanted = id ?? data.current;
  return data.accounts.find((a) => a.id === wanted) ?? (id ? null : data.accounts[0] ?? null);
};

/** Insert or update an account. `activate` also makes it the current mailbox. */
export const save = (acc, { activate = true } = {}) => {
  const data = readAll();
  const next = normalise(acc);
  const at = data.accounts.findIndex((a) => a.id === next.id);
  if (at === -1) data.accounts.push(next);
  else data.accounts[at] = { ...data.accounts[at], ...next };
  if (activate || !data.current) data.current = next.id;
  writeAll(data);
  return next;
};

export const setCurrent = (id) => {
  const data = readAll();
  if (!data.accounts.some((a) => a.id === id)) return null;
  data.current = id;
  writeAll(data);
  return load(id);
};

export const rename = (id, label) => {
  const data = readAll();
  const acc = data.accounts.find((a) => a.id === id);
  if (!acc) return null;
  acc.label = label?.trim() || null;
  writeAll(data);
  return acc;
};

export const remove = (id) => {
  const data = readAll();
  const gone = data.accounts.find((a) => a.id === id);
  data.accounts = data.accounts.filter((a) => a.id !== id);
  if (data.current === id) data.current = data.accounts[0]?.id ?? null;
  writeAll(data);
  return gone ?? null;
};
