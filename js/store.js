// Persistence. Everything lives under one key so a reset is one line, and a run in progress is
// stored as (origin seed, tier, the digits the player typed, what the run has cost) rather than a
// copy of the board or the solution — the generator is deterministic, so the 题面 never has to
// travel through storage at all. A whole 4×4 run costs well under a kilobyte.

const KEY = 'loshu.save.v1';

const defaults = () => ({
  settings: { sound: true, reduceMotion: false, showNotes: true, mode: 'fill', seenHelp: false },
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

// ---- 两段式解码 ---------------------------------------------------------------------------
// 第一段只管"读出来、解析得动"，第二段只管"这条记录是不是它声称的那种东西"。
// 校验按记录分块：best 里一条脏纪录不许连带清掉存档、resume 坏了就回到选档页而不是崩在开局。
// 手写/半截/被别的版本写歪的 localStorage 在这里被逐条定罪，游戏本身永远能拿到一份合法数据。

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const int = (v, min, max) => (finite(v) && Number.isInteger(v) && v >= min && v <= max ? v : null);
const flag = (v) => (typeof v === 'boolean' ? v : null);

function validSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { ...defaults().settings };
  for (const k of ['sound', 'reduceMotion', 'showNotes', 'seenHelp']) {
    const v = flag(src[k]);
    if (v !== null) out[k] = v;
  }
  if (src.mode === 'fill' || src.mode === 'note') out.mode = src.mode;
  return out;
}

function validTotals(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { ...defaults().totals };
  for (const k of ['solved', 'hints']) {
    const v = int(src[k], 0, 1e9);
    if (v !== null) out[k] = v;
  }
  if (finite(src.ms) && src.ms >= 0) out.ms = Math.round(src.ms);
  return out;
}

// 一条纪录要有"能格式化的时间 + 非负整数计数 + 可显示的盘面尺寸"，缺一就不是纪录。
// 时间只校验到"有限非负"，因为计时本身按 ms 取整；NaN 会一路流到 fmtMs 变成 "NaN:NaN"。
function validBest(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const [tier, rec] of Object.entries(src)) {
    if (!rec || typeof rec !== 'object' || typeof tier !== 'string') continue;
    const ms = int(rec.ms, 0, 86400000 * 30);
    const hints = int(rec.hints, 0, 100000);
    const moves = int(rec.moves, 0, 1000000);
    if (ms === null || hints === null || moves === null) continue;
    out[tier] = {
      ms,
      hints,
      moves,
      size: typeof rec.size === 'string' ? rec.size.slice(0, 24) : '—',
      at: int(rec.at, 0, Number.MAX_SAFE_INTEGER) ?? Date.now(),
    };
  }
  return out;
}

// RLE 的合法域很小（值 0..n²+1 移位后 ≤ 256、长度 ≤ 255），而且必须成对。
// 逐对校验：坏的对丢掉、好的对留下，长度不够就由 rleDecode 补 0（空格）。
function validInk(raw, cells) {
  if (!Array.isArray(raw)) return [];
  const pairs = [];
  for (let p = 0; p + 1 < raw.length; p += 2) {
    const value = int(raw[p], 0, 256);
    const run = int(raw[p + 1], 1, 255);
    if (value === null || run === null) continue;
    pairs.push(value, run);
  }
  return pairs;
}

function validNotes(raw, cells) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (let p = 0; p + 1 < raw.length; p += 2) {
    const t = int(raw[p], 0, cells - 1);
    const mask = int(Number.parseInt(String(raw[p + 1]), 16), 1, 0xffff);
    if (t === null || mask === null) continue;
    out.push(t, mask.toString(16));
  }
  return out;
}

function validResume(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const cells = int(raw.cells, 1, 400);
  if (cells === null) return null;
  if (typeof raw.tier !== 'string' || !raw.tier || raw.tier.length > 24) return null;
  if (typeof raw.seed !== 'string' || !raw.seed || raw.seed.length > 64) return null;
  const elapsedMs = int(raw.elapsedMs, 0, 86400000 * 30);
  return {
    seed: raw.seed,
    tier: raw.tier,
    cells,
    elapsedMs: elapsedMs === null ? 0 : elapsedMs,
    ink: validInk(raw.ink, cells),
    notes: validNotes(raw.notes, cells),
    moves: int(raw.moves, 0, 1000000) ?? 0,
    hints: int(raw.hints, 0, 100000) ?? 0,
    at: int(raw.at, 0, Number.MAX_SAFE_INTEGER) ?? Date.now(),
  };
}

function load() {
  let parsed = null;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    parsed = JSON.parse(raw);
  } catch {
    return defaults(); // 半截 JSON / 非 JSON：整份当没有，游戏照样从默认值开跑
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaults();
  const base = defaults();
  return {
    settings: validSettings(parsed.settings),
    best: validBest(parsed.best),
    totals: validTotals(parsed.totals),
    resume: validResume(parsed.resume),
  };
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
    // 解码的是 load() 验过形状的那条记录：这里只管把字节展开，不再兜脏数据。
    return {
      ...r,
      fill: rleDecode(r.ink, r.cells),
      notes: notesDecode(r.notes, r.cells),
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
