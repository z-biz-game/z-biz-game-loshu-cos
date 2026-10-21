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
import { FxLayer, loadSprites, SIM_STEP } from './render/fx.js';
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
  fxCanvas: $('#fx-layer'),
  pauseVeil: $('#pause-veil'),
  helpVeil: $('#help-veil'),
};

const view = new BoardView(el.canvas);
const fx = new FxLayer(el.fxCanvas);
let game = null;
let pulse = null;
let startedAt = 0;
let baseElapsed = 0;
let ticker = 0;
let paused = false;
let helpOpen = false;

// 帧循环只有一条时间来源：rAF 的 ts 差进累加器，累加器按定步长喂仿真。
// 位移/寿命一律不直接吃帧 dt —— 那样 30Hz 与 120Hz 会跑出两个世界。
let rafId = 0;
let lastFrameMs = -1;
let simAccumulator = 0;
let lastBox = { w: 0, h: 0, n: 0 };

const PULSE_TTL = 1.6; // 秒

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
  // 下面那 280 是抄来的常数，而顶栏在手机上会换行——常数一破，画布底边就顶出视口
  // （tools/scenarios.js 的「画布整个在视口里」判的正是这条）。改成量出来的：盘从哪儿
  // 开始，就只留给它到视口底减去读数行的那点高度。
  const rect = el.wrap && el.wrap.getBoundingClientRect ? el.wrap.getBoundingClientRect() : null;
  const docTop = rect ? rect.top + (window.scrollY || 0) : 0;
  const reserve = 104; // 盘下两行读数 + 版面内边距 + 页脚
  return {
    w: Math.max(260, w),
    h: Math.max(260, window.innerHeight - docTop - reserve),
  };
}

function draw(force = false) {
  if (!game) return;
  const { w, h } = availBox();
  if (force || w !== lastBox.w || h !== lastBox.h || game.n !== lastBox.n) {
    view.resize(game, w, h);
    // 叠层对齐的是画布的 CSS 尺寸（layoutFor 算出来的），不是可用框——差一点就会错位。
    fx.resize(view.geo.w || w, view.geo.h || h, view.geo.dpr || 1);
    lastBox = { w, h, n: game.n };
  }
  view.draw(game, { pulse, notes: Store.setting('showNotes') !== false });
  fx.draw(view.geo);
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
  paused = false;   // 新一局从"没暂停"开始；setPaused(false) 走的就是这条路
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
  // 顺序不能反：先把句柄交给 clearInterval，再置 0。反过来写每次暂停都会漏一个仍在跑的
  // 秒级 interval，暂停几次就有几个定时器在往同一个 DOM 节点写时间。
  clearInterval(ticker);
  ticker = 0;
}

function setPulse(p) {
  pulse = p;
  if (!p) return;
  // 存续时间挂在动效时钟上，不是挂在真实时间上：暂停期间那个时钟一口都不涨，于是
  // "这一格被拒了"的红线不会在你回到牌桌之前悄悄消失。
  pulse.until = fx.clock + PULSE_TTL;
  // Reduced motion takes away the fade, not the mark. The timer runs either way, because a red
  // strike that survives the fix it was complaining about tells the player the wrong thing.
  // 真实时间那份只是兜底（没有 rAF 的宿主里上面那条判据永远不会被读到）。
  const mine = p;
  setTimeout(() => {
    if (pulse === mine) {
      pulse = null;
      draw();
    }
  }, PULSE_TTL * 1000);
}

// ---- 暂停 / 玩法 / 全屏 ----------------------------------------------------------------------

// 暂停是"仿真停在原地"，不是"遮罩盖住画面"：累加器一口不喂、计时器停表、音频上下文挂起、
// 输入全挡。恢复时把 lastFrameMs 重置，免得把中间那几分钟一次性补算成一场粒子暴雨。
function setPaused(v) {
  const want = !!v && !!game && game.status !== 'won';
  if (want === paused) return paused;
  paused = want;
  document.body.classList.toggle('is-paused', paused);
  if (el.pauseVeil) el.pauseVeil.hidden = !paused;
  const btn = $('#btn-pause');
  if (btn) {
    btn.setAttribute('aria-pressed', String(paused));
    btn.textContent = paused ? '继续' : '暂停';
  }
  if (paused) {
    stopClock();
    Sound.halt();
    flushResume();
  } else {
    startClock();
    Sound.unhalt();
    lastFrameMs = -1;
    simAccumulator = 0;
    fx.clearMotion();
  }
  syncStats();
  draw(true);
  return paused;
}

function toggleHelp(on) {
  helpOpen = on === undefined ? !helpOpen : !!on;
  if (el.helpVeil) el.helpVeil.hidden = !helpOpen;
  const btn = $('#btn-help');
  if (btn) btn.setAttribute('aria-pressed', String(helpOpen));
  return helpOpen;
}

// 全屏：特性探测三套 API 前缀（老 Edge 只认 ms、Firefox 认 moz），不做 UA 判断——
// UA 字符串是猜的，方法在不在是量的，猜错就静默失效。
function fsRoot() {
  return document.documentElement;
}

function fsElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function fsRequest(root) {
  // 老 Edge 的 msRequestFullscreen 挂在元素上，和标准名同一个位置，所以并排取即可。
  return root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen || null;
}

function fullscreenActive() {
  return !!fsElement();
}

function syncFullscreenBtn() {
  const btn = $('#btn-full');
  if (!btn) return;
  const on = fullscreenActive();
  btn.setAttribute('aria-pressed', String(on));
  btn.textContent = on ? '退出全屏' : '全屏';
  btn.title = on ? '退出全屏 (F)' : '全屏 (F)';
}

// 不支持就要说明为什么：只把按钮变灰，玩家会以为这活根本没做完。
// （iPhone 版 Safari 压根没有元素全屏，只有 <video> 能全屏。）
function syncFullscreenSupport() {
  const btn = $('#btn-full');
  if (!btn) return;
  if (!fsRequest(fsRoot())) {
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
    btn.title = '这个浏览器不提供元素全屏（iOS Safari 请用「添加到主屏幕」）';
    return;
  }
  syncFullscreenBtn();
}

function toggleFullscreen() {
  const root = fsRoot();
  const req = fsRequest(root);
  if (!req) {
    syncFullscreenSupport();
    return false;
  }
  const settle = (target, fn) => {
    try {
      const r = fn && fn.call(target);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch {
      /* 宿主不允许（Electron 未授权、iframe 无 allowfullscreen）就保持现状 */
    }
    setTimeout(syncFullscreenBtn, 60);
  };
  if (fullscreenActive()) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
    settle(document, exit);
  } else {
    settle(root, req);
  }
  return fullscreenActive();
}

// 暂停或说明页开着的时候，盘面与键盘都不该改动牌局——遮罩不是装饰。
const inputLocked = () => paused || helpOpen;

// 一帧的算术只有一处：ts 差进累加器，累加器按 SIM_STEP 喂仿真。
// 30/60/120Hz 喂同样长度的时间，就必须跑出同样多的步数、同样的位置。
function frame(ts) {
  // 沙箱（没有 rAF 的宿主）通过 loshu.tick(ts) 手动喂帧，走的就是这一段算术，
  // 于是被测的那条时间路径和真机跑的是同一条。
  if (typeof requestAnimationFrame === 'function') rafId = requestAnimationFrame(frame);
  const now = Number.isFinite(ts) ? ts : Date.now();
  if (lastFrameMs < 0) {
    lastFrameMs = now;
    return;
  }
  let elapsed = (now - lastFrameMs) / 1000;
  lastFrameMs = now;
  if (!(elapsed > 0)) elapsed = 0;
  if (elapsed > 0.25) elapsed = 0.25; // 切回前台不补算整段空洞
  if (paused) return; // 暂停：仿真一口都不吃，clock/steps 全停在原地
  simAccumulator += elapsed;
  let steps = 0;
  while (simAccumulator >= SIM_STEP && steps < 8) {
    simAccumulator -= SIM_STEP;
    fx.step(SIM_STEP);
    steps++;
  }
  if (steps >= 8) simAccumulator = 0; // 追不上了就丢掉欠账，不跑"补帧"死循环
  if (pulse && fx.clock >= pulse.until) {
    pulse = null;
    draw();
  } else if (game) {
    fx.draw(view.geo); // 只有叠层在动：#board 没有理由跟着每帧重画一遍
  }
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
  const side = view.geo.cell * game.n;
  fx.celebrate({ x: view.geo.x, y: view.geo.y, w: side, h: side }, Palette.success);
  Sound.win();
  renderRecords();
}

// One sound and one burst per kind of thing that happened, and a line closing is the game's real
// event. Which lines closed is tracked per line, not as a count: two lines can go from 2 to 3 and
// back again in one undo, and a counter would celebrate the wrong one.
let prevDone = [];
const snapshotDone = () => {
  prevDone = game.diag.lines.map((l) => !!l.done);
};

function lineRect(i) {
  const l = game.diag.lines[i];
  if (!l || !l.cells.length || !view.geo.cell) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const t of l.cells) {
    const r = view.cellRect(t);
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.size);
    y1 = Math.max(y1, r.y + r.size);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function afterStep(soundKey) {
  const justClosed = [];
  game.diag.lines.forEach((l, i) => {
    if (l.done && !prevDone[i]) justClosed.push(i);
  });
  snapshotDone();
  syncAll();
  if (game.status === 'won') onWin();
  else {
    flushResume();
    for (const i of justClosed) fx.celebrate(lineRect(i), Palette.chipDone);
    if (justClosed.length) Sound.lineClose();
    else if (soundKey) Sound[soundKey]();
    if (game.diag.stuck) Sound.conflict();
  }
}

function useHint() {
  if (!game || game.status === 'won' || inputLocked()) return null;
  const info = game.hint();
  if (!info) return null;
  showHint(info);
  afterStep(null);
  return info;
}

function undo() {
  if (!game || inputLocked()) return null;
  const step = game.undo();
  if (!step) return null;
  pulse = null;
  Sound.undo();
  snapshotDone();
  fx.clearMotion();
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
    // 存档里记的档位在换代后可能对不上盘（九宫 9 格 ↔ 四四 16 格）。长度不匹配就当新盘开：
    // 宁可丢掉半截局面，也不把 16 个数字塞进 9 格的 board 里。
    const fill = resume.fill && resume.fill.length === game.size ? resume.fill : null;
    const notes = resume.notes && resume.notes.length === game.size ? resume.notes : null;
    if (fill) game.load(fill, notes);
  }
  snapshotDone();
  // 新的一局从干净的动效状态开始：时钟归零、粒子与涟漪清空，上一局停在暂停态也不能开局就冻着。
  fx.reset();
  setPaused(false);
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
  if (!game || t < 0 || inputLocked()) return false;
  game.select(t);
  const r = game.linesThrough(t);
  boxLine(r.text, r.ok);
  draw();
  return true;
}

function pointerDown(ev) {
  if (!game || game.status === 'won' || inputLocked()) return;
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
  if (!game || game.status === 'won' || inputLocked()) return null;
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
  if (!game || inputLocked()) return;
  const res = game.erase();
  if (!res.ok) {
    boxLine(res.reason);
    Sound.reject();
    return;
  }
  boxLine(`擦掉 ${Engine.cellName(game.board, game.selected)}`);
  afterStep('erase');
});

// 静音走存档、按钮与键盘同一条路：切换设置 → 让 Sound 真的挂起上下文 → 更新按钮文案。
// 恢复时才放一声，作为"这条路是通的"的即时回执。
function toggleSound() {
  Store.setSetting('sound', !Store.setting('sound'));
  applySettings();
  if (Store.setting('sound')) Sound.place();
  return Store.setting('sound');
}

$('#btn-sound').addEventListener('click', toggleSound);
$('#btn-notes').addEventListener('click', () => {
  Store.setSetting('showNotes', !Store.setting('showNotes'));
  applySettings();
  draw();
});
$('#btn-motion').addEventListener('click', () => {
  Store.setSetting('reduceMotion', !Store.setting('reduceMotion'));
  applySettings();
  // 省动效要立刻看得见：粒子当场清掉，叠层重画一次，而不是等下一局。
  fx.clearMotion();
  draw(true);
});
$('#btn-help').addEventListener('click', () => toggleHelp());
$('#btn-help-close').addEventListener('click', () => toggleHelp(false));
$('#btn-help-play').addEventListener('click', () => {
  toggleHelp(false);
  begin({ tier: 'jiugong' });
});
$('#btn-pause').addEventListener('click', () => setPaused(!paused));
$('#btn-unpause').addEventListener('click', () => setPaused(false));
$('#btn-pause-menu').addEventListener('click', () => {
  setPaused(false);
  flushResume();
  show('menu');
});
$('#btn-full').addEventListener('click', toggleFullscreen);
// 开局前先问一次：这台浏览器给不给元素全屏。不给就把按钮禁用并说明原因，
// 别让玩家按下去才发现"按了没反应"。
syncFullscreenSupport();
document.addEventListener('fullscreenchange', syncFullscreenBtn);
document.addEventListener('webkitfullscreenchange', syncFullscreenBtn);
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
$('#btn-reset').addEventListener('click', () => {
  Store.reset();
  applySettings();
  game = null;
  show('menu');
});

window.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const k = ev.key;

  if (k === '?') return void (ev.preventDefault(), toggleHelp());
  if (k === 'Escape') {
    if (helpOpen) {
      ev.preventDefault();
      toggleHelp(false);
    } else if (paused) {
      ev.preventDefault();
      setPaused(false);
    }
    return;
  }
  if (helpOpen) return; // 说明页是模态：其余按键此刻都不该改动牌局

  if (k === 'm' || k === 'M') return void toggleSound();
  if (k === 'p' || k === 'P') return void (ev.preventDefault(), setPaused(!paused));
  if (k === ' ' || k === 'Enter') {
    // 焦点停在某个按钮上时，Space/Enter 归那个按钮：抢过来会变成"按回车既点了聚焦的按钮又暂停了"。
    const tag = ev.target ? ev.target.tagName : '';
    if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    ev.preventDefault();
    if (!game) begin({ tier: 'jiugong' });
    else if (game.status !== 'won') setPaused(!paused);
    return;
  }
  if (!game) {
    if (k === 'f' || k === 'F') return void toggleFullscreen();
    return;
  }
  if (inputLocked()) return;
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
  if (k === 'r' || k === 'R') return void (ev.preventDefault(), begin({ tier: game.puzzle.tier }));
  const v = valueForKey(k);
  if (v >= 1 && v <= game.size) {
    ev.preventDefault();
    onPad(v);
    return;
  }
  // 四阶把 10~16 敲成 a~g，于是 f 在这一档是数字 15：能当数字用就当数字，当不了才是全屏键。
  if (k === 'f' || k === 'F') return void toggleFullscreen();
});

window.addEventListener('resize', draw);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushResume();
});
window.addEventListener('pagehide', flushResume);

applyThemeVars();
applySettings();
renderMenu();
loadSprites();
syncFullscreenBtn();

// 首启把玩法页摊开：一条"有教学"的判据不该要求玩家先去猜哪个按钮是。看完（或关掉）就记账，
// 以后每次启动都直接进选档页。
if (!Store.setting('seenHelp')) {
  Store.setSetting('seenHelp', true);
  toggleHelp(true);
}

// 全站只有一条 rAF 循环：仿真（动效时钟、粒子、涟漪）与过期判定都从这里进，别处不再各自计时。
requestAnimationFrame(frame);

// 可安装：只在 http(s) 下注册。Electron 与直接双击 index.html 走的都是 file://，那里
// navigator.serviceWorker 存在但 register 必抛，不吞掉就是每次启动一条未捕获异常。
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator
    && /^https?:$/.test(typeof location === 'object' && location ? location.protocol : '')) {
  window.addEventListener('load', () => {
    try {
      navigator.serviceWorker.register(new URL('sw.js', document.baseURI || location.href).href)
        .catch(() => {});
    } catch {
      /* 路径解析不了的宿主就不装，游戏照玩 */
    }
  });
}

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
  // ---- 时间与控制的可观测面 ---------------------------------------------------------------
  // 尺子要读的是"同样的真实时间有没有跑出同样的仿真"，所以这里给的是仿真自身的时钟与步数，
  // 而不是某一帧的像素。tick(ts) 就是把 rAF 的 ts 直接喂进同一段算术。
  tick: (ts) => frame(ts),
  get anim() {
    return fx.summary();
  },
  fx,
  get paused() {
    return paused;
  },
  pause: () => setPaused(true),
  resume: () => setPaused(false),
  togglePause: () => setPaused(!paused),
  get helpOpen() {
    return helpOpen;
  },
  help: toggleHelp,
  fullscreen: toggleFullscreen,
  toggleSound,
  sound: Sound.probe,
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
