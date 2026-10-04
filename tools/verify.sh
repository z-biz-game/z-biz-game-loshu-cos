#!/usr/bin/env bash
# 一次性浏览器验收：真 Chrome、真 DOM、真几何、真像素。
#
#   bash tools/verify.sh
#   SKIP_UNIT=1 bash tools/verify.sh                    # 跳过 npm test（只在刚跑过绿时用）
#   SCENARIOS="play hint" bash tools/verify.sh          # 只跑指定场景
#   SHOTS=1 bash tools/verify.sh                        # 顺手截图到 tools/shots/
#   BASE_URL=https://z-biz-game.github.io/z-biz-game-loshu-cos/ bash tools/verify.sh
#
# 不要加 --use-gl=angle --use-angle=swiftshader：软件光栅会吃满所有核，而且在没有 CDP 客户端
#  attached 的时候 Chrome 根本不会自己退出，端口就永久留给下一轮。
#
# PORTS: 本仓占 5223(web) 与 9373(CDP)。农场里的邻居：shikaku 5251、gridlock 5180/9340、
# chomp 5201/9361、euclid 5221/9371、ulam 5222/9372。
# 别人仓里起来的 Chrome 若挂在 9373 上，这套壳就会把*他们的*页面报成我们的，所以端口被占是
# 硬停而不是警告。但兄弟 agent 占着端口时正确做法是等并重试 —— 绝不为了变绿削弱任何一条检查：
# 不换端口跑过去（那测的是别人）、不 kill 别人的进程（那是别人的活）、不放宽 checks>0。
set -u

HERE=$(cd "$(dirname "$0")/.." && pwd)
WEB_PORT=${WEB_PORT:-5223}
CDP_PORT=${CDP_PORT:-9373}
BASE=${BASE_URL:-http://127.0.0.1:$WEB_PORT/}
RUN=/tmp/loshu-verify.$$
mkdir -p "$RUN"

CHROME=${CHROME_BIN:-}
if [ -z "$CHROME" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           "$(command -v google-chrome 2>/dev/null)" \
           "$(command -v chromium 2>/dev/null)"; do
    [ -n "$c" ] && [ -x "$c" ] && { CHROME=$c; break; }
  done
fi
[ -n "$CHROME" ] || { echo "找不到 Chrome，设 CHROME_BIN 指向可执行文件" >&2; exit 2; }

cd "$HERE"

# ---------- 端口 ----------
holder_of() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | tr '\n' ' '; }
why_busy() {
  local pids=$(holder_of "$1") pid
  for pid in $pids; do
    ps -p "$pid" -o command= 2>/dev/null | head -c 160
  done
}
# wait_free <port> <label> —— 端口被占不是失败，是排队。等不到才算失败。
wait_free() {
  local port=$1 label=$2 i max=${PORT_WAIT_TRIES:-20}
  for i in $(seq 1 "$max"); do
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || return 0
    echo "  :${port}（${label}）还被 [$(why_busy "$port")]占着，等它释放 $i/$max …" >&2
    sleep 3
  done
  echo "端口 :${port}（${label}）始终被别的进程占着：" >&2
  lsof -nP -iTCP:"$port" -sTCP:LISTEN >&2 || true
  echo "那是别人仓的进程。附上去就是在测他们的页面，所以这里不抢、不换、不 kill —— 请等它空出来再跑。" >&2
  return 1
}

wait_free "$CDP_PORT" "devtools" || exit 6
wait_free "$WEB_PORT" "web" || exit 6
# 没占端口但已经在跑的带调试端口的 headless Chrome（邻居的 9358 之类）说明这台机器正有人
# 抢 CPU/端口，先让一让；但不因为「机器上有别的浏览器」就罢工 —— 真正要防的不是邻居存在，
# 而是我附上去的那个端点不是我自己起的进程，那件事在下面用 --user-data-dir 唯一指纹来证明。
for i in $(seq 1 ${ORPHAN_TRIES:-3}); do
  ORPH=$(ps -Ao command= | awk '/remote-debugging[-]port/ && !/--type=/' | wc -l | tr -d ' ')  # instances, not procs
  [ "${ORPH:-0}" = "0" ] && break
  echo "  机器上还有 $ORPH 个带 remote-debugging-port 的 Chrome（不是本仓端口），让路 $i/${ORPHAN_TRIES:-3}" >&2
  sleep 4
done

# ours_on <port> <needle> —— 这个端点是不是我起的进程占的？看命令行指纹，不看端口号。
owns_port() {
  local port=$1 needle=$2 pid
  for pid in $(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null); do
    ps -p "$pid" -o command= 2>/dev/null | grep -q "$needle" || return 1
  done
  lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | grep -q .
}

# ---------- 单元闸 ----------
MIN_ASSERTIONS=128
if [ "${SKIP_UNIT:-0}" = "1" ]; then
  echo "单元：SKIP_UNIT=1，跳过 npm test（本轮只验浏览器）"
else
  echo "单元：npm test"
  node tools/engine-test.mjs >"$RUN/unit.log" 2>&1; UNIT_RC=$?
  tail -8 "$RUN/unit.log"
  N=$(grep -o '[0-9]\+ 通过' "$RUN/unit.log" | head -1 | grep -o '[0-9]\+' || echo 0)
  F=$(grep -o '[0-9]\+ 失败' "$RUN/unit.log" | head -1 | grep -o '[0-9]\+' || echo 9)
  [ "$N" -ge "$MIN_ASSERTIONS" ] || { echo "断言只有 $N 条，少于 $MIN_ASSERTIONS —— 清点不能靠嘴说" >&2; exit 5; }
  { [ "$UNIT_RC" = 0 ] && [ "$F" = 0 ]; } || { echo "npm test 没过（rc=${UNIT_RC}，失败 $F 条），先看 $RUN/unit.log" >&2; exit 5; }
  echo "单元：$N 条断言全过"
fi

# ---------- 起服务 ----------
SPID=0
LOCAL=0
case "$BASE" in "http://127.0.0.1:$WEB_PORT/"*) LOCAL=1 ;; esac
if [ "$LOCAL" = 1 ]; then
  node server.cjs "$WEB_PORT" >"$RUN/server.log" 2>&1 &
  SPID=$!
  for i in $(seq 1 60); do
    curl -fsS -m 1 "$BASE" >/dev/null 2>&1 && break
    sleep 0.25
  done
  # 这个 :5223 是我刚起的那个 node 吗？端口号不足以证明归属，PID 才证明。
  LISTEN=$(lsof -nP -iTCP:"$WEB_PORT" -sTCP:LISTEN -t 2>/dev/null | tr '\n' ' ')
  [ "$LISTEN" = "$SPID " ] || {
    echo ":$WEB_PORT 的监听者不是本脚本起的 node（我起的 PID=${SPID}，实际监听 PID=${LISTEN:-无}）—— 不测别人的 server" >&2; exit 7; }
fi
# 起手预检：先把「服务到的字节确实是幻方」钉死，否则后面所有像素都是别人的
SERVED=$(curl -fsS -m 5 "$BASE" 2>/dev/null || true)
[ -n "$SERVED" ] || { echo "$BASE 没有响应，见 $RUN/server.log" >&2; tail -5 "$RUN/server.log" >&2; exit 2; }
echo "$SERVED" | grep -qi loshu || { echo "$BASE 服务的是别的应用（首页里找不到 loshu）" >&2; exit 2; }
echo "$SERVED" | grep -q '<canvas' || { echo "$BASE 的首页里没有 canvas" >&2; exit 2; }
echo "$SERVED" | grep -q 'js/main.js' || { echo "$BASE 的首页没有引 js/main.js" >&2; exit 2; }
echo "预检：$BASE 是本站（$(printf '%s' "$SERVED" | wc -c | tr -d ' ') 字节）"

UDD=$(mktemp -d /tmp/loshu-chrome.XXXXXX)
"$CHROME" --headless=new --remote-debugging-port=$CDP_PORT --user-data-dir="$UDD" \
  --window-size=1280,900 --no-first-run --no-default-browser-check about:blank \
  >"$RUN/chrome.log" 2>&1 &
CPID=$!
PIDS="$SPID $CPID"
WID=0
( sleep ${WD_TIMEOUT:-900}; echo "看门狗：超过 ${WD_TIMEOUT:-900}s，收摊" >&2; cleanup ) </dev/null >/dev/null 2>&1 &
WID=$!
PIDS="$PIDS $WID"

cleanup() {
  [ -n "$_CLEANED" ] && return 0; _CLEANED=1
  for p in $PIDS; do [ "$p" != 0 ] && kill "$p" 2>/dev/null; done
  for p in $PIDS; do [ "$p" != 0 ] && wait "$p" 2>/dev/null; done
  # 孤儿：headless=new 会把 renderer 过继给 launchd，profile 目录也留着
  for p in $(pgrep -f "user-data-dir=$UDD" 2>/dev/null); do kill "$p" 2>/dev/null; done
  rm -rf "$UDD"
}
_CLEANED=""
trap 'cleanup; exit 130' INT TERM
trap cleanup EXIT

for i in $(seq 1 120); do
  curl -fsS -m 1 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -m 2 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 || {
  echo "devtools 从没在 :$CDP_PORT 上起来，见 $RUN/chrome.log" >&2; tail -10 "$RUN/chrome.log" >&2; exit 3; }
V=$(curl -fsS -m 2 "http://127.0.0.1:$CDP_PORT/json/version")
# 唯一的 --user-data-dir 是本脚本刚 mktemp 出来的路径：:9373 上的进程命令行里没有它，就说明
# 我附到的是别人的 Chrome —— 这时候的每一条绿断言都在给别人仓的页面背书。
owns_port "$CDP_PORT" "user-data-dir=$UDD" || {
  echo ":$CDP_PORT 上的 Chrome 不是本脚本起的（我的 profile 是 ${UDD}，监听者命令行里没有它）" >&2
  lsof -nP -iTCP:"$CDP_PORT" -sTCP:LISTEN >&2 || true
  exit 7; }
echo "浏览器：$(echo "$V" | sed -n 's/.*"Browser": "\(.*\)".*/\1/p')"

export CDP_PORT BASE_URL="$BASE"
node tools/playtest.cjs open "$BASE" >"$RUN/open.log" 2>&1 || {
  echo "attach 不上页面：$(tail -3 $RUN/open.log)" >&2; exit 3; }
echo "页面：$(tail -1 "$RUN/open.log")"

# 轮询测试面，不睡固定秒数：模块是 type=module，脚本比 curl 慢半拍
BOOT=""
for i in $(seq 1 80); do
  BOOT=$(node tools/playtest.cjs eval "window.loshu?window.loshu.version:'nope'" nonav 2>/dev/null | tr -d '\n" ')
  case "$BOOT" in *nope*|""|*ERROR*) sleep 0.25 ;; *) break ;; esac
done
case "$BOOT" in ""|nope|*ERROR*) echo "window.loshu 一直没出现在 $BASE" >&2; exit 4 ;; esac
echo "测试面：window.loshu $BOOT @ $BASE"

# RESULT 那行是唯一可信的载荷：控制台噪音里可能混进 '{'，所以按花括号配对截出 JSON
json_from_log() {
  awk '
    !pending && /RESULT / { sub(/.*RESULT /, "", $0); pending = $0; depth = 0; out = ""; started = 0; line = 1 }
    pending {
      s = (line == 1 ? pending : $0); line = 2;
      for (i = 1; i <= length(s); i++) {
        c = substr(s, i, 1); out = out c;
        if (c == "{") { depth++; started = 1 }
        else if (c == "}") { depth--; if (started && depth == 0) { print out; exit } }
      }
      if (started) pending = pending "\n" s
    }
  ' "$1"
}
report() { # <name> <json> -> prints, exit 1 unless 0 fail and checks>0
  SCEN=$1 SCEN_JSON=$2 node -e '
    const name = process.env.SCEN, raw = process.env.SCEN_JSON;
    if (!raw) { console.log("  没有 RESULT 载荷（看场景的 console 日志）"); process.exit(1); }
    let d; try { d = JSON.parse(raw); } catch (e) { console.log("  RESULT 解析不了: " + raw.slice(0, 200)); process.exit(1); }
    for (const f of (d.failed || [])) console.log("  ✗ " + f);
    const extra = Object.entries(d).filter(([k]) => !["checks", "fail", "failed"].includes(k));
    if (!d.checks) { console.log("  一条断言都没跑 —— 不指认任何事实的场景不能算绿"); process.exit(1); }
    console.log("  " + d.checks + " 项检查，" + d.fail + " 项失败" + (extra.length ? "  " + JSON.stringify(Object.fromEntries(extra)) : ""));
    process.exit(d.fail ? 1 : 0);
  '
}

TOTAL_CHECKS=0; TOTAL_FAIL=0; FAILED=0
for s in ${SCENARIOS:-engine gen play reject hint notes undo save resume win layout}; do
  echo "=== 场景 $s ==="
  node tools/playtest.cjs scenario "$s" >"$RUN/$s.out" 2>"$RUN/$s.console.log"
  JSON=$(json_from_log "$RUN/$s.out")
  if ! report "$s" "$JSON"; then FAILED=1; fi
  C=$(echo "$JSON" | sed -n 's/.*"checks": *\([0-9]*\).*/\1/p'); C=${C:-0}
  F=$(echo "$JSON" | sed -n 's/.*"fail": *\([0-9]*\).*/\1/p'); F=${F:-0}
  TOTAL_CHECKS=$((TOTAL_CHECKS + C)); TOTAL_FAIL=$((TOTAL_FAIL + F))
  if [ -s "$RUN/$s.console.log" ]; then
    echo "  --- 页面 console（末 6 行）---"
    sed 's/^/  /' "$RUN/$s.console.log" | tail -6
  fi
done

# 窄屏重跑版式：手机上的棋盘是另一份几何，不是同一份的缩放
echo "=== 场景 layout @ 380x760 ==="
VIEWPORT=380x760 node tools/playtest.cjs scenario layout >"$RUN/narrow.out" 2>"$RUN/narrow.console.log"
JSON=$(json_from_log "$RUN/narrow.out")
report narrow-layout "$JSON" || FAILED=1
C=$(echo "$JSON" | sed -n 's/.*"checks": *\([0-9]*\).*/\1/p'); TOTAL_CHECKS=$((TOTAL_CHECKS + ${C:-0}))
F=$(echo "$JSON" | sed -n 's/.*"fail": *\([0-9]*\).*/\1/p'); TOTAL_FAIL=$((TOTAL_FAIL + ${F:-0}))

if [ -n "${SHOTS:-}" ]; then
  mkdir -p tools/shots
  for shot in menu board win; do
    case $shot in
      menu) node tools/playtest.cjs eval "window.loshu.show('menu');'ok'" >/dev/null 2>&1 ;;
      board) node tools/playtest.cjs eval "window.loshu.begin({tier:'jiugong',seed:'shot-board'});'ok'" >/dev/null 2>&1 ;;
      win) node tools/playtest.cjs eval "window.loshu.begin({tier:'jiugong',seed:'shot-win'});window.loshu.solveWithLogic();'ok'" >/dev/null 2>&1 ;;
    esac
    sleep 1.2
    node tools/playtest.cjs shot "tools/shots/$shot-$SHOTS.png" >/dev/null 2>&1
  done
  echo "截图：$(ls tools/shots/*-$SHOTS.png 2>/dev/null | tr '\n' ' ')"
fi

kill $WID 2>/dev/null
echo "== 合计：$TOTAL_CHECKS 项浏览器断言，$TOTAL_FAIL 项失败 =="
[ $FAILED -eq 0 ] && echo "=== 全绿 ===" || echo "=== 上面有失败 ==="
cleanup
[ $FAILED -eq 0 ] && exit 0 || exit 1
