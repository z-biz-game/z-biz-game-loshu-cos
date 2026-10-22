# 幻方 · LOSHU — 交付报告

## 摘要

| 字段 | 值 |
|---|---|
| **App 名称** | 幻方 · LOSHU（填数幻方推理） |
| 英文名 / 形态 | LOSHU · 浏览器原生（根形态 + Pages 前缀形态） |
| 玩法一句话 | 把 1~n² 各用一次填进方格：每行、每列、对角线的和都等于同一个数 M = n(n²+1)/2；「泛对角」档把对角线换成**闭合的斜带**（断开的首尾相接也算同一条线），一共 16 条线 |
| 三档 | 三阶（3×3 九宫，8 条线）/ 四四（4×4，10 条线）/ 泛对角（16 条线：4 行 + 4 列 + 8 条斜带，主副对角线是这 8 条里的两条，不重复计） |
| 难度口径 | 分数 = Σ规则权重 × 出手次数，是推完这局的实际代价；档位区间是筛子不是标签（区间住在 `js/engine/generate.js` 的 `TIERS`），`npm run balance` 三档各抽 40 局现场验 |
| 测试钩子 | `window.loshu`（`version` `select` `erase` `move` `tick` `pause` `resume` `togglePause` `help` `fullscreen` `sound` `elapsed` `state` `cellAt` `valueAt` `candidates` `boxLine` `engine`） |
| 依赖 | 运行时 **0** 个、`devDependencies` 1 个（electron，只有 `npm run electron` 那条路需要它） |
| 二进制资产 | 21 张位图，无音频文件、无字体（音效由 WebAudio 合成） |
| node 断言 | **520 条**（`tools/engine-test.mjs`，含现场穷举清点），0 失败；另有文档腿 `tools/docs-test.mjs` **15 条**，0 失败 |
| 浏览器断言 | **339 条**，11 段（engine 56 / gen 33 / play 29 / reject 24 / hint 22 / notes 27 / undo 21 / save 22 / resume 25 / win 28 / layout 26 + layout@380x760 26），0 失败 |
| 验收命令 | `npm run check` · `npm test` · `node tools/docs-test.mjs` · `node tools/deploy-set.mjs` · `bash tools/verify.sh` |

依赖与资产的机器可判定检查：

```bash
$ node -e 'const p=require("./package.json");const d=p.dependencies||{};
  process.stdout.write(Object.keys(d).length===0?"ok":JSON.stringify(d))'
ok
$ git ls-files | grep -cE '\.(png|jpg|jpeg|mp3|wav|woff2?|ttf|svg)$'
21
```

---

## 基线 → 本次提交

| | 提交 | 说明 |
|---|---|---|
| 基线 | `a7d23e6` | 「Merge branch 'main' of github.com:z-biz-game/z-biz-game-loshu-cos」（仓内已经并过一次，这次是第二次） |
| 本次修复 1 | `9f278d8` | 修并线造成的硬伤：同名顶层声明、三处重复接线、重复 id |
| 本次修复 2 | `b0577db` | 补回并线丢掉的两个声明（每次发声都抛 ReferenceError） |
| 本交付物 | 本文件所在提交 | 只增这一个文件 |

---

## 改动表：旧代码错在哪 → 新代码为什么对

| # | 旧代码错在哪 | 新代码为什么对 |
|---|---|---|
| 1 | `js/main.js` 有三处同名顶层声明：`paused`（`let` / `var` 各一份）、`setPaused`、`toggleFullscreen` 各两份。**ES module 的顶层作用域里同名声明是 SyntaxError**（实测 `node --check`：`Identifier 'paused' has already been declared`）⇒ 整个 `js/main.js` 根本不加载 ⇒ 页面只剩一个空壳，**整局不可玩** | 逐个留一份。暂停留**本地侧**那份（带遮罩、音频挂起、恢复时重置帧累加器与 `lastFrameMs`）；全屏留本地侧那份（按钮状态回写、退出侧兜底、60ms 后重新同步按钮） |
| 2 | `index.html` 里 `#btn-pause` 出现了**两次**（顶栏一颗、并线带进来的一颗），同一个 id 两颗按钮；而全屏有两颗（`#btn-full` 与 `#btn-fullscreen`） | 删掉并线带进来的那一行，顶栏保留一颗暂停与一颗全屏。删之前先核过：页面 57 个 id 现在全部唯一，脚本引用的 55 个 id 一个都不悬空 |
| 3 | 三处接线被接了**两遍** ⇒ 一次点击进出各一次，净效果是「按了没反应」：**暂停按钮**（本地侧一条 + 远端侧追加块里 `getElementById` 一条）、**F 键**（本地侧 keydown + 远端侧 `bindFullscreen` 里一条）、**M 键静音**（本地侧 keydown + 远端侧追加块里一条） | 接线各留一份。键位表仍是那一份（h/z/b/w/e/m/p/f/r…），空格在焦点落在按钮上时仍然归那个按钮 |
| 4 | 全屏能力少了一半：本地侧那份只认 `requestFullscreen` / `webkitRequestFullscreen`（老 Edge 的 `ms` 前缀不认），而且**不支持时按钮不会禁用也不会说明原因** | 把远端侧那两样折进来：三套 API 前缀的特性探测（`fsRequest`：`requestFullscreen` / `webkitRequestFullscreen` / `msRequestFullscreen`）与「不支持就把按钮禁用并写清原因」（`syncFullscreenSupport`：iOS Safari 只有 `<video>` 能全屏，请用「添加到主屏幕」） |
| 5 | `js/audio/synth.js`：`tone()` 调 `silent()`、`halt()` / `unhalt()` 写 `halted`，而**这两个声明在并线时被裁掉了**（引入它们的是 `2bcd40b`）⇒ 第一次发声就抛 `ReferenceError: silent is not defined`，而它是在**落子的路径上**抛的 ⇒ 浏览器场景「零报错贯穿一局」got 5 want 0、「提示全程零报错」got 15 want 0，胜利音与拒绝音同理；暂停时 `halt()` 也直接抛 | 按引入它们的那次提交原样补回两行：`let halted = false;` 与 `const silent = () => !enabled || halted;`。两件事是分开的：`enabled` 是玩家自己选的静音，`halted` 是这一局暂停期间那一档 |
| 6 | 远端侧在文件末尾追加的整段（fs 帮手与第二套全屏、`bindFullscreen`、第二套暂停、第二套 P/空格键、第二条 M 键） | 删掉：那些都是同名声明与重复接线。它独有的两样能力（全屏前缀探测、不支持时的说明）已折进留下的那份 |

### 改钉一览（钉的是实数，强度不变）

| 钉 | 旧 | 新 | 为什么变 |
|---|---|---|---|
| `tools/deploy-set.mjs` `EXPECT_CHECKS` | 26 | 30 | 并线把页面要取的东西凑到了 30 条，钉停在旧值 |
| `tools/deploy-set.mjs` `EXPECT_ROWS` | 45 | 49 | 同上 |

闸的**断言一条没改、强度一条没降**：部署集闸仍然逐条查「页面要取的东西在不在产物里且非 0 字节」，仍然要求引用条数与断言条数两个数**一起**等于钉在文件里的值（少一条断言就不能是绿的）。

---

## 真实文件清单

本轮实际改动的文件：

| 文件 | 作用 | 由谁验证 |
|---|---|---|
| `js/main.js` | 路由、DOM 接线、时钟、暂停/全屏/静音/玩法、`window.loshu` 测试桥 | `@play` 29 条 + `@reject` 24 条 + `@layout` 26 条；`npm run check` 的语法门 |
| `js/audio/synth.js` | WebAudio 合成音效 + 静音/暂停两档 | `@play` 的「零报错贯穿一局」、`@hint` 的「提示全程零报错」、`@win` 28 条（每一次发声都在这些路径上） |
| `index.html` | 壳：顶栏（玩法/暂停/全屏/笔记/音效/动效）、画布、面板、遮罩 | `node tools/deploy-set.mjs`（每个 href/src 都在产物里）；`@layout`（命中盒与几何） |
| `tools/deploy-set.mjs` | 部署集闸（产物清单 / manifest / og / CI 接线） | 自身 `rows: 49 fail: 0` + `deploy-set-selftest.mjs` rc=0 |

未改动但被本轮引用（写出来是为了说明它们**由谁验证**）：

| 文件 | 作用 | 由谁验证 |
|---|---|---|
| `js/engine/loshu.js` | 六条铅笔规则与 `propagate`（不回溯的推到底） | `engine-test` 的规则段；`@hint` 的「提示引用的规则」读数 |
| `js/engine/generate.js` | 出题、唯一解筛选、难度带 | `engine-test` 的生成保证段；`@gen` 33 条（实测分位） |
| `js/engine/count.js` | 第二套穷举复解（逐格比对） | `engine-test`；`npm test` 的现场穷举清点（8 / 7040 / 384 盘） |
| `js/engine/rng.js` | 种子哈希与洗牌 | `engine-test` 的确定性断言 |
| `js/ui/game.js` | 一局的状态机（选数、落笔、撤销、提示计费、判胜） | `engine-test` 的状态机段；`@play` / `@undo` |
| `js/render/board.js` `js/render/fx.js` | canvas 渲染、命中、笔记层、粒子 | `@layout`（像素与几何）、`@notes` 27 条 |
| `js/store.js` | 存档与设置 | `engine-test`；`@save` 22 条 + `@resume` 25 条（真重新导航） |
| `js/theme.js` | 配色与设计令牌 | `engine-test`；`@layout` 的颜色断言 |
| `js/sw-register.js` | Service Worker 注册（相对 `document.baseURI`） | `npm run check`；部署集闸 |
| `tools/engine-test.mjs` | 520 条 Node 断言 + 现场穷举清点 | 自身末行 `520 通过 / 0 失败` |
| `tools/docs-test.mjs` | 文档行号对账（每个 `path:NN` 读回真文件那一行） | 自身末行 `rows: 15 fail: 0` |
| `tools/balance.mjs` | 难度实测台（三档各抽 40 局） | `npm run balance` |
| `tools/playtest.cjs` `tools/scenarios.js` | 零依赖 CDP 驱动 + 十一个场景 | `tools/verify.sh` 每段的 `N 项检查，0 项失败` |
| `tools/verify.sh` | 一条命令一个结论 | 自身末行 `=== 全绿 ===` |
| `tools/assemble-site.sh` | 部署产物的唯一清单 | 部署集闸调它 |
| `server.cjs` `electron/main.cjs` `electron/preload.cjs` | 零依赖静态服务器 / 桌面壳 | 服务器：`verify.sh` 的端口与内容预检；桌面壳：只有 `npm run check` 的语法门（见「需人接手」） |

---

## 删行审计

本轮**没有删掉任何功能**。逐条列出被删掉的代码行，以及它们为什么不是功能：

| 删掉的行 | 在哪 | 为什么不是功能 |
|---|---|---|
| `var paused = false;` / `function setPaused(v)`（文件末尾那份，15 行） | `js/main.js` | 同名声明后定义者胜 ⇒ 这份赢、前面那份成了死代码；这份没有遮罩、不挂音频、不写存档 —— 能力是前一份的子集 |
| `function toggleFullscreen(root)` + `bindFullscreen` + `bootFullscreen` + 那段 DOMContentLoaded 接线（远端侧的第二套全屏，约 80 行） | `js/main.js` | 同名声明；它的按钮是 `#btn-fullscreen`（另一颗按钮），它自带一条 F 键 ⇒ 与前面那份构成"按一下进出各一次"。它独有的两样能力已折进留下的那份 |
| `document.getElementById('btn-pause').addEventListener('click', togglePause);` | `js/main.js` | 与本地侧那条重复（同一颗按钮） |
| 那条 P/空格键的 keydown | `js/main.js` | 与本地侧那条重复；本地侧那条还带"焦点在按钮上就放行"的无障碍判断 |
| 那条 M 键（静音）的 keydown | `js/main.js` | 与本地侧那条重复 |
| `<button id="btn-pause">…</button><button id="btn-fullscreen">…</button>`（一整行） | `index.html` | 并线带进来的第二颗暂停按钮（与顶栏那颗**同一个 id**）与第二颗全屏按钮 |

逐文件增删行数（`git diff --numstat a7d23e6..HEAD`）：

```
0/1    index.html      8/0   js/audio/synth.js
46/160 js/main.js      2/2   tools/deploy-set.mjs
```

---

## 验收命令原样输出

```bash
$ bash tools/verify.sh
单元：npm test
== 穷举清点（npm test 现场跑的数，不是书上的）==
  三阶：8 盘 / 1 基本盘（节点 58，1 ms）
  四四：7040 盘 / 880 基本盘（节点 1662753，1556 ms）
  泛对角：384 盘 / 48 基本盘（节点 1537937，2043 ms）

520 通过 / 0 失败  （引擎与清点耗时 12.0s）
单元：520 条断言全过
=== deploy-set ===（单元：页面要取的东西必须在产物里）
部署集：30 条引用（含 3 张位图尺寸核对），失败 0 项
rows: 49 fail: 0
=== docs ===（印在纸上的每个行号都读回真文件的那一行）
文档行号对账：3 份文档 · 23 条引用 · 13 条带指认 · 1 条续引 · 0 条跨仓 · 15 条判据
rows: 15 fail: 0
预检：http://127.0.0.1:5223/ 是本站（13274 字节）
测试面：window.loshu 1.0.0 @ http://127.0.0.1:5223/
=== 场景 engine ===  56 项检查，0 项失败  {"rules":["行列补全","候选排除","区间剪枝","对角线","互补对称","反证"], ...}
=== 场景 gen ===    33 项检查，0 项失败  {"median":[13,121.5,162.5]}
=== 场景 play ===   29 项检查，0 项失败  {"moves":5,"hints":0,"firstDoneAt":"1/8"}
=== 场景 reject === 24 项检查，0 项失败  {"rejected":[2,8]}
=== 场景 hint ===   22 项检查，0 项失败  {"cited":["对角线","候选排除","行列补全"],"hints":10}
=== 场景 notes ===  27 项检查，0 项失败  {"noteInk":0.062}
=== 场景 undo ===   21 项检查，0 项失败  {"hints":1}
=== 场景 save ===   22 项检查，0 项失败  {"seed":"scen|save","moves":3,"hints":1,"bytes":163}
=== 场景 resume === 25 项检查，0 项失败  {"resumedFromReload":true,"seed":"scen|save"}
=== 场景 win ===    28 项检查，0 项失败
=== 场景 layout === 26 项检查，0 项失败  {"width":1280,"cell":78,"margin":56,"narrow":false}
=== 场景 layout @ 380x760 === 26 项检查，0 项失败  {"width":380,"cell":68,"margin":49,"narrow":true}
== 合计：339 项浏览器断言，0 项失败 ==
=== 全绿 ===
VERIFY_RC=0
```

逐条命令的退出码：

| 命令 | 退出码 | 实数 |
|---|---|---|
| `npm run check` | 0 | 每个源文件 `node --check`（含 server / electron / 测试脚本） |
| `npm test` | 0 | **520 条**断言，0 失败（含现场穷举清点） |
| `node tools/docs-test.mjs` | 0 | **15 条**判据，0 失败 |
| `node tools/deploy-set.mjs` | 0 | **30 条引用** / **49 行**，失败 0 项 |
| `node tools/deploy-set-selftest.mjs` | 0 | 每一刀都按预期发力 |
| `bash tools/verify.sh` | **0** | 浏览器 **339 条**，11 段全过 |

---

## 行为变化需知会

1. **顶栏只有一颗暂停与一颗全屏**。并线那版页面上有两颗暂停（同一个 id）与两颗全屏，暂停按一下等于没按、全屏按一下也等于没按。
2. **全屏按钮在不提供元素全屏的浏览器上会自己禁用并说明原因**（iOS Safari 只有 `<video>` 能全屏，请用「添加到主屏幕」），不再是一个按下去没反应的按钮。
3. **全屏现在认老 Edge 的 `ms` 前缀**（特性探测，不是 UA 字符串判断）。
4. **音效恢复**：并线那版第一次发声就抛 ReferenceError（而它是在落子的路径上抛的），落子、提示、拒绝、胜利全都会在控制台留红；现在这几条路径都不再报错。暂停期间音效上下文照旧挂起，恢复时继续。
5. **空格键在焦点落在按钮上时仍归那个按钮**（键盘玩家按空格可正常按任意按钮）；焦点不在按钮上时空格才是暂停。

---

## 未实现 / 需人接手

| 事项 | 现状 | 需要谁 |
|---|---|---|
| 桌面壳 `electron/main.cjs` / `electron/preload.cjs` | 只过了 `npm run check` 的语法门，运行期没有自动化验收 | 需要人手工跑一次 Electron 外壳 |
| 三种 URL 形态 | 整闸跑的是**根形态**（`http://127.0.0.1:5223/`）；Pages 的 `/<slug>/` 前缀形态与线上产物形态要各自起服务再跑一次 `BASE_URL=… bash tools/verify.sh` | 需要有 Pages 访问权的机器跑那两遍 |
| 难度分位表的实时性 | `npm run balance` 打印的是**生成器当前能产出的**分位；文档里印的那一格是上一次烘焙的读数 | 改难度带的人 |

---

## 基线归因记录

用 `git worktree add --detach /tmp/loshu-pre a7d23e6` 建了合并前基线，在**同一套闸**上跑，结果如下：

| 检查 | 基线（`a7d23e6`） | 本次 | 判定 |
|---|---|---|---|
| `node --check js/main.js` | `SyntaxError: Identifier 'toggleFullscreen' has already been declared`（另有 `paused` / `setPaused` 两处，解析器只报第一个） | 解析通过；`js/main.js:350` 的 `toggleFullscreen` 是唯一定义 | **并线造成**：整局不可玩 |
| `npm test` | 520 通过 / 0 失败 | 520 通过 / 0 失败 | 未受影响（引擎层与 UI 层无关） |
| `node tools/docs-test.mjs` | rows: 15 fail: 0 | 并线后现跑 `rows: 15 fail: 3`（D2 报 `deliverable.md=0`，D10 的份数/引用两格还停在并线前）→ 补引用、重贴盖章后 `rows: 15 fail: 0` | **并线造成**，不是"未受影响"：这一行原先写的 0 是并线那一跑的读数，合并后的树上它红过 |
| `node tools/deploy-set.mjs` | 30 条引用 / 49 行，**2 项失败**（两个计数钉还停在并线前的 26 / 45） | 30 条引用 / 49 行，0 失败 | **并线造成**（页面要取的东西凑到了 30 条） |
| 浏览器十一段 | 跑不起来（整页不加载） | 339 条，0 失败 | 另有一处：`js/audio/synth.js` 的 `silent()` / `halted` 两个声明在更早的一次并线里就丢了（引入它们的是 `2bcd40b`），两侧都没有 ⇒ 每次发声都抛 ReferenceError；补回的两个声明现在在 `js/audio/synth.js:15` 的 `halted` 与 `js/audio/synth.js:16` 的 `silent` |

结论：全部红都是并线（仓内并过两次）把两侧拼在一起带进来的；`synth.js` 那两个声明是**上一次并线**丢的，本轮一并补回。

基线 worktree `/tmp/loshu-pre` 已用 `git worktree remove --force` 清掉。
