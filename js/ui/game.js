// The playable state machine: what a tap on the number pad writes, what an undo takes back, when
// a square counts as filled, and what a hint is allowed to say.
//
// Two deliberate bindings to js/engine/loshu.js:
//   * the ink lives in the engine's own `st.fill` / `st.notes`. A UI-side copy of the board is how
//     a painted digit and a "this line already sums to M" judgement drift apart.
//   * the win check is the engine's independent `verify()`, written from the rules of the game
//     rather than from this file's bookkeeping, so "the UI said I won" and "this is a magic
//     square" cannot disagree — and a bug in candidate pruning cannot fake a win.
//
// One snapshot is one gesture: the engine pushes it, `steps` mirrors it, 撤销 pops both.

import {
  EMPTY,
  createState,
  rebuild,
  snapshot,
  undo as undoState,
  diagnose,
  nextDeduction,
  applyDeduction,
  tryPlace,
  eraseCell,
  toggleNote,
  complete,
  valuesOf,
  cellName,
  lineReadout,
  identityText,
  magicSum,
} from '../engine/loshu.js';

export { EMPTY };

const inkSum = (fill) => {
  let s = 0;
  for (let t = 0; t < fill.length; t++) s += fill[t];
  return s;
};

export class Game {
  constructor(puzzle) {
    this.puzzle = puzzle;
    this.board = puzzle.board;
    this.n = this.board.n;
    this.w = this.board.n;
    this.h = this.board.n;
    this.size = this.board.size;
    this.M = this.board.M;
    this.checksum = this.board.n * this.board.M;
    this.st = createState(this.board);
    this.steps = [];
    this.moves = 0;
    this.hints = 0;
    this.status = 'playing';
    this.mode = 'fill';
    this.selected = this.firstBlank();
    this.lastHint = null;
    this.recompute();
  }

  recompute() {
    this.diag = diagnose(this.st);
    this.total = this.st.fill.reduce((a, v) => a + v, 0);
    return this.diag;
  }

  firstBlank() {
    for (let t = 0; t < this.size; t++) if (this.st.fill[t] === EMPTY) return t;
    return 0;
  }

  cellAt(x, y) {
    if (x < 0 || y < 0 || x >= this.n || y >= this.n) return -1;
    return y * this.n + x;
  }

  valueAt(t) {
    return t >= 0 && t < this.size ? this.st.fill[t] : EMPTY;
  }

  givenAt(t) {
    return t >= 0 && t < this.size && !!this.board.givenFlag[t];
  }

  isBlank(t) {
    return t >= 0 && t < this.size && this.st.fill[t] === EMPTY;
  }

  select(t) {
    if (t < 0 || t >= this.size) return false;
    this.selected = t;
    return true;
  }

  record(kind, info) {
    this.steps.push({ kind, ...info });
    if (kind === 'hint' || kind === 'nishio') this.hints++;
    // A prune walked through on the way to a hint is not a gesture the player made: it is recorded
    // so the undo stack stays aligned with the engine's snapshot stack, and it moves no counter.
    else if (kind !== 'prune') this.moves++;
  }

  // A gesture that wrote nothing must not cost a step. The engine snapshots before it knows
  // whether the ink changes, so this is where the wasted snapshot gets taken back.
  protected(before, kind, info) {
    if (inkSum(this.st.fill) === before) {
      undoState(this.st);
      this.recompute();
      return null;
    }
    this.record(kind, info);
    this.recompute();
    this.checkWin();
    return this.steps[this.steps.length - 1];
  }

  // The one gesture that puts a digit on the board. Every refusal comes back with the engine's
  // own reason — the arithmetic, not an adjective — so nothing is ever silently swallowed.
  place(v) {
    return this.placeAt(this.selected, v);
  }

  placeAt(t, v) {
    if (this.status === 'won') return { ok: false, reason: '这一局已经完成，先换一局' };
    const before = inkSum(this.st.fill);
    const res = tryPlace(this.st, t, v);
    if (!res.ok) {
      this.recompute();
      return { ok: false, reason: res.reason, cell: t, clash: res.clash, given: res.given, same: res.same };
    }
    const step = this.protected(before, 'place', { cell: t, value: v });
    return { ok: true, step, cell: t, value: v };
  }

  erase(t = this.selected) {
    const before = inkSum(this.st.fill);
    if (!eraseCell(this.st, t)) return { ok: false, reason: `${cellName(this.board, t)} 本来就是空的` };
    return { ok: true, step: this.protected(before, 'erase', { cell: t }) };
  }

  // Notes are ink-free: they cost a gesture and an undo, and they change no candidate pool.
  note(v, t = this.selected) {
    if (this.givenAt(t)) return { ok: false, reason: `${cellName(this.board, t)} 是题面给的数，笔记记在它头上没有意义` };
    if (!this.isBlank(t)) return { ok: false, reason: `${cellName(this.board, t)} 已经有数了，擦掉它才谈得上记笔记` };
    if (!(v >= 1 && v <= this.size)) return { ok: false, reason: `${v} 不在 1~${this.size} 之内` };
    const on = toggleNote(this.st, t, v);
    this.steps.push({ kind: on ? 'note' : 'unnote', cell: t, value: v });
    this.moves++;
    this.recompute();
    return { ok: true, on, cell: t, value: v };
  }

  load(fill, notes) {
    for (let t = 0; t < this.size; t++) {
      const v = fill ? fill[t] : EMPTY;
      this.st.fill[t] = this.board.givenFlag[t] ? this.board.givens[t] : v > 0 && v <= this.size ? v : EMPTY;
      this.st.notes[t] = notes ? notes[t] & 0xffff : 0;
      if (this.st.fill[t] !== EMPTY) this.st.notes[t] = 0;
    }
    rebuild(this.st);
    this.recompute();
    this.checkWin();
    return this;
  }

  undo() {
    // One gesture, not one engine write: a hint that walked through three candidate deletions
    // before it wrote a digit took four snapshots, and undoing it has to take all four back.
    let step = null;
    for (;;) {
      step = this.steps.pop();
      if (!step) return null;
      undoState(this.st);
      if (step.kind === 'prune') continue;
      break;
    }
    // A hint taken back is still a hint that was taken: records rank runs by help used, so
    // refunding the counter would let a player undo their way to a clean 提示 0.
    if (step.kind !== 'hint' && step.kind !== 'nishio') this.moves = Math.max(0, this.moves - 1);
    if (this.status === 'won') this.status = 'playing';
    this.recompute();
    return step;
  }

  // The engine's own next step. Pure candidate deletions are walked through for free — they leave
  // no digit a player could act on — until the board gives something to write down. A 反证 is
  // never free: it is the one move that costs a hypothesis, so the player pays for it and reads
  // the reasoning, which is the only honest way to hand one over.
  hint() {
    if (this.status === 'won') return null;
    let pendingPrune = null;
    for (let k = 0; k < 400; k++) {
      const d = nextDeduction(this.st);
      if (!d) {
        if (pendingPrune) return this.chargePrune(pendingPrune);
        return { stalled: true, text: '当前没有可推导的一步：这一盘要的是重新想一遍，不是提示。' };
      }
      const why = d.rule.text(this.board, d);
      if (d.kind === 'prune') {
        const nishio = d.rule.name === '反证';
        snapshot(this.st);
        applyDeduction(this.st, d);
        this.recompute();
        if (nishio) return this.chargePrune({ rule: d.rule.name, why, cell: d.cell, value: d.value, nishio: true });
        // The deletion is undone together with the hint it preceded, so it needs its own entry.
        this.record('prune', { cell: d.cell, value: d.value, rule: d.rule.name });
        pendingPrune = { rule: d.rule.name, why, cell: d.cell, value: d.value };
        continue;
      }
      const before = inkSum(this.st.fill);
      snapshot(this.st);
      applyDeduction(this.st, d);
      const step = this.protected(before, 'hint', { cell: d.cell, value: d.value, rule: d.rule.name });
      if (!step) continue;
      const info = { rule: d.rule.name, kind: 'place', cell: d.cell, value: d.value, why };
      this.lastHint = info;
      return info;
    }
    if (pendingPrune) return this.chargePrune(pendingPrune);
    return { stalled: true, text: '推导到此为止，剩下的要你自己想。' };
  }

  chargePrune(p) {
    const info = { rule: p.rule, kind: 'prune', cell: p.cell, value: p.value, why: p.why, nishio: !!p.nishio };
    this.record(p.nishio ? 'nishio' : 'hint', { cell: p.cell, value: p.value, rule: p.rule });
    this.lastHint = info;
    return info;
  }

  checkWin() {
    this.status = complete(this.board, this.st.fill) ? 'won' : 'playing';
    return this.status === 'won';
  }

  // Used by the verification harness and nothing else: drive the engine's own deductions to the
  // end. Every digit it writes is one the pencil rules justify, so this cannot light a cell the
  // game would not accept as a hint.
  solveWithLogic({ cap = 400 } = {}) {
    let k = 0;
    while (this.status !== 'won' && k++ < cap) {
      const before = this.steps.length;
      const h = this.hint();
      if (!h || h.stalled) break;
      if (this.steps.length === before) break;
    }
    return { status: this.status, steps: k };
  }

  // ---- readouts the UI is allowed to show ------------------------------------------------
  candidatesOf(t) {
    return t >= 0 && t < this.size && this.st.fill[t] === EMPTY ? valuesOf(this.st.cand[t]) : [];
  }

  linesThrough(t) {
    return lineReadout(this.board, this.st.fill, t);
  }

  identity() {
    return identityText(this.board);
  }

  state() {
    const g = this.diag;
    return {
      tier: this.puzzle.tier,
      name: this.puzzle.tierName,
      seed: this.puzzle.seed,
      originSeed: this.puzzle.originSeed,
      n: this.n,
      pan: this.board.pan,
      M: magicSum(this.n),
      moves: this.moves,
      hints: this.hints,
      status: this.status,
      mode: this.mode,
      selected: this.selected,
      filled: g.filled,
      total: g.total,
      remaining: g.remaining,
      clues: g.clueCount,
      lineDone: g.lineDone,
      lineCount: g.lineCount,
      lineBad: g.lineBad,
      dups: g.dupValues.length,
      dubiousNotes: g.dubiousNotes,
      stuck: g.stuck,
      boardTotal: this.total,
      checksum: this.n * this.M,
      score: this.puzzle.score,
      steps: this.steps.length,
    };
  }
}

// The readout a tap on the number pad shows before it commits: the rules of the game are exactly
// "1..n² each once, every line M", so this is the same arithmetic the acceptance test uses.
export function padReadout(game, v) {
  const board = game.board;
  if (v < 1 || v > board.size) return { ok: false, text: `${v} 不在 1~${board.size} 之内` };
  const used = game.st.fill.filter((x) => x === v).length;
  const t = game.selected;
  const cand = game.candidatesOf(t);
  return {
    ok: used === 0 && cand.includes(v),
    used,
    cell: t,
    value: v,
    text: `${v} · 全盘 ${used ? '已用过' : '未用'} · ${cellName(board, t)} 候选 ${cand.length ? cand.join('') : '空'}`,
  };
}
