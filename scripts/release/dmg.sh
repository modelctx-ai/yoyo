#!/bin/bash
# 把 $1（里面是 yoyo.app 和指向「应用程序」的链接）做成 $3 这个只读压缩的 dmg，卷名 $2。
# 先尽量摆好窗口：背景图、窗口大小、yoyo.app 和「应用程序」的位置。做法是建可读写镜像、挂上、
# 用 AppleScript 让访达摆位置和设背景（访达把它们记在卷里的 .DS_Store 里），再转成只读压缩。
# 访达要登录会话才能用，CI 里偶尔没有、或者不让脚本控制它：那样布局做不成，就退回不带布局的 dmg，
# 打一行警告，不让发版失败。DMG_LAYOUT=0 直接跳过布局（本机上图省事）。
#
#   dmg.sh <放 yoyo.app 的目录> <卷名> <输出的 .dmg>
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
stage="$(cd "$1" && pwd)"
volname="$2"
out="$3"

# 窗口内容区 660x400，和 dmg/make-background.py 画的背景对得上。
# 窗口的高度要加上标题栏：不同系统版本标题栏不一样高，多留一点，背景图下半截是渐变到白色的，多出来的几个像素看不出来
WIDTH=660
HEIGHT=400
TITLEBAR=28
WINDOW_LEFT=200
WINDOW_TOP=120
APP_POSITION="170, 185"
APPLICATIONS_POSITION="490, 185"
ICON_SIZE=128

work="$(mktemp -d)"
device=""
mount=""
cleanup() {
  detach
  rm -rf "$work"
}
trap cleanup EXIT

# 卸载挂着的可读写镜像：runner 上偶尔报资源忙，重试几次，最后强制
detach() {
  [ -n "$device" ] || return 0
  local attempt
  for attempt in 1 2 3; do
    if hdiutil detach "$device" >/dev/null 2>&1; then
      device=""
      return 0
    fi
    sleep 3
  done
  hdiutil detach "$device" -force >/dev/null 2>&1 || true
  device=""
}

# 命令超过 $1 秒还没结束就杀掉：访达没有登录会话、或者在等一个没人点的授权框时，osascript 会一直等
run_with_timeout() {
  local seconds="$1"
  shift
  "$@" &
  local pid=$!
  (sleep "$seconds" && kill "$pid" 2>/dev/null) >/dev/null 2>&1 &
  local watcher=$!
  local status=0
  wait "$pid" || status=$?
  kill "$watcher" 2>/dev/null || true
  wait "$watcher" 2>/dev/null || true
  return "$status"
}

# 普通的只读压缩 dmg：没有窗口布局。runner 上 hdiutil 偶尔报资源忙，重试几次
plain_dmg() {
  rm -rf "$stage/.background"
  rm -f "$out"
  local attempt
  for attempt in 1 2 3; do
    if hdiutil create -volname "$volname" -srcfolder "$stage" -fs HFS+ -format UDZO -imagekey zlib-level=9 -ov "$out"; then
      return 0
    fi
    [ "$attempt" = 3 ] && return 1
    sleep 5
  done
}

fallback() {
  echo "::warning::dmg 窗口布局没做成，退回不带布局的 dmg：$1"
  echo "dmg 窗口布局：没做（$1）"
  detach
  plain_dmg
}

# 摆好窗口：成功返回 0；不行就把原因放进 $reason，返回 1。不能放在 $(...) 里调用：设备和挂载点要留给外面卸载
reason=""
layout() {
  if [ "${DMG_LAYOUT:-1}" = 0 ]; then
    reason="DMG_LAYOUT=0"
    return 1
  fi
  if ! command -v osascript >/dev/null; then
    reason="没有 osascript"
    return 1
  fi

  # 背景图：有 tiffutil 就把 1x、2x 并成一张，视网膜屏上不糊；没有就用 1x
  mkdir -p "$stage/.background" || { reason="建不了 .background"; return 1; }
  local background=background.png
  if tiffutil -cathidpicheck "$here/dmg/background.png" "$here/dmg/background@2x.png" -out "$stage/.background/background.tiff" >/dev/null 2>&1; then
    background=background.tiff
  else
    cp "$here/dmg/background.png" "$stage/.background/background.png" || { reason="拷不了背景图"; return 1; }
  fi

  local size_mb
  size_mb="$(( $(du -sm "$stage" | cut -f1) + 64 ))"
  local rw="$work/rw.dmg"
  if ! hdiutil create -volname "$volname" -srcfolder "$stage" -fs HFS+ -format UDRW -size "${size_mb}m" -ov "$rw" >/dev/null; then
    reason="建不了可读写镜像"
    return 1
  fi
  mount="/Volumes/$volname"
  # 不能用 -nobrowse：访达要看得到这个卷才能摆它
  local attached
  if ! attached="$(hdiutil attach "$rw" -readwrite -noverify -noautoopen -mountpoint "$mount")"; then
    reason="挂不上可读写镜像"
    return 1
  fi
  device="$(echo "$attached" | awk '/^\/dev\// {print $1; exit}')"
  if [ -z "$device" ]; then
    reason="不知道挂在哪个设备上"
    return 1
  fi

  local script="$work/layout.applescript"
  cat >"$script" <<APPLESCRIPT
on run argv
  set volumeName to item 1 of argv
  tell application "Finder"
    tell disk volumeName
      open
      set current view of container window to icon view
      set toolbar visible of container window to false
      set statusbar visible of container window to false
      set the bounds of container window to {$WINDOW_LEFT, $WINDOW_TOP, $WINDOW_LEFT + $WIDTH, $WINDOW_TOP + $HEIGHT + $TITLEBAR}
      set viewOptions to the icon view options of container window
      set arrangement of viewOptions to not arranged
      set icon size of viewOptions to $ICON_SIZE
      set text size of viewOptions to 13
      set background picture of viewOptions to file ".background:$background"
      set position of item "yoyo.app" of container window to {$APP_POSITION}
      set position of item "Applications" of container window to {$APPLICATIONS_POSITION}
      update without registering applications
      delay 2
      close
    end tell
  end tell
end run
APPLESCRIPT
  if ! run_with_timeout 90 osascript "$script" "$volname" >"$work/osascript.log" 2>&1; then
    reason="访达不听话：$(tr '\n' ' ' <"$work/osascript.log" | cut -c1-200)"
    return 1
  fi

  # 访达把布局写进卷里的 .DS_Store；等它落盘
  local _
  for _ in $(seq 1 20); do
    [ -s "$mount/.DS_Store" ] && break
    sleep 1
  done
  if [ ! -s "$mount/.DS_Store" ]; then
    reason="访达没有留下 .DS_Store"
    return 1
  fi
  sync
  chmod -Rf go-w "$mount" 2>/dev/null || true
  return 0
}

if layout; then
  detach
  rm -f "$out"
  attempt=1
  while ! hdiutil convert "$work/rw.dmg" -format UDZO -imagekey zlib-level=9 -ov -o "$out" >/dev/null; do
    if [ "$attempt" = 3 ]; then
      fallback "转成只读压缩的 dmg 没成功"
      exit 0
    fi
    attempt=$((attempt + 1))
    sleep 5
  done
  rm -rf "$stage/.background"
  echo "dmg 窗口布局：做好了"
else
  fallback "${reason:-不知道为什么}"
fi
