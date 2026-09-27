// 幻方 engine. A magic square is not a grid of cells: it is a *set of lines* that must each
// add up to M = n(n²+1)/2, filled with 1..n² each exactly once. So the model here is built
// around groups (rows, columns and the diagonal families) — every deduction below is a
// statement about a group, and a cell's candidate mask is nothing but the intersection of the
// groups that pass through it.
//
// `solve()` is the pencil path: the player's route, the acceptance test for a generated puzzle
// and the only source of hints, so it never backtracks. Search lives only in count.js, and the
// generator trusts neither.
//
// The line sets are written a second time, independently, in count.js — on purpose. Typing an
// order-4 "副对角线" as a wrapped diagonal turns the census of 7040 squares into 1088, and two
// implementations that disagree loudly are cheaper than one that agrees quietly and wrongly.

export const EMPTY = 0;

// Candidate masks are 16 bits, one per value, so n² may not exceed 16.
export const MAX_N = 4;

export const ROW = 'row';
export const COL = 'col';
export const DIAG = 'diag';
export const PAN = 'pan';

const POP = (() => {
  const a = new Uint8Array(1 << 16);
  for (let i = 1; i < a.length; i++) a[i] = a[i >> 1] + (i & 1);
  return a;
})();

export const pop = (m) => POP[m & 0xffff];
export const bitOf = (v) => 1 << (v - 1);
export const hasBit = (m, v) => !!(m & bitOf(v));
// mask with exactly one bit -> that value. 32 - clz32(bit) is the bit index plus one.
export const onlyValue = (m) => 32 - Math.clz32(m & -m);
export function valuesOf(m) {
  const out = [];
  for (let v = 1; v <= 16; v++) if (hasBit(m, v)) out.push(v);
  return out;
}

export function magicSum(n) {
  return (n * (n * n + 1)) / 2;
}

// Σ of the n line sums equals Σ of all values: n·M = n²(n²+1)/2. The UI prints it, the tests
// recompute it, and `count.js` uses it to know when a square is finished without re-adding.
export function sumIdentity(n) {
  const c = n * n;
  return { values: (c * (c + 1)) / 2, lines: n * magicSum(n) };
}

// ---- class properties, each proven by the census in count.js -------------------------------
// `associated` = every square of this class obeys value(rot180(t)) = n²+1 − value(t). The
// 互补对称 rule may only fire where that is true, which is what keeps it a deduction instead of
// a guess dressed up as one. Exhaustive census of the whole class (npm test prints the run):
//   3×3 normal       8 squares,  8 associated  -> true   (and the centre is 5 in all 8)
//   4×4 normal    7 040 squares, 384 associated -> false
//   4×4 pandiagonal  384 squares,   0 associated -> false — the two properties are mutually
//   exclusive at order 4, so 互补对称 is a 九宫-only rule, and the shipped 四四/泛对角 bands use
//   the other five. Measured, not quoted: see DESIGN.md 「复现这些数字」.
export const ASSOCIATED = {
  '3:plain': true,
  '4:plain': false,
  '4:pan': false,
};

// ---- groups: what a line actually is ------------------------------------------------------
export function groupsOf(n, pan) {
  const out = [];
  for (let r = 0; r < n; r++) out.push({ kind: ROW, label: `第${r + 1}行`, cells: Int32Array.from({ length: n }, (_, c) => r * n + c) });
  for (let c = 0; c < n; c++) out.push({ kind: COL, label: `第${c + 1}列`, cells: Int32Array.from({ length: n }, (_, r) => r * n + c) });
  if (pan) {
    // Pandiagonal: the wrap-around diagonals too. These two families already contain the main
    // and the anti diagonal (s = 0 and s = n−1), so they are not added a second time.
    for (let s = 0; s < n; s++) out.push({ kind: PAN, label: `右斜带 ${s + 1}`, cells: Int32Array.from({ length: n }, (_, i) => i * n + ((i + s) % n)) });
    for (let s = 0; s < n; s++) out.push({ kind: PAN, label: `左斜带 ${s + 1}`, cells: Int32Array.from({ length: n }, (_, i) => i * n + ((((s - i) % n) + n) % n)) });
  } else {
    out.push({ kind: DIAG, label: '主对角线', cells: Int32Array.from({ length: n }, (_, i) => i * n + i) });
    // i·n + (n−1−i): for 4×4 that is cells 3, 6, 9, 12 — *not* the wrapped 0, 13, 10, 7, which
    // is a broken diagonal and belongs to the 泛对角 band only.
    out.push({ kind: DIAG, label: '副对角线', cells: Int32Array.from({ length: n }, (_, i) => i * n + (n - 1 - i)) });
  }
  return out;
}

export function createBoard({ n, pan = false, givens }) {
  if (!(n >= 1 && n <= MAX_N)) throw new Error(`本引擎只做 1~${MAX_N} 阶（候选位掩码只有 ${MAX_N * MAX_N} 位）`);
  const size = n * n;
  if (!givens || givens.length !== size) throw new Error('givens length mismatch');
  const M = magicSum(n);
  const groups = groupsOf(n, pan);
  const g = Int8Array.from(givens);
  const givenFlag = new Uint8Array(size);
  const seen = new Uint8Array(size + 1);
  for (let t = 0; t < size; t++) {
    const v = g[t];
    if (v === EMPTY) continue;
    if (v < 1 || v > size) throw new Error(`给定的数 ${v} 不在 1~${size} 之内`);
    if (seen[v]) throw new Error(`同一个数被给了两次：${v}`);
    seen[v] = 1;
    givenFlag[t] = 1;
  }
  const groupsOfCell = Array.from({ length: size }, () => []);
  groups.forEach((gr, i) => {
    for (const t of gr.cells) groupsOfCell[t].push(i);
  });
  // A line whose givens already overshoot M can never be repaired. Saying so here stops a
  // dead-on-arrival board from reading downstream as "推完了但和不对".
  for (const gr of groups) {
    let s = 0;
    let empties = 0;
    const vals = [];
    for (const t of gr.cells) {
      if (g[t] === EMPTY) empties++;
      else {
        s += g[t];
        vals.push(g[t]);
      }
    }
    if (new Set(vals).size !== vals.length) throw new Error(`${gr.label} 里给了两个一样的数`);
    if (s > M) throw new Error(`${gr.label} 给定的数已和到 ${s}，超过 M=${M}`);
    if (empties === 0 && s !== M) throw new Error(`${gr.label} 已满但和是 ${s}，不是 ${M}`);
  }
  return {
    n,
    size,
    pan,
    M,
    band: `${n}:${pan ? 'pan' : 'plain'}`,
    full: size === 16 ? 0xffff : (1 << size) - 1,
    complement: size + 1,
    groups,
    groupsOfCell,
    givens: g,
    givenFlag,
    rot: Int32Array.from({ length: size }, (_, t) => size - 1 - t),
    associated: !!ASSOCIATED[`${n}:${pan ? 'pan' : 'plain'}`],
    cells: Array.from({ length: size }, (_, i) => i),
  };
}

export function createState(board) {
  const st = {
    board,
    fill: Int8Array.from(board.givens),
    notes: new Uint16Array(board.size),
    cand: new Uint16Array(board.size),
    gstate: board.groups.map(() => ({ sum: 0, mask: 0, empty: [] })),
    used: 0,
    dead: false,
    log: [],
    history: [],
    writes: 0,
  };
  rebuild(st);
  return st;
}

// Re-derive every candidate from the ink on the board, remembering nothing: erase a wrong
// number and the pool snaps back to exactly what the remaining ink justifies. Notes are not
// read here at all — see DESIGN.md 「笔记不约束任何东西」.
export function rebuild(st) {
  const { board } = st;
  st.used = 0;
  st.dead = false;
  for (const gr of st.gstate) {
    gr.sum = 0;
    gr.mask = 0;
    gr.empty.length = 0;
  }
  for (let t = 0; t < board.size; t++) {
    const v = st.fill[t];
    if (v === EMPTY) continue;
    st.used |= bitOf(v);
    for (const gi of board.groupsOfCell[t]) {
      const gr = st.gstate[gi];
      gr.sum += v;
      gr.mask |= bitOf(v);
    }
  }
  for (let gi = 0; gi < board.groups.length; gi++) {
    for (const t of board.groups[gi].cells) if (st.fill[t] === EMPTY) st.gstate[gi].empty.push(t);
  }
  for (let t = 0; t < board.size; t++) {
    if (st.fill[t] !== EMPTY) {
      st.cand[t] = 0;
      continue;
    }
    // A value is possible for a cell only if the whole board does not use it already and no
    // line through that cell uses it.
    let m = board.full & ~st.used;
    for (const gi of board.groupsOfCell[t]) m &= ~st.gstate[gi].mask;
    st.cand[t] = m;
    if (!m) st.dead = true;
  }
  for (let gi = 0; gi < board.groups.length; gi++) {
    const gr = st.gstate[gi];
    if (gr.sum > board.M) st.dead = true;
    if (!gr.empty.length && gr.sum !== board.M) st.dead = true;
    if (gr.empty.length && !reachable(st, gi)) st.dead = true;
  }
  return st;
}

// ---- subset-sum reachability --------------------------------------------------------------
// For a line with k blanks that must add up to d: which candidate values can take part in
// *some* k-subset hitting d? Ignoring which blank each value goes into makes this a
// relaxation, so dropping everything else is sound — and it is exactly the arithmetic a player
// does on paper ("这几个数怎么凑都凑不出 17").

const SUBSET_CACHE = new Map();
const CACHE_CAP = 200000;

// vals: ascending, no repeats. Returns { ok, mask } — mask is the union of values appearing in
// any k-subset of vals summing to want.
export function subsetReach(vals, k, want) {
  const key = k + '|' + want + '|' + vals.join(',');
  const hit = SUBSET_CACHE.get(key);
  if (hit) return hit;
  const out = { ok: false, mask: 0 };
  const chosen = [];
  const walk = (from, left, sum) => {
    if (left === 0) {
      if (sum === want) {
        out.ok = true;
        for (const v of chosen) out.mask |= bitOf(v);
      }
      return;
    }
    for (let i = from; i <= vals.length - left; i++) {
      const s = sum + vals[i];
      if (s > want) break; // ascending and all positive, so everything past here is worse
      chosen.push(vals[i]);
      walk(i + 1, left - 1, s);
      chosen.pop();
    }
  };
  if (k === 0) out.ok = want === 0;
  else if (vals.length >= k && want > 0) walk(0, k, 0);
  if (SUBSET_CACHE.size > CACHE_CAP) SUBSET_CACHE.clear();
  SUBSET_CACHE.set(key, out);
  return out;
}

// Union of a line's blank-cell candidates, ascending.
export function lineValues(st, gi) {
  const gr = st.gstate[gi];
  let m = 0;
  for (const t of gr.empty) m |= st.cand[t];
  const out = [];
  for (let v = 1; v <= st.board.size; v++) if (hasBit(m, v)) out.push(v);
  return out;
}

export function reachable(st, gi) {
  const gr = st.gstate[gi];
  return subsetReach(lineValues(st, gi), gr.empty.length, st.board.M - gr.sum).ok;
}

// ---- the rules ----------------------------------------------------------------------------
// Each one states something true in *every* square of the class, so applying them in any order,
// to any depth, can never rule out the real answer.

export const Rules = {
  // A row or column with one blank left: the deficit is the answer. Plus the hidden single —
  // a value that has exactly one home left among every empty cell on the board (see the note at
  // the check itself: the line-scoped version of that sentence is not a rule of this game).
  lineClose: {
    name: '行列补全',
    weight: 1,
    text: (b, d) =>
      d.via === 'hidden'
        ? `${b.groups[d.group].label}里 ${d.value} 只剩一格放得下：${cellName(b, d.cell)}（全盘再没有第二个格子容得下它）`
        : `${b.groups[d.group].label}只差一格：M=${b.M} 减已和 ${d.sum} = ${d.value}，所以 ${cellName(b, d.cell)} = ${d.value}`,
  },
  // The cell itself has been squeezed down to one candidate by the lines through it.
  onlyCandidate: {
    name: '候选排除',
    weight: 1.5,
    text: (b, d) => `${cellName(b, d.cell)} 的候选只剩 ${d.value}：${linesThrough(b, d.cell).join('、')} 把别的数都挤掉了`,
  },
  // Which values can still take part in a row's or column's sum at all.
  rangePrune: {
    name: '区间剪枝',
    weight: 2.5,
    text: (b, d) =>
      d.dead
        ? `${b.groups[d.group].label}还差 ${d.want}、剩 ${d.k} 格，怎么也凑不出来`
        : `${b.groups[d.group].label}还差 ${d.want}、只剩 ${d.k} 格：凑得出 ${d.want} 的组合里没有 ${d.value}，${cellName(b, d.cell)} 不是 ${d.value}`,
  },
  // The same arithmetic on the diagonal families — the lines that make a 幻方 more than a
  // row/column puzzle.
  diagPrune: {
    name: '对角线',
    weight: 2,
    text: (b, d) =>
      d.dead
        ? `${b.groups[d.group].label}还差 ${d.want}、剩 ${d.k} 格凑不出来`
        : d.via === 'deficit'
          ? `${b.groups[d.group].label}只差一格：M=${b.M} 减已和 ${d.sum} = ${d.value}，所以 ${cellName(b, d.cell)} = ${d.value}`
          : `${b.groups[d.group].label}要凑 ${d.want}（剩 ${d.k} 格）：含 ${d.value} 的组合一个都不存在，所以 ${cellName(b, d.cell)} ≠ ${d.value}`,
  },
  // Only where the whole class is proven associated (九宫/洛书): opposite cells complement.
  complement: {
    name: '互补对称',
    weight: 3,
    text: (b, d) =>
      d.pruned
        ? `${b.n} 阶${b.pan ? '泛对角' : '洛书'}这一类的每一盘都中心互补：${cellName(b, d.cell)} 与 ${cellName(b, b.rot[d.cell])} 必凑成 ${b.complement}，所以它不是 ${d.value}`
        : `${b.n} 阶${b.pan ? '泛对角' : '洛书'}这一类的每一盘都中心互补：${cellName(b, d.from)} = ${d.fromValue}，${cellName(b, d.cell)} 在它对面，两数凑成 ${b.complement} → ${d.value}`,
  },
  // One assumption deep, and only once everything above has stalled.
  nishio: {
    name: '反证',
    weight: 6,
    text: (b, d) => `假设 ${cellName(b, d.cell)} = ${d.value}，把规则推到底会出现凑不出的线，所以 ${cellName(b, d.cell)} ≠ ${d.value}`,
  },
};

export const cellName = (b, t) => `第${Math.floor(t / b.n) + 1}行第${(t % b.n) + 1}列`;
const linesThrough = (b, t) => b.groupsOfCell[t].map((gi) => b.groups[gi].label);

// One sweep of the unit rules. Returns 'dead', 'idle', or the deductions applied.
export function propagate(st, opts = {}) {
  const { board } = st;
  const found = [];
  const apply = (d) => {
    if (d.kind === 'dead') {
      st.dead = true;
      found.push(d);
      return 'dead';
    }
    if (!opts.previewOnly) applyDeduction(st, d, true);
    found.push(d);
    return null;
  };

  // 0. a line whose deficit cannot be met ends the sweep immediately.
  for (let gi = 0; gi < board.groups.length; gi++) {
    if (st.gstate[gi].empty.length && !reachable(st, gi)) {
      st.dead = true;
      return { status: 'dead', found };
    }
  }

  // 1. rows and columns: one blank left -> forced; a value with one home -> placed.
  for (let gi = 0; gi < board.groups.length; gi++) {
    const kind = board.groups[gi].kind;
    if (kind !== ROW && kind !== COL) continue;
    const gr = st.gstate[gi];
    if (!gr.empty.length) continue;
    if (gr.empty.length === 1) {
      const t = gr.empty[0];
      const v = board.M - gr.sum;
      if (v >= 1 && v <= board.size && hasBit(st.cand[t], v)) {
        if (apply({ kind: 'place', cell: t, value: v, group: gi, via: 'deficit', sum: gr.sum, rule: Rules.lineClose }) === 'dead') return { status: 'dead', found };
      }
      continue;
    }
    if (gr.empty.length > 3) continue;
    let stop = false;
    for (const v of lineValues(st, gi)) {
      // The hidden single is sound only board-wide: 1~n² each appears once *somewhere*, so when
      // no other empty cell on the board can take v, the one that can is forced. Counting homes
      // inside this line alone is the Sudoku habit — there every digit really does visit every
      // row, and here it need not. The line-scoped version wrote a 2 into a 泛对角 row that had
      // to reach 34 without it, and tools/verify.sh's hint scenario caught the dead board.
      const homes = board.cells.filter((t) => st.fill[t] === EMPTY && hasBit(st.cand[t], v));
      if (!homes.length) {
        // lineValues() is derived from these same masks, so an empty home list means the masks
        // and the line stopped agreeing: that is a dead state, not a missed deduction.
        st.dead = true;
        return { status: 'dead', found };
      }
      if (homes.length === 1) {
        if (apply({ kind: 'place', cell: homes[0], value: v, group: gi, via: 'hidden', sum: gr.sum, rule: Rules.lineClose }) === 'dead') return { status: 'dead', found };
        stop = true;
        break;
      }
    }
    if (stop) continue;
  }

  // 2. naked singles, cell level.
  for (const t of board.cells) {
    if (st.fill[t] !== EMPTY) continue;
    const m = st.cand[t];
    if (!m) {
      st.dead = true;
      return { status: 'dead', found };
    }
    if (pop(m) === 1) apply({ kind: 'place', cell: t, value: onlyValue(m), rule: Rules.onlyCandidate });
  }

  // 3. range pruning on rows and columns.
  for (let gi = 0; gi < board.groups.length; gi++) {
    const kind = board.groups[gi].kind;
    if (kind !== ROW && kind !== COL) continue;
    for (const d of prunesFor(st, gi, Rules.rangePrune)) if (apply(d) === 'dead') return { status: 'dead', found };
  }

  // 4. the diagonal families: forced last cell, then the same subset-sum cut.
  for (let gi = 0; gi < board.groups.length; gi++) {
    const kind = board.groups[gi].kind;
    if (kind !== DIAG && kind !== PAN) continue;
    const gr = st.gstate[gi];
    if (!gr.empty.length) continue;
    if (gr.empty.length === 1) {
      const t = gr.empty[0];
      const v = board.M - gr.sum;
      if (v >= 1 && v <= board.size && hasBit(st.cand[t], v)) {
        if (apply({ kind: 'place', cell: t, value: v, group: gi, via: 'deficit', sum: gr.sum, rule: Rules.diagPrune }) === 'dead') return { status: 'dead', found };
        continue;
      }
    }
    for (const d of prunesFor(st, gi, Rules.diagPrune)) if (apply(d) === 'dead') return { status: 'dead', found };
  }

  // 5. complement symmetry, only where the class is proven associated.
  if (board.associated) {
    for (let t = 0; t < board.size; t++) {
      const v = st.fill[t];
      if (v === EMPTY) continue;
      const u = board.rot[t];
      if (u === t || st.fill[u] !== EMPTY) continue;
      const want = board.complement - v;
      if (want < 1 || want > board.size) continue;
      if (hasBit(st.cand[u], want)) {
        if (apply({ kind: 'place', cell: u, value: want, from: t, fromValue: v, rule: Rules.complement }) === 'dead') return { status: 'dead', found };
      }
    }
  }

  return { status: found.length ? 'progress' : 'idle', found };
}

// Values in a line's blanks that appear in no k-subset summing to the deficit.
function prunesFor(st, gi, rule) {
  const { board } = st;
  const gr = st.gstate[gi];
  if (!gr.empty.length) return [];
  const k = gr.empty.length;
  const want = board.M - gr.sum;
  const vals = lineValues(st, gi);
  const reach = subsetReach(vals, k, want);
  if (!reach.ok) return [{ kind: 'dead', group: gi, want, k, rule, dead: true }];
  if (k > 8) return [];
  const out = [];
  for (const t of gr.empty) {
    const drop = st.cand[t] & ~reach.mask;
    if (!drop) continue;
    for (const v of valuesOf(drop)) out.push({ kind: 'prune', cell: t, value: v, group: gi, want, k, rule });
  }
  return out;
}

export function cloneState(board, st) {
  return {
    board,
    fill: Int8Array.from(st.fill),
    notes: Uint16Array.from(st.notes),
    cand: Uint16Array.from(st.cand),
    gstate: board.groups.map((_, i) => ({ sum: st.gstate[i].sum, mask: st.gstate[i].mask, empty: st.gstate[i].empty.slice() })),
    used: st.used,
    dead: st.dead,
    log: [],
    history: [],
    writes: 0,
  };
}

// The single way a value enters the board inside the engine: it also removes that value from
// every line's pool, which is where "行列补全" gets its force from.
function placeValue(st, t, v) {
  const { board } = st;
  if (st.fill[t] !== EMPTY || !(v >= 1 && v <= board.size)) return false;
  st.fill[t] = v;
  st.cand[t] = 0;
  st.used |= bitOf(v);
  st.notes[t] = 0;
  for (const gi of board.groupsOfCell[t]) {
    const gr = st.gstate[gi];
    gr.sum += v;
    gr.mask |= bitOf(v);
    const at = gr.empty.indexOf(t);
    if (at >= 0) gr.empty.splice(at, 1);
  }
  const b = bitOf(v);
  for (const u of board.cells) if (st.fill[u] === EMPTY) st.cand[u] &= ~b;
  return true;
}

export function applyDeduction(st, d, quiet = false) {
  const { board } = st;
  if (d.kind === 'place') {
    const done = placeValue(st, d.cell, d.value);
    if (done) {
      if (!quiet) st.log.push({ rule: d.rule.name, cell: d.cell, value: d.value });
      st.writes++;
    }
    return done;
  }
  if (d.kind === 'prune') {
    if (st.fill[d.cell] !== EMPTY || !hasBit(st.cand[d.cell], d.value)) return false;
    st.cand[d.cell] &= ~bitOf(d.value);
    if (!quiet) st.log.push({ rule: d.rule.name, cell: d.cell, value: d.value, prune: true });
    return true;
  }
  if (d.kind === 'dead') {
    st.dead = true;
    return false;
  }
  return false;
}

// ---- the pencil path ------------------------------------------------------------------------

export function solve(board, seedState = null) {
  const st = seedState ? cloneState(board, seedState) : createState(board);
  if (!seedState) resetInk(st);
  const used = new Map();
  const rows = [];
  let nishioUsed = 0;
  let guard = 0;
  for (;;) {
    const sweep = propagate(st);
    for (const d of sweep.found) {
      bump(used, d.rule.name, d.rule.weight);
      if (d.kind !== 'dead') rows.push({ rule: d.rule.name, kind: d.kind, text: d.rule.text(board, d), cell: d.cell, value: d.value });
    }
    if (sweep.status === 'dead') {
      return { ok: false, dead: true, steps: count(used), nishio: nishioUsed, score: score(used), state: st, rows, breakdown: Object.fromEntries(used) };
    }
    if (sweep.status === 'progress') {
      if (++guard > 4000) return { ok: false, dead: false, unfinished: true, steps: count(used), nishio: nishioUsed, score: score(used), state: st, rows, breakdown: Object.fromEntries(used) };
      continue;
    }
    if (filled(board, st.fill)) break;
    const hard = findContradiction(st);
    if (!hard) break;
    applyDeduction(st, hard);
    bump(used, hard.rule.name, hard.rule.weight);
    nishioUsed++;
    rows.push({ rule: hard.rule.name, kind: 'prune', text: hard.rule.text(board, hard), cell: hard.cell, value: hard.value });
  }
  const empty = board.cells.filter((t) => st.fill[t] === EMPTY).length;
  const ok = complete(board, st.fill) && empty === 0;
  return {
    ok,
    dead: false,
    empty,
    steps: count(used),
    nishio: nishioUsed,
    score: score(used),
    breakdown: Object.fromEntries(used),
    state: st,
    rows,
  };
}

function bump(map, name, weight) {
  const cur = map.get(name) || { n: 0, weight };
  cur.n++;
  map.set(name, cur);
}
const count = (map) => [...map.values()].reduce((a, x) => a + x.n, 0);
const score = (map) => {
  let s = 0;
  for (const x of map.values()) s += x.n * x.weight;
  return Math.round(s * 10) / 10;
};

// The next single deduction the board offers, for 问一步 and for hints. Placements come first
// because those are what a player can act on; a bare candidate deletion is still a real step
// in this game (划掉一个候选就是推进), so it is reported with its own rule name.
export function nextDeduction(st) {
  const { board } = st;
  if (filled(board, st.fill)) return null;
  const preview = propagate(cloneState(board, st), { previewOnly: true });
  if (preview.status === 'dead') return null;
  const placed = preview.found.filter((d) => d.kind === 'place');
  if (placed.length) return placed[0];
  const cut = preview.found.filter((d) => d.kind === 'prune');
  if (cut.length) return cut[0];
  return findContradiction(st);
}

// depth-1: assume one candidate for one cell, run the unit rules; if the board dies, that
// value is impossible. The only place anything is hypothesised, and its conclusion is still a
// proof — which is why it can be a hint.
export function findContradiction(st) {
  const { board } = st;
  for (const t of board.cells) {
    if (st.fill[t] !== EMPTY) continue;
    const m = st.cand[t];
    for (const v of valuesOf(m)) {
      const probe = cloneState(board, st);
      probe.fill[t] = v;
      rebuild(probe);
      let died = probe.dead;
      let guard = 0;
      while (!died && guard++ < 400) {
        const r = propagate(probe);
        if (r.status === 'dead') died = true;
        else if (r.status === 'idle') break;
      }
      if (died) return { kind: 'prune', cell: t, value: v, rule: Rules.nishio };
      if (guard >= 400) return null; // runaway guard: never report a conclusion we did not reach
    }
  }
  return null;
}

export function resetInk(st) {
  st.fill = Int8Array.from(st.board.givens);
  st.notes.fill(0);
  st.log.length = 0;
  st.history.length = 0;
  st.writes = 0;
  rebuild(st);
  return st;
}

// ---- what a gesture is allowed to write -----------------------------------------------------

// One snapshot per gesture, so 撤销 takes back a whole action instead of one bit of it.
export function snapshot(st) {
  st.history.push({ fill: Int8Array.from(st.fill), notes: Uint16Array.from(st.notes) });
  if (st.history.length > 500) st.history.shift();
  return st;
}

export function undo(st) {
  const last = st.history.pop();
  if (!last) return false;
  st.fill.set(last.fill);
  st.notes.set(last.notes);
  st.writes = Math.max(0, st.writes - 1);
  rebuild(st);
  return true;
}

// Every rejection states why, in the language of the rules: an illegal entry is never silently
// swallowed, and the reason is the same arithmetic the win check uses.
export function tryPlace(st, t, v) {
  const { board } = st;
  if (t < 0 || t >= board.size) return { ok: false, reason: '没有这一格' };
  if (board.givenFlag[t]) return { ok: false, reason: `${cellName(board, t)} 是题面给的 ${board.givens[t]}，动不了`, given: true };
  if (!(v >= 1 && v <= board.size)) return { ok: false, reason: `${v} 不在 1~${board.size} 之内` };
  if (st.fill[t] === v) return { ok: false, reason: `${cellName(board, t)} 本来就是 ${v}，不必再填一次`, same: true };
  for (let u = 0; u < board.size; u++) {
    if (st.fill[u] === v) return { ok: false, reason: `${v} 已经用在 ${cellName(board, u)}：1~${board.size} 每个数只能用一次`, clash: u };
  }
  for (const gi of board.groupsOfCell[t]) {
    const gr = st.gstate[gi];
    if (gr.sum + v > board.M) return { ok: false, reason: `${board.groups[gi].label}会到 ${gr.sum + v}，超过 M=${board.M}`, over: true };
  }
  snapshot(st);
  if (st.fill[t] !== EMPTY) {
    // Replace the old entry by rebuilding the pool from scratch, then placing.
    st.fill[t] = EMPTY;
    rebuild(st);
  }
  placeValue(st, t, v);
  st.log.push({ rule: '手填', cell: t, value: v });
  return { ok: true, cell: t, value: v };
}

export function eraseCell(st, t) {
  const { board } = st;
  if (t < 0 || t >= board.size) return false;
  if (board.givenFlag[t] || st.fill[t] === EMPTY) return false;
  snapshot(st);
  st.fill[t] = EMPTY;
  rebuild(st);
  return true;
}

// A note is a thought, not a decision: neither rebuild() nor propagate() reads it, so a wrong
// note can never make a solvable board unsolvable. diagnose() reports the notes that contradict
// the current pool and the UI says so out loud.
export function toggleNote(st, t, v) {
  const { board } = st;
  if (t < 0 || t >= board.size || !(v >= 1 && v <= board.size)) return false;
  if (board.givenFlag[t] || st.fill[t] !== EMPTY) return false;
  snapshot(st);
  const b = bitOf(v);
  st.notes[t] ^= b;
  st.writes++;
  return !!(st.notes[t] & b);
}

// ---- acceptance test, independent of the candidate pool ------------------------------------

// Reads only the numbers on the board and the rules of the game: 1..n² each exactly once, every
// line exactly M, plus the broken diagonals when the band asks for them. Nothing here looks at
// `cand`, so a bug in the pruning cannot fake a win.
export function verify(board, fill) {
  const bad = [];
  const seen = new Uint8Array(board.size + 1);
  for (let t = 0; t < board.size; t++) {
    const v = fill[t];
    if (v === EMPTY) {
      bad.push({ why: '空格', cell: t });
      continue;
    }
    if (v < 1 || v > board.size) bad.push({ why: `数 ${v} 出界`, cell: t });
    else if (seen[v]) bad.push({ why: `${v} 用了两次`, cell: t });
    else seen[v] = 1;
  }
  for (const gr of board.groups) {
    let s = 0;
    const vals = [];
    for (const t of gr.cells) {
      s += fill[t];
      vals.push(fill[t]);
    }
    if (new Set(vals).size !== vals.length) bad.push({ why: `${gr.label} 里有重复的数`, cells: Array.from(gr.cells) });
    else if (s !== board.M) bad.push({ why: `${gr.label} 的和是 ${s}，不是 ${board.M}`, cells: Array.from(gr.cells), sum: s, want: board.M });
  }
  return bad;
}

export const filled = (board, fill) => board.cells.every((t) => fill[t] !== EMPTY);
export function complete(board, fill) {
  return filled(board, fill) && verify(board, fill).length === 0;
}

// ---- readouts for the UI --------------------------------------------------------------------

export function diagnose(st) {
  const { board } = st;
  let filledCount = 0;
  for (const t of board.cells) if (st.fill[t] !== EMPTY) filledCount++;
  const lines = board.groups.map((gr, gi) => {
    const g = st.gstate[gi];
    const k = g.empty.length;
    const reach = k ? subsetReach(lineValues(st, gi), k, board.M - g.sum) : { ok: g.sum === board.M, mask: 0 };
    const dup = (() => {
      const seen = new Set();
      for (const t of gr.cells) {
        const v = st.fill[t];
        if (v === EMPTY) continue;
        if (seen.has(v)) return true;
        seen.add(v);
      }
      return false;
    })();
    return {
      gi,
      kind: gr.kind,
      label: gr.label,
      cells: Array.from(gr.cells),
      sum: g.sum,
      want: board.M,
      empty: k,
      dup,
      done: k === 0 && g.sum === board.M,
      closed: k === 0,
      over: g.sum > board.M,
      unreachable: k > 0 && !reach.ok,
      deficit: board.M - g.sum,
      // 这一行的候选和：区间剪枝对玩家可见的那部分（最小/最大可成之和）
      bounds: k ? boundsOf(lineValues(st, gi), k) : null,
    };
  });
  const valuesUsed = new Uint8Array(board.size + 1);
  const countOf = new Uint8Array(board.size + 1);
  for (const t of board.cells) {
    const v = st.fill[t];
    if (v === EMPTY) continue;
    valuesUsed[v] = 1;
    countOf[v]++;
  }
  const dupValues = [];
  for (let v = 1; v <= board.size; v++) if (countOf[v] > 1) dupValues.push(v);
  const badCells = new Set();
  for (const l of lines) {
    if (l.over || l.unreachable || l.dup) for (const t of l.cells) if (st.fill[t] !== EMPTY && !board.givenFlag[t]) badCells.add(t);
  }
  for (const v of dupValues) for (const t of board.cells) if (st.fill[t] === v && !board.givenFlag[t]) badCells.add(t);
  let dubiousNotes = 0;
  const noteList = [];
  for (let t = 0; t < board.size; t++) {
    if (!st.notes[t]) continue;
    for (const v of valuesOf(st.notes[t])) {
      if (st.fill[t] !== EMPTY || !hasBit(st.cand[t], v)) {
        dubiousNotes++;
        noteList.push({ cell: t, value: v });
      }
    }
  }
  const missingValues = [];
  for (let v = 1; v <= board.size; v++) if (!valuesUsed[v]) missingValues.push(v);
  return {
    filled: filledCount,
    total: board.size,
    remaining: board.size - filledCount,
    lines,
    lineCount: lines.length,
    lineDone: lines.filter((l) => l.done).length,
    lineClosed: lines.filter((l) => l.closed).length,
    lineBad: lines.filter((l) => l.over || l.unreachable || l.dup || (l.closed && l.sum !== l.want)).length,
    valuesUsed,
    dupValues,
    badCells,
    dubiousNotes,
    stuck: st.dead || lines.some((l) => l.unreachable),
    missingValues,
    clueCount: board.cells.filter((t) => board.givenFlag[t]).length,
    candidates: Int32Array.from(st.cand),
  };
}

// The min/max of any k-subset, used to tell the player how wide a line still is.
function boundsOf(vals, k) {
  if (vals.length < k) return null;
  const lo = vals.slice(0, k).reduce((a, v) => a + v, 0);
  const hi = vals.slice(vals.length - k).reduce((a, v) => a + v, 0);
  return { lo, hi };
}

// What the lines through a cell mean right now, in the same arithmetic the win check uses:
// the game is about lines, so that is what the readout talks about.
export function lineReadout(board, fill, t) {
  if (t < 0 || t >= board.size) return { ok: false, text: '' };
  let bad = 0;
  const parts = board.groupsOfCell[t].map((gi) => {
    const gr = board.groups[gi];
    let s = 0;
    let k = 0;
    for (const u of gr.cells) {
      if (fill[u] === EMPTY) k++;
      else s += fill[u];
    }
    const tail = k ? `差 ${board.M - s}（剩 ${k} 格）` : s === board.M ? '✓ 和对了' : `✗ 和是 ${s}`;
    if (!k && s !== board.M) bad++;
    return `${gr.label} ${s} · ${tail}`;
  });
  return { ok: !bad, text: `${cellName(board, t)} 所在线：${parts.join(' · ')}`, lines: parts, bad };
}

// The checksum under the board. If this line is ever wrong on screen the model is broken, which
// is exactly why it is on screen.
export function identityText(board) {
  const id = sumIdentity(board.n);
  return `Σ线 = n·M = ${board.n}×${board.M} = ${id.lines} = 1+2+…+${board.size}`;
}
