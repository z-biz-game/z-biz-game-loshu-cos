// Persistence. Everything lives under one key so a reset is one line, and a run in progress is
// stored as (origin seed, tier, the digits the player typed, what the run has cost) rather than a
// copy of the board or the solution — the generator is deterministic, so the 题面 never has to
// travel through storage at all. A whole 4×4 run costs well under a kilobyte.

const KEY = 'loshu.save.v1';

const defaults = () => ({
  settings: { sound: true, reduceMotion: false, showNotes: true, mode: 'fill' },
  best: {},
  resume: null,
  totals: { solved: 0, hints: 0, ms: 0 },
});

// EMPTY is 0 and the digits run 1..n², so the run-length code shifts by one to keep a filled
// cell distinct from "no more pairs". Players quit early, which leaves a board mostly empty, and
// that is exactly the case RLE is cheap in.
const SHIFT = 1;

function rleEncode(ink) {
  const out = [];
  let run = (ink[0] ?? 0) + SHIFT;
  let n = 1;
  for (let i = 1; i < ink.length; i++) {
    if (ink[i] + SHIFT === run && n < 255) n++;
    else {
      out.push(run, n);
      run = ink[i] + SHIFT;
      n = 1;
    }
  }
  out.push(run, n);
  return out;
}

function rleDecode(pairs, len) {
  const b = new Int8Array(len);
  let i = 0;
  for (let p = 0; p + 1 < pairs.length; p += 2) {
    const v = pairs[p] - SHIFT;
    const n = pairs[p + 1];
    for (let k = 0; k < n && i < len; k++) b[i++] = v;
  }
  return b;
}

// Notes are a 16-bit mask per cell, which is a lot of zeros and a handful of small integers.
// Only the non-zero ones are written, and the value is stored as a hex string so a hand-edited
// save cannot smuggle a float or a negative into a Uint16Array.
function notesEncode(notes) {
  const out = [];
  for (let t = 0; t < notes.length; t++) if (notes[t]) out.push(t, notes[t].toString(16));
  return out;
}

function notesDecode(list, len) {
  const b = new Uint16Array(len);
  for (let p = 0; p + 1 < list.length; p += 2) {
    const t = list[p];
    const v = Number.parseInt(String(list[p + 1]), 16);
    if (Number.isInteger(t) && t >= 0 && t < len && Number.isInteger(v)) b[t] = v & 0xffff;
  }
  return b;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw);
    const base = defaults();
    return {
      ...base,
      ...parsed,
      settings: { ...base.settings, ...(parsed.settings || {}) },
      totals: { ...base.totals, ...(parsed.totals || {}) },
    };
  } catch {
    return defaults();
  }
}

export const Store = {
  data: load(),
  key: KEY,

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* private mode / quota — the game stays playable, just forgetful */
    }
  },

  setting(name) {
    return this.data.settings[name];
  },
  setSetting(name, value) {
    this.data.settings[name] = value;
    this.save();
  },

  best(tier) {
    return this.data.best[tier] || null;
  },
  // Best is decided by *least help taken* first: a record has to mean "I filled this square
  // myself", and a fast board built on six hints is not that.
  recordBest(tier, { ms, hints, moves, size }) {
    const cur = this.data.best[tier];
    const better =
      !cur ||
      hints < cur.hints ||
      (hints === cur.hints && (moves < cur.moves || (moves === cur.moves && ms < cur.ms)));
    if (better) this.data.best[tier] = { ms, hints, moves, size, at: Date.now() };
    this.save();
    return better;
  },

  recordSolve(ms, hints) {
    const t = this.data.totals;
    t.solved++;
    t.hints += hints;
    t.ms += ms;
    this.save();
  },

  saveResume(puzzle, state, elapsedMs, run) {
    this.data.resume = {
      // The generator derives its own trial seed from what it is handed, so a resume has to keep
      // the *origin* seed or the redrawn board would not be the one the player left.
      seed: puzzle.originSeed || puzzle.seed,
      tier: puzzle.tier,
      elapsedMs,
      cells: puzzle.n * puzzle.n,
      ink: rleEncode(state.fill),
      notes: notesEncode(state.notes),
      // The cost of the run travels with the board. Without it a player could take six hints,
      // close the tab, come back, and finish with a clean 提示 0 record — and records are ranked
      // by help taken, so the save has to carry the help.
      moves: run.moves,
      hints: run.hints,
      at: Date.now(),
    };
    this.save();
  },

  resume() {
    const r = this.data.resume;
    if (!r) return null;
    return {
      ...r,
      fill: rleDecode(r.ink || [], r.cells || 0),
      notes: notesDecode(r.notes || [], r.cells || 0),
    };
  },

  clearResume() {
    this.data.resume = null;
    this.save();
  },

  reset() {
    this.data = defaults();
    this.save();
  },
};

export { rleEncode, rleDecode, notesEncode, notesDecode, SHIFT };
