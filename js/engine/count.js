// Independent solution counter and census. It shares nothing with solve(): no candidate masks,
// no subset-sum cache, no rules. It re-derives the line sets from the rule text, fills cells in
// order and checks sums the way a person marking an answer sheet would. The generator only ships
// a board when this and the pencil solver agree, cell by cell.
//
// The same file answers the "how many are there" questions the README quotes. Those numbers are
// produced by running it (npm test), never typed in from a book: an earlier draft of this repo
// used a wrapped diagonal where the plain anti-diagonal belongs and "counted" 1088 order-4
// squares instead of the true total. Having the line sets written twice, and asserted against
// Dürer's square and Lo Shu by hand-written literals, is what keeps that failure mode open.

export const EMPTY = 0;
export const UNIQUE = 'UNIQUE';
export const MANY = 'MANY';
export const NONE = 'NONE';
export const OVERBUDGET = 'OVERBUDGET';

// Written from the sentence "每行、每列、两条主对角线（泛对角再加环绕对角线）", not imported.
export function linesFor(n, pan) {
  const at = (r, c) => r * n + c;
  const rows = [];
  for (let r = 0; r < n; r++) rows.push(Array.from({ length: n }, (_, c) => at(r, c)));
  const cols = [];
  for (let c = 0; c < n; c++) cols.push(Array.from({ length: n }, (_, r) => at(r, c)));
  const main = Array.from({ length: n }, (_, i) => at(i, i));
  const anti = Array.from({ length: n }, (_, i) => at(i, n - 1 - i));
  if (!pan) return [...rows, ...cols, main, anti];
  // Pandiagonal: n "right" wraps and n "left" wraps. main is wrap #0 of the first family and
  // anti is wrap #n-1 of the second, so they are not listed twice here either.
  const wraps = [];
  for (let s = 0; s < n; s++) wraps.push(Array.from({ length: n }, (_, i) => at(i, (i + s) % n)));
  for (let s = 0; s < n; s++) wraps.push(Array.from({ length: n }, (_, i) => at(i, (((s - i) % n) + n) % n)));
  return [...rows, ...cols, ...wraps];
}

const M = (n) => (n * (n * n + 1)) / 2;

// ---- counting one puzzle -------------------------------------------------------------------

// `cap` solutions ends the search early; `budget` bounds the nodes so a pathological board
// reports OVERBUDGET instead of hanging. Forced completion (a line with a single blank left has
// exactly one value that fits) is used as a prune: it is the rule of the game itself, not a
// candidate theory, so it cannot cut a real solution.
export function countSolutions(board, { cap = 2, budget = 400_000, givens = null } = {}) {
  const n = board.n;
  const size = n * n;
  const target = M(n);
  const lines = linesFor(n, board.pan);
  // Which lines end at which cell, and how many blanks each still has.
  const at = Array.from({ length: size }, () => []);
  lines.forEach((L, i) => L.forEach((t) => at[t].push(i)));
  const grid = new Int8Array(size);
  const givenCopy = givens ? Int8Array.from(givens) : Int8Array.from(board.givens);
  const usedMask = new Uint32Array(1);
  const blanks = lines.map((L) => L.length);
  const sums = lines.map(() => 0);
  let nodes = 0;
  let solutions = 0;
  let exhausted = true;
  let first = null;

  const take = (t, v) => {
    grid[t] = v;
    usedMask[0] |= 1 << (v - 1);
    for (const i of at[t]) {
      blanks[i]--;
      sums[i] += v;
    }
  };
  const drop = (t, v) => {
    grid[t] = EMPTY;
    usedMask[0] &= ~(1 << (v - 1));
    for (const i of at[t]) {
      blanks[i]++;
      sums[i] -= v;
    }
  };

  // Fill everything that is forced, and fail on the first line that cannot be completed.
  const force = () => {
    const placed = [];
    for (;;) {
      let moved = false;
      for (let i = 0; i < lines.length; i++) {
        if (blanks[i] === 0) {
          if (sums[i] !== target) return { died: true, placed };
          continue;
        }
        if (blanks[i] > 1) continue;
        const t = lines[i].find((u) => grid[u] === EMPTY);
        const want = target - sums[i];
        if (want < 1 || want > size || usedMask[0] & (1 << (want - 1))) return { died: true, placed };
        take(t, want);
        placed.push(t);
        moved = true;
      }
      if (!moved) return { died: false, placed };
    }
  };

  const unplace = (placed) => {
    for (const t of placed) drop(t, grid[t]);
  };

  const nextFree = () => {
    for (let t = 0; t < size; t++) if (grid[t] === EMPTY) return t;
    return -1;
  };

  const walk = () => {
    nodes++;
    if (nodes > budget) {
      exhausted = false;
      return;
    }
    const t = nextFree();
    if (t === -1) {
      solutions++;
      // the trail is unwound as the search backs out, so the answer is copied at the moment it
      // is found rather than read off the stack afterwards
      if (!first) first = Int8Array.from(grid);
      return;
    }
    for (let v = 1; v <= size; v++) {
      if (usedMask[0] & (1 << (v - 1))) continue;
      take(t, v);
      const f = force();
      if (!f.died && nextFree() === -1 && checkAll()) {
        solutions++;
        if (!first) first = Int8Array.from(grid);
      } else if (!f.died) {
        walk();
      }
      unplace(f.placed);
      drop(t, v);
      if (solutions >= cap || !exhausted) return;
    }
  };

  const checkAll = () => {
    for (let i = 0; i < lines.length; i++) if (sums[i] !== target) return false;
    return true;
  };

  // Givens go in first; a given that breaks a line ends the count immediately.
  for (let t = 0; t < size; t++) if (givenCopy[t] !== EMPTY) take(t, givenCopy[t]);
  for (let i = 0; i < lines.length; i++) {
    if (blanks[i] === 0 && sums[i] !== target) return { solutions: 0, status: NONE, nodes, grid: null };
  }
  const f0 = force();
  if (f0.died) return { solutions: 0, status: NONE, nodes, grid: null };
  if (nextFree() === -1) {
    if (checkAll()) {
      solutions = 1;
      first = Int8Array.from(grid);
    }
  } else walk();
  unplace(f0.placed);
  const status = !exhausted && solutions < 2 ? OVERBUDGET : solutions === 0 ? NONE : solutions === 1 ? UNIQUE : MANY;
  return { solutions, status, nodes, grid: first };
}

// ---- census: every square of a class --------------------------------------------------------

// Exhaustive backtracking over the whole class, with forced completion as the only prune.
export function enumerate(n, pan = false, { budget = 0 } = {}) {
  const size = n * n;
  const target = M(n);
  const lines = linesFor(n, pan);
  const at = Array.from({ length: size }, () => []);
  lines.forEach((L, i) => L.forEach((t) => at[t].push(i)));
  const grid = new Int8Array(size);
  const used = new Uint32Array(1);
  const blanks = lines.map((L) => L.length);
  const sums = lines.map(() => 0);
  const squares = [];
  let nodes = 0;
  let truncated = false;
  const t0 = performance.now();

  const take = (t, v) => {
    grid[t] = v;
    used[0] |= 1 << (v - 1);
    for (const i of at[t]) {
      blanks[i]--;
      sums[i] += v;
    }
  };
  const drop = (t, v) => {
    grid[t] = EMPTY;
    used[0] &= ~(1 << (v - 1));
    for (const i of at[t]) {
      blanks[i]++;
      sums[i] -= v;
    }
  };
  const force = () => {
    const placed = [];
    for (;;) {
      let moved = false;
      for (let i = 0; i < lines.length; i++) {
        if (blanks[i] === 0) {
          if (sums[i] !== target) return { died: true, placed };
          continue;
        }
        if (blanks[i] > 1) continue;
        const t = lines[i].find((u) => grid[u] === EMPTY);
        const want = target - sums[i];
        if (want < 1 || want > size || used[0] & (1 << (want - 1))) return { died: true, placed };
        take(t, want);
        placed.push(t);
        moved = true;
      }
      if (!moved) return { died: false, placed };
    }
  };
  const nextFree = () => {
    for (let t = 0; t < size; t++) if (grid[t] === EMPTY) return t;
    return -1;
  };
  const record = () => {
    for (let i = 0; i < lines.length; i++) if (sums[i] !== target) return false;
    squares.push(Int8Array.from(grid));
    return true;
  };
  const walk = () => {
    nodes++;
    if (budget && nodes > budget) {
      truncated = true;
      return;
    }
    const t = nextFree();
    if (t === -1) {
      record();
      return;
    }
    for (let v = 1; v <= size; v++) {
      if (used[0] & (1 << (v - 1))) continue;
      take(t, v);
      const f = force();
      if (!f.died) {
        if (nextFree() === -1) record();
        else walk();
      }
      for (let k = f.placed.length - 1; k >= 0; k--) drop(f.placed[k], grid[f.placed[k]]);
      drop(t, v);
      if (truncated) return;
    }
  };
  walk();
  return { squares, nodes, truncated, ms: Math.round(performance.now() - t0), n, pan };
}

// ---- D4: the eight symmetries ---------------------------------------------------------------

const TRANSFORMS = {
  恒等: (r, c, n) => [r, c],
  转90: (r, c, n) => [c, n - 1 - r],
  转180: (r, c, n) => [n - 1 - r, n - 1 - c],
  转270: (r, c, n) => [n - 1 - c, r],
  左右翻: (r, c, n) => [r, n - 1 - c],
  上下翻: (r, c, n) => [n - 1 - r, c],
  主镜像: (r, c, n) => [c, r],
  副镜像: (r, c, n) => [n - 1 - c, n - 1 - r],
};

// perm[name] is an array where perm[t] is where cell t lands.
export function d4Maps(n) {
  const out = {};
  for (const [name, f] of Object.entries(TRANSFORMS)) {
    const p = new Int32Array(n * n);
    for (let t = 0; t < n * n; t++) {
      const [r2, c2] = f(Math.floor(t / n), t % n, n);
      p[t] = r2 * n + c2;
    }
    out[name] = p;
  }
  return out;
}

export function applyMap(grid, p) {
  const out = new Int8Array(grid.length);
  for (let t = 0; t < grid.length; t++) out[p[t]] = grid[t];
  return out;
}

const same = (a, b) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

// Orbit count: canonical representative = the lexicographically largest grid in the orbit, so
// counting distinct representatives is counting fundamental squares.
export function orbitStats(squares, n) {
  const maps = Object.values(d4Maps(n));
  const reps = new Set();
  for (const g of squares) {
    let best = null;
    for (const p of maps) {
      const q = applyMap(g, p);
      const key = Array.from(q).join(',');
      if (best === null || key > best) best = key;
    }
    reps.add(best);
  }
  return { total: squares.length, fundamental: reps.size };
}

// Burnside's lemma: fundamental = (1/8) Σ_g |fix(g)|. Computed straight from the census list, so
// it is a second, genuinely different route to the same number — and the per-element fixpoint
// counts say whether the action is free (every non-identity fixpoint count 0), which is the only
// circumstance in which total/8 is the fundamental count.
export function burnside(squares, n) {
  const maps = d4Maps(n);
  const fix = {};
  for (const [name, p] of Object.entries(maps)) {
    let k = 0;
    for (const g of squares) if (same(applyMap(g, p), g)) k++;
    fix[name] = k;
  }
  const sum = Object.values(fix).reduce((a, v) => a + v, 0);
  return { fix, sum, fundamental: sum / 8, free: Object.entries(fix).every(([name, v]) => name === '恒等' || v === 0) };
}

// ---- structural properties the README quotes ----------------------------------------------

// Associated: value at the 180°-opposite cell is the complement.
export function associatedCount(squares, n) {
  const size = n * n;
  let k = 0;
  for (const g of squares) {
    let ok = true;
    for (let t = 0; t < size; t++) if (g[size - 1 - t] !== size + 1 - g[t]) ok = false;
    if (ok) k++;
  }
  return k;
}

// The 3×3 centre: forced by the four lines through it (see DESIGN.md), so census-verifiable.
// For even n there is no centre cell, and the tests get the two middle main-diagonal cells
// instead — the honest way of saying "this forcing does not exist here".
export function centreValues(squares, n) {
  if (n % 2 === 0) {
    const set = new Set();
    for (const g of squares) {
      set.add(g[(n / 2 - 1) * n + (n / 2 - 1)]);
      set.add(g[(n / 2) * n + n / 2]);
    }
    return [...set].sort((a, b) => a - b);
  }
  const c = ((n - 1) / 2) * n + (n - 1) / 2;
  const out = new Set();
  for (const g of squares) out.add(g[c]);
  return [...out].sort((a, b) => a - b);
}

// Every wrapped 2×2 block of a most-perfect square has the same sum, and that sum is not free to
// pick: each cell lies in exactly 4 of the n² blocks, so the blocks add up to 4·(Σ all values)
// = 4nM, i.e. each one is 4M/n = 2(n²+1). At order 4 that is 2·17 = 34, which happens to equal M.
// (An earlier draft here used 2M/n = 17 and "measured" 0 such squares — the formula was wrong,
// not the squares. The census below is what re-derived it.)
export function wrappedBlocksSum(grid, n) {
  const sums = new Set();
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) sums.add(grid[r * n + c] + grid[r * n + ((c + 1) % n)] + grid[((r + 1) % n) * n + c] + grid[((r + 1) % n) * n + ((c + 1) % n)]);
  }
  return [...sums].sort((a, b) => a - b);
}

export const forcedBlockSum = (n) => (4 * M(n)) / n;

export function mostPerfectCount(squares, n) {
  const want = forcedBlockSum(n);
  let k = 0;
  for (const g of squares) {
    const s = wrappedBlocksSum(g, n);
    if (s.length === 1 && s[0] === want) k++;
  }
  return k;
}

export function isPandiagonal(grid, n) {
  const target = M(n);
  for (const L of linesFor(n, true)) {
    let s = 0;
    for (const t of L) s += grid[t];
    if (s !== target) return false;
  }
  return true;
}

export { M as magicSumOf };
