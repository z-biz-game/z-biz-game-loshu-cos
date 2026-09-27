// Browser-side scenario suite, injected by tools/playtest.cjs and run against the real page.
//
// The rule for anything asserted here: read the DOM, the geometry and the canvas pixels, not a
// flag. A `.hidden` boolean says what the code intended; a client rect and a pixel say what the
// player got. The interesting failures in this game are exactly the ones where the state is
// right and the picture or the click is wrong — a digit the engine accepted but never painted,
// a line that reads closed in the ledger while its sum chip still says 12, a tap that lands one
// cell off because the margin is in the drawing but not in the hit test.
//
// window.loshu.engine is the *shipped* module graph (js/engine/loshu.js plus the generator and the
// unique-solve counter), so a scenario that passes here has passed on the same solver the
// player's hints come from — not a second copy kept for testing. Engine constants are read
// *inside* each scenario: this file is installed before the app's module has run, so window.loshu
// does not exist yet at load time.
//
// Only surfaces that actually hang off window.loshu are used: {version, view, game, show, begin,
// useHint, undo, setMode, select, press, erase, move, solveWithLogic, elapsed, state, cellAt,
// valueAt, candidates, boxLine, engine}. The heavy census (7040 / 384 / Burnside) lives in
// tools/engine-test.mjs; the browser re-counts only what is cheap enough to run in a page.

((w) => {
  'use strict';

  // ---- the harness ---------------------------------------------------------------
  const rows = [];
  const ck = (test, cond, detail) => {
    rows.push({ test, pass: !!cond, detail: cond ? '' : String(detail === undefined ? '' : detail) });
  };
  // Equality is spelled separately from truthiness on purpose: `ck('count', 0)` reads as a pass
  // to a boolean test and as a failure to a human, so every "this must equal that" here goes
  // through eq, and every "this must hold" through ck.
  const eq = (test, got, want) => ck(test, String(got) === String(want), `got ${got} want ${want}`);
  const report = (extra) => {
    // A scenario that checked nothing is a scenario that passed nothing.
    if (rows.length < 8) ck('这个场景真的跑了断言', false, `只有 ${rows.length} 条`);
    const bad = rows.filter((r) => !r.pass);
    const out = {
      checks: rows.length,
      fail: bad.length,
      failed: bad.map((f) => `${f.test} — ${f.detail}`),
      ...extra,
    };
    rows.length = 0;
    return out;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- page health: installed before the app's module runs ------------------------
  const pageErrors = [];
  w.addEventListener('error', (e) => pageErrors.push(String(e.message)));
  w.addEventListener('unhandledrejection', (e) => pageErrors.push('rejection: ' + (e && e.reason)));
  const realError = console.error;
  console.error = (...a) => {
    pageErrors.push('console.error: ' + a.join(' '));
    realError(...a);
  };

  const A = () => w.loshu;
  const E = () => w.loshu.engine;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const text = (sel) => {
    const e = $(sel);
    return e ? String(e.textContent || '').trim() : '';
  };
  const shown = (sel) => {
    const e = $(sel);
    if (!e) return false;
    if (e.hasAttribute('hidden')) return false;
    return getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0;
  };

  // ---- shared board reads (ink is the engine's own array, by design) --------------
  const ink = () => Array.from(A().game.st.fill);
  const filledCount = () => ink().filter((v) => v !== 0).length;
  const clueCells = () => {
    const b = A().game.board;
    return Array.from(b.cells).filter((t) => b.givenFlag[t]);
  };
  const blankCells = () => {
    const b = A().game.board;
    return Array.from(b.cells).filter((t) => !b.givenFlag[t]);
  };
  const ledger = () => $$('#line-ledger li .l-sum').map((b) => b.textContent.trim());
  const ledgerDone = () => $$('#line-ledger li.done').length;
  // The digits the engine's own pencil path would write, in order. Used only to *drive* the
  // gestures; every assertion below is made on the DOM and the canvas afterwards.
  const planPlaces = (board) => E().solve(board).rows.filter((r) => r.kind === 'place').map((r) => [r.cell, r.value]);
  const median = (arr) => {
    const a = arr.slice().sort((x, y) => x - y);
    return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
  };

  // ---- real gestures --------------------------------------------------------------
  // pointerdown on the canvas, then a click on the pad button: the same two events a player
  // produces, dispatched at the same nodes the app listens on.
  function pointer(type, x, y) {
    const ev = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX: x, clientY: y });
    A().view.canvas.dispatchEvent(ev);
    return ev;
  }
  const canvasPoint = (t) => {
    const r = A().view.cellRect(t);
    const box = A().view.canvas.getBoundingClientRect();
    return { x: box.left + r.x + r.size / 2, y: box.top + r.y + r.size / 2, size: r.size };
  };
  async function tapCell(t) {
    const p = canvasPoint(t);
    pointer('pointerdown', p.x, p.y);
    pointer('pointerup', p.x, p.y);
    await wait(30);
    return p;
  }
  async function press(v) {
    const b = $(`#pad button[data-value="${v}"]`);
    if (!b) throw new Error(`数字键盘里没有 ${v}`);
    b.click();
    await wait(30);
    return b;
  }

  // ---- pixel reads ----------------------------------------------------------------
  const hex = (h) => {
    const m = String(h).replace('#', '');
    if (m.length < 6) return [-1, -1, -1];
    return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
  };
  const rgba = (s) => {
    const m = String(s).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[,\s/]+/).filter((x) => x.length).map(Number);
    return { rgb: [p[0], p[1], p[2]], a: p.length > 3 ? p[3] : 1 };
  };
  const dist = (p, c) => Math.max(Math.abs(p[0] - c[0]), Math.abs(p[1] - c[1]), Math.abs(p[2] - c[2]));
  const closerTo = (p, a, b) => dist(p, a) < dist(p, b);
  const over = (base, top, alpha) => base.map((c, i) => Math.round(c * (1 - alpha) + top[i] * alpha));
  // CSS pixels in, device pixels read: the backing store is DPR-scaled and getImageData ignores
  // the ctx transform, so this is the one place the scaling is allowed to appear.
  function pixel(x, y) {
    const v = A().view;
    const d = v.geo.dpr;
    const i = Math.max(0, Math.min(Math.round(v.canvas.width - 1), Math.round(x * d)));
    const j = Math.max(0, Math.min(Math.round(v.canvas.height - 1), Math.round(y * d)));
    const p = v.ctx.getImageData(i, j, 1, 1).data;
    return [p[0], p[1], p[2]];
  }
  const cellPixel = (t) => {
    const r = A().view.cellRect(t);
    return pixel(r.x + r.size / 2, r.y + r.size / 2);
  };
  // A point inside the cell but off the glyph: the paper itself, wash and all.
  const paperPixel = (t) => {
    const r = A().view.cellRect(t);
    return pixel(r.x + r.size * 0.14, r.y + r.size * 0.86);
  };
  // The strongest colour on the cell's inner edge: whatever ring (cursor, rejection, hint) the UI
  // last painted, sampled past the grid line that sits exactly on the boundary.
  function strokePixel(t) {
    const r = A().view.cellRect(t);
    const paper = hex(E().theme.cellPaper);
    let best = paper;
    let bestD = 0;
    for (let k = 1; k <= 9; k++) {
      const p = pixel(r.x + k, r.y + r.size / 2);
      if (dist(p, paper) > bestD) {
        bestD = dist(p, paper);
        best = p;
      }
    }
    return best;
  }
  // How much ink (anything not the paper colour) a cell carries. Digits, notes and rings all
  // raise it; an empty, unselected cell sits at ~0. The pad keeps the sample inside the cell so
  // the grid lines and the cursor ring never count as ink.
  function inkIn(t, pad = 8) {
    const v = A().view;
    const d = v.geo.dpr;
    const r = v.cellRect(t);
    const x0 = Math.round((r.x + pad) * d);
    const y0 = Math.round((r.y + pad) * d);
    const side = Math.round((r.size - pad * 2) * d);
    if (side <= 2) return 0;
    const img = v.ctx.getImageData(x0, y0, side, side).data;
    const paper = hex(E().theme.cellPaper);
    let n = 0;
    for (let i = 0; i < img.length; i += 4) {
      if (dist([img[i], img[i + 1], img[i + 2]], paper) > 14) n++;
    }
    return Math.round((n / (img.length / 4)) * 1000) / 1000;
  }
  // Does the cell contain *any* pixel of this colour? Digits are 3/4 of a cell wide, so a centre
  // sample is a coin toss; scanning is the honest version of "the player can see it".
  function colourIn(t, color, tol = 30) {
    const v = A().view;
    const d = v.geo.dpr;
    const r = v.cellRect(t);
    const target = hex(color);
    const img = v.ctx.getImageData(Math.round(r.x * d), Math.round(r.y * d), Math.round(r.size * d), Math.round(r.size * d)).data;
    let n = 0;
    for (let i = 0; i < img.length; i += 4) {
      if (dist([img[i], img[i + 1], img[i + 2]], target) <= tol) n++;
    }
    return n;
  }
  const chipPixel = (rect) => pixel(rect.x + rect.w / 2, rect.y + rect.h / 2);

  // ---------- engine: the shipped solver, in the shipped page ----------
  const engine = async () => {
    const en = E();
    ck('页面挂出了可测的引擎', !!(en && en.createBoard && en.solve && en.countSolutions && en.makePuzzle));
    eq('版本号写在表面上', A().version, '1.0.0');
    eq('开局零报错', pageErrors.length, 0);
    ck('boot 之后在选档页', shown('#view-menu') && !shown('#view-game'));
    eq('规则表里有六条', Object.keys(en.Rules).length, 6);
    const names = Object.values(en.Rules).map((r) => r.name);
    eq('第一条是行列补全', names[0], '行列补全');
    eq('最后一条是反证', names[5], '反证');
    eq('档位有三档', en.TIERS.length, 3);
    let ordered = true;
    for (let i = 1; i < en.TIERS.length; i++) if (!(en.TIERS[i].band[0] > en.TIERS[i - 1].band[0])) ordered = false;
    ck('档位按实测难度递增', ordered, JSON.stringify(en.TIERS.map((t) => t.band)));
    eq('档位不认识时退回第一档', en.tierFor('nope').key, 'jiugong');

    // M 与恒等式：菜单与盘下那行说的算术，全部手算对回来
    eq('M(1)=1', en.magicSum(1), 1);
    eq('M(3) = 3(9+1)/2 = 15', en.magicSum(3), 15);
    eq('M(4) = 4(16+1)/2 = 34', en.magicSum(4), 34);
    eq('M(8) = 8(64+1)/2 = 260', en.magicSum(8), 260);
    eq('三阶 Σ线 = 3×15 = 45', en.sumIdentity(3).lines, 45);
    eq('三阶 Σ数 = 1+…+9 = 45', en.sumIdentity(3).values, 45);
    eq('四阶 Σ数 = 1+…+16 = 136', en.sumIdentity(4).values, 136);

    const luo = en.createBoard({ n: 3, pan: false, givens: Int8Array.from([4, 9, 2, 3, 5, 7, 8, 1, 6]) });
    eq('洛书八条线', luo.groups.length, 8);
    eq('洛书 verify 干净', en.verify(luo, luo.givens).length, 0);
    eq('洛书 complete', en.complete(luo, luo.givens), true);
    eq('洛书中心是 5', luo.givens[4], 5);
    eq('洛书身份行', en.identityText(luo), 'Σ线 = n·M = 3×15 = 45 = 1+2+…+9');
    eq('四四线集 10 条', en.createBoard({ n: 4, pan: false, givens: new Int8Array(16) }).groups.length, 10);
    eq('泛对角线集 16 条', en.createBoard({ n: 4, pan: true, givens: new Int8Array(16) }).groups.length, 16);
    const panGroups = en.groupsOf(4, true);
    const panLabels = panGroups.map((g) => g.label);
    ck('泛对角把斜带写进线名里', panLabels.includes('右斜带 1') && panLabels.includes('左斜带 4'), panLabels.slice(8).join(','));
    ck('泛对角不再另列主副对角线', !panLabels.includes('主对角线') && !panLabels.includes('副对角线'), panLabels.slice(8).join(','));
    const band1 = Array.from(panGroups.find((g) => g.label === '左斜带 1').cells).join('-');
    eq('环绕斜带 1 走 0-7-10-13（四四盘面上不是直线）', band1, '0-7-10-13');
    const anti = Array.from(en.groupsOf(4, false).find((g) => g.label === '副对角线').cells).join('-');
    eq('四四的副对角线只走 3-6-9-12', anti, '3-6-9-12');
    eq('三阶是互补对称的', en.ASSOCIATED['3:plain'], true);
    eq('四四不是互补对称', en.ASSOCIATED['4:plain'], false);
    eq('泛对角也不是互补对称', en.ASSOCIATED['4:pan'], false);

    // 浏览器里当场再数一遍三阶：清点器与出题器互不认识，只在数字上碰头
    const empty3 = en.createBoard({ n: 3, pan: false, givens: new Int8Array(9) });
    const all3 = en.countSolutions(empty3, { cap: 100, budget: 4_000_000 });
    eq('空三阶穷举 = 8 盘', all3.solutions, 8);
    eq('空三阶不是唯一解', all3.status, 'MANY');
    const one3 = en.countSolutions(en.createBoard({ n: 3, pan: false, givens: Int8Array.from([0, 0, 0, 0, 5, 0, 0, 0, 0]) }), { cap: 99, budget: 4_000_000 });
    eq('只钉住中心 5 还是有 8 盘', one3.solutions, 8);
    ck('空四四远不止一解', en.countSolutions(en.createBoard({ n: 4, pan: false, givens: new Int8Array(16) }), { cap: 40, budget: 400_000 }).status === 'MANY');

    // 菜单文案与引擎同源
    const li = $$('.rules li').map((x) => x.querySelector('b').textContent);
    eq('菜单列了六条规则', li.length, 6);
    eq('菜单规则名与引擎逐条相同', li.join(','), names.join(','));
    ck('菜单自己承认四阶不互补', $$('.rules li')[4].textContent.includes('四阶不成立'), $$('.rules li')[4].textContent);
    eq('选档列了三张牌', $$('#tier-list button.tier').length, 3);
    ck('每张牌写着实测区间', /实测 \d+–\d+/.test($('#tier-list button.tier').textContent), $('#tier-list button.tier').textContent);
    ck('开局不给继续卡', !shown('#resume-card'));

    A().begin({ tier: 'jiugong', seed: 'scen|engine' });
    await wait(80);
    eq('M 显示对了', text('#stat-m'), 'M=15');
    ck('身份行写着 45 恒等式', text('#identity-line').includes('= 45 = '), text('#identity-line'));
    ck('身份行还写了已填 Σ', text('#identity-line').includes('已填 Σ'), text('#identity-line'));
    eq('线账本行数 = 8', $$('#line-ledger li').length, 8);
    eq('键盘 1~9', $$('#pad button').length, 9);
    eq('已填 = 线索数', text('#stat-filled'), `${clueCells().length}/9`);
    eq('线索数 = 题面格数', text('#stat-clues'), String(clueCells().length));
    eq('待填 = 9 减线索', text('#stat-remaining'), String(9 - clueCells().length));
    eq('开局没有矛盾', text('#stat-problems'), '0');
    eq('档位名字上了面板', text('#stat-tier'), '九宫');
    ck('标题写了 3×3', text('#stat-name').includes('3×3'), text('#stat-name'));
    eq('合上的线与引擎同数', text('#stat-lines'), `${A().game.diag.lineDone}/8`);
    ck('难度实测是量出来的数', Number(text('#stat-score')) > 0, text('#stat-score'));
    eq('九宫给的正解合法', en.verify(A().game.board, en.solutionOf(A().game.board, A().game.puzzle.solution)).length, 0);
    eq('引擎场景零报错', pageErrors.length, 0);
    return report({ rules: names, bands: en.TIERS.map((t) => t.band.join('-')) });
  };

  // ---------- gen: every shipped board is unique and guess-free ----------
  const gen = async () => {
    const en = E();
    const med = [];
    for (const tier of en.TIERS) {
      let unique = 0;
      let pencil = 0;
      let nishio = 0;
      let scored = 0;
      let inBand = 0;
      let bad = 0;
      let clues = 0;
      const scores = [];
      for (let s = 0; s < 3; s++) {
        const p = en.makePuzzle(`scen|gen|${tier.key}|${s}`, tier.key);
        if (!p) continue;
        const c = en.countSolutions(p.board, { cap: 2, budget: 400_000 });
        if (c.status === 'UNIQUE') unique++;
        const r = en.solve(p.board);
        if (r.ok) pencil++;
        nishio += r.nishio;
        if (r.score === p.score) scored++;
        if (p.score >= tier.band[0] && p.score <= tier.band[1]) inBand++;
        if (en.verify(p.board, en.solutionOf(p.board, p.solution)).length) bad++;
        clues = p.clueCount;
        scores.push(p.score);
      }
      eq(`${tier.name}：3 局全部唯一解`, unique, 3);
      eq(`${tier.name}：3 局全部纯逻辑推得完`, pencil, 3);
      eq(`${tier.name}：反证出手 0 次`, nishio, 0);
      eq(`${tier.name}：重跑求解与出题同分`, scored, 3);
      eq(`${tier.name}：分数都落在自己区间`, inBand, 3);
      eq(`${tier.name}：抽盘器给的正解合法`, bad, 0);
      ck(`${tier.name}：线索数不低于 keep`, clues >= tier.keep, `${clues} vs ${tier.keep}`);
      eq(`${tier.name}：线数等于档位的线集`, en.makePuzzle('scen|gen|x', tier.key).board.groups.length, en.groupsOf(tier.n, tier.pan).length);
      med.push(median(scores));
    }
    eq('九宫线数 8', en.groupsOf(3, false).length, 8);
    eq('四四线数 10', en.groupsOf(4, false).length, 10);
    eq('泛对角线数 16', en.groupsOf(4, true).length, 16);
    // 难度是量出来的：三档的中位实测分必须阶梯上升
    ck('中位分单调上升', med[0] < med[1] && med[1] < med[2], JSON.stringify(med));
    ck(`${med[0]}→${med[1]}→${med[2]}：档间留了余量`, med[1] - med[0] > 20 && med[2] - med[1] > 4, JSON.stringify(med));
    // 同一个种子必须给同一盘题：存档只种子的前提
    const a = en.makePuzzle('scen|gen|same', 'sishi');
    const b = en.makePuzzle('scen|gen|same', 'sishi');
    eq('同种子同题面', Array.from(a.board.givens).join(','), Array.from(b.board.givens).join(','));
    eq('同种子同分数', a.score, b.score);
    const c = en.makePuzzle('scen|gen|other', 'sishi');
    ck('换种子就换题面', Array.from(a.board.givens).join(',') !== Array.from(c.board.givens).join(','));
    eq('生成场景零报错', pageErrors.length, 0);
    return report({ median: med.map((v) => Math.round(v * 10) / 10) });
  };

  // ---------- play: click digits on a 九宫 until the square closes ----------
  const play = async () => {
    A().begin({ tier: 'jiugong', seed: 'scen|play' });
    await wait(80);
    const g = A().game;
    const plan = planPlaces(g.board);
    eq('要填的格数 = 9 减线索数', plan.length, 9 - clueCells().length);
    ck('一开局没赢', !shown('#win-veil'));
    eq('开局步数 0', text('#stat-moves'), '0');
    const paper0 = hex(E().theme.cellPaper);
    const wash = rgba(E().theme.lineDone);
    const wantWash = over(paper0, wash.rgb, wash.a);
    let doneCell = -1;
    let plainCell = -1;
    let firstDoneAt = '';
    let midDone = null;
    let midPlain = null;
    for (const [t, v] of plan) {
      await tapCell(t);
      eq(`选中第 ${t} 格`, A().game.selected, t);
      await press(v);
      if (ink()[t] !== v) {
        ck('点击真的把数写进格子了', false, `t${t} 是 ${ink()[t]}，要 ${v}`);
        break;
      }
      // catch the first moment a line has closed while others still hang open
      if (doneCell < 0 && A().game.status !== 'won') {
        const dg = A().game.diag;
        const done = dg.lines.filter((l) => l.done);
        if (done.length && dg.lineDone < dg.lineCount) {
          const inDone = new Set();
          done.forEach((l) => l.cells.forEach((c) => inDone.add(c)));
          const cand = done[0].cells.find((c) => !A().game.board.givenFlag[c]);
          const plain = dg.lines.filter((l) => !l.done).flatMap((l) => l.cells).find((c) => !inDone.has(c) && !A().game.board.givenFlag[c]);
          if (cand !== undefined && plain !== undefined) {
            doneCell = cand;
            plainCell = plain;
            firstDoneAt = text('#stat-lines');
            // read the pixels NOW: after the win every cell wears the 合上 wash, so a sample
            // taken at the end would prove nothing about the mid-game picture
            midDone = paperPixel(cand);
            midPlain = paperPixel(plain);
          }
        }
      }
    }
    await wait(80);
    const g2 = A().game;
    eq('盘上下完显示 9/9', text('#stat-filled'), '9/9');
    eq('八条线都合上', text('#stat-lines'), '8/8');
    eq('线账本 8 个勾', ledger().filter((s) => s === '15 ✓').length, 8);
    eq('账本 done 条目 8', ledgerDone(), 8);
    eq('合上的线 8 条', g2.diag.lineDone, 8);
    eq('全盘数字和 = 45', g2.total, 45);
    eq('恒等式还说 45', g2.checksum, 45);
    eq('没有坏线', text('#stat-problems'), '0');
    eq('步数 = 落子次数', text('#stat-moves'), String(plan.length));
    eq('没花一次提示', text('#stat-hints'), '0');
    ck('胜利遮罩出来了', shown('#win-veil'));
    ck('遮罩上写了 M=15', text('#win-meta').includes('M=15'), text('#win-meta'));
    ck('遮罩上有战绩行', text('#win-record').length > 4, text('#win-record'));
    // pixels: the row that closed mid-game was already green before the win, the open ones were not
    ck('中途抓到过一条合上的线', doneCell >= 0, firstDoneAt);
    if (doneCell >= 0) {
      ck('合上的线在像素上是绿的', closerTo(midDone, wantWash, paper0), `${midDone} vs ${wantWash}`);
      ck('没合上的线还是白纸', dist(midPlain, paper0) <= 3, `${midPlain} vs ${paper0}`);
    }
    // finished: the whole square reads green, digits included
    const greenCells = blankCells().filter((t) => colourIn(t, E().theme.chipDone, 24) > 8).length;
    eq('填进去的格子全变成绿的墨', greenCells, plan.length);
    ck('题面给的数到胜利时也变绿', colourIn(clueCells()[0], E().theme.chipDone, 24) > 8, String(colourIn(clueCells()[0], E().theme.chipDone, 24)));
    const geo0 = A().view.geo;
    const winFrame = pixel(geo0.x - 1, geo0.y + (A().game.n * geo0.cell) / 2);
    ck('胜利时盘框换成成功色', closerTo(winFrame, hex(E().theme.success), hex(E().theme.lineHeavy)), String(winFrame));
    const frozenInk = ink().join(',');
    press(1);
    eq('下完之后再点键盘不写数', ink().join(','), frozenInk);
    eq('零报错贯穿一局', pageErrors.length, 0);
    return report({ moves: A().game.moves, hints: A().game.hints, firstDoneAt });
  };

  // ---------- reject: an illegal entry is visible and changes nothing ----------
  const reject = async () => {
    A().begin({ tier: 'jiugong', seed: 'scen|reject' });
    await wait(80);
    const g = A().game;
    const b = g.board;
    const paper = hex(E().theme.cellPaper);
    const errC = hex(E().theme.error);
    const usedValue = ink()[clueCells()[0]];
    // 1) a digit already on the board
    const dupTarget = b.cells.find((t) => !b.givenFlag[t] && Array.from(b.groupsOfCell[t]).length);
    const before = { filled: text('#stat-filled'), moves: text('#stat-moves'), lines: text('#stat-lines'), ink: ink().join(','), ledger: ledger().join('|') };
    const baseInk = inkIn(dupTarget);
    await tapCell(dupTarget);
    await press(usedValue);
    eq('重号没写进格子', ink()[dupTarget], 0);
    eq('盘面一格未动', ink().join(','), before.ink);
    eq('步数不涨', text('#stat-moves'), before.moves);
    eq('已填不涨', text('#stat-filled'), before.filled);
    eq('线账本一个字没变', ledger().join('|'), before.ledger);
    ck('拒绝理由写在盘下', /已经用在/.test(text('#box-line')), text('#box-line'));
    ck('理由里点名数字与格名', text('#box-line').includes(String(usedValue)) && /第\d行第\d列/.test(text('#box-line')), text('#box-line'));
    ck('理由还说了规则', text('#box-line').includes('每个数只能用一次'), text('#box-line'));
    ck('红圈画在被点的那格上', closerTo(strokePixel(dupTarget), errC, paper), `${strokePixel(dupTarget)} vs ${errC}`);
    eq('矛盾计数还是 0', text('#stat-problems'), '0');
    eq('被拒的那格一个像素都没多', inkIn(dupTarget), baseInk);
    // 2) a digit that pushes a line past M
    let overCell = -1;
    let overValue = 0;
    let lineLabel = '';
    for (const t of b.cells) {
      if (b.givenFlag[t] || ink()[t] !== 0) continue;
      for (const gi of b.groupsOfCell[t]) {
        const gr = b.groups[gi];
        const sum = Array.from(gr.cells).reduce((a, u) => a + ink()[u], 0);
        for (let v = 1; v <= b.size; v++) {
          if (ink().includes(v) || (t >= 0 && ink()[t] === v)) continue;
          if (sum + v > b.M) {
            overCell = t;
            overValue = v;
            lineLabel = gr.label;
            break;
          }
        }
        if (overCell >= 0) break;
      }
      if (overCell >= 0) break;
    }
    ck('找得到一个会把线推过 M 的填法', overCell >= 0, JSON.stringify({ overCell, overValue }));
    await tapCell(overCell);
    await press(overValue);
    eq('超和的填法被拒', ink()[overCell], 0);
    ck('拒理由里带 M=15 的算术', text('#box-line').includes(`超过 M=${b.M}`), text('#box-line'));
    ck('拒理由点名那条线', text('#box-line').includes(lineLabel), `${text('#box-line')} / ${lineLabel}`);
    ck('超和被拒时画布上给了红圈', closerTo(strokePixel(overCell), errC, paper), String(strokePixel(overCell)));
    // 3) a printed given cannot be edited
    const given = clueCells()[0];
    await tapCell(given);
    const gv = ink()[given];
    await press(gv === 1 ? 2 : 1);
    eq('题面给的数没被改掉', ink()[given], gv);
    ck('理由说这是题面给的数', text('#box-line').includes('题面给的'), text('#box-line'));
    ck('理由说出了那个数是几', text('#box-line').includes(String(gv)), text('#box-line'));
    eq('三次拒绝之后已填还是开局那样', text('#stat-filled'), before.filled);
    eq('三次拒绝之后合上的线也没变', text('#stat-lines'), before.lines);
    // 4) a tap on the margin (a sum chip) is a readout, not a move
    const box = A().view.canvas.getBoundingClientRect();
    const chip = A().view.rowChipRect(0);
    const movesBefore = text('#stat-moves');
    pointer('pointerdown', box.left + chip.x + chip.w / 2, box.top + chip.y + chip.h / 2);
    await wait(30);
    eq('点线外的数字块不落子', text('#stat-moves'), movesBefore);
    ck('它只说了一句该怎么填', text('#box-line').includes('点在线上的数字块'), text('#box-line'));
    eq('拒绝全程零报错', pageErrors.length, 0);
    return report({ rejected: [usedValue, overValue] });
  };

  // ---------- hint: the hint names a rule and a cell ----------
  const hint = async () => {
    A().begin({ tier: 'jiugong', seed: 'scen|hint' });
    await wait(80);
    const en = E();
    const names = Object.values(en.Rules).map((r) => r.name);
    eq('提示框初始文案', text('#hint-rule'), '提示理由');
    $('#btn-hint').click();
    await wait(60);
    const rule = text('#hint-rule');
    ck('提示说出了规则名', rule.startsWith('规则：') && names.includes(rule.slice(3)), rule);
    const line = text('#hint-line');
    ck('提示给出了算式而不是一句形容词', line.length > 8, line);
    eq('提示计数进面板', text('#stat-hints'), '1');
    eq('提示计数进按钮', text('#hint-count'), '1');
    eq('提示不花步数', text('#stat-moves'), '0');
    const named = line.match(/第(\d+)行第(\d+)列/);
    const lh = A().game.lastHint || {};
    const target = named ? (Number(named[1]) - 1) * A().game.n + (Number(named[2]) - 1) : lh.cell;
    ck('提示点名的格子在盘上', Number.isInteger(target) && target >= 0 && target < 9, String(target));
    if (named) eq('文案点名的格与引擎指的同一格', target, lh.cell);
    const paper = hex(en.theme.cellPaper);
    const hintC = hex(en.theme.hint);
    ck('提示的格子在画布上被圈了出来', closerTo(strokePixel(target), hintC, paper), `${strokePixel(target)} vs ${hintC}`);
    ck('提示要么落了子，要么划掉了一个候选', lh.kind === 'place' || lh.kind === 'prune', String(lh.kind));
    // keep hinting: the whole square has to fall out of the pencil rules, with no ink from the player
    let guard = 0;
    while (A().game.status !== 'won' && guard++ < 60) {
      $('#btn-hint').click();
      await wait(25);
    }
    eq('一路提示能把九宫推到底', A().game.status, 'won');
    ck('推到底用的求助次数有限', A().game.hints <= 40, String(A().game.hints));
    eq('全程没自己落过一手', text('#stat-moves'), '0');
    ck('求助次数记进了遮罩', /提示 \d+ 次/.test(text('#win-meta')), text('#win-meta'));
    eq('八条线都合上', ledger().filter((s) => s === '15 ✓').length, 8);
    ck('规则名都来自六条之一', !text('#hint-rule').startsWith('规则：') || names.includes(text('#hint-rule').slice(3)), text('#hint-rule'));
    // 互补对称 only holds for order 3, so 泛对角 must never cite it
    A().begin({ tier: 'pandiagonal', seed: 'scen|hint2' });
    await wait(60);
    const cited = [];
    for (let k = 0; k < 90 && A().game.status !== 'won'; k++) {
      $('#btn-hint').click();
      await wait(20);
      if (text('#hint-rule').startsWith('规则：')) cited.push(text('#hint-rule').slice(3));
    }
    const uniq = Array.from(new Set(cited));
    ck('泛对角档不引用互补对称', !uniq.includes('互补对称'), JSON.stringify(uniq));
    ck('泛对角档推得完', A().game.status === 'won', A().game.status);
    eq('泛对角档 16 条线', $$('#line-ledger li').length, 16);
    eq('泛对角档 M=34', text('#stat-m'), 'M=34');
    eq('泛对角 16/16 合上', text('#stat-lines'), '16/16');
    eq('提示全程零报错', pageErrors.length, 0);
    return report({ cited: uniq, hints: A().game.hints });
  };

  // ---------- notes: a note is a thought, not a decision ----------
  const notes = async () => {
    A().begin({ tier: 'jiugong', seed: 'scen|notes' });
    await wait(80);
    const g = A().game;
    const b = g.board;
    const t = b.cells.find((u) => !b.givenFlag[u]);
    eq('默认在填数模式', $('#btn-mode-fill').getAttribute('aria-pressed'), 'true');
    $('#btn-mode-note').click();
    await wait(40);
    eq('切到笔记模式', $('#btn-mode-note').getAttribute('aria-pressed'), 'true');
    eq('画布 dataset 跟着切', A().view.canvas.dataset.mode, 'note');
    ck('无障碍标签改了话术', (A().view.canvas.getAttribute('aria-label') || '').includes('笔记'), A().view.canvas.getAttribute('aria-label'));
    await tapCell(t);
    const candBefore = A().candidates(t).join(',');
    const filledBefore = text('#stat-filled');
    const linesBefore = text('#stat-lines');
    const inkBefore = inkIn(t);
    const v = Number(A().candidates(t)[0]);
    await press(v);
    ck('笔记落在格子里', (A().game.st.notes[t] & (1 << (v - 1))) > 0, String(A().game.st.notes[t]));
    eq('笔记不动候选池', A().candidates(t).join(','), candBefore);
    eq('笔记不填数', text('#stat-filled'), filledBefore);
    eq('笔记不动线账', text('#stat-lines'), linesBefore);
    ck('反馈说的是记下候选', text('#box-line').includes('记下候选'), text('#box-line'));
    eq('笔记算一步手势', text('#stat-moves'), '1');
    ck('笔记在画布上看得见', inkIn(t) > inkBefore + 0.002, `${inkBefore} → ${inkIn(t)}`);
    const withNote = inkIn(t);
    const other = b.cells.find((u) => !b.givenFlag[u] && u !== t && u !== A().game.selected);
    ck('没记笔记的格子没被画脏', inkIn(other) < inkIn(t), `${inkIn(other)} < ${inkIn(t)}`);
    // a note never breaks the board: the pencil path ignores it entirely
    A().setMode('fill');
    await wait(30);
    const r = A().solveWithLogic();
    eq('带着笔记照样推到底', r.status, 'won');
    ck('笔记没把盘面搞死', A().game.diag.lineBad === 0, String(A().game.diag.lineBad));
    // hide notes: the pixels go, the state stays
    A().begin({ tier: 'jiugong', seed: 'scen|notes2' });
    await wait(60);
    A().setMode('note');
    const t2 = A().game.board.cells.find((u) => !A().game.board.givenFlag[u]);
    await tapCell(t2);
    const basePixels = inkIn(t2);
    await press(Number(A().candidates(t2)[0]));
    const shownPixels = inkIn(t2);
    ck('笔记把这一格的墨加上去了', shownPixels > basePixels + 0.002, `${basePixels} → ${shownPixels}`);
    $('#btn-notes').click();
    await wait(60);
    eq('笔记开关改了 aria', $('#btn-notes').getAttribute('aria-pressed'), 'false');
    eq('开关文案改了', text('#btn-notes'), '笔记 藏');
    ck('藏起来之后画布回到基线', Math.abs(inkIn(t2) - basePixels) < 0.004, `${basePixels} → ${inkIn(t2)}`);
    ck('但引擎里那笔笔记还在', A().game.st.notes[t2] > 0, String(A().game.st.notes[t2]));
    $('#btn-notes').click();
    await wait(60);
    eq('开关文案改回来', text('#btn-notes'), '笔记 显');
    ck('再点开又画回来了', inkIn(t2) >= shownPixels, `${shownPixels} → ${inkIn(t2)}`);
    // a note on a printed given is refused out loud
    const givenCell = clueCells()[0];
    await tapCell(givenCell);
    await press(1);
    eq('题面格上记笔记被拒', A().game.st.notes[givenCell], 0);
    ck('拒理由是解释，不是沉默', text('#box-line').includes('题面给的'), text('#box-line'));
    ck('拒理由点名是哪一格', /第\d行第\d列/.test(text('#box-line')), text('#box-line'));
    // 模式是会被 localStorage 带进下一场的（begin() 读 Store.setting('mode')），所以收尾要
    // 用真的按钮把模式还回填数：用 click 而不是 setMode，正因为要验它写进设置里。
    $('#btn-mode-fill').click();
    await wait(30);
    eq('点填数按钮能切回去', A().view.canvas.dataset.mode, 'fill');
    eq('切回去也写进了设置（下一场开局读的就是它）',
      JSON.parse(localStorage.getItem('loshu.save.v1')).settings.mode, 'fill');
    eq('笔记场景零报错', pageErrors.length, 0);
    return report({ noteInk: withNote });
  };

  // ---------- undo: one gesture, not one bit of it ----------
  const undo = async () => {
    A().begin({ tier: 'jiugong', seed: 'scen|undo' });
    await wait(80);
    // 这一场把数按在数字键上，前提是「填数模式」。上一场留的模式会顺着 localStorage 溜进来，
    // 所以先点明前提：前提不成立时报「模式不对」，而不是报一句谁也看不懂的「墨没长」。
    eq('开局在填数模式（上一场不该把笔记模式留给下一场）', A().view.canvas.dataset.mode, 'fill');
    const b = A().game.board;
    const plan = planPlaces(b);
    // the engine's own route order: tryPlace is a legality test, and a row-scoped pick can ask a
    // line for a sum it cannot absorb — which is a correct refusal, not a failed gesture
    const s0 = plan[0];
    const s1 = plan[1];
    const base0 = inkIn(s0[0]);
    const base1 = inkIn(s1[0]);
    await tapCell(s0[0]);
    await press(s0[1]);
    await tapCell(s1[0]);
    await press(s1[1]);
    eq('两步之后已填涨了 2', text('#stat-filled'), `${clueCells().length + 2}/9`);
    eq('步数是 2', text('#stat-moves'), '2');
    ck('落子把墨画上去了', inkIn(s1[0]) > base1 + 0.004, `${base1} → ${inkIn(s1[0])}`);
    $('#btn-undo').click();
    await wait(60);
    eq('一次撤销只退一步', text('#stat-moves'), '1');
    eq('后填的那格空了', ink()[s1[0]], 0);
    eq('先填的那格还在', ink()[s0[0]], s0[1]);
    eq('已填回到 1 格前', text('#stat-filled'), `${clueCells().length + 1}/9`);
    ck('撤销后那一格的墨回到基线', Math.abs(inkIn(s1[0]) - base1) < 0.004, `${base1} → ${inkIn(s1[0])}`);
    const rowLine = ledger()[Math.floor(s1[0] / b.n)];
    ck('线账本跟着退回去', /差 \d+（剩/.test(rowLine), rowLine);
    $('#btn-undo').click();
    await wait(60);
    eq('再撤销回到开局', text('#stat-moves'), '0');
    eq('一格不剩（题面除外）', text('#stat-filled'), `${clueCells().length}/9`);
    $('#btn-undo').click();
    await wait(60);
    eq('没有可撤销时盘面不动', text('#stat-filled'), `${clueCells().length}/9`);
    eq('撤销到负数之外', text('#stat-moves'), '0');
    // a hint that walked through prunes is one gesture too
    A().begin({ tier: 'sishi', seed: 'scen|undo2' });
    await wait(80);
    let wrote = false;
    let beforeHintFilled = filledCount();
    let hintCell = -1;
    for (let k = 0; k < 24 && !wrote; k++) {
      beforeHintFilled = filledCount();
      $('#btn-hint').click();
      await wait(35);
      wrote = filledCount() > beforeHintFilled;
      if (wrote) hintCell = A().game.lastHint.cell;
    }
    ck('四四的提示最终会写下一个数', wrote, String(filledCount()));
    eq('提示花的是求助不是步数', text('#stat-moves'), '0');
    const inkAfterHint = hintCell >= 0 ? inkIn(hintCell) : 0;
    ck('提示写下的数真的画在画布上', inkAfterHint > 0.01, String(inkAfterHint));
    $('#btn-undo').click();
    await wait(60);
    eq('撤销把那一步整个收回', filledCount(), beforeHintFilled);
    ck('撤销不退还求助次数', Number(text('#stat-hints')) > 0, text('#stat-hints'));
    ck('收回之后那一格的墨也退了', hintCell >= 0 && inkIn(hintCell) < inkAfterHint, `${inkAfterHint} → ${hintCell >= 0 ? inkIn(hintCell) : -1}`);
    eq('撤销场景零报错', pageErrors.length, 0);
    return report({ hints: A().game.hints });
  };

  // ---------- save: what a resume has to carry ----------
  const save = async () => {
    const en = E();
    en.Store.reset();
    A().begin({ tier: 'jiugong', seed: 'scen|save' });
    await wait(60);
    const g = A().game;
    const plan = planPlaces(g.board).slice(0, 2);
    for (const [t, v] of plan) {
      await tapCell(t);
      await press(v);
    }
    A().useHint();
    await wait(40);
    A().setMode('note');
    const nt = g.board.cells.find((u) => g.isBlank(u) && !g.givenAt(u));
    await tapCell(nt);
    await press(Number(A().candidates(nt)[0]) || 1);
    const movesNow = A().game.moves;
    const hintsNow = A().game.hints;
    const inkNow = ink().join(',');
    const noteNow = A().game.st.notes[nt];
    A().show('menu');
    await wait(60);
    const raw = JSON.parse(localStorage.getItem('loshu.save.v1'));
    ck('存档键名是本作的', !!raw && !!raw.resume, Object.keys(raw || {}).join(','));
    eq('存档写原始种子', raw.resume.seed, g.puzzle.originSeed);
    eq('存档写档位', raw.resume.tier, 'jiugong');
    eq('存档写格数', raw.resume.cells, 9);
    eq('存档写步数', raw.resume.moves, movesNow);
    eq('存档写提示数', raw.resume.hints, hintsNow);
    ck('存档写用时', raw.resume.elapsedMs > 0, raw.resume.elapsedMs);
    ck('存档不过 2 千字', JSON.stringify(raw.resume).length < 2000, JSON.stringify(raw.resume).length);
    ck('存档不抄盘面，只抄游程对', Array.isArray(raw.resume.ink) && raw.resume.ink.length <= 9 * 2, JSON.stringify(raw.resume.ink));
    ck('续局整份不到 200 字节', JSON.stringify(raw.resume).length < 200, JSON.stringify(raw.resume).length);
    ck('存档不写答案', !JSON.stringify(raw).includes('solution'), JSON.stringify(raw).slice(0, 120));
    const back = en.Store.resume();
    eq('墨回来了', Array.from(back.fill).join(','), inkNow);
    eq('笔记回来了', back.notes[nt], noteNow);
    eq('题面不在存档里（靠种子重画）', raw.resume.givens, undefined);
    eq('设置默认音效开', en.Store.setting('sound'), true);
    eq('设置默认笔记显', en.Store.setting('showNotes'), true);
    en.Store.setSetting('showNotes', false);
    eq('设置落盘', JSON.parse(localStorage.getItem('loshu.save.v1')).settings.showNotes, false);
    en.Store.setSetting('showNotes', true);
    // a leftover save from a sibling repo must not be read
    localStorage.setItem('shikaku.save.v1', JSON.stringify({ settings: { showNotes: false }, resume: { seed: 'x' } }));
    eq('不读隔壁仓的存档键', en.Store.setting('showNotes'), true);
    localStorage.removeItem('shikaku.save.v1');
    ck('选档页上留着继续卡', shown('#resume-card'));
    ck('继续卡写着档位', text('#resume-name').includes('九宫'), text('#resume-name'));
    ck('继续卡写着代价', /步 · 提示 \d+ 次/.test(text('#resume-meta')), text('#resume-meta'));
    eq('存档场景零报错', pageErrors.length, 0);
    return report({ seed: g.puzzle.originSeed, moves: movesNow, hints: hintsNow, bytes: JSON.stringify(raw.resume).length });
  };

  // ---------- resume: a save written before this page load, then the 继续 button ----------
  const resume = async () => {
    const en = E();
    // playtest.cjs re-navigates for every scenario, so reaching this page with a save on disk is a
    // genuine reload: nothing in this scenario wrote it.
    const fromDisk = !!en.Store.resume();
    const saved = en.Store.resume();
    ck('读盘之后存档还在', !!saved);
    if (!saved) return report({ resumedFromReload: false, skipped: true });
    const rawFill = Array.from(saved.fill);
    const rawMoves = saved.moves;
    const rawHints = saved.hints;
    const rawElapsed = saved.elapsedMs;
    ck('回选档留下继续卡', shown('#resume-card'));
    ck('继续卡写着档位', text('#resume-name').includes('九宫'), text('#resume-name'));
    $('#btn-resume').click();
    await wait(80);
    const g = A().game;
    eq('续局重绘出同一个题面', Array.from(g.board.givens).join(','), Array.from(en.makePuzzle(saved.seed, saved.tier).board.givens).join(','));
    eq('续局还原全部墨水', ink().join(','), rawFill.join(','));
    eq('续局还原步数', text('#stat-moves'), String(rawMoves));
    eq('续局还原提示数', text('#stat-hints'), String(rawHints));
    ck('续局接着计时', A().elapsed() >= rawElapsed, `${A().elapsed()} vs ${rawElapsed}`);
    ck('时间显示是 mm:ss', /^\d\d:\d\d$/.test(text('#stat-time')), text('#stat-time'));
    ck('续局带着存档里的墨水', ink().join(',') === rawFill.join(','), ink().join(','));
    eq('续局之后点撤销不会退到存档之前（存档只带墨水不带历史）', A().undo(), null);
    eq('撤销失败也不动盘面', ink().join(','), rawFill.join(','));
    A().begin({ tier: saved.tier, seed: saved.seed, resume: saved });
    await wait(60);
    eq('重放存档：墨水一格不差', ink().join(','), rawFill.join(','));
    const tInked = rawFill.findIndex((val, u) => val !== 0 && !A().game.board.givenFlag[u]);
    ck('续局之后那格在画布上真有墨', inkIn(tInked) > 0.01, String(inkIn(tInked)));
    const tEmpty = A().game.board.cells.find((u) => !A().game.board.givenFlag[u] && rawFill[u] === 0 && u !== A().game.selected);
    ck('续局之后没写的格子明显更干净', inkIn(tEmpty) < inkIn(tInked) / 3, `${inkIn(tEmpty)} vs ${inkIn(tInked)}`);
    const r = A().solveWithLogic();
    eq('续局可以推到胜利', r.status, 'won');
    ck('胜利记了档', !!en.Store.best(saved.tier), JSON.stringify(en.Store.best(saved.tier)));
    eq('胜利后续局被清掉', en.Store.resume(), null);
    ck('胜利遮罩可见', shown('#win-veil'));
    $('#btn-menu-2').click();
    await wait(40);
    ck('胜利后回选档不再给继续', !shown('#resume-card'));
    ck('纪录列表写上了时间', /\d\d:\d\d/.test(text('#record-list li')), text('#record-list li'));
    $('#btn-reset').click();
    await wait(40);
    eq('清空存档清掉纪录', en.Store.best('jiugong'), null);
    ck('清空存档回到选档', shown('#view-menu'));
    eq('清空后续档也没了', en.Store.resume(), null);
    eq('续局场景零报错', pageErrors.length, 0);
    return report({ resumedFromReload: fromDisk, seed: saved.seed });
  };

  // ---------- win: the veil, the record, the arithmetic on show ----------
  const win = async () => {
    A().begin({ tier: 'jiugong', seed: 'scen|win' });
    await wait(60);
    eq('开局遮罩藏着的', $('#win-veil').hasAttribute('hidden'), true);
    const r = A().solveWithLogic();
    await wait(80);
    eq('逻辑推到底', r.status, 'won');
    const g = A().game;
    ck('遮罩可见', shown('#win-veil'));
    ck('遮罩标题说每条线等于 M', text('#win-veil h3').includes('M'), text('#win-veil h3'));
    ck('遮罩写了 3×3', text('#win-meta').includes('3×3'), text('#win-meta'));
    ck('遮罩写了 M=15', text('#win-meta').includes('M=15'), text('#win-meta'));
    ck('遮罩写了提示次数', /提示 \d+ 次/.test(text('#win-meta')), text('#win-meta'));
    eq('八条线全绿', $$('#line-ledger li.done').length, 8);
    eq('每条都写 15 ✓', ledger().filter((s) => s === '15 ✓').length, 8);
    eq('合上的线 8/8', text('#stat-lines'), '8/8');
    eq('已填 9/9', text('#stat-filled'), '9/9');
    eq('全盘和 45', g.total, 45);
    eq('校验和 45', g.checksum, 45);
    const p = A().game.puzzle;
    const sol = Array.from(E().solutionOf(p.board, p.solution)).join(',');
    eq('玩家填出来的就是唯一解', ink().join(','), sol);
    eq('穷举器也说这一盘只有一解', E().countSolutions(p.board, { cap: 2, budget: 400_000 }).solutions, 1);
    ck('胜利之后题面格仍不可动', g.placeAt(p.board.cells.find((t) => g.givenAt(t)), 1).ok === false);
    ck('胜利之后键盘不再写数', (A().press(3), ink().join(',')), sol);
    // the win is decided by the engine's independent verify(), not by a counter
    eq('verify 干净', E().verify(g.board, g.st.fill).length, 0);
    eq('complete 为真', E().complete(g.board, g.st.fill), true);
    // and the two line definitions in the repo agree with each other on this square
    const rowsOk = E().groupsOf(3, false).every((gr) => Array.from(gr.cells).reduce((a, t) => a + g.st.fill[t], 0) === 15);
    eq('八条线自己算一遍也都是 15', rowsOk, true);
    // pixels: the finished square is green everywhere, the frame too
    const paper0 = hex(E().theme.cellPaper);
    const wash = rgba(E().theme.lineDone);
    const wantWash = over(paper0, wash.rgb, wash.a);
    const greens = g.board.cells.filter((t) => closerTo(paperPixel(t), wantWash, paper0)).length;
    eq('九格在像素上都读成合上', greens, 9);
    ck('胜利盘上有绿色数字', blankCells().every((t) => colourIn(t, E().theme.chipDone, 24) > 8));
    $('#btn-again').click();
    await wait(80);
    eq('再来一局换掉了墨水', A().game.status, 'playing');
    ck('再来一局遮罩收起', !shown('#win-veil'));
    eq('新局步数归零', text('#stat-moves'), '0');
    eq('新局提示归零', text('#stat-hints'), '0');
    ck('新局题面不一样', Array.from(A().game.board.givens).join(',') !== Array.from(p.board.givens).join(','));
    eq('胜利场景零报错', pageErrors.length, 0);
    return report({});
  };

  // ---------- layout: geometry, chips outside the grid, narrow viewport ----------
  const layout = async () => {
    // 版式的唯一来源是那条 media query，测试就别自己抄一遍阈值：`max-width:900px` 是含 900 的，
    // 而 `innerWidth < 900` 在正好 900 时判成宽屏，于是断言会和浏览器实际用的那份版式相反。
    const narrow = w.matchMedia('(max-width: 900px)').matches;
    A().begin({ tier: narrow ? 'jiugong' : 'pandiagonal', seed: 'scen|layout' });
    await wait(120);
    const v = A().view;
    const g = A().game;
    const n = g.n;
    const geo = v.geo;
    eq('盘面尺寸就是档位', `${g.w}×${g.h}`, `${n}×${n}`);
    eq('DPR 与设备一致', geo.dpr, Math.max(1, Math.round(w.devicePixelRatio || 1)));
    eq('画布缓冲按 DPR 放大', v.canvas.width, Math.round(parseFloat(v.canvas.style.width) * geo.dpr));
    const rect = v.canvas.getBoundingClientRect();
    ck('画布整个在视口里', rect.left >= -1 && rect.top >= -1 && rect.right <= w.innerWidth + 1 && rect.bottom <= w.innerHeight + 1, JSON.stringify({ l: rect.left, r: rect.right, b: rect.bottom, vw: w.innerWidth, vh: w.innerHeight }));
    ck('格子不小于可点最小值', geo.cell >= 26, String(geo.cell));
    ck('页面没有横向溢出', document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1, `${document.documentElement.scrollWidth} vs ${document.documentElement.clientWidth}`);
    // geometry: cell rects tile the grid, row-major
    let tiled = true;
    for (let t = 0; t < n * n; t++) {
      const r = v.cellRect(t);
      const want = { x: geo.x + (t % n) * geo.cell, y: geo.y + Math.floor(t / n) * geo.cell, size: geo.cell };
      if (Math.abs(r.x - want.x) > 0.01 || Math.abs(r.y - want.y) > 0.01 || r.size !== want.size) tiled = false;
    }
    ck('格子矩形按行主序铺满', tiled, JSON.stringify(v.cellRect(Math.min(n + 1, n * n - 1))));
    // hit test uses the same numbers the drawing used — round trip every cell
    let misses = 0;
    for (let t = 0; t < n * n; t++) {
      const p = canvasPoint(t);
      if (v.hitCell(p.x, p.y) !== t) misses++;
    }
    eq('每一格都点得中', misses, 0);
    // the margin is not the board: a tap on a sum chip must not write into a corner cell
    eq('点行和块不落子', v.hitCell(rect.left + v.rowChipRect(0).x + 4, rect.top + v.rowChipRect(0).y + 4), -1);
    eq('点列和块不落子', v.hitCell(rect.left + v.colChipRect(0).x + 4, rect.top + v.colChipRect(0).y + 4), -1);
    ck('行和块画在盘的右边', v.rowChipRect(0).x >= n * geo.cell + geo.x, JSON.stringify(v.rowChipRect(0)));
    ck('列和块画在盘的下边', v.colChipRect(0).y >= n * geo.cell + geo.y, JSON.stringify(v.colChipRect(0)));
    ck('斜带和块画在盘的上边', v.diagChipRect().y < geo.y, JSON.stringify(v.diagChipRect()));
    ck('Σ 块画在盘的左上角', (() => { const s = v.sumChipRect(); return s.x < geo.x && s.y < geo.y; })(), JSON.stringify(v.sumChipRect()));
    // chips carry the running sums: the corner block really says Σfilled/45
    const surf = hex(E().theme.surface);
    const lift = hex(E().theme.surfaceLift);
    const chip = v.rowChipRect(0);
    const cp = chipPixel(chip);
    ck('行和块在画布上真的画出来了', !closerTo(cp, surf, lift), `${cp} vs ${surf}/${lift}`);
    const sc = v.sumChipRect();
    ck('Σ 块也画出来了', !closerTo(chipPixel(sc), surf, lift), String(chipPixel(sc)));
    ck('Σ 块的读数写在盘下那行', text('#identity-line').includes(`已填 Σ${g.total}`), text('#identity-line'));
    // the panel never sits on top of the board
    const wrapRect = $('#board-wrap').getBoundingClientRect();
    const padRect = $('#pad').getBoundingClientRect();
    ck('键盘与棋盘不相叠', wrapRect.right <= padRect.left + 1 || wrapRect.bottom <= padRect.top + 1, JSON.stringify({ wr: Math.round(wrapRect.right), pl: Math.round(padRect.left), wb: Math.round(wrapRect.bottom), pt: Math.round(padRect.top) }));
    const style = getComputedStyle($('#view-game'));
    ck('游戏页是网格/弹性布局', style.display === 'grid' || style.display === 'flex', style.display);
    ck('窄屏下菜单换列', getComputedStyle($('.menu-cols')).display !== 'none');
    eq('线账本跟着档位', $$('#line-ledger li').length, g.board.groups.length);
    eq('键盘格数 = n²', $$('#pad button').length, n * n);
    ck('最后一个键标着键位字母', /数字键/.test($$('#pad button').at(-1).title), $$('#pad button').at(-1).title);
    await tapCell(0);
    const p = hex(E().theme.cellPaper);
    const edge = hex(E().theme.accentEdge);
    ck('选中后画布上有光标', closerTo(strokePixel(g.selected), edge, p), `${strokePixel(g.selected)} vs ${edge}`);
    ck(narrow ? '窄屏：键盘排在棋盘之下' : '宽屏：键盘排在棋盘之右', narrow ? padRect.top >= wrapRect.top : padRect.left >= wrapRect.left, JSON.stringify({ wl: Math.round(wrapRect.left), wr: Math.round(wrapRect.right), pl: Math.round(padRect.left), pt: Math.round(padRect.top) }));
    eq('布局场景零报错', pageErrors.length, 0);
    return report({ width: window.innerWidth, cell: geo.cell, margin: geo.m, narrow });
  };

  w.__ng = { engine, gen, play, reject, hint, notes, undo, save, resume, win, layout };
})(window);
