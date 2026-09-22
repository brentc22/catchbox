import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DIR = path.join(os.homedir(), ".config/testmail");
const STORE = path.join(DIR, "account.json");

// `mailsy` keeps its account in its own install directory. We read and write it too,
// so the two tools always agree on which inbox is "current" — otherwise `mailsy m`
// silently talks to a different mailbox than `testmail list`.
const MAILSY_STORE = "/opt/homebrew/lib/node_modules/mailsy/data/account.json";

const readJson = (p) => {
  try {
    const raw = fs.readFileSync(p, "utf8").trim();
    return raw && raw !== "null" ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

export const load = () => readJson(STORE) ?? readJson(MAILSY_STORE);

export const save = (acc) => {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(acc, null, 2));
  try {
    fs.writeFileSync(MAILSY_STORE, JSON.stringify(acc, null, 2));
  } catch {
    /* mailsy not installed or not writable — never fatal */
  }
};

export const clear = () => {
  fs.rmSync(STORE, { force: true });
  try {
    fs.writeFileSync(MAILSY_STORE, "null");
  } catch {}
};
