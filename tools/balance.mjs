// 难度实测台. Reads the difficulty of each band off generated boards — it does not set it.
//
// The numbers printed here are what TIERS[].band has to contain. Editing a band without
// re-running this is how the ladder becomes decoration and the README's measured table becomes
// a lie. The gate is the batch, not the median: every shipped board must sit inside its own
// band, because "四四档" is a promise about the board in front of the player, not about a
// distribution they will never see.

import { performance } from 'node:perf_hooks';
import { TIERS, makePuzzle, draw, solutionOf, clueFloor } from '../js/engine/generate.js';
import { createBoard, solve, verify, Rules } from '../js/engine/loshu.js';
import { countSolutions, UNIQUE } from '../js/engine/count.js';

const N = Number(process.env.SAMPLES || 40);

const q = (sorted, p) => {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[i];
};

const ruleNames = Object.values(Rules).map((r) => r.name);
let worst = 0;
const ladder = [];
const outOfBand = [];
for (const tier of TIERS) {
  const scores = [];
  const steps = [];
  const nishio = [];
  const clues = [];
  const tries = [];
  const usage = Object.fromEntries(ruleNames.map((k) => [k, 0]));
  let accepted = 0;
  let inBand = 0;
  let ms = 0;
  for (let s = 0; s < N; s++) {
    const t0 = performance.now();
    const p = makePuzzle(`balance|${s}`, tier.key);
    ms += performance.now() - t0;
    if (!p) continue;
    accepted++;
    if (p.offBand === 0) inBand++;
    else outOfBand.push(`${tier.name}#${s} 分数 ${p.score}`);
    scores.push(p.score);
    steps.push(p.steps);
    nishio.push(p.nishio);
    clues.push(p.clueCount);
    tries.push(p.gen);
    for (const [k, v] of Object.entries(p.breakdown)) if (k in usage) usage[k] += v.n;
  }
  const sort = (a) => a.slice().sort((x, y) => x - y);
  const line = (label, arr, fmt = (v) => v) => {
    const a = sort(arr);
    console.log(`    ${label.padEnd(8)} p25 ${fmt(q(a, 0.25))}  中位 ${fmt(q(a, 0.5))}  p75 ${fmt(q(a, 0.75))}  max ${fmt(a[a.length - 1])}`);
  };
  console.log(`\n${tier.name} ${tier.key} ${tier.n}×${tier.n}${tier.pan ? ' 泛对角' : ''}（留 ${tier.keep} 个 clue，目标分 ${tier.band[0]}–${tier.band[1]}）`);
  console.log(
    `    出题成功率 ${accepted}/${N}，命中目标区间 ${inBand}/${accepted}，平均抽 ${((tries.reduce((a, b) => a + b, 0) / Math.max(1, tries.length)) || 0).toFixed(1)} 次，耗时 ${(ms / N).toFixed(0)} ms/局`,
  );
  line('分数', scores, (v) => (v || 0).toFixed(1));
  line('推理步数', steps);
  line('反证次数', nishio);
  line('线索数', clues);
  console.log(
    '    规则出手 ' +
      ruleNames
        .map((k) => `${k} ${usage[k]}`)
        .join(' · '),
  );
  ladder.push({ tier, label: `${tier.name} ${tier.n}×${tier.n}`, median: q(sort(scores), 0.5) || 0, inBand, accepted, clues: q(sort(clues), 0.5) });
  worst = Math.max(worst, ms / N);
}

// The ladder is the product promise: 九宫 must read easier than 泛对角, and a band that never
// lands inside its own interval means the interval was never measured.
console.log('\n== 档位阶梯（中位分数必须单调；出货的每一局都必须在自己的区间内）==');
let mono = true;
{
  let prev = -Infinity;
  for (const l of ladder) {
    const okScore = l.median > prev;
    const allIn = l.accepted > 0 && l.inBand === l.accepted;
    if (!okScore || !allIn) mono = false;
    console.log(`  ${okScore && allIn ? '✓' : '✗'} ${l.label} 中位 ${l.median.toFixed(1)}  命中区间 ${l.inBand}/${l.accepted}  线索中位 ${l.clues}`);
    prev = l.median;
  }
  if (outOfBand.length) console.log(`  ✗ 出带的局：${outOfBand.slice(0, 6).join(', ')}`);
  console.log(mono ? '  阶梯成立' : '  阶梯不成立：生成器需要重做，band 不许放松');
}

// What the generator produces *before* the band selects anything. This is the distribution the
// bands were cut out of, printed here so a future edit to `keep` can be read against reality
// instead of against the comment that was written when things were convenient.
console.log('\n== 裸分布（band 不参与挑选，tries=1 张一张看）==');
const RAW = 12;
for (const tier of TIERS) {
  const scores = [];
  let drawn = 0;
  let pencilFail = 0;
  let ambiguous = 0;
  let t0 = performance.now();
  for (let s = 0; s < RAW; s++) {
    const r = draw({ n: tier.n, pan: tier.pan, seed: `raw|${tier.key}|${s}`, keep: tier.keep, tries: 1 });
    if (!r.ok) {
      drawn += r.stats.drawn;
      pencilFail += r.stats.pencilFail;
      ambiguous += r.stats.ambiguous;
      continue;
    }
    drawn += r.stats.drawn;
    pencilFail += r.stats.pencilFail;
    ambiguous += r.stats.ambiguous;
    scores.push(r.score);
  }
  const a = scores.slice().sort((x, y) => x - y);
  console.log(
    `  ${tier.name}：候选 ${drawn}，出货 ${scores.length}，推不尽 ${pencilFail}，多解 ${ambiguous}  ` +
      `分数 min ${a[0] ?? '-'} 中位 ${q(a, 0.5) ?? '-'} max ${a[a.length - 1] ?? '-'}  ` +
      `${((performance.now() - t0) / RAW).toFixed(1)} ms/张`,
  );
}

// Cross-check one: the exhaustive counter is allowed to disagree with the pencil solver and must
// not — and "one solution" is not enough, it must be the *same* solution, cell by cell.
console.log('\n== 穷举复核（第二套互不信任的实现，逐格比对解答）==');
let checked = 0;
let bad = 0;
for (const tier of TIERS) {
  for (let s = 0; s < 6; s++) {
    const p = makePuzzle(`cross|${s}`, tier.key);
    if (!p) continue;
    const c = countSolutions(p.board, { cap: 2, budget: 400_000 });
    checked++;
    if (c.status !== UNIQUE) {
      bad++;
      console.log(`  ✗ ${tier.name} seed ${s}: 穷举解数 ${c.solutions}（铅笔求解器判定唯一）`);
      continue;
    }
    const mine = solve(p.board).state.fill;
    let diff = 0;
    for (let t = 0; t < p.board.size; t++) if (mine[t] !== c.grid[t]) diff++;
    if (diff) {
      bad++;
      console.log(`  ✗ ${tier.name} seed ${s}: 两套实现的解答有 ${diff} 格不同`);
    }
    // and the generator's own answer must be that answer too
    const sol = solutionOf(p.board, p.solution);
    for (let t = 0; t < p.board.size; t++) if (sol[t] !== c.grid[t]) diff++;
    if (diff) {
      bad++;
      console.log(`  ✗ ${tier.name} seed ${s}: 生成器给的解与穷举的解不一致`);
    }
  }
}
console.log(`  ${checked - bad}/${checked} 局穷举复核与铅笔判定逐格一致`);

// Cross-check two: re-solving an accepted board must reproduce the same score, or the score is a
// property of the generator's state rather than of the board.
{
  let drift = 0;
  for (const tier of TIERS) {
    const p = makePuzzle(`drift|1`, tier.key);
    if (!p) continue;
    const board = createBoard({ n: tier.n, pan: tier.pan, givens: p.givens });
    const r = solve(board);
    if (!r.ok || r.score !== p.score) {
      drift++;
      console.log(`  ✗ ${tier.name} 复解不一致`, r.ok, r.score, p.score);
    }
  }
  console.log(`  复解一致：${TIERS.length - drift}/${TIERS.length} 档`);
}

// 线索下界: for the shipped boards, the smallest subset of *their own* clues that still pins the
// square, tested exhaustively with the counter. Reported, never assumed.
console.log('\n== 线索下界（出货盘自身线索的穷举子集测试）==');
for (const tier of TIERS) {
  const floors = [];
  const given = [];
  let truncated = 0;
  for (let s = 0; s < 8; s++) {
    const p = makePuzzle(`floor|${s}`, tier.key);
    if (!p) continue;
    const f = clueFloor(p.board, { budget: 40_000, maxCounted: 4096 });
    if (f.truncated) truncated++;
    floors.push(f.floor);
    given.push(p.clueCount);
  }
  const sort = (a) => a.slice().sort((x, y) => x - y);
  console.log(
    `  ${tier.name}：线索 ${sort(given)[0]}–${sort(given)[sort(given).length - 1]} 个，下界中位 ${q(sort(floors), 0.5)}（删到这么少仍然唯一），截断 ${truncated}/8`,
  );
}

// Sanity for the peel: the square it peeled from must satisfy the rules of the game as verify()
// reads them — which looks at none of the generator's internals.
{
  let total = 0;
  let broken = 0;
  for (let s = 0; s < 40; s++) {
    const p = makePuzzle(`peel|${s}`, TIERS[1].key);
    if (!p) continue;
    total++;
    const wrong = verify(p.board, solutionOf(p.board, p.solution));
    if (wrong.length) {
      broken++;
      if (broken <= 3) console.log('  ✗ 抽出来的正解不合法:', wrong.slice(0, 2).map((x) => x.why).join('; '));
    }
  }
  console.log(`  抽盘器产出的正解合法：${total - broken}/${total}`);
}

console.log(`\n最慢档位 ${worst.toFixed(0)} ms/局`);
process.exit(mono && bad === 0 ? 0 : 1);
