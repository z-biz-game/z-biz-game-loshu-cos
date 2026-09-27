// Wiring: DOM, taps and keystrokes, the clock, storage, and the `window.loshu` surface the
// verification harness drives. No rule about the board lives here — every judgement comes from
// js/engine/loshu.js through js/ui/game.js.

import { Palette, applyThemeVars, setReduceMotion, systemPrefersReducedMotion } from './theme.js';
import { Sound } from './audio/synth.js';
import { Store } from './store.js';
// The generator's `draw` samples puzzles out of a seed; the render `draw()` below paints a frame.
// Two very different verbs sharing a name in one module is how a puzzle gets painted over, so the
// import is aliased and only the aliased name is re-exported.
import { TIERS, tierFor, makePuzzle, draw as samplePuzzle, solutionOf } from './engine/generate.js';
import * as Engine from './engine/loshu.js';
import { countSolutions } from './engine/count.js';
import { BoardView } from './render/board.js';
import { Game, padReadout, EMPTY } from './ui/game.js';

const VERSION = '1.0.0';

const $ = (sel) => document.querySelector(sel);
const el = {
  viewMenu: $('#view-menu'),
  viewGame: $('#view-game'),
  tiers: $('#tier-list'),
  records: $('#record-list'),
  resumeCard: $('#resume-card'),
  resumeName: $('#resume-name'),
  resumeMeta: $('#resume-meta'),
  name: $('#stat-name'),
  tier: $('#stat-tier'),
  m: $('#stat-m'),
  time: $('#stat-time'),
  moves: $('#stat-moves'),
  hints: $('#stat-hints'),
  filled: $('#stat-filled'),
  remaining: $('#stat-remaining'),
  lines: $('#stat-lines'),
  problems: $('#stat-problems'),
  clues: $('#stat-clues'),
  score: $('#stat-score'),
  hintRule: $('#hint-rule'),
  hintLine: $('#hint-line'),
  hintCount: $('#hint-count'),
  boxLine: $('#box-line'),
  identity: $('#identity-line'),
  ledger: $('#line-ledger'),
  pad: $('#pad'),
  winVeil: $('#win-veil'),
  winMeta: $('#win-meta'),
  winRecord: $('#win-record'),
  wrap: $('#board-wrap'),
  canvas: $('#board'),
};

const view = new BoardView(el.canvas);
let game = null;
let pulse = null;
let startedAt = 0;
let baseElapsed = 0;
let ticker = 0;
let prevLinesDone = 0;

const clock = () => baseElapsed + (startedAt ? Date.now() - startedAt : 0);
const running = () => !!startedAt;

function fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// 10..16 are typed as letters, the way a hex keyboard does, because 1 and 6 arriving as two
// keystrokes in a row is not a thing a player should have to wait out.
const keyFor = (v) => (v <= 9 ? String(v) : String.fromCharCode(96 + v - 9));
const valueForKey = (k) => {
  if (/^[1-9]$/.test(k)) return Number(k);
  const c = k.toLowerCase();
  if (c >= 'a' && c <= 'g') return 9 + (c.charCodeAt(0) - 96);
  return 0;
};

function availBox() {
  const narrow = window.innerWidth <= 900;
  const w = narrow ? window.innerWidth - 60 : el.viewGame.clientWidth - 360;
  return {
    w: Math.max(260, w),
    h: Math.max(260, window.innerHeight - 280),
  };
}

function draw() {
  if (!game) return;
  const { w, h } = availBox();
  view.resize(game, w, h);
  view.draw(game, { pulse, notes: Store.setting('showNotes') !== false });
}

// One place writes the readouts, so a stat can never be updated by half the file.
function syncStats() {
  if (!game) return;
  const st = game.state();
  el.name.textContent = `${st.name} · ${st.n}×${st.n}`;
  el.tier.textContent = tierFor(st.tier).name;
  el.tier.dataset.tier = st.tier;
  el.m.textContent = `M=${st.M}`;
  el.time.textContent = fmtMs(clock());
  el.moves.textContent = st.moves;
  el.hints.textContent = st.hints;
  el.hintCount.textContent = st.hints;
  el.filled.textContent = `${st.filled}/${st.total}`;
  el.remaining.textContent = st.remaining;
  el.lines.textContent = `${st.lineDone}/${st.lineCount}`;
  el.problems.textContent = st.lineBad + st.dups + st.dubiousNotes;
  el.clues.textContent = st.clues;
  el.score.textContent = st.score.toFixed(1);
  el.problems.closest('.stat').classList.toggle('bad', st.lineBad + st.dups + st.dubiousNotes > 0);
  el.remaining.closest('.stat').classList.toggle('bad', st.status !== 'won' && st.remaining > 0);
  el.identity.textContent = `${game.identity()} · 已填 Σ${game.total}`;
  renderLedger();
  renderPad();
  renderBoxLine();
}

// Two things want that one line: what the board says about itself, and what the gesture just
// said back to the player. The board wins while it is complaining; otherwise the last thing the
// player did stays on screen until the next gesture, instead of being wiped by a redraw.
let note = { text: '', good: false };
const stateLine = () => {
  if (!game) return '';
  const g = game.diag;
  if (g.stuck) return '填不下了：这些数互相矛盾，撤销一步再想。';
  if (g.dupValues.length) return `${g.dupValues.join('、')} 被用了两次——1~${game.size} 每个数只能用一次。`;
  if (g.lineBad) return `${g.lineBad} 条线现在到不了 M=${game.M}，它们只是数字，擦掉就回来了。`;
  if (g.dubiousNotes) return `有 ${g.dubiousNotes} 个笔记已经不在候选里了。笔记不约束盘面，留着或擦掉都不影响推。`;
  return '';
};
function renderBoxLine() {
  const line = stateLine() || note.text;
  el.boxLine.textContent = line;
  el.boxLine.classList.toggle('good', !stateLine() && note.good);
}

// The line ledger is the game's scoreboard: not "how many cells" but "which lines have closed".
function renderLedger() {
  const g = game.diag;
  if (el.ledger.childElementCount !== g.lines.length) {
    el.ledger.innerHTML = '';
    for (let i = 0; i < g.lines.length; i++) {
      const li = document.createElement('li');
      li.dataset.line = String(i);
      li.innerHTML = '<span class="l-name"></span><b class="l-sum"></b>';
      el.ledger.appendChild(li);
    }
  }
  g.lines.forEach((l, i) => {
    const li = el.ledger.children[i];
    if (!li) return;
    li.querySelector('.l-name').textContent = l.label;
    li.querySelector('.l-sum').textContent = l.done
      ? `${l.sum} ✓`
      : l.closed
        ? `${l.sum} ✗`
        : `${l.sum} · 差 ${l.deficit}（剩 ${l.empty} 格）`;
    li.classList.toggle('done', l.done);
    li.classList.toggle('bad', l.over || l.unreachable || l.dup || (l.closed && l.sum !== l.want));
  });
}

// The pad is 1..n² laid out as the square itself. A value already on the board is marked spent
// but stays clickable, because clicking it is how the player learns *why* it cannot go again.
function renderPad() {
  const size = game.size;
  if (el.pad.dataset.size !== String(size)) {
    el.pad.dataset.size = String(size);
    el.pad.style.setProperty('--pad-cols', String(game.n));
    el.pad.innerHTML = '';
    for (let v = 1; v <= size; v++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.value = String(v);
      b.textContent = String(v);
      b.setAttribute('aria-label', `填 ${v}`);
      b.title = `数字键 ${keyFor(v)}`;
      b.addEventListener('click', () => onPad(v));
      el.pad.appendChild(b);
    }
  }
  for (const b of el.pad.children) {
    const v = Number(b.dataset.value);
    const used = game.st.fill.includes(v);
    b.classList.toggle('spent', used);
    b.setAttribute('aria-pressed', String(game.st.fill[game.selected] === v));
  }
}

function syncAll() {
  syncStats();
  draw();
}

function flushResume() {
  if (!game || game.status === 'won') return;
  Store.saveResume(game.puzzle, game.st, clock(), { moves: game.moves, hints: game.hints });
}

function startClock() {
  startedAt = Date.now();
  clearInterval(ticker);
  // The ticker writes the clock and nothing else. Repainting a frame here would put a per-second
  // tick into the canvas, which is exactly the motion a reduced-motion player asked not to see.
  ticker = setInterval(() => {
    el.time.textContent = fmtMs(clock());
  }, 1000);
}

function stopClock() {
  baseElapsed = clock();
  startedAt = 0;
  ticker = 0;
  clearInterval(ticker);
}

function setPulse(p) {
  pulse = p;
  if (!p) return;
  // Reduced motion takes away the fade, not the mark. The timer runs either way, because a red
  // strike that survives the fix it was complaining about tells the player the wrong thing.
  const mine = p;
  setTimeout(() => {
    if (pulse === mine) {
      pulse = null;
      draw();
    }
  }, 1600);
}

function setMode(mode) {
  if (!game) return;
  game.mode = mode;
  $('#btn-mode-fill').setAttribute('aria-pressed', String(mode === 'fill'));
  $('#btn-mode-note').setAttribute('aria-pressed', String(mode === 'note'));
  el.canvas.dataset.mode = mode;
  el.canvas.setAttribute('aria-label', mode === 'fill' ? '幻方棋盘：点一格，再用数字键盘填数' : '幻方棋盘：点一格，再用数字键盘记候选笔记');
  draw();
}

function showHint(info) {
  if (!info) return;
  if (info.stalled) {
    el.hintRule.textContent = '推不动了';
    el.hintLine.textContent = info.text;
    return;
  }
  el.hintRule.textContent = `规则：${info.rule}`;
  el.hintLine.textContent = info.why;
  setPulse({ cells: info.cell === undefined ? [] : [info.cell], prune: info.kind === 'prune', color: info.nishio ? Palette.warn : Palette.hint });
  Sound.hint();
}

function onWin() {
  stopClock();
  const ms = clock();
  const better = Store.recordBest(game.puzzle.tier, {
    ms,
    hints: game.hints,
    moves: game.moves,
    size: `${game.n}×${game.n}`,
  });
  Store.recordSolve(ms, game.hints);
  Store.clearResume();
  el.winMeta.textContent = `${tierFor(game.puzzle.tier).name} · ${game.n}×${game.n} · M=${game.M} · ${fmtMs(ms)} · ${game.moves} 步 · 提示 ${game.hints} 次`;
  el.winRecord.textContent = better ? '新纪录：这一局比存档里的更不求人。' : '未破纪录：同档先比提示次数。';
  el.winVeil.hidden = false;
  Sound.win();
  renderRecords();
}

// One sound per kind of thing that happened, and a line closing is the game's real event.
function afterStep(soundKey) {
  const nowDone = game.diag.lineDone;
  const closed = nowDone > prevLinesDone;
  prevLinesDone = nowDone;
  syncAll();
  if (game.status === 'won') onWin();
  else {
    flushResume();
    if (closed) Sound.lineClose();
    else if (soundKey) Sound[soundKey]();
    if (game.diag.stuck) Sound.conflict();
  }
}

function useHint() {
  if (!game || game.status === 'won') return null;
  const info = game.hint();
  if (!info) return null;
  showHint(info);
  afterStep(null);
  return info;
}

function undo() {
  if (!game) return null;
  const step = game.undo();
  if (!step) return null;
  pulse = null;
  Sound.undo();
  prevLinesDone = game.diag.lineDone;
  syncAll();
  flushResume();
  return step;
}

function begin({ tier = 'jiugong', seed = null, resume = null } = {}) {
  const origin = seed || `s${Math.floor(Math.random() * 1e9)}`;
  const puzzle = makePuzzle(origin, tier);
  if (!puzzle) return null;
  game = new Game(puzzle);
  pulse = null;
  el.winVeil.hidden = true;
  baseElapsed = 0;
  note = { text: '', good: false };
  if (resume) {
    game.moves = resume.moves || 0;
    game.hints = resume.hints || 0;
    baseElapsed = resume.elapsedMs || 0;
    game.load(resume.fill, resume.notes);
  }
  prevLinesDone = game.diag.lineDone;
  setMode(Store.setting('mode') === 'note' ? 'note' : 'fill');
  show('game');
  startClock();
  el.hintRule.textContent = '提示理由';
  el.hintLine.textContent = '按 提示 会说出当前能推的一步，以及它依据哪条规则。';
  syncAll();
  flushResume();
  renderResumeCard();
  return game;
}

function show(which) {
  el.viewMenu.hidden = which !== 'menu';
  el.viewGame.hidden = which !== 'game';
  if (which === 'menu') {
    stopClock();
    renderMenu();
  }
  if (which === 'game') draw();
  return which;
}

function renderMenu() {
  renderTiers();
  renderRecords();
  renderResumeCard();
}

const TIER_NOTE = {
  jiugong: '洛书原式：中心必是 5，四角必是偶数',
  sishi: '四四 34：对角线开始咬住行列',
  pandiagonal: '泛对角：折出去的斜带也要等于 34',
};

function renderTiers() {
  el.tiers.innerHTML = '';
  for (const t of TIERS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tier';
    b.dataset.tier = t.key;
    b.innerHTML =
      `<span class="tier-name">${t.name}</span>` +
      `<span class="tier-note">${TIER_NOTE[t.key] || ''}</span>` +
      `<span class="tier-size mono">${t.n}×${t.n} · M=${Engine.magicSum(t.n)} · 实测 ${t.band[0]}–${t.band[1]}</span>`;
    b.addEventListener('click', () => begin({ tier: t.key }));
    el.tiers.appendChild(b);
  }
}

function renderRecords() {
  el.records.innerHTML = '';
  for (const t of TIERS) {
    const li = document.createElement('li');
    const best = Store.best(t.key);
    li.dataset.tier = t.key;
    li.innerHTML =
      `<b>${t.name}</b>` +
      (best
        ? `<span class="mono">${fmtMs(best.ms)}</span> · 提示 ${best.hints} · ${best.moves} 步<br><span>${best.size}</span>`
        : '<span>还没有纪录</span>');
    el.records.appendChild(li);
  }
}

function renderResumeCard() {
  const r = Store.resume();
  // Do not offer "继续" for the board already on screen.
  const live = game && game.status !== 'won' && running();
  if (!r || (live && r.seed === game.puzzle.originSeed && r.tier === game.puzzle.tier)) {
    el.resumeCard.hidden = true;
    return;
  }
  el.resumeCard.hidden = false;
  el.resumeName.textContent = `继续 ${tierFor(r.tier).name} 的一局`;
  el.resumeMeta.textContent = `${fmtMs(r.elapsedMs || 0)} · ${r.moves || 0} 步 · 提示 ${r.hints || 0} 次`;
}

function applySettings() {
  Sound.setEnabled(Store.setting('sound'));
  const reduce = !!Store.setting('reduceMotion') || systemPrefersReducedMotion();
  setReduceMotion(!!Store.setting('reduceMotion'));
  document.body.classList.toggle('reduce-motion', reduce);
  $('#btn-sound').setAttribute('aria-pressed', String(!!Store.setting('sound')));
  $('#btn-sound').textContent = Store.setting('sound') ? '音效 开' : '音效 关';
  $('#btn-notes').setAttribute('aria-pressed', String(!!Store.setting('showNotes')));
  $('#btn-notes').textContent = Store.setting('showNotes') ? '笔记 显' : '笔记 藏';
  $('#btn-motion').setAttribute('aria-pressed', String(!!Store.setting('reduceMotion')));
  $('#btn-motion').textContent = reduce ? '动效 省' : '动效 全';
}

// ---- gestures: select a cell, then commit a digit ------------------------------------------

function boxLine(text, good) {
  note = { text: text || '', good: !!good };
  renderBoxLine();
}

function selectCell(t) {
  if (!game || t < 0) return false;
  game.select(t);
  const r = game.linesThrough(t);
  boxLine(r.text, r.ok);
  draw();
  return true;
}

function pointerDown(ev) {
  if (!game || game.status === 'won') return;
  ev.preventDefault();
  const t = view.hitCell(ev.clientX, ev.clientY);
  if (t < 0) {
    note = { text: '', good: false };
    boxLine('点在线上的数字块只是读数，要填数请点格子里面');
    return;
  }
  note = { text: '', good: false };
  selectCell(t);
}

// The pad is the commit; the cell is the target. A tap on a filled cell with a fresh digit
// replaces it, which is the same arithmetic as the win check.
function onPad(v) {
  if (!game || game.status === 'won') return null;
  const t = game.selected;
  if (game.mode === 'note') {
    const res = game.note(v, t);
    if (!res.ok) {
      boxLine(res.reason);
      Sound.reject();
      setPulse({ cells: [t], color: Palette.error });
      syncAll();
      return null;
    }
    boxLine(res.on ? `记下候选 ${v}：笔记不动盘面，它只是你想过的地方` : `擦掉笔记 ${v}`);
    afterStep('note');
    return res;
  }
  const res = game.placeAt(t, v);
  if (!res.ok) {
    // The refusal is the feedback: the reason, the sound, and a strike on the cells involved.
    boxLine(res.reason);
    Sound.reject();
    setPulse({ cells: res.clash !== undefined ? [t, res.clash] : [t], color: Palette.error });
    syncAll();
    return null;
  }
  const r = padReadout(game, v);
  boxLine(`${r.used ? '' : '填下了 '}${game.n}×${game.n} · ${Engine.cellName(game.board, res.cell)} = ${v} — ${game.linesThrough(res.cell).text}`, true);
  advanceSelection();
  afterStep('place');
  return res;
}

// After a digit goes down, hand the cursor to the next blank: this game is played in a sweep, and
// making the player hunt for the next empty cell is busywork, not difficulty.
function advanceSelection() {
  const start = game.selected;
  for (let k = 1; k <= game.size; k++) {
    const t = (start + k) % game.size;
    if (game.isBlank(t)) {
      game.select(t);
      return t;
    }
  }
  return start;
}

function moveSelection(dr, dc) {
  if (!game) return;
  const r = ((game.selected / game.n) | 0) + dr;
  const c = (game.selected % game.n) + dc;
  if (r < 0 || c < 0 || r >= game.n || c >= game.n) return;
  selectCell(r * game.n + c);
}

el.canvas.addEventListener('pointerdown', pointerDown);
el.canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

$('#btn-mode-fill').addEventListener('click', () => {
  Store.setSetting('mode', 'fill');
  setMode('fill');
});
$('#btn-mode-note').addEventListener('click', () => {
  Store.setSetting('mode', 'note');
  setMode('note');
});
$('#btn-hint').addEventListener('click', useHint);
$('#btn-undo').addEventListener('click', undo);
$('#btn-erase').addEventListener('click', () => {
  if (!game) return;
  const res = game.erase();
  if (!res.ok) {
    boxLine(res.reason);
    Sound.reject();
    return;
  }
  boxLine(`擦掉 ${Engine.cellName(game.board, game.selected)}`);
  afterStep('erase');
});
$('#btn-new').addEventListener('click', () => begin({ tier: game ? game.puzzle.tier : 'jiugong' }));
$('#btn-menu').addEventListener('click', () => {
  flushResume();
  show('menu');
});
$('#btn-menu-2').addEventListener('click', () => show('menu'));
$('#btn-again').addEventListener('click', () => begin({ tier: game ? game.puzzle.tier : 'jiugong' }));
$('#btn-resume').addEventListener('click', () => {
  const r = Store.resume();
  if (!r) return;
  begin({ tier: r.tier, seed: r.seed, resume: r });
});
$('#btn-sound').addEventListener('click', () => {
  Store.setSetting('sound', !Store.setting('sound'));
  applySettings();
  Sound.place();
});
$('#btn-notes').addEventListener('click', () => {
  Store.setSetting('showNotes', !Store.setting('showNotes'));
  applySettings();
  draw();
});
$('#btn-motion').addEventListener('click', () => {
  Store.setSetting('reduceMotion', !Store.setting('reduceMotion'));
  applySettings();
});
$('#btn-reset').addEventListener('click', () => {
  Store.reset();
  applySettings();
  game = null;
  show('menu');
});

window.addEventListener('keydown', (ev) => {
  if (!game || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const k = ev.key;
  if (k === 'ArrowLeft') return void (ev.preventDefault(), moveSelection(0, -1));
  if (k === 'ArrowRight') return void (ev.preventDefault(), moveSelection(0, 1));
  if (k === 'ArrowUp') return void (ev.preventDefault(), moveSelection(-1, 0));
  if (k === 'ArrowDown') return void (ev.preventDefault(), moveSelection(1, 0));
  if (k === 'Backspace' || k === 'Delete') {
    ev.preventDefault();
    $('#btn-erase').click();
    return;
  }
  if (k === 'h' || k === 'H') return void useHint();
  if (k === 'z' || k === 'Z') return void undo();
  if (k === 'n' || k === 'N') return void $(`#btn-mode-${game.mode === 'note' ? 'fill' : 'note'}`).click();
  const v = valueForKey(k);
  if (v >= 1 && v <= game.size) {
    ev.preventDefault();
    onPad(v);
  }
});

window.addEventListener('resize', draw);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushResume();
});
window.addEventListener('pagehide', flushResume);

applyThemeVars();
applySettings();
renderMenu();

window.loshu = {
  version: VERSION,
  view,
  get game() {
    return game;
  },
  show,
  begin,
  useHint,
  undo,
  setMode,
  select: selectCell,
  // The harness commits through the same pad path a click does, so a scenario that passes here
  // has driven the real acceptance test rather than a copy of it.
  press(v) {
    return onPad(v);
  },
  erase: () => $('#btn-erase').click(),
  move: moveSelection,
  solveWithLogic() {
    if (!game) return null;
    const r = game.solveWithLogic();
    syncAll();
    if (game.status === 'won') onWin();
    return r;
  },
  elapsed: clock,
  state: () => (game ? { ...game.state(), elapsedMs: clock(), mode: game.mode } : null),
  cellAt: (x, y) => (game ? game.cellAt(x, y) : -1),
  valueAt: (t) => (game ? game.valueAt(t) : EMPTY),
  candidates: (t) => (game ? game.candidatesOf(t) : []),
  boxLine: () => el.boxLine.textContent,
  // The palette travels with the surface so a pixel assertion can name the token it expects
  // rather than a hex copied out of this file.
  engine: {
    ...Engine,
    makePuzzle,
    samplePuzzle,
    solutionOf,
    countSolutions,
    TIERS,
    tierFor,
    Game,
    padReadout,
    Store,
    theme: Palette,
    EMPTY,
  },
};
