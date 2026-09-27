// Puzzle generator. It draws a random square of the band's class, then peels numbers off it
// while two independent gates keep saying yes: the pencil solver must still be able to finish
// the board without guessing, and the exhaustive counter must still call it unique. Nothing
// here decides whether a board is *hard* — the measured pencil score decides that, and the tier
// band only picks which of the accepted draws ships.

import { makeRng } from './rng.js';
import { createBoard, solve, groupsOf, magicSum, EMPTY } from './loshu.js';
import { countSolutions, UNIQUE, OVERBUDGET } from './count.js';

// ---- drawing one square of the class --------------------------------------------------------

// Bounds for a line that still needs k more values out of the unused ones: the smallest and
// largest sum k of them can make. Sound because any completion must use k *distinct* unused
// values, so it can neither fall below lo nor rise above hi.
function boundRange(used, size, k) {
  let lo = 0;
  let hi = 0;
  let n = 0;
  for (let v = 1; v <= size && n < k; v++) {
    if (used & (1 << (v - 1))) continue;
    lo += v;
    n++;
  }
  n = 0;
  for (let v = size; v >= 1 && n < k; v--) {
    if (used & (1 << (v - 1))) continue;
    hi += v;
    n++;
  }
  return { lo, hi, enough: n === k };
}

// One random square of the class, by depth-first search with the rules of the game as the only
// prunes (sum bounds and forced completion). Deterministic in `rng`, which is what lets a save
// redraw the same board from its seed.
export function randomSquare(n, pan, rng, { budget = 4_000_000 } = {}) {
  const size = n * n;
  const target = magicSum(n);
  const groups = groupsOf(n, pan);
  const at = Array.from({ length: size }, () => []);
  groups.forEach((g, i) => g.cells.forEach((t) => at[t].push(i)));
  const grid = new Int8Array(size);
  const blanks = groups.map((g) => g.cells.length);
  const sums = groups.map(() => 0);
  let used = 0;
  let nodes = 0;

  const take = (t, v) => {
    grid[t] = v;
    used |= 1 << (v - 1);
    for (const i of at[t]) {
      blanks[i]--;
      sums[i] += v;
    }
  };
  const drop = (t, v) => {
    grid[t] = EMPTY;
    used &= ~(1 << (v - 1));
    for (const i of at[t]) {
      blanks[i]++;
      sums[i] -= v;
    }
  };
  const fits = (t, v) => {
    for (const i of at[t]) {
      const s = sums[i] + v;
      const k = blanks[i] - 1;
      if (s > target) return false;
      if (k === 0) {
        if (s !== target) return false;
        continue;
      }
      const r = boundRange(used | (1 << (v - 1)), size, k);
      if (!r.enough || s + r.lo > target || s + r.hi < target) return false;
    }
    return true;
  };
  // A line with one blank left has exactly one value that fits, so writing it is not a guess.
  const force = () => {
    const placed = [];
    for (;;) {
      let moved = false;
      for (let i = 0; i < groups.length; i++) {
        if (blanks[i] === 0) continue;
        if (blanks[i] > 1) continue;
        const t = groups[i].cells.find((u) => grid[u] === EMPTY);
        const want = target - sums[i];
        if (want < 1 || want > size || used & (1 << (want - 1))) return { died: true, placed };
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
  const complete = () => sums.every((s) => s === target);

  const pool = Array.from({ length: size }, (_, i) => i + 1);
  const walk = () => {
    if (++nodes > budget) return null;
    const t = nextFree();
    if (t === -1) return complete() ? Int8Array.from(grid) : null;
    const order = rng.shuffle(pool.slice());
    for (const v of order) {
      if (used & (1 << (v - 1))) continue;
      if (!fits(t, v)) continue;
      take(t, v);
      const f = force();
      let hit = null;
      if (!f.died) hit = nextFree() === -1 ? (complete() ? Int8Array.from(grid) : null) : walk();
      for (let k = f.placed.length - 1; k >= 0; k--) drop(f.placed[k], grid[f.placed[k]]);
      drop(t, v);
      if (hit) return hit;
    }
    return null;
  };
  const g = walk();
  return g ? { grid: g, nodes } : null;
}

// ---- peeling the givens ---------------------------------------------------------------------

// Both gates have to stay open for a peel to be kept: unique (counter) and guess-free (pencil
// solver, with 反证 never needed). Order matters, so which numbers survive is part of the puzzle.
export function peel(board, rng, { keep = 0, requireNoNishio = true } = {}) {
  const { n, pan, size } = board;
  const givens = Int8Array.from(board.givens);
  const order = rng.shuffle(Array.from({ length: size }, (_, t) => t));
  let count = size;
  const removed = [];
  for (const t of order) {
    if (keep && count <= keep) break;
    if (givens[t] === EMPTY) continue;
    const trial = Int8Array.from(givens);
    trial[t] = EMPTY;
    const c = countSolutions({ n, pan, givens: trial }, { cap: 2, budget: 200_000 });
    if (c.status !== UNIQUE) continue;
    if (requireNoNishio) {
      const p = solve(createBoard({ n, pan, givens: trial }));
      if (!p.ok || p.nishio > 0) continue;
    } else {
      const p = solve(createBoard({ n, pan, givens: trial }));
      if (!p.ok) continue;
    }
    givens[t] = EMPTY;
    removed.push(t);
    count--;
  }
  return { givens, removed };
}

// The honest 线索下界: which subsets of the shipped clues already pin the square? Tested
// exhaustively, smallest size first, so the answer is a measured minimum over *this* board's
// own clues rather than a bound copied out of a book.
export function clueFloor(board, { budget = 60_000, maxCounted = 4096 } = {}) {
  const givenCells = board.cells.filter((t) => board.givenFlag[t]);
  const k = givenCells.length;
  let tested = 0;
  let truncated = false;
  for (let size = 1; size <= k; size++) {
    const combo = [];
    const pick = (from) => {
      if (truncated || tested >= maxCounted) return null;
      if (combo.length === size) {
        const g = new Int8Array(board.size);
        for (const t of combo) g[t] = board.givens[t];
        tested++;
        const c = countSolutions(board, { cap: 2, budget, givens: g });
        if (c.status === OVERBUDGET) {
          truncated = true;
          return null;
        }
        return c.status === UNIQUE ? combo.slice() : null;
      }
      for (let i = from; i < k - (size - combo.length) + 1; i++) {
        combo.push(givenCells[i]);
        const hit = pick(i + 1);
        if (hit) return hit;
        combo.pop();
      }
      return null;
    };
    const hit = pick(0);
    if (tested >= maxCounted && !hit) {
      truncated = true;
      break;
    }
    if (hit) return { floor: size, tested, truncated, cells: hit.map((t) => ({ cell: t, value: board.givens[t] })) };
  }
  return { floor: k, tested, truncated, cells: givenCells.map((t) => ({ cell: t, value: board.givens[t] })) };
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---- drawing a whole board and measuring it ---------------------------------------------------

export function draw({ n, pan, seed, keep = 0, tries = 60, band = null, requireNoNishio = true, report = () => {} } = {}) {
  let best = null;
  const stats = { drawn: 0, pencilFail: 0, ambiguous: 0, overbudget: 0, inBand: 0 };
  const keyOf = (c) => c.offBand + 4 * c.nishio;
  for (let k = 0; k < tries; k++) {
    const trial = `${seed}#${k}`;
    const rng = makeRng(trial);
    const sq = randomSquare(n, pan, rng);
    if (!sq) continue;
    stats.drawn++;
    const full = createBoard({ n, pan, givens: sq.grid });
    const peeled = peel(full, makeRng(`${trial}|peel`), { keep, requireNoNishio });
    let board;
    try {
      board = createBoard({ n, pan, givens: peeled.givens });
    } catch {
      continue;
    }
    const p = solve(board);
    if (!p.ok) {
      stats.pencilFail++;
      report({ k, stage: 'pencil', ok: false, score: p.score });
      continue;
    }
    const c = countSolutions(board, { cap: 2, budget: 400_000 });
    if (c.status === OVERBUDGET) {
      stats.overbudget++;
      continue;
    }
    if (c.status !== UNIQUE) {
      stats.ambiguous++;
      continue;
    }
    const offBand = band ? Math.abs(p.score - clamp(p.score, band[0], band[1])) : 0;
    if (band && p.score >= band[0] && p.score <= band[1]) stats.inBand++;
    const cand = {
      board,
      seed: trial,
      score: p.score,
      steps: p.steps,
      nishio: p.nishio,
      breakdown: p.breakdown,
      rows: p.rows,
      givens: peeled.givens,
      solution: sq.grid,
      clueCount: board.cells.filter((t) => board.givenFlag[t]).length,
      offBand,
      gen: k + 1,
    };
    if (!best || keyOf(cand) < keyOf(best)) best = cand;
    report({ k, stage: 'ready', score: p.score, clues: cand.clueCount, offBand });
    // Deterministic early stop only: the save keeps this seed and redraws the board on resume,
    // so a draw that depended on how loaded the machine is would not be reproducible.
    if (band && cand.offBand === 0 && cand.nishio === 0) break;
  }
  if (!best) return { ok: false, stats, reason: '没找到既唯一又能纯逻辑推到底的盘面' };
  return { ok: true, stats, ...best };
}

// Bands are selection targets, not adjectives. Each `band` is the measured spread of pencil
// scores for that class (`npm run balance`, 40 raw draws per config, 2026-09-27), and `keep` is
// how many numbers the peel is allowed to leave on the board:
//   九宫   keep 4  -> min 5  p25 10  中位 13  p75 37   max 42     (0.5 ms/张)
//   四四   keep 7  -> min 58 p25 93.5 中位 103 p75 124.5 max 150  (2.1 ms/张)
//   泛对角 keep 6  -> min 121 p25 135 中位 144.5 p75 163.5 max 205 (21 ms/张)
// The bands sit inside those spreads so a tier keeps a real choice of draws, and `balance`
// rejects the batch if any shipped board falls outside its own band. 反证 is never part of the
// target: across 120 raw draws and 120 shipped ones it fired 0 times, and it must stay that way.
export const TIERS = [
  { key: 'jiugong', name: '九宫', n: 3, pan: false, band: [8, 20], keep: 4, tries: 40 },
  { key: 'sishi', name: '四四', n: 4, pan: false, band: [90, 130], keep: 7, tries: 40 },
  { key: 'pandiagonal', name: '泛对角', n: 4, pan: true, band: [132, 170], keep: 6, tries: 24 },
];

export function tierFor(key) {
  return TIERS.find((t) => t.key === key) || TIERS[0];
}

export function makePuzzle(seed, tierKey) {
  const tier = tierFor(tierKey);
  const r = draw({ n: tier.n, pan: tier.pan, seed, keep: tier.keep, tries: tier.tries, band: tier.band });
  if (!r.ok) return null;
  return {
    ...r,
    tier: tier.key,
    tierName: tier.name,
    originSeed: seed,
    size: `${tier.n}×${tier.n}`,
    n: tier.n,
    w: tier.n,
    h: tier.n,
    pan: tier.pan,
  };
}

// The square the peel started from, as a fill map — the generator's own answer, checked by
// verify() without looking at any of the machinery that built it.
export function solutionOf(board, grid) {
  return Int8Array.from(grid);
}

export { EMPTY };
