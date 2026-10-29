#!/bin/bash
# 在 macOS 上组装 yoyo 安装包：yoyo 和桌宠、Node、Electron、ffmpeg、whisper-cli、听写模型、按键助手都在里面，
# 解压、填好配置就能用。先冒烟测试，再压成 $OUT_DIR/yoyo-<版本>-macos-<架构>.zip。
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
stage="$OUT_DIR/$name"
downloads="$root/.cache/release-downloads"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
rm -rf "$stage" "$OUT_DIR/$name.zip"
mkdir -p "$stage/lib/bin" "$stage/lib/licenses" "$stage/lib/models" "$downloads"

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
cp -R "$root/dist/yoyo" "$stage/lib/yoyo"
cp "$here/yoyo" "$stage/yoyo"
chmod 755 "$stage/yoyo"
cp "$root/config.example.json" "$stage/config.example.json"
cp "$here/README.txt" "$stage/README.txt"
cp "$root/assets/NOTICE" "$stage/lib/licenses/yoyo-assets.txt"
echo "$VERSION" > "$stage/lib/VERSION"

echo "== 按键助手"
swiftc -O -target "$arch-apple-macos$MACOS_MIN" -o "$stage/lib/bin/yoyo-hotkey" "$root/src/adapters/platform/hotkey.swift"

echo "== whisper-cli、ffmpeg"
"$here/tools.sh" "$TOOLS_DIR"
cp "$TOOLS_DIR/bin/whisper-cli" "$TOOLS_DIR/bin/ffmpeg" "$stage/lib/bin/"
cp "$TOOLS_DIR/licenses/"* "$stage/lib/licenses/"

echo "== 听写模型"
fetch "$MODEL_URL" "$MODEL_SHA256" ggml-tiny.bin
cp "$downloads/ggml-tiny.bin" "$stage/lib/models/ggml-tiny.bin"

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
mkdir -p "$stage/lib/node"
cp -R "$node_dir/bin" "$node_dir/lib" "$stage/lib/node/"
cp "$node_dir/LICENSE" "$stage/lib/licenses/node.txt"
node_version="$("$stage/lib/node/bin/node" --version)"

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
mv "$pet" "$stage/lib/dsh-pet"
mv "$deps" "$stage/lib/dsh-pet/node_modules"
links="$(find "$stage/lib/dsh-pet" -type l)"
if [ -n "$links" ]; then
  echo "dsh-pet 里还有符号链接：" >&2
  echo "$links" >&2
  exit 1
fi
cp "$stage/lib/dsh-pet/LICENSE" "$stage/lib/licenses/dsh-pet.txt"
pet_version="$("$stage/lib/node/bin/node" -p "require('$stage/lib/dsh-pet/package.json').version")"

echo "== Electron"
# 和 dsh-pet 自己第一次运行时去下的版本一样
electron_version="$(sed -n 's/.*DSH_PET_ELECTRON_VERSION || "\([0-9][0-9.]*\)".*/\1/p' "$stage/lib/dsh-pet/lib/standalone.js" | head -n 1)"
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
mkdir -p "$stage/lib/electron"
ditto "$work/electron/Electron.app" "$stage/lib/electron/Electron.app"
cp "$work/electron/LICENSE" "$stage/lib/licenses/electron.txt"
cp "$work/electron/LICENSES.chromium.html" "$stage/lib/licenses/chromium.html"

commit_of() { git -C "$1" rev-parse HEAD 2>/dev/null || echo unknown; }
cat >"$stage/lib/VERSIONS.txt" <<EOF
yoyo      $VERSION ($(commit_of "$root"))
ctx       $(commit_of "$CTX_DIR")
dsh-pet   $pet_version (npm，打了 patches/dsh-pet@$pet_version.patch)
node      $node_version
electron  $electron_version
$(cat "$TOOLS_DIR/.stamp")
EOF

echo "== 冒烟测试"
"$here/smoke.sh" "$stage"

echo "== 压缩"
# ditto 保留 Electron.app 里的符号链接和可执行位
(cd "$OUT_DIR" && ditto -c -k --sequesterRsrc --keepParent "$name" "$name.zip")
(cd "$OUT_DIR" && shasum -a 256 "$name.zip" > "$name.zip.sha256")
du -sh "$OUT_DIR/$name.zip"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "name=$name"
    echo "zip=$OUT_DIR/$name.zip"
    echo "sha=$OUT_DIR/$name.zip.sha256"
  } >>"$GITHUB_OUTPUT"
fi
