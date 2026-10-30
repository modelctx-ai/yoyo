#!/bin/bash
# 换上新的 yoyo.app：等旧的退出，把新的放到旧的位置，旧的删掉；旧的本来开着就重开。
# `yoyo update install` 把它复制到数据目录里再跑，不从要被换掉的 app 里跑。
#
#   swap.sh <旧 app> <新 app> <旧 app 的进程号，0 是没开着>
set -u

app="$1"
new="$2"
pid="$3"

if [ "$pid" != 0 ]; then
  # app 收好常驻进程和桌宠再退出，最多等一分钟
  for _ in $(seq 1 120); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "旧版一分钟还没退出，不换了" >&2
    exit 1
  fi
fi

old="$(dirname "$app")/.$(basename "$app").old"
rm -rf "$old"
if ! mv "$app" "$old"; then
  echo "挪不开 $app" >&2
  exit 1
fi
if mv "$new" "$app"; then
  rm -rf "$old"
  echo "换好了：$(cat "$app/Contents/Resources/lib/VERSION")"
else
  echo "放不进新版，换回旧的" >&2
  mv "$old" "$app"
fi
if [ "$pid" != 0 ]; then
  open "$app"
fi
