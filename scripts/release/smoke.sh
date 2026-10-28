#!/bin/bash
# 安装包的冒烟测试，在 macOS 上跑：$1 是解压后的包目录。
# 查原生程序只链系统库、录音和听写的管线走得通、yoyo 能说一句、桌宠能开起来。
set -euo pipefail

pkg="$(cd "$1" && pwd)"
lib="$pkg/lib"
work="$(mktemp -d)"
pet_pid=""
cleanup() {
  if [ -n "$pet_pid" ]; then
    kill -TERM "$pet_pid" 2>/dev/null || true
    wait "$pet_pid" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT
fail() {
  echo "✗ $*" >&2
  exit 1
}

echo "-- 原生程序只链系统库"
for bin in "$lib/bin/"* "$lib/node/bin/node"; do
  [ -L "$bin" ] && continue
  # 第一行是文件名本身
  if otool -L "$bin" | tail -n +2 | awk '{print $1}' | grep -vE '^(/usr/lib/|/System/Library/)'; then
    fail "$(basename "$bin") 链了系统以外的库"
  fi
done

echo "-- Node"
"$lib/node/bin/node" -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 18)) throw new Error(`Node ${process.version} 太旧`);
  require("node:sqlite");
' 2>/dev/null || fail "Node 不能用"

echo "-- ffmpeg 有 avfoundation"
"$lib/bin/ffmpeg" -hide_banner -devices 2>&1 | grep -q avfoundation || fail "ffmpeg 没有 avfoundation"

echo "-- 录音转换和听写"
say -o "$work/hello.aiff" "hello, this is yoyo"
# 和麦克风一样给 44.1 kHz 双声道浮点，走 yoyo 录音时同样的转换
afconvert -f WAVE -d LEF32@44100 -c 2 "$work/hello.aiff" "$work/in.wav"
"$lib/bin/ffmpeg" -hide_banner -loglevel error -y -i "$work/in.wav" -t 5 -ac 1 -ar 16000 "$work/out.wav" ||
  fail "ffmpeg 转不了 16 kHz 单声道"
model="$lib/models/ggml-tiny.bin"
transcribe() {
  "$lib/bin/whisper-cli" -m "$model" -f "$work/out.wav" -l en -nt -otxt -of "$work/out" --no-prints "$@"
}
if ! transcribe; then
  # runner 是虚拟机，可能没有 Metal；用户的 Mac 上有
  echo "whisper-cli 用 GPU 没跑成，换 CPU 再试"
  transcribe -ng || fail "whisper-cli 跑不了"
fi
[ -s "$work/out.txt" ] || fail "whisper-cli 没写出识别结果"
echo "听到：$(tr -d '\n' <"$work/out.txt")"

echo "-- 按键助手"
file "$lib/bin/yoyo-hotkey" | grep -q "Mach-O" || fail "按键助手不是 macOS 程序"

echo "-- yoyo 说一句（控制台舞台）"
export YOYO_HOME="$work/home"
mkdir -p "$YOYO_HOME"
printf '{"stage":"console","weather":{"enabled":false}}\n' >"$YOYO_HOME/config.json"
"$pkg/yoyo" once || fail "yoyo once 没跑成"
"$pkg/yoyo" log tail | grep -q . || fail "yoyo log tail 没有记录"
[ -s "$YOYO_HOME/models/ggml-tiny.bin" ] || fail "听写模型没放进数据目录"

echo "-- 桌宠"
export DSH_HOME="$work/dsh"
"$pkg/yoyo" pet --check || fail "桌宠自检没过"
"$pkg/yoyo" pet --port 3999 >"$work/pet.log" 2>&1 &
pet_pid=$!
for _ in $(seq 1 60); do
  if curl -fsS -m 2 http://127.0.0.1:3999/health >/dev/null 2>&1; then
    echo "桌宠开起来了"
    exit 0
  fi
  kill -0 "$pet_pid" 2>/dev/null || break
  sleep 1
done
cat "$work/pet.log" >&2
fail "桌宠没开起来"
