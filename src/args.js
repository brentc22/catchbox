// Which flags take a value. Everything else is a switch, and a switch must never eat the
// argument behind it: guessing from the next word turned `show --json 2` into `show 0`.
// A value flag given bare (`--wait` at the end, or before another flag) reads as its fallback.
const VALUE_FLAGS = new Set(["--box", "--grace", "--prefix", "--out", "--wait"]);

export const parseArgs = (argv) => {
  const positional = [];
  const values = new Map();
  const switches = new Set();

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { positional.push(a); continue; }

    const next = argv[i + 1];
    if (VALUE_FLAGS.has(a) && next !== undefined && !next.startsWith("--")) { values.set(a, next); i++; }
    else switches.add(a);
  }

  const has = (name) => switches.has(name) || values.has(name);
  // A bare flag reads as its fallback, so `--wait` alone means the documented 120 seconds.
  const value = (name, fallback = null) => (values.has(name) ? values.get(name) : fallback);
  const seconds = (name, fallback) => {
    const raw = value(name, fallback);
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} needs a number of seconds, got "${raw}"`);
    return n;
  };

  return { positional, has, value, seconds };
};
