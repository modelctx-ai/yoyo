#!/bin/bash
# 在 macOS 上组装 yoyo.app：yoyo 和桌宠、Node、Electron、ffmpeg、whisper-cli、听写模型、按键助手都在里面，
# 拖进「应用程序」、填好配置就能用。先冒烟测试，再做成拖动安装的 $OUT_DIR/yoyo-<版本>-macos-<架构>.dmg。
# app 内更新（yoyo update）下载的就是这个 dmg，名字改了要连带改 src/app/update.ts。
#
# 桌宠是 npm 上上游发的 dsh-pet，版本和右键菜单的补丁跟 yoyo 的锁文件走（patches/、pnpm-workspace.yaml），不检出它的仓库。
#
# 环境变量：
#   CTX_DIR      ctx 仓库的检出，要已经构建过；缺省 yoyo 旁边的 ../ctx。只用来记版本
#   VERSION      缺省 package.json 的 version
#   OUT_DIR      缺省 dist/release
#   TOOLS_DIR    tools.sh 的产物目录，缺省 .cache/release-tools
# 跑之前 yoyo 要已经 `pnpm install`（ctx 链在旁边、构建过）。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
CTX_DIR="${CTX_DIR:-$root/../ctx}"
VERSION="${VERSION:-$(node -p "require('$root/package.json').version")}"
OUT_DIR="$(mkdir -p "${OUT_DIR:-$root/dist/release}" && cd "${OUT_DIR:-$root/dist/release}" && pwd)"
TOOLS_DIR="${TOOLS_DIR:-$root/.cache/release-tools}"

NODE_MAJOR=22
MACOS_MIN=12.0
MODEL_URL=https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin
MODEL_SHA256=be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21

if [ "$(uname -s)" != Darwin ]; then
  echo "安装包要在 macOS 上组装" >&2
  exit 1
fi
arch="$(uname -m)"
case "$arch" in
  arm64) dist_arch=arm64 ;;
  x86_64) dist_arch=x64 ;;
  *) echo "不认识的架构：$arch" >&2; exit 1 ;;
esac

name="yoyo-$VERSION-macos-$arch"
# dmg 里放的东西：yoyo.app 和指向「应用程序」的链接
stage="$OUT_DIR/$name"
app="$stage/yoyo.app"
res="$app/Contents/Resources"
downloads="$root/.cache/release-downloads"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
rm -rf "$stage" "$OUT_DIR/$name.dmg"
mkdir -p "$app/Contents/MacOS" "$res/lib/bin" "$res/lib/licenses" "$res/lib/models" "$downloads"

# 下载到缓存 $downloads/<名字> 并校验 sha256；缓存里已有且校验得上就不再下。
# 不要放进 $(...) 里调用：macOS 的 bash 3.2 在命令替换里不继承 set -e，校验失败也不会停。
fetch() {
  local url="$1" sha="$2" file="$downloads/$3"
  if [ -f "$file" ] && echo "$sha  $file" | shasum -a 256 -c - >/dev/null 2>&1; then
    return 0
  fi
  curl -fsSL --retry 3 -o "$file.part" "$url"
  mv "$file.part" "$file"
  echo "$sha  $file" | shasum -a 256 -c -
}

echo "== yoyo $VERSION"
(cd "$root" && pnpm pack:app)
cp -R "$root/dist/yoyo" "$res/lib/yoyo"
cp "$here/yoyo" "$res/yoyo"
cp "$here/swap.sh" "$res/lib/swap.sh"
chmod 755 "$res/yoyo" "$res/lib/swap.sh"
cp "$root/config.example.json" "$res/config.example.json"
cp "$root/assets/NOTICE" "$res/lib/licenses/yoyo-assets.txt"
echo "$VERSION" > "$res/lib/VERSION"

echo "== app 外壳"
swiftc -O -target "$arch-apple-macos$MACOS_MIN" -o "$app/Contents/MacOS/yoyo" "$here/app/main.swift"
iconset="$work/yoyo.iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$root/assets/icon.png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  if [ $((size * 2)) -le 512 ]; then
    sips -z $((size * 2)) $((size * 2)) "$root/assets/icon.png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
  fi
done
iconutil -c icns "$iconset" -o "$res/yoyo.icns"
# CFBundleShortVersionString 只能是数字，-dev.<提交> 放在 CFBundleVersion 里
cat >"$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>yoyo</string>
  <key>CFBundleDisplayName</key><string>yoyo</string>
  <key>CFBundleIdentifier</key><string>ai.modelctx.yoyo</string>
  <key>CFBundleExecutable</key><string>yoyo</string>
  <key>CFBundleIconFile</key><string>yoyo</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleShortVersionString</key><string>${VERSION%%-*}</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>$MACOS_MIN</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>https://github.com/modelctx-ai/yoyo</string>
  <key>NSMicrophoneUsageDescription</key><string>yoyo 说完一句后听你回应，按 Control+Option+Y 时听你说话。</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
EOF
plutil -lint "$app/Contents/Info.plist"
printf 'APPL????' >"$app/Contents/PkgInfo"

echo "== 按键助手"
swiftc -O -target "$arch-apple-macos$MACOS_MIN" -o "$res/lib/bin/yoyo-hotkey" "$root/src/adapters/platform/hotkey.swift"

echo "== whisper-cli、ffmpeg"
"$here/tools.sh" "$TOOLS_DIR"
cp "$TOOLS_DIR/bin/whisper-cli" "$TOOLS_DIR/bin/ffmpeg" "$res/lib/bin/"
cp "$TOOLS_DIR/licenses/"* "$res/lib/licenses/"

echo "== 听写模型"
fetch "$MODEL_URL" "$MODEL_SHA256" ggml-tiny.bin
cp "$downloads/ggml-tiny.bin" "$res/lib/models/ggml-tiny.bin"

echo "== Node $NODE_MAJOR"
node_base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
curl -fsSL --retry 3 -o "$work/node-shasums.txt" "$node_base/SHASUMS256.txt"
node_line="$(grep " node-v[0-9.]*-darwin-$dist_arch.tar.gz\$" "$work/node-shasums.txt")" || {
  echo "Node $NODE_MAJOR 的 SHASUMS256.txt 里没有 darwin-$dist_arch 的包" >&2
  exit 1
}
node_file="$(echo "$node_line" | awk '{print $2}')"
fetch "$node_base/$node_file" "$(echo "$node_line" | awk '{print $1}')" "$node_file"
tar -xzf "$downloads/$node_file" -C "$work"
node_dir="$work/${node_file%.tar.gz}"
# 只要运行时和 npm、npx（MCP 服务器常用 npx 启动），不要头文件和手册
mkdir -p "$res/lib/node"
cp -R "$node_dir/bin" "$node_dir/lib" "$res/lib/node/"
cp "$node_dir/LICENSE" "$res/lib/licenses/node.txt"
node_version="$("$res/lib/node/bin/node" --version)"

echo "== dsh-pet"
# 按锁文件 deploy 出一份平铺的真目录，安装时已经打上补丁：桌宠本体放 lib/dsh-pet，运行依赖放 lib/dsh-pet/node_modules
(cd "$root" && pnpm --filter @yoyo/pet-release deploy --prod --legacy --config.node-linker=hoisted "$work/pet")
deps="$work/pet/node_modules"
# overrides 里 link: 到 ctx 的几个包、工作区里的 @yoyo/* 也会跟着进来，桌宠用不着；.bin 里是指来指去的链接
rm -rf "$deps/@modelctx-ai" "$deps/@yoyo"
find "$deps" -name .bin -type d -prune -exec rm -rf {} +
pet="$deps/dsh-pet"
grep -q yoyoArrangeMenu "$pet/runtime/electron-helper/sprite.js" || {
  echo "dsh-pet 没打上 yoyo 的补丁" >&2
  exit 1
}
if [ -d "$pet/node_modules" ]; then
  rmdir "$pet/node_modules" || {
    echo "dsh-pet 有嵌在自己目录里的依赖，这里要跟着改" >&2
    exit 1
  }
fi
mv "$pet" "$res/lib/dsh-pet"
mv "$deps" "$res/lib/dsh-pet/node_modules"
links="$(find "$res/lib/dsh-pet" -type l)"
if [ -n "$links" ]; then
  echo "dsh-pet 里还有符号链接：" >&2
  echo "$links" >&2
  exit 1
fi
cp "$res/lib/dsh-pet/LICENSE" "$res/lib/licenses/dsh-pet.txt"
pet_version="$("$res/lib/node/bin/node" -p "require('$res/lib/dsh-pet/package.json').version")"

echo "== Electron"
# 和 dsh-pet 自己第一次运行时去下的版本一样
electron_version="$(sed -n 's/.*DSH_PET_ELECTRON_VERSION || "\([0-9][0-9.]*\)".*/\1/p' "$res/lib/dsh-pet/lib/standalone.js" | head -n 1)"
if [ -z "$electron_version" ]; then
  echo "dsh-pet 的 lib/standalone.js 里没找到缺省的 Electron 版本" >&2
  exit 1
fi
electron_base="https://github.com/electron/electron/releases/download/v$electron_version"
electron_file="electron-v$electron_version-darwin-$dist_arch.zip"
curl -fsSL --retry 3 -o "$work/electron-shasums.txt" "$electron_base/SHASUMS256.txt"
electron_sha="$(grep " \*$electron_file\$" "$work/electron-shasums.txt" | awk '{print $1}')"
if [ -z "$electron_sha" ]; then
  echo "Electron 的 SHASUMS256.txt 里没有 $electron_file" >&2
  exit 1
fi
fetch "$electron_base/$electron_file" "$electron_sha" "$electron_file"
ditto -x -k "$downloads/$electron_file" "$work/electron"
mkdir -p "$res/lib/electron"
ditto "$work/electron/Electron.app" "$res/lib/electron/Electron.app"
cp "$work/electron/LICENSE" "$res/lib/licenses/electron.txt"
cp "$work/electron/LICENSES.chromium.html" "$res/lib/licenses/chromium.html"

commit_of() { git -C "$1" rev-parse HEAD 2>/dev/null || echo unknown; }
cat >"$res/lib/VERSIONS.txt" <<EOF
yoyo      $VERSION ($(commit_of "$root"))
ctx       $(commit_of "$CTX_DIR")
dsh-pet   $pet_version (npm，打了 patches/dsh-pet@$pet_version.patch)
node      $node_version
electron  $electron_version
$(cat "$TOOLS_DIR/.stamp")
EOF

echo "== 签名"
# 没有开发者证书，签个临时签名：Apple 芯片上的程序都要签名，系统也靠它认出 app 被改过没有
codesign --force --sign - --timestamp=none "$app"

echo "== 冒烟测试"
"$here/smoke.sh" "$app"
# 跑完冒烟测试 app 里不能多出东西：多了签名就对不上，更新时也验不过
codesign --verify --verbose "$app"

echo "== dmg"
ln -s /Applications "$stage/Applications"
dmg="$OUT_DIR/$name.dmg"
# runner 上 hdiutil 偶尔报资源忙，重试几次
for attempt in 1 2 3; do
  if hdiutil create -volname "yoyo $VERSION" -srcfolder "$stage" -fs HFS+ -format UDZO -imagekey zlib-level=9 -ov "$dmg"; then
    break
  fi
  [ "$attempt" = 3 ] && exit 1
  sleep 5
done
# 和 app 内更新一样挂上、看版本和签名
mount="$work/mount"
mkdir -p "$mount"
hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mount" "$dmg" >/dev/null
dmg_version="$(cat "$mount/yoyo.app/Contents/Resources/lib/VERSION")"
codesign --verify "$mount/yoyo.app"
hdiutil detach "$mount" >/dev/null
[ "$dmg_version" = "$VERSION" ] || {
  echo "dmg 里的版本是 $dmg_version，不是 $VERSION" >&2
  exit 1
}
(cd "$OUT_DIR" && shasum -a 256 "$name.dmg" > "$name.dmg.sha256")
du -sh "$dmg"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "name=$name"
    echo "dmg=$dmg"
    echo "sha=$dmg.sha256"
  } >>"$GITHUB_OUTPUT"
fi
