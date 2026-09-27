// Engine unit tests, run in plain Node: `npm test`.
//
// The risk in this repo is not arithmetic but soundness: a single rule that wrote a cell the
// rules of the game do not force, and every board would still ship, the hints would still be
// self-consistent, and "每局都能推到底" would be a caption on a coin flip. So the expectations
// below are hand-derived from squares worked out on paper (and written down as literals), and
// the census numbers are re-derived twice over — once by the counter that ships in count.js and
// once by the small independent counter at the bottom of this file. Nothing here reads an
// expectation back off the solver it is testing.
//
// Runtime: ~10 s. Most of it is the three exhaustive censuses (8 / 7040 / 384 squares) and the
// order-4 re-counts, which is the price of asserting the numbers the README quotes instead of
// quoting them.

import {
  EMPTY,
  MAX_N,
  ROW,
  COL,
  DIAG,
  PAN,
  ASSOCIATED,
  Rules,
  magicSum,
  sumIdentity,
  groupsOf,
  createBoard,
  createState,
  rebuild,
  cloneState,
  resetInk,
  propagate,
  applyDeduction,
  nextDeduction,
  findContradiction,
  solve,
  verify,
  complete,
  filled,
  diagnose,
  tryPlace,
  eraseCell,
  toggleNote,
  snapshot,
  undo,
  cellName,
  lineReadout,
  identityText,
  subsetReach,
  lineValues,
  reachable,
  pop,
  bitOf,
  hasBit,
  onlyValue,
  valuesOf,
} from '../js/engine/loshu.js';
import {
  linesFor,
  countSolutions,
  enumerate,
  d4Maps,
  applyMap,
  orbitStats,
  burnside,
  associatedCount,
  centreValues,
  wrappedBlocksSum,
  forcedBlockSum,
  mostPerfectCount,
  isPandiagonal,
  magicSumOf,
  UNIQUE,
  MANY,
  NONE,
} from '../js/engine/count.js';
import { randomSquare, peel, clueFloor, draw, TIERS, tierFor, makePuzzle, solutionOf } from '../js/engine/generate.js';
import { hash32, makeRng, dateSeed } from '../js/engine/rng.js';
import { Store, rleEncode, rleDecode, notesEncode, notesDecode, SHIFT } from '../js/store.js';
import { Game, padReadout } from '../js/ui/game.js';

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  if (String(got) === String(want)) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name}\n       got  ${got}\n       want ${want}`);
  }
};
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name} ${detail}`);
  }
};

// ---------- the two squares this whole repo is written against, by hand -----------------------
// 洛书: 4 9 2 / 3 5 7 / 8 1 6. Every line checked on paper below.
const LOSHU = [4, 9, 2, 3, 5, 7, 8, 1, 6];
// Dürer《忧郁 I》: 16 3 2 13 / 5 10 11 8 / 9 6 7 12 / 4 15 14 1, M = 4(16+1)/2 = 34.
const DURER = [16, 3, 2, 13, 5, 10, 11, 8, 9, 6, 7, 12, 4, 15, 14, 1];

const throws = (fn) => {
  try {
    fn();
    return '';
  } catch (e) {
    return e.message;
  }
};
const board3 = (pairs) => {
  const g = new Array(9).fill(EMPTY);
  for (const [t, v] of pairs) g[t] = v;
  return createBoard({ n: 3, pan: false, givens: g });
};
const board4 = (pairs, pan = false) => {
  const g = new Array(16).fill(EMPTY);
  for (const [t, v] of pairs) g[t] = v;
  return createBoard({ n: 4, pan, givens: g });
};
// The deductions the unit rules offer *right now*, without writing anything: propagate in
// preview mode is what lets one rule be looked at on its own.
const preview = (board, st = null) => propagate(st ? cloneState(board, st) : createState(board), { previewOnly: true }).found;
const forRule = (board, name, st = null) => preview(board, st).filter((d) => d.rule.name === name && d.kind !== 'dead');

// ---------- M = n(n²+1)/2, computed by hand for n = 1..8 --------------------------------------
// n=1: 1(1+1)/2 = 1        n=2: 2(4+1)/2 = 5        n=3: 3(9+1)/2 = 15     n=4: 4(16+1)/2 = 34
// n=5: 5(25+1)/2 = 65      n=6: 6(36+1)/2 = 111     n=7: 7(49+1)/2 = 175   n=8: 8(64+1)/2 = 260
eq('M(1)', magicSum(1), 1);
eq('M(2)', magicSum(2), 5);
eq('M(3)', magicSum(3), 15);
eq('M(4)', magicSum(4), 34);
eq('M(5)', magicSum(5), 65);
eq('M(6)', magicSum(6), 111);
eq('M(7)', magicSum(7), 175);
eq('M(8) = 8×65/2', magicSum(8), 260);
eq('count.js 自己那份 M 与 engine 一致（n=4）', magicSumOf(4), magicSum(4));
eq('count.js 自己那份 M 与 engine 一致（n=7）', magicSumOf(7), magicSum(7));

// Σ identity: n·M = n²(n²+1)/2 = 1+2+…+n². Hand: n=3 → 3×15 = 45 = 9·10/2; n=4 → 4×34 = 136
// = 16·17/2; n=8 → 8×252 = 2016 = 64·65/2.
for (let n = 1; n <= 8; n++) {
  const id = sumIdentity(n);
  eq(`Σ线 = Σ数 (n=${n})`, id.lines, id.values);
}
eq('n=3 全盘数字和', sumIdentity(3).values, 45);
eq('n=3 n·M', sumIdentity(3).lines, 45);
eq('n=4 全盘数字和', sumIdentity(4).values, 136);
eq('n=4 n·M', sumIdentity(4).lines, 136);
eq('n=8 n·M（8×260 = 2080 = 64×65/2）', sumIdentity(8).lines, 2080);
eq('候选掩码只够 4 阶', MAX_N, 4);
eq('EMPTY 是 0', EMPTY, 0);

// ---------- bit helpers, hand-checked ---------------------------------------------------------
eq('bitOf(1)', bitOf(1), 1);
eq('bitOf(9)', bitOf(9), 256); // 1 << 8
eq('pop(全 9 位)', pop(0x1ff), 9);
eq('pop(0)', pop(0), 0);
eq('onlyValue(bitOf(7))', onlyValue(bitOf(7)), 7);
eq('valuesOf(1|4)', valuesOf(bitOf(1) | bitOf(3)).join(','), '1,3');
eq('hasBit 拒绝没在掩码里的数', hasBit(bitOf(5), 6), false);
eq('3 阶全盘掩码 = 低 9 位（2^9-1 = 511）', board3([[0, 4]]).full, 511);
eq('4 阶全盘掩码 = 低 16 位（2^16-1 = 65535）', board4([[0, 1]], false).full, 65535);
eq('三阶 complement = n²+1 = 10', board3([[0, 4]]).complement, 10);

// ---------- what a line is --------------------------------------------------------------------
eq('三阶有 8 条线（3 行 + 3 列 + 2 对角）', groupsOf(3, false).length, 8);
eq('四四有 10 条线（4 + 4 + 2）', groupsOf(4, false).length, 10);
eq('泛对角四四有 16 条线（4 + 4 + 8 条环绕斜带）', groupsOf(4, true).length, 16);
eq('count.js 那份线集：三阶 8 条', linesFor(3, false).length, 8);
eq('count.js 那份线集：四四 10 条', linesFor(4, false).length, 10);
eq('count.js 那份线集：泛对角 16 条', linesFor(4, true).length, 16);
eq('主对角线是 0,4,8', Array.from(groupsOf(3, false)[6].cells).join(','), '0,4,8');
// 副对角线在四阶是 3,6,9,12 —— 不是环绕的 0,7,10,13（那是泛对角斜带，写错就把 7040 数成 1088）
eq('四四副对角线是 3,6,9,12', Array.from(groupsOf(4, false)[9].cells).join(','), '3,6,9,12');
ok(
  '四四副对角线不是环绕带',
  !linesFor(4, false).some((l) => l.join(',') === '0,7,10,13'),
  linesFor(4, false).map((l) => l.join(',')).join(' | ')
);
ok(
  '环绕带 0,7,10,13 只在泛对角档出现',
  linesFor(4, true).some((l) => l.join(',') === '0,7,10,13') && !linesFor(3, false).some((l) => l.length === 4)
);
eq('线 kinds 齐备', [...new Set(groupsOf(4, true).map((g) => g.kind))].join(','), `${ROW},${COL},${PAN}`);
eq('普通档 kinds', [...new Set(groupsOf(4, false).map((g) => g.kind))].join(','), `${ROW},${COL},${DIAG}`);
eq('洛书 label 从第1行起', groupsOf(3, false)[0].label, '第1行');
eq('泛对角斜带 label', groupsOf(4, true)[8].label, '右斜带 1');

// ---------- 洛书：八条线的和全在纸上算过 ------------------------------------------------------
{
  const b = board3(LOSHU.map((v, t) => [t, v]));
  eq('洛书 M', b.M, 15);
  eq('洛书 verify 无问题', verify(b, Int8Array.from(LOSHU)).length, 0);
  eq('洛书 complete', complete(b, Int8Array.from(LOSHU)), true);
  // rows: 4+9+2 = 15, 3+5+7 = 15, 8+1+6 = 15
  eq('第1行 4+9+2', LOSHU[0] + LOSHU[1] + LOSHU[2], 15);
  eq('第2行 3+5+7', LOSHU[3] + LOSHU[4] + LOSHU[5], 15);
  eq('第3行 8+1+6', LOSHU[6] + LOSHU[7] + LOSHU[8], 15);
  // cols: 4+3+8 = 15, 9+5+1 = 15, 2+7+6 = 15
  eq('第1列 4+3+8', LOSHU[0] + LOSHU[3] + LOSHU[6], 15);
  eq('第2列 9+5+1', LOSHU[1] + LOSHU[4] + LOSHU[7], 15);
  eq('第3列 2+7+6', LOSHU[2] + LOSHU[5] + LOSHU[8], 15);
  // diags: 4+5+6 = 15, 2+5+8 = 15
  eq('主对角 4+5+6', LOSHU[0] + LOSHU[4] + LOSHU[8], 15);
  eq('副对角 2+5+8', LOSHU[2] + LOSHU[4] + LOSHU[6], 15);
  eq('洛书中心互补：4+6 = n²+1', LOSHU[0] + LOSHU[8], b.complement);
  eq('洛书中心互补：9+1 = n²+1', LOSHU[1] + LOSHU[7], 10);
  eq('盘上 band 记号', b.band, '3:plain');
  eq('三阶普通类是 associated（穷举 8/8 见下）', b.associated, true);
  // 中心 5 的算术：过中心的四条线之和 4M = 60，等于全盘 45 加上中心多算 3 次 → c = (60-45)/3 = 5
  eq('4M − Σ数 = 3c 的左边', 4 * 15 - 45, 15);
  eq('所以中心 = 5', (4 * 15 - 45) / 3, 5);
}
{
  const b = board4(DURER.map((v, t) => [t, v]), false);
  eq('Dürer M', b.M, 34);
  eq('Dürer verify 无问题', verify(b, Int8Array.from(DURER)).length, 0);
  eq('Dürer complete', complete(b, Int8Array.from(DURER)), true);
  // rows 16+3+2+13 = 34, 5+10+11+8 = 34, 9+6+7+12 = 34, 4+15+14+1 = 34
  eq('Dürer 第1行', DURER[0] + DURER[1] + DURER[2] + DURER[3], 34);
  eq('Dürer 第2行', DURER[4] + DURER[5] + DURER[6] + DURER[7], 34);
  eq('Dürer 第3行', DURER[8] + DURER[9] + DURER[10] + DURER[11], 34);
  eq('Dürer 第4行', DURER[12] + DURER[13] + DURER[14] + DURER[15], 34);
  // cols 16+5+9+4 = 34, 3+10+6+15 = 34, 2+11+7+14 = 34, 13+8+12+1 = 34
  eq('Dürer 第1列', DURER[0] + DURER[4] + DURER[8] + DURER[12], 34);
  eq('Dürer 第2列', DURER[1] + DURER[5] + DURER[9] + DURER[13], 34);
  eq('Dürer 第3列', DURER[2] + DURER[6] + DURER[10] + DURER[14], 34);
  eq('Dürer 第4列', DURER[3] + DURER[7] + DURER[11] + DURER[15], 34);
  eq('Dürer 主对角 16+10+7+1', DURER[0] + DURER[5] + DURER[10] + DURER[15], 34);
  eq('Dürer 副对角 13+11+6+4', DURER[3] + DURER[6] + DURER[9] + DURER[12], 34);
  // The broken diagonal through cells 0,7,10,13 is 16+8+7+15 = 46 ≠ 34: Dürer is not pandiagonal.
  eq('Dürer 的环绕斜带 16+8+7+15 = 46', DURER[0] + DURER[7] + DURER[10] + DURER[13], 46);
  eq('所以 Dürer 不是泛对角盘', isPandiagonal(Int8Array.from(DURER), 4), false);
  eq('四四普通类不是 associated（384/7040，见穷举）', b.associated, false);
  eq('泛对角类也不是 associated（0/384，见穷举）', board4([], true).associated, false);
}

// ---------- createBoard refuses impossible 题面 ------------------------------------------------
eq('重复给定直接拒绝', throws(() => board3([[0, 4], [1, 4]])), '同一个数被给了两次：4');
eq('出界的数拒绝', throws(() => board3([[0, 10]])), '给定的数 10 不在 1~9 之内');
eq('长度不对拒绝', throws(() => createBoard({ n: 3, givens: [4, 9] })), 'givens length mismatch');
eq('五阶超出掩码', throws(() => createBoard({ n: 5, givens: new Array(25).fill(EMPTY) })), '本引擎只做 1~4 阶（候选位掩码只有 16 位）');
// 第1行给了 9 + 8：光这两格已经 17 > M = 15，这一行永远回不来
eq('一行已和超过 M 就拒绝', throws(() => board3([[0, 9], [1, 8]])), '第1行 给定的数已和到 17，超过 M=15');
// 三格给满而和不是 M：1 + 2 + 3 = 6
eq('一行填满但和不对就拒绝', throws(() => board3([[0, 1], [1, 2], [2, 3]])), '第1行 已满但和是 6，不是 15');
// 对角线上重号：全局的「同一个数被给了两次」先拦住，所以按线检查那一道是纵深防御而不是第一道门
eq('对角线上重号也拒绝', throws(() => board3([[0, 7], [4, 7]])), '同一个数被给了两次：7');
eq('空题面合法（0 个给定）', createBoard({ n: 3, givens: new Array(9).fill(EMPTY) }).size, 9);

// ---------- subset-sum: the arithmetic behind 区间剪枝, done by hand ---------------------------
// vals = [1,2,3,5,6,7,8,9] (即 9 个数里去掉已用的 4)，取 2 个凑 11：
// 2+9 = 11, 3+8 = 11, 5+6 = 11 → 参与的数只有 {2,3,5,6,8,9}，1 和 7 谁都凑不出来。
{
  const r = subsetReach([1, 2, 3, 5, 6, 7, 8, 9], 2, 11);
  eq('凑得出 11', r.ok, true);
  eq('参与凑 11 的数', valuesOf(r.mask).join(','), '2,3,5,6,8,9');
  ok('1 被排除', !hasBit(r.mask, 1));
  ok('7 被排除', !hasBit(r.mask, 7));
  // 三格凑 6，只能 1+2+3
  const r2 = subsetReach([1, 2, 3, 4, 5], 3, 6);
  eq('1+2+3 是唯一解', valuesOf(r2.mask).join(','), '1,2,3');
  // 两格凑 3：1+2
  eq('两格凑 3 只剩 1,2', valuesOf(subsetReach([1, 2, 3, 4], 2, 3).mask).join(','), '1,2');
  eq('凑不到的时候 ok 是 false', subsetReach([1, 2], 2, 9).ok, false);
  eq('k=0 且 want=0 才算成', subsetReach([], 0, 0).ok, true);
  eq('k=0 而 want>0 不成', subsetReach([], 0, 1).ok, false);
  // 四阶主对角：给了 16 与 10，剩两格要凑 34-26 = 8；不重复的配对只有 1+7, 2+6, 3+5
  eq('8 = 1+7 / 2+6 / 3+5', valuesOf(subsetReach([1, 2, 3, 5, 6, 7, 8, 9], 2, 8).mask).join(','), '1,2,3,5,6,7');
}

// ---------- 六条铅笔规则，各自在手写盘上单独点火 ------------------------------------------------
eq('规则表里有六条', Object.keys(Rules).length, 6);
eq('规则名字', Object.values(Rules).map((r) => r.name).join(','), '行列补全,候选排除,区间剪枝,对角线,互补对称,反证');
eq('权重从小到大', Object.values(Rules).map((r) => r.weight).join(','), '1,1.5,2.5,2,3,6');
{
  // 只给 t0 = 4：第1行还差 15-4 = 11、剩 2 格 → 1 与 7 谁都凑不出（上面手算）
  const b = board3([[0, 4]]);
  const p = forRule(b, '区间剪枝');
  eq('区间剪枝第一刀砍在第1行第2列的 1', `${p[0].cell},${p[0].value}`, '1,1');
  eq('区间剪枝第二刀砍 7', `${p[1].cell},${p[1].value}`, '1,7');
  eq('区间剪枝只砍不填', p[0].kind, 'prune');
  ok('区间剪枝说的是 11 和 2 格', p[0].rule.text(b, p[0]).includes('还差 11'), p[0].rule.text(b, p[0]));
  // 两条对角线同样差 11（主对角 0,4,8 已有 4）→ 同样砍掉 1 与 7
  const d = forRule(b, '对角线');
  eq('对角线第一刀在主对角上', `${d[0].cell},${d[0].value}`, '4,1');
  ok('对角线与区间剪枝是不同的线', d[0].cell !== p[0].cell);
}
{
  // 给 t0 = 4, t1 = 9：第1行只差一格，15 - (4+9) = 2
  const b = board3([[0, 4], [1, 9]]);
  const p = forRule(b, '行列补全');
  eq('行列补全填出 2', `${p[0].cell},${p[0].value}`, '2,2');
  eq('行列补全是填数不是删候选', p[0].kind, 'place');
  ok('提示词里有 15 减已和 13', p[0].rule.text(b, p[0]).includes('M=15 减已和 13 = 2'), p[0].rule.text(b, p[0]));
  // 互补对称：三阶每一盘对角互补，t0 = 4 → 对面 t8 = 10 - 4 = 6
  const c = forRule(b, '互补对称');
  eq('互补对称把 t0=4 映到 t8=6', `${c[0].cell},${c[0].value}`, '8,6');
  ok('互补对称说的是凑成 10', c[0].rule.text(b, c[0]).includes('10'), c[0].rule.text(b, c[0]));
}
{
  // 八个给定、只剩 t8 空：全盘唯一没用过的数是 6；同时 15-(8+1) = 6、15-(2+7) = 6、10-4 = 6
  const b = board3(LOSHU.slice(0, 8).map((v, t) => [t, v]));
  eq('候选数只剩一个', valuesOf(createState(b).cand[8]).join(','), '6');
  const n = forRule(b, '候选排除');
  eq('候选排除落在 t8 = 6', `${n[0].cell},${n[0].value}`, '8,6');
  eq('三条线在这一步意见一致', forRule(b, '行列补全')[0].value, 6);
  eq('互补对称也给出 6', forRule(b, '互补对称')[0].value, 6);
  // 诚实的边界：候选掩码 = 全盘未用之数（线内掩码必然是它的子集），所以「候选排除」要等到只剩
  // 一个数没用才点得着 —— 实测出货盘里九宫档一次都不点它（40 局 0 次）。
  const mid = board3([[0, 4], [1, 9], [3, 3], [4, 5]]);
  const ms = createState(mid);
  eq('候选掩码与线内掩码同源', ms.cand[2], mid.full & ~ms.used);
  eq('四格给定时 t2 的候选 = 9-4 = 5 个', pop(ms.cand[2]), 5);
  eq('t2 的候选就是没给过的那 5 个数', valuesOf(ms.cand[2]).join(','), '1,2,6,7,8');
}
{
  // 只有中心 5 的三阶盘：单位规则推不完，反证先说 t0 ≠ 1（三阶每一盘的四个角都是偶数，见穷举）
  const b = board3([[4, 5]]);
  const st = createState(b);
  const r = findContradiction(st);
  eq('反证给出一条删候选', r && r.rule.name, '反证');
  eq('反证的第一刀在 t0 上砍 1', `${r.cell},${r.value}`, '0,1');
  ok('反证的措辞是「假设…推到底会出现凑不出的线」', r.rule.text(b, r).includes('假设'), r.rule.text(b, r));
  // 独立复核：8 盘洛书里 t0 从来不是奇数，所以这一刀是真的
  const cen = enumerate(3, false).squares;
  eq('八盘洛书的 t0 全是偶数', cen.filter((g) => g[0] % 2 === 0).length, 8);
  eq('八盘洛书的 t0 取值集合', centreValues(cen, 3).join(','), '5');
  ok('反证砍掉的值不在任何一盘的 t0 上', !cen.some((g) => g[0] === 1));
}

// ---------- 穷举清点：README 引的数字全部当场再数一遍 -----------------------------------------
console.log('== 穷举清点（npm test 现场跑的数，不是书上的）==');
const t0run = Date.now();
const cen3 = enumerate(3, false);
const cen4 = enumerate(4, false);
const cen4p = enumerate(4, true);
const keyOf = (g) => Array.from(g).join(',');
console.log(
  `  三阶：${cen3.squares.length} 盘 / ${orbitStats(cen3.squares, 3).fundamental} 基本盘（节点 ${cen3.nodes}，${cen3.ms} ms）`
);
console.log(
  `  四四：${cen4.squares.length} 盘 / ${orbitStats(cen4.squares, 4).fundamental} 基本盘（节点 ${cen4.nodes}，${cen4.ms} ms）`
);
console.log(
  `  泛对角：${cen4p.squares.length} 盘 / ${orbitStats(cen4p.squares, 4).fundamental} 基本盘（节点 ${cen4p.nodes}，${cen4p.ms} ms）`
);
{
  const os = orbitStats(cen3.squares, 3);
  const bs = burnside(cen3.squares, 3);
  eq('三阶总数 8', cen3.squares.length, 8);
  eq('三阶基本盘 1', os.fundamental, 1);
  eq('三阶 total/8 == fundamental', os.total / 8, os.fundamental);
  eq('Burnside 不动点和 = 8', bs.sum, 8);
  eq('Burnside 独立给出 1', bs.fundamental, 1);
  eq('三阶作用自由（非恒等不动点全 0）', bs.free, true);
  for (const name of ['转90', '转180', '转270', '左右翻', '上下翻', '主镜像', '副镜像']) eq(`三阶 ${name} 不动点 0`, bs.fix[name], 0);
  eq('三阶恒等不动点 = 总数', bs.fix['恒等'], 8);
  eq('三阶中心只可能是 5', centreValues(cen3.squares, 3).join(','), '5');
  eq('三阶 associated = 8/8', associatedCount(cen3.squares, 3), 8);
  eq('三阶四角全偶', cen3.squares.every((g) => [0, 2, 6, 8].every((t) => g[t] % 2 === 0)), true);
  eq('三阶四边中全奇', cen3.squares.every((g) => [1, 3, 5, 7].every((t) => g[t] % 2 === 1)), true);
  eq('ASSOCIATED 表与穷举一致（3:plain）', ASSOCIATED['3:plain'], associatedCount(cen3.squares, 3) === 8);
  eq('三阶里没有泛对角盘（互补对称与泛对角在这一阶无关）', cen3.squares.filter((g) => isPandiagonal(g, 3)).length, 0);
  eq('三阶没有截断', cen3.truncated, false);
}
{
  const os = orbitStats(cen4.squares, 4);
  const bs = burnside(cen4.squares, 4);
  eq('四四总数 7040', cen4.squares.length, 7040);
  eq('四四基本盘 880', os.fundamental, 880);
  eq('四四 total/8 == fundamental', os.total / 8, os.fundamental);
  eq('Burnside 不动点和 = 7040', bs.sum, 7040);
  eq('Burnside 独立给出 880', bs.fundamental, 880);
  eq('四四作用自由', bs.free, true);
  eq('四四 转90 不动点 0', bs.fix['转90'], 0);
  eq('四四 转180 不动点 0', bs.fix['转180'], 0);
  eq('四四 主镜像 不动点 0', bs.fix['主镜像'], 0);
  eq('四四 associated 只有 384 盘（5.5%）', associatedCount(cen4.squares, 4), 384);
  eq('所以 4:plain 不是 associated 类', ASSOCIATED['4:plain'], false);
  // 4M = 136 = Σ数 136，但 4 阶没有中心格：中间两格可以是任何数，所以「中心必是 X」在这阶不成立
  eq('四四的中间两格取值覆盖 1~16', centreValues(cen4.squares, 4).join(','), '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16');
  eq('四四里没有强制的中间数', centreValues(cen4.squares, 4).length, 16);
}
{
  const os = orbitStats(cen4p.squares, 4);
  const bs = burnside(cen4p.squares, 4);
  const panSet = new Set(cen4p.squares.map(keyOf));
  eq('泛对角总数 384', cen4p.squares.length, 384);
  eq('泛对角基本盘 48', os.fundamental, 48);
  eq('泛对角 total/8 == fundamental', os.total / 8, os.fundamental);
  eq('Burnside 独立给出 48', bs.fundamental, 48);
  eq('泛对角作用自由', bs.free, true);
  // 被推翻的说法：「泛对角四四盘当然中心互补」。实测 384 盘里 0 盘满足。
  eq('泛对角四盘的 associated 是 0（互补对称在这一类根本不存在）', associatedCount(cen4p.squares, 4), 0);
  eq('所以 4:pan 不是 associated 类', ASSOCIATED['4:pan'], false);
  eq('384 盘泛对角全在 7040 盘四四之中', cen4p.squares.filter((g) => cen4.squares.some((h) => keyOf(h) === keyOf(g))).length, 384);
  eq('四四里恰好 384 盘是泛对角', cen4.squares.filter((g) => isPandiagonal(g, 4)).length, 384);
  // 384 与 384 不是同一批盘：泛对角与 associated 在四阶互斥，这才是互补对称不能当四四提示的理由
  const isAssoc = (g) => {
    for (let t = 0; t < 16; t++) if (g[15 - t] !== 17 - g[t]) return false;
    return true;
  };
  eq('四四里 associated 的盘有 384', cen4.squares.filter(isAssoc).length, 384);
  eq('泛对角 ∩ associated = 空集（0 盘）', cen4.squares.filter((g) => isPandiagonal(g, 4) && isAssoc(g)).length, 0);
  eq('泛对角那 384 盘里没有一盘中心互补', cen4p.squares.filter(isAssoc).length, 0);
  // most-perfect：每个环绕 2×2 块同和，且那个和被算出来是 4M/n = 2(n²+1) = 34
  eq('强制块和 forcedBlockSum(4) = 4·34/4 = 34', forcedBlockSum(4), 34);
  eq('等价于 2(n²+1) = 2·17', forcedBlockSum(4), 2 * (16 + 1));
  eq('三阶的强制块和 = 4·15/3 = 20', forcedBlockSum(3), 20);
  eq('四四的 most-perfect 也是 384 盘', mostPerfectCount(cen4.squares, 4), 384);
  eq('在四阶 most-perfect 与泛对角是同一批盘', cen4.squares.filter((g) => { const s = wrappedBlocksSum(g, 4); return s.length === 1 && s[0] === 34; }).filter((g) => panSet.has(keyOf(g))).length, 384);
  eq('每盘的环绕 2×2 块和只有一个取值', wrappedBlocksSum(cen4p.squares[0], 4).length, 1);
  ok('16 盘（每盘 16 块）之和 = 4·Σ数 = 544', (() => { const g = cen4p.squares[0]; let t = 0; for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) t += g[r * 4 + c] + g[r * 4 + ((c + 1) % 4)] + g[((r + 1) % 4) * 4 + c] + g[((r + 1) % 4) * 4 + ((c + 1) % 4)]; return t === 4 * 136; })());
}

// ---------- 第二套实现：这个文件自带的穷举计数器 ------------------------------------------------
// 与 count.js 无共享代码：线集在这里按句子的字面意思再写一遍，节点数与盘数都必须撞上。
function countWithLines(n, lines) {
  const size = n * n;
  const target = (n * (n * n + 1)) / 2;
  const at = Array.from({ length: size }, () => []);
  lines.forEach((l, i) => l.forEach((t) => at[t].push(i)));
  const grid = new Int8Array(size);
  const used = [0];
  const blanks = lines.map((l) => l.length);
  const sums = lines.map(() => 0);
  let nodes = 0;
  let count = 0;
  const take = (t, v) => {
    grid[t] = v;
    used[0] |= 1 << (v - 1);
    for (const i of at[t]) {
      blanks[i]--;
      sums[i] += v;
    }
  };
  const drop = (t, v) => {
    grid[t] = 0;
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
        const t = lines[i].find((u) => grid[u] === 0);
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
    for (let t = 0; t < size; t++) if (grid[t] === 0) return t;
    return -1;
  };
  const allDone = () => {
    for (let i = 0; i < lines.length; i++) if (sums[i] !== target) return false;
    return true;
  };
  const walk = () => {
    nodes++;
    const t = nextFree();
    if (t === -1) {
      if (allDone()) count++;
      return;
    }
    for (let v = 1; v <= size; v++) {
      if (used[0] & (1 << (v - 1))) continue;
      take(t, v);
      const f = force();
      if (!f.died) {
        if (nextFree() === -1) {
          if (allDone()) count++;
        } else walk();
      }
      for (let k = f.placed.length - 1; k >= 0; k--) drop(f.placed[k], grid[f.placed[k]]);
      drop(t, v);
    }
  };
  walk();
  return { count, nodes };
}
{
  // 按句子写的线集：每行、每列、主对角、副对角（3,6,9,12）
  const at = (r, c) => r * 4 + c;
  const rows = [],
    cols = [];
  for (let r = 0; r < 4; r++) rows.push([0, 1, 2, 3].map((c) => at(r, c)));
  for (let c = 0; c < 4; c++) cols.push([0, 1, 2, 3].map((r) => at(r, c)));
  const main = [0, 1, 2, 3].map((i) => at(i, i));
  const anti = [0, 1, 2, 3].map((i) => at(i, 3 - i));
  const wrapped = [0, 1, 2, 3].map((i) => at(i, ((0 - i) % 4 + 4) % 4)); // 0,7,10,13 —— 泛对角带的第 2 条
  const plain = [...rows, ...cols, main, anti];
  const wrong = [...rows, ...cols, main, wrapped];
  eq('本文件的重写线集 = count.js 的线集', plain.map((l) => l.join('-')).join('|'), linesFor(4, false).map((l) => l.join('-')).join('|'));
  const mine = countWithLines(4, plain);
  eq('第二套实现数出 7040', mine.count, 7040);
  eq('两套实现的节点数相同', mine.nodes, cen4.nodes);
  const minePan = countWithLines(4, linesFor(4, true));
  eq('第二套实现数出泛对角 384', minePan.count, 384);
  // 这就是那句被推翻的传言：把副对角线写成环绕带，四四清点立刻从 7040 塌成 1088
  const folk = countWithLines(4, wrong);
  eq('把副对角写成环绕带 → 只剩 1088 盘', folk.count, 1088);
  ok('1088 与 7040 的差就是那个笔误', folk.count !== mine.count, `${folk.count} vs ${mine.count}`);
  eq('环绕带确实是泛对角档的一条线', linesFor(4, true).filter((l) => l.join(',') === wrapped.join(',')).length, 1);
  const mine3 = countWithLines(3, linesFor(3, false));
  eq('第二套实现数出三阶 8 盘', mine3.count, 8);
}

// ---------- D4：8 个对称各自把盘映到哪儿 -------------------------------------------------------
{
  const maps = d4Maps(3);
  eq('D4 有 8 个变换', Object.keys(maps).length, 8);
  eq('恒等不动任何格', Array.from(maps['恒等']).join(','), '0,1,2,3,4,5,6,7,8');
  // 转90: (r,c) → (c, 2-r) → 0→2, 1→5, 2→8, 3→1, 4→4, 5→7, 6→0, 7→3, 8→6
  eq('转90 的置换', Array.from(maps['转90']).join(','), '2,5,8,1,4,7,0,3,6');
  // 转180: t → 8-t
  eq('转180 就是 rot 表', Array.from(maps['转180']).join(','), board3([[0, 4]]).rot.join(','));
  eq('洛书转 90 之后还是幻方', verify(board3(LOSHU.map((v, t) => [t, v])), applyMap(Int8Array.from(LOSHU), maps['转90'])).length, 0);
  eq('洛书左右翻之后还是幻方', verify(board3(LOSHU.map((v, t) => [t, v])), applyMap(Int8Array.from(LOSHU), maps['左右翻'])).length, 0);
  const orbit = new Set(Object.values(maps).map((p) => keyOf(applyMap(Int8Array.from(LOSHU), p))));
  eq('洛书的轨道大小 = 8（作用自由）', orbit.size, 8);
  eq('轨道里全是不同的盘', orbit.size, cen3.squares.length);
}

// ---------- 单条规则都推不完一整局 --------------------------------------------------------------
// 只准用一条规则反复推，剩下的空格数就是这条规则单独的能力边界。
function soloRun(board, ruleName, cap = 400) {
  const st = createState(board);
  let rounds = 0;
  for (;;) {
    if (++rounds > cap) break;
    const mine = forRule(board, ruleName, st);
    if (!mine.length) break;
    for (const d of mine) applyDeduction(st, d, true);
  }
  return board.cells.filter((t) => st.fill[t] === EMPTY).length;
}
function soloNishio(board, cap = 200) {
  const st = createState(board);
  let rounds = 0;
  while (rounds++ < cap) {
    const d = findContradiction(st);
    if (!d) break;
    if (!applyDeduction(st, d, true)) break;
  }
  return board.cells.filter((t) => st.fill[t] === EMPTY).length;
}
{
  const tier = TIERS[0];
  const p = makePuzzle('unit|solo', tier.key);
  ok('出一局九宫', !!p);
  const b = p.board;
  const clues = b.cells.filter((t) => b.givenFlag[t]).length;
  const blanksAtStart = b.size - clues;
  eq('九宫题面留的空格 = 9 - 线索', blanksAtStart, 9 - 4);
  const full = solve(b);
  eq('六条规则一起能推完九宫', full.ok, true);
  eq('六条一起时空格为 0', full.empty, 0);
  // 量出来的事实，不是修辞：4 个线索的九宫，光靠「行列补全」就能填满 9 格。
  // 这就是九宫档分数只有 13 的原因 —— 它是线算术档，不是推理档。
  eq('九宫：只有行列补全也推得完', soloRun(b, '行列补全'), 0);
  eq('九宫：只有对角线推不完', soloRun(b, '对角线') > 0, true);
  eq('九宫：只有互补对称推不完', soloRun(b, '互补对称') > 0, true);
  for (const r of ['候选排除', '区间剪枝']) {
    // 这两条只删候选、不写数，所以跑完空格数正好等于题面留下的那些
    eq(`九宫：只有「${r}」时一格未填`, soloRun(b, r), blanksAtStart);
  }
  eq('九宫：反证单独跑完也不写一个数', soloNishio(b), blanksAtStart);
  eq('出货盘上的反证次数是 0', full.nishio, 0);
  ok('出货盘的 breakdown 里没有反证', !('反证' in full.breakdown), JSON.stringify(full.breakdown));
}
{
  // 四四与泛对角：任何一条规则单打独斗都推不完一整局 —— 这才敢说「六条缺一不可」
  for (const idx of [1, 2]) {
    const tier = TIERS[idx];
    const p = makePuzzle(`unit|solo-${tier.key}`, tier.key);
    const b = p.board;
    const blanks = b.size - b.cells.filter((t) => b.givenFlag[t]).length;
    eq(`${tier.name}：六条一起能推完`, solve(b).ok, true);
    for (const r of ['行列补全', '候选排除', '区间剪枝', '对角线', '互补对称']) {
      const left = soloRun(b, r);
      ok(`${tier.name}：只有「${r}」时推不完（还剩 ${left} 格）`, left > 0);
    }
    eq(`${tier.name}：只靠反证一格也填不出来`, soloNishio(b), blanks);
    eq(`${tier.name}：反证次数 0`, solve(b).nishio, 0);
  }
}

// ---------- 出货的每一档：唯一解、纯逻辑、分数在自己的区间里 ------------------------------------
const ruleNames = Object.values(Rules).map((r) => r.name);
const tierFacts = [];
for (const tier of TIERS) {
  const seeds = ['0', '1', '2', 'unit|a', 'unit|b', `seed-${tier.key}`];
  let unique = 0;
  let pencil = 0;
  let nishio = 0;
  let inBand = 0;
  let minClues = Infinity;
  const scores = [];
  let first = null;
  for (const s of seeds) {
    const p = makePuzzle(`unit|${tier.key}|${s}`, tier.key);
    ok(`${tier.name} 能出局（seed ${s}）`, !!p);
    if (!p) continue;
    first = first || p;
    const c = countSolutions(p.board, { cap: 2, budget: 400_000 });
    if (c.status === UNIQUE) unique++;
    const r = solve(p.board);
    if (r.ok) pencil++;
    nishio += r.nishio;
    if (r.score === p.score) inBand++;
    if (p.offBand === 0) inBand++;
    minClues = Math.min(minClues, p.clueCount);
    scores.push(p.score);
    // 穷举器找到的那一盘必须和铅笔器填出来的完全相同（逐格）
    let diff = 0;
    for (let t = 0; t < p.board.size; t++) if (r.state.fill[t] !== c.grid[t]) diff++;
    eq(`${tier.name} 两套实现逐格一致（seed ${s}）`, diff, 0);
    // 生成器自己抽出来的正解也是同一盘
    const sol = solutionOf(p.board, p.solution);
    let diff2 = 0;
    for (let t = 0; t < p.board.size; t++) if (sol[t] !== c.grid[t]) diff2++;
    eq(`${tier.name} 抽盘正解与穷举一致（seed ${s}）`, diff2, 0);
    eq(`${tier.name} 题面在正解里一格未动（seed ${s}）`, p.board.cells.filter((t) => p.board.givenFlag[t] && sol[t] !== p.board.givens[t]).length, 0);
  }
  eq(`${tier.name} 六局全部唯一解`, unique, 6);
  eq(`${tier.name} 六局全部纯逻辑推得完`, pencil, 6);
  eq(`${tier.name} 六局反证合计 0 次`, nishio, 0);
  eq(`${tier.name} 复解分数不换`, inBand, 12);
  ok(`${tier.name} 线索不少于 keep`, minClues >= tier.keep, `${minClues} vs ${tier.keep}`);
  ok(
    `${tier.name} 的分数都在自己的 band 里`,
    scores.every((v) => v >= tier.band[0] && v <= tier.band[1]),
    JSON.stringify(scores)
  );
  tierFacts.push({ tier, p: first, median: scores.slice().sort((a, b) => a - b)[3] });
}
// 阶梯必须是量出来的：中位分数按档位单调上升
ok('九宫 < 四四', tierFacts[0].median < tierFacts[1].median, `${tierFacts[0].median} vs ${tierFacts[1].median}`);
ok('四四 < 泛对角', tierFacts[1].median < tierFacts[2].median, `${tierFacts[1].median} vs ${tierFacts[2].median}`);
eq('档位有三档', TIERS.length, 3);
eq('档位按尺寸与区间递增', TIERS.map((t) => `${t.n}${t.pan ? 'p' : ''}:${t.band[0]}`).join(','), '3:8,4:90,4p:132');
eq('不认识的档位退回第一档', tierFor('nope').key, 'jiugong');
eq('九宫是 3 阶非泛对角', JSON.stringify([tierFor('jiugong').n, tierFor('jiugong').pan]), '[3,false]');
eq('泛对角档是 4 阶泛对角', JSON.stringify([tierFor('pandiagonal').n, tierFor('pandiagonal').pan]), '[4,true]');
eq('泛对角档的 M 是 34', magicSum(tierFor('pandiagonal').n), 34);

// ---------- 胜负判定与穷举判定不许吵架：拿坏盘喂它们 --------------------------------------------
// 对同一个 fill：loshu.complete() 说「是幻方」，countSolutions(givens = 这盘满盘) 就必须说
// 「恰有一解」；反过来也必须一致。createBoard 会先拒掉一部分坏盘，那也是「不承认」。
{
  const { tier, p } = tierFacts[0];
  const b = p.board;
  const good = solutionOf(b, p.solution);
  eq('正解先自证合法', verify(b, good).length, 0);
  eq('正解 complete', complete(b, good), true);
  eq('正解在穷举器里是唯一解', countSolutions(b, { cap: 2, budget: 400_000, givens: good }).status, UNIQUE);
  const mutate = (fn) => {
    const f = Int8Array.from(good);
    fn(f);
    return f;
  };
  const swap = (f, a, z) => {
    const t = f[a];
    f[a] = f[z];
    f[z] = t;
  };
  const cases = [
    ['交换同一行相邻两格', mutate((f) => swap(f, 0, 1))],
    ['某格 +1', mutate((f) => (f[1] = f[1] + 1))],
    ['某格改成已被用掉的数', mutate((f) => (f[1] = f[0]))],
    ['跨行跨列对调两格', mutate((f) => swap(f, 2, 6))],
    ['某格改成界外数', mutate((f) => (f[5] = 99))],
    ['某格改成负数', mutate((f) => (f[5] = -3))],
  ];
  for (const [label, f] of cases) {
    const loshuSays = complete(b, f);
    const bad = verify(b, f);
    let countSays;
    try {
      countSays = countSolutions(b, { cap: 2, budget: 400_000, givens: Int8Array.from(f) }).solutions;
    } catch (e) {
      countSays = 'throws';
    }
    ok(`坏盘（${label}）：loshu 不认`, loshuSays === false, String(loshuSays));
    ok(`坏盘（${label}）：verify 说得出问题`, bad.length > 0, JSON.stringify(bad.slice(0, 2)));
    ok(`坏盘（${label}）：穷举器也不认`, countSays === 0 || countSays === 'throws', String(countSays));
    // 铅笔求解器在同一盘上的判定也必须和 complete() 同调
    const st = createState(b);
    for (let t = 0; t < b.size; t++) st.fill[t] = f[t];
    let solverSays = false;
    try {
      rebuild(st);
      solverSays = complete(b, st.fill);
    } catch {
      solverSays = false;
    }
    eq(`坏盘（${label}）：两套判定同调`, solverSays, loshuSays);
  }
  // verify 报的理由要能用手工算术核出来：把 t1 从 9 改成 10 → 第1行和变成 4+10+2 = 16
  const f = Int8Array.from(good);
  const row0 = good[0] + good[1] + good[2];
  f[1] = good[1] + 1;
  const bad = verify(b, f);
  ok('理由里点名第1行', bad.some((x) => x.why.includes('第1行')), JSON.stringify(bad.slice(0, 2)));
  ok('理由里的和就是 4+10+2 = 手算和 +1', bad.some((x) => x.sum === row0 + 1), `${row0} → ${JSON.stringify(bad.slice(0, 3))}`);
  eq('和不对时 want 仍是 M', bad.find((x) => x.sum !== undefined).want, 15);
  // 留一空格不是「坏盘」，是「没下完」：两边都必须这么说，而且穷举器补出来的那一盘必须就是原答案
  const blanked = mutate((f) => (f[1] = EMPTY));
  eq('缺一格时 loshu 说不合法', complete(b, blanked), false);
  eq('缺一格时 verify 点名空格', verify(b, blanked).filter((x) => x.why === '空格').length, 1);
  eq('缺一格时 filled 说不满', filled(b, blanked), false);
  const partial = countSolutions(b, { cap: 2, budget: 400_000, givens: blanked });
  eq('缺一格时穷举器仍只补得出 1 盘', partial.solutions, 1);
  eq('补出来的就是原答案', Array.from(partial.grid).join(','), Array.from(good).join(','));
}
{
  // 四四与泛对角档各拿一盘做同样的对抗测试
  for (const idx of [1, 2]) {
    const p = tierFacts[idx].p;
    const good = solutionOf(p.board, p.solution);
    eq(`${p.tierName} 正解合法`, verify(p.board, good).length, 0);
    const f = Int8Array.from(good);
    f[0] = f[0] + 1;
    ok(`${p.tierName} 改一个数就不合法`, verify(p.board, f).length > 0);
    eq(`${p.tierName} 改过的盘穷举 0 解`, countSolutions(p.board, { cap: 2, budget: 400_000, givens: f }).solutions, 0);
    eq(`${p.tierName} 满盘正解穷举 1 解`, countSolutions(p.board, { cap: 2, budget: 400_000, givens: good }).solutions, 1);
  }
}

// ---------- 手写盘上的求解路径：每一步都可手算 ---------------------------------------------------
{
  // 给满第1行 4-9-2 的九宫。有几解可以手算：洛书一共 8 盘，D4 的 8 个对称里只有单位元把有序
  // 三元组 (4,9,2) 留在第1行原位——竖轴反射把它翻成 2-9-4，任何 90°/180° 旋转都把它搬到别行。
  // 稳定子 = 1，所以这一盘必须是唯一解，而且 6 个空格必须能被单位规则推到死。
  const b = board3([[0, 4], [1, 9], [2, 2]]);
  const s = solve(b);
  eq('给满一行的九宫纯逻辑推得完', s.ok, true);
  eq('给满一行的九宫把 9 格填满', filled(b, s.state.fill), true);
  eq('落子行数 = 9 格 - 3 个给定', s.rows.filter((r) => r.kind === 'place').length, 6);
  eq('steps 就是 breakdown 的计数之和', s.steps, Object.values(s.breakdown).reduce((a, x) => a + x.n, 0));
  eq('score 就是 breakdown 的权重加总', s.score, Math.round(Object.values(s.breakdown).reduce((a, x) => a + x.n * x.weight, 0) * 10) / 10);
  ok('这一盘不动用反证', s.nishio === 0, String(s.nishio));
  eq('清点器独立数到 1 解', countSolutions(b, { cap: 2, budget: 400_000 }).solutions, 1);
  eq('区间剪枝的权重 2.5', Rules.rangePrune.weight, 2.5);
  eq('对角线权重 2', Rules.diagPrune.weight, 2);
  eq('反证权重 6（最贵的一条）', Rules.nishio.weight, 6);
  // 只给 t0 = 4：过 t0 的三条线各剩 2 格、其余五条线各剩 3 格，没有一条只剩 1 格，所以「行列补全」
  // 的补缺形式第一步无从下手；而 4 在洛书 8 盘里落在 4 个角上，钉住一角只剩 8/4 = 2 盘。
  // 2 盘 ≠ 1 盘，这种题面不许出货——keep ≥ 4 就是从这类手算来的。
  const one = board3([[0, 4]]);
  eq('单给定九宫穷举 2 盘（8 盘 ÷ 4 个角）', countSolutions(one, { cap: 9, budget: 400_000 }).solutions, 2);
  const sOne = solve(one);
  eq('单给定九宫纯逻辑推不完', sOne.ok, false);
  ok('单给定盘被逼到动用反证', sOne.nishio > 0, String(sOne.nishio));
  eq('单给定盘推到最后仍没填满', filled(one, sOne.state.fill), false);
  // 只有中心 5 的九宫：中心是 D4 的不动点，8 盘全在中心写 5，钉中心一盘都不减，单位规则也一步走不动
  const only5 = solve(board3([[4, 5]]));
  eq('只给中心的九宫推不完', only5.ok, false);
  ok('只给中心时要动用反证', only5.nishio > 0, String(only5.nishio));
  eq('动用的规则就叫反证', only5.rows.filter((r) => r.rule === '反证').length > 0, true);
  eq('只钉中心的九宫还是 8 盘', countSolutions(board3([[4, 5]]), { cap: 99, budget: 4_000_000 }).solutions, 8);
  // 一个已经被推到死的局面（等价于一份坏存档）不该被认成赢，账本也要报出坏了的线
  const deadBoard = board3([[0, 4], [1, 9]]);
  const dead = createState(deadBoard);
  dead.fill[2] = 8; // 第1行 4+9+8 = 21 > 15：手填不会让它进门，这里模拟的是一份被改坏的存档
  rebuild(dead);
  eq('rebuild 认出死局', dead.dead, true);
  ok('死局的账本报出坏线', diagnose(dead).lineBad >= 1, String(diagnose(dead).lineBad));
  eq('死局不被认成赢', complete(deadBoard, dead.fill), false);
  eq('推完的盘上没有下一步', nextDeduction(s.state), null);
}
{
  // lineClose 的算术：第2行给了 3 和 5，差 15-8 = 7
  const b = board3([[3, 3], [4, 5]]);
  const st = createState(b);
  const d = nextDeduction(st);
  eq('下一步是填 7 在 t5', `${d.cell},${d.value}`, '5,7');
  eq('依据规则名', d.rule.name, '行列补全');
  applyDeduction(st, d);
  eq('走完一步后 t5 有数了', st.fill[5], 7);
  eq('走完一步后 7 从别的格的候选里消失', hasBit(st.cand[2], 7), false);
  // 可达性：第3行还差 15，剩 3 格，候选里有能凑出来的组合
  eq('第3行仍可达', reachable(st, 2), true);
  eq('第1行的线内候选（t2 空）', lineValues(st, 0).includes(1), true);
}

// ---------- 读盘：线账本、身份行、矛盾口径 --------------------------------------------------------
{
  const b = board3([[0, 4], [1, 9]]);
  const st = createState(b);
  const g = diagnose(st);
  eq('三阶一共 8 条线', g.lineCount, 8);
  eq('开局合上的线 0', g.lineDone, 0);
  eq('已填 2 格', g.filled, 2);
  eq('待填 7 格', g.remaining, 7);
  eq('线索数 2', g.clueCount, 2);
  eq('第1行的已和 13', g.lines[0].sum, 13);
  eq('第1行差 2', g.lines[0].deficit, 2);
  eq('第1行剩 1 格', g.lines[0].empty, 1);
  eq('线账本按顺序带 label', g.lines.map((l) => l.label).slice(0, 3).join(','), '第1行,第2行,第3行');
  const bad = tryPlace(st, 8, 4);
  eq('重号被拒', bad.ok, false);
  ok('拒绝理由点名已用的格子', bad.reason.includes('已经用在'), bad.reason);
  eq('拒绝理由里是 4', bad.reason.includes('4'), true);
  // 第1行已有 4 与 9：再放一个 8 就是 4+9+8 = 21 > 15
  const over = tryPlace(st, 2, 8);
  eq('把第1行推到 21 的填法被拒', over.ok, false);
  ok('理由里带超和的算术（4+9+8 = 21 > 15）', over.reason.includes('21') && over.reason.includes('M=15'), over.reason);
  const onGiven = tryPlace(st, 0, 2);
  eq('题面给的数动不了', onGiven.ok, false);
  ok('理由是「动不了」', onGiven.reason.includes('动不了'), onGiven.reason);
  eq('填一格合法', tryPlace(st, 2, 2).ok, true);
  eq('填完第1行合上', diagnose(st).lines[0].done, true);
  const lr = lineReadout(b, st.fill, 2);
  ok('线读数说的是第1行 15 ✓', lr.text.includes('第1行 15 · ✓'), lr.text);
  eq('线读数的坏线数 0', lr.bad, 0);
  eq('身份行原文', identityText(b), 'Σ线 = n·M = 3×15 = 45 = 1+2+…+9');
  eq('四阶身份行', identityText(board4([[0, 16]], false)), 'Σ线 = n·M = 4×34 = 136 = 1+2+…+16');
}

// ---------- 一次手势一份快照：撤销不许只回一半 ---------------------------------------------------
{
  const b = board3([[0, 4], [1, 9]]);
  const st = createState(b);
  eq('开局没有历史', st.history.length, 0);
  tryPlace(st, 2, 2);
  eq('一次落子一份快照', st.history.length, 1);
  toggleNote(st, 3, 3);
  eq('记一笔笔记也有一份快照', st.history.length, 2);
  eq('笔记落在 t3 上', hasBit(st.notes[3], 3), true);
  const candBefore = st.cand[3];
  toggleNote(st, 3, 5);
  eq('笔记不动候选池', st.cand[3], candBefore);
  rebuild(st);
  eq('rebuild 之后候选池还是不动（笔记不约束任何东西）', st.cand[3], candBefore);
  undo(st);
  eq('撤销抹掉第二笔笔记', hasBit(st.notes[3], 5), false);
  eq('撤销留下第一笔', hasBit(st.notes[3], 3), true);
  undo(st);
  eq('再撤销把 t3 的笔记清空', st.notes[3], 0);
  undo(st);
  eq('第三次撤销收回落子', st.fill[2], EMPTY);
  eq('历史空了就不撤销', undo(st), false);
  // 题面只给了 4 与 9，所以收回落子后 t2 的候选应该回到 9-2 = 7 个
  eq('收回落子后候选池复原（7 个）', pop(st.cand[2]), 7);
  eq('复原后的候选就是没给过的 7 个数', valuesOf(st.cand[2]).join(','), '1,2,3,5,6,7,8');
  // 擦掉与「空着的格」
  tryPlace(st, 2, 2);
  eq('擦掉有数的格子', eraseCell(st, 2), true);
  eq('擦掉之后是空的', st.fill[2], EMPTY);
  eq('擦空格子不成立', eraseCell(st, 2), false);
  eq('擦题面给的数不成立', eraseCell(st, 0), false);
  eq('题面格上记笔记不成立', toggleNote(st, 0, 5), false);
  // resetInk 把盘面收回到题面
  tryPlace(st, 2, 2);
  resetInk(st);
  eq('resetInk 只留题面', [st.fill[0], st.fill[1], st.fill[2]].join(','), '4,9,0');
  eq('resetInk 清掉写入计数', st.writes, 0);
}

// ---------- 生成器零件：抽盘、削题面、线索下界 -----------------------------------------------------
{
  const rng = makeRng('unit|rng');
  const rng2 = makeRng('unit|rng');
  eq('同种子哈希相同', hash32('loshu'), hash32('loshu'));
  ok('不同种子哈希不同', hash32('loshu') !== hash32('shikaku'));
  eq('rng 序列可复现', `${rng.int(100)},${rng.int(100)}`, `${rng2.int(100)},${rng2.int(100)}`);
  ok('dateSeed 给出当天的 key', /^\d{4}-\d{2}-\d{2}$/.test(dateSeed(0).key), dateSeed(0).key);
  eq('dateSeed 的 epochDays 是整数', Number.isInteger(dateSeed(0).epochDays), true);
  eq('往后一天正好差 1 天', dateSeed(1).epochDays - dateSeed(0).epochDays, 1);
  eq('同一天的 key 稳定', dateSeed(0).key === dateSeed(0).key, true);
  eq('由日期种子出的局可复现', Array.from(makePuzzle(dateSeed(0).key, 'jiugong').board.givens).join(','), Array.from(makePuzzle(dateSeed(0).key, 'jiugong').board.givens).join(','));
  const r = randomSquare(3, false, makeRng('unit|sq'));
  ok('抽得出三阶盘', !!r && !!r.grid);
  eq('抽出来的三阶盘合法', verify(board3(Array.from(r.grid).map((v, t) => [t, v])), r.grid).length, 0);
  const r4 = randomSquare(4, false, makeRng('unit|sq4'));
  eq('抽出来的四四盘合法', verify(board4(Array.from(r4.grid).map((v, t) => [t, v]), false), r4.grid).length, 0);
  const r4p = randomSquare(4, true, makeRng('unit|sq4p'));
  eq('抽出来的泛对角盘是泛对角', isPandiagonal(r4p.grid, 4), true);
  // 把整盘当题面削到 keep 个数：削完必须还是唯一解
  const full = createBoard({ n: 3, pan: false, givens: Int8Array.from(LOSHU) });
  const peeled = peel(full, makeRng('unit|peel'), { keep: 4 });
  eq('削题面后还剩 4 个数', peeled.givens.filter((v) => v !== EMPTY).length, 4);
  eq('削完仍唯一', countSolutions({ n: 3, pan: false, givens: peeled.givens }, { cap: 2, budget: 200_000 }).status, UNIQUE);
  const floor = clueFloor(full, { budget: 40_000, maxCounted: 4096 });
  ok('整盘的线索下界 ≥ 1', floor.floor >= 1, String(floor.floor));
  eq('整盘的下界不截断', floor.truncated, false);
  const p = makePuzzle('unit|floor', 'jiugong');
  const pf = clueFloor(p.board);
  ok('出货盘的下界不超过它自己的线索数', pf.floor <= p.clueCount, `${pf.floor} vs ${p.clueCount}`);
  eq('出货盘的下界测试没被截断', pf.truncated, false);
  const d = draw({ n: 3, pan: false, seed: 'unit|draw', keep: 4, tries: 8 });
  eq('draw 出货', d.ok, true);
  eq('draw 报的统计里有抽盘数', d.stats.drawn >= 1, true);
  eq('draw 的分数在 band 内时 offBand 为 0', d.offBand, 0);
  eq('draw 的 rows 与 steps 自洽', d.rows.length, d.steps);
  eq('draw 的 steps 与复解一致', d.steps, solve(d.board).steps);
  ok('裸抽盘（tries=1）也能出', !!draw({ n: 3, pan: false, seed: 'unit|raw', keep: 4, tries: 1 }).ok);
}

// ---------- 存档：一次手势一格数都不许多存 ---------------------------------------------------------
{
  Store.reset();
  const p = makePuzzle('unit|store', 'jiugong');
  const full = solutionOf(p.board, p.solution);
  const ink = Int8Array.from(full.map((v, t) => (t % 3 === 0 ? EMPTY : v)));
  Store.saveResume(p, { fill: ink, notes: new Uint16Array(9) }, 61_000, { moves: 9, hints: 2 });
  const r = Store.resume();
  eq('存档带上步数', r.moves, 9);
  eq('存档带上提示数', r.hints, 2);
  eq('存档带计时', r.elapsedMs, 61000);
  eq('存档能一格不差地还原', Array.from(r.fill).join(','), Array.from(ink).join(','));
  ok('空格还原后仍是空格', r.fill.some((v) => v === EMPTY) && r.fill.every((v) => v >= EMPTY));
  eq('存档记的是原始种子', r.seed, p.originSeed);
  const notes = new Uint16Array(9);
  notes[1] = bitOf(2) | bitOf(5);
  Store.saveResume(p, { fill: ink, notes }, 1000, { moves: 1, hints: 0 });
  eq('笔记掩码能原样回来', Store.resume().notes[1], notes[1]);
  eq('没记笔记的格还是空的', Store.resume().notes[0], 0);
  eq('SHIFT 让空格与「没有下一段」区分开', SHIFT, 1);
  eq('RLE 往返无损', Array.from(rleDecode(rleEncode(ink), 9)).join(','), Array.from(ink).join(','));
  const mostlyEmpty = Int8Array.from(full).map((v, t) => (t < 2 ? v : EMPTY));
  ok('早退的存档明显小于一格一数', rleEncode(mostlyEmpty).length < 9 * 2, `${rleEncode(mostlyEmpty).length}`);
  eq('notesEncode 只写非零格', notesEncode(new Uint16Array([0, 3, 0, 0, 0, 0, 0, 0, 7])).length, 4);
  eq('notesDecode 认十六进制', notesDecode([1, 'ff'], 9)[1], 255);
  const again = makePuzzle(r.seed, r.tier);
  eq('从存档种子重绘得到同一个题面', Array.from(again.board.givens).join(','), Array.from(p.board.givens).join(','));
  eq('重绘出来的尺寸也对', again.size, p.size);
  eq('首个纪录直接成立', Store.recordBest('jiugong', { ms: 50000, hints: 1, moves: 20, size: '3×3' }), true);
  eq('更快但更靠提示的不算破纪录', Store.recordBest('jiugong', { ms: 1000, hints: 2, moves: 5, size: '3×3' }), false);
  eq('同样求助次数下省步数的算破纪录', Store.recordBest('jiugong', { ms: 60000, hints: 1, moves: 12, size: '3×3' }), true);
  eq('步数也相同时才比时间', Store.recordBest('jiugong', { ms: 90000, hints: 1, moves: 12, size: '3×3' }), false);
  eq('纪录里存的是最好的那一次', Store.best('jiugong').moves, 12);
  Store.recordSolve(5000, 2);
  eq('总览记了一次通关', Store.data.totals.solved, 1);
  eq('总览累计提示数', Store.data.totals.hints, 2);
  eq('总览累计用时', Store.data.totals.ms, 5000);
  Store.clearResume();
  eq('清档之后没有续局', Store.resume(), null);
  Store.reset();
  eq('重置之后纪录空了', Store.best('jiugong'), null);
}

// ---------- 玩法层：一次落子、一次拒绝、一次提示、一次撤销 ----------------------------------------
{
  const p = makePuzzle('unit|game', 'jiugong');
  const g = new Game(p);
  eq('开局没赢', g.status, 'playing');
  eq('九宫 checksum = 3×15', g.checksum, 45);
  eq('身份行挂在玩法层上', g.identity().includes('45'), true);
  const sol = solutionOf(p.board, p.solution);
  const firstBlank = p.board.cells.find((t) => !p.board.givenFlag[t]);
  eq('填对一格', g.placeAt(firstBlank, sol[firstBlank]).ok, true);
  eq('步数 +1', g.moves, 1);
  eq('填进去的数就是它', g.valueAt(firstBlank), sol[firstBlank]);
  eq('再填同一个数不成立（本来就是）', g.placeAt(firstBlank, sol[firstBlank]).ok, false);
  eq('没写东西就不算一步', g.moves, 1);
  const dupTarget = p.board.cells.find((t) => !p.board.givenFlag[t] && t !== firstBlank);
  const rej = g.placeAt(dupTarget, sol[firstBlank]);
  eq('重号被拒', rej.ok, false);
  ok('拒绝理由看得见（不是空串）', typeof rej.reason === 'string' && rej.reason.length > 6, rej.reason);
  eq('被拒之后那格还是空的', g.valueAt(dupTarget), EMPTY);
  eq('被拒之后步数不动', g.moves, 1);
  const hint = g.hint();
  ok('提示给得出一步', !!hint && !hint.stalled, JSON.stringify(hint));
  ok('提示说出规则名', ruleNames.includes(hint.rule), hint.rule);
  ok('提示点名格子', /第\d行第\d列/.test(hint.why || ''), hint.why);
  eq('提示计一次求助', g.hints, 1);
  const before = g.steps.length;
  g.undo();
  eq('撤销收回一整步', g.steps.length, before - 1);
  eq('撤销不退还求助次数', g.hints, 1);
  // 笔记：记一笔不动盘面
  const blank2 = p.board.cells.find((t) => g.isBlank(t));
  const cand = g.candidatesOf(blank2).join(',');
  const note = g.note(1, blank2);
  eq('笔记能记', note.ok, true);
  eq('笔记不动候选池', g.candidatesOf(blank2).join(','), cand);
  eq('笔记算一步手势', g.moves, 2);
  eq('题面格上记笔记被拒', g.note(1, p.board.cells.find((t) => g.givenAt(t))).ok, false);
  g.undo();
  eq('撤销收掉笔记', g.st.notes[blank2], 0);
  // 键盘读数
  const pr = padReadout(g, sol[firstBlank]);
  eq('读数说这个数已用过', pr.used >= 1, true);
  eq('读数 ok 为假', pr.ok, false);
  ok('读数文本带「候选」', pr.text.includes('候选'), pr.text);
  eq('界外的数直接被读数拒绝', padReadout(g, 10).ok, false);
  // 推到赢：全部通过 hint（= 引擎认可的一步），不许借答案
  const win = new Game(makePuzzle('unit|win', 'jiugong'));
  const r = win.solveWithLogic();
  eq('逻辑能推到赢', r.status, 'won');
  eq('赢的时候 complete 为真', complete(win.board, win.st.fill), true);
  eq('赢的时候一条线不落', win.diag.lineDone, win.diag.lineCount);
  eq('八条线', win.diag.lineCount, 8);
  eq('全盘数字和 = 45', win.total, 45);
  eq('赢的盘里没有反证', win.steps.filter((s) => s.kind === 'nishio').length, 0);
  eq('赢完再填就拒绝了', win.place(1).ok, false);
  ok('赢之后 status 不再变回 playing', win.status === 'won');
}

console.log(`\n${pass} 通过 / ${fail} 失败  （引擎与清点耗时 ${((Date.now() - t0run) / 1000).toFixed(1)}s）`);
process.exit(fail ? 1 : 0);
