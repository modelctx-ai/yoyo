#!/bin/bash
# 在 macOS 上组装 yoyo 安装包：yoyo 和桌宠、Node、Electron、ffmpeg、whisper-cli、听写模型、按键助手都在里面，
# 解压、填好配置就能用。先冒烟测试，再压成 $OUT_DIR/yoyo-<版本>-macos-<架构>.zip。
#
# 环境变量：
#   DSH_PET_DIR  dsh-pet 仓库的检出（必填）
#   CTX_DIR      ctx 仓库的检出，要已经构建过；缺省 yoyo 旁边的 ../ctx。只用来记版本
#   VERSION      缺省 package.json 的 version
#   OUT_DIR      缺省 dist/release
#   TOOLS_DIR    tools.sh 的产物目录，缺省 .cache/release-tools
# 跑之前 yoyo 要已经 `pnpm install`（ctx 链在旁边、构建过）。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
: "${DSH_PET_DIR:?要给 DSH_PET_DIR：dsh-pet 仓库的检出}"
DSH_PET_DIR="$(cd "$DSH_PET_DIR" && pwd)"
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
pet="$DSH_PET_DIR/dsh-pet"
pnpm12=(npx --yes pnpm@12)
(
  cd "$pet"
  "${pnpm12[@]}" install --frozen-lockfile
  "${pnpm12[@]}" run bundle
  "${pnpm12[@]}" run build:desktop-core
)
# 只装运行依赖，平铺成真目录（不留指到包外的符号链接）
mkdir -p "$work/pet-deps"
cp "$pet/package.json" "$pet/pnpm-lock.yaml" "$pet/pnpm-workspace.yaml" "$work/pet-deps/"
(cd "$work/pet-deps" && "${pnpm12[@]}" install --prod --frozen-lockfile --ignore-scripts --config.node-linker=hoisted)
# 和 npm 上的 dsh-pet 包一样，带 package.json 的 files 里列的那些
mkdir -p "$stage/lib/dsh-pet"
cp "$pet/package.json" "$stage/lib/dsh-pet/"
"$stage/lib/node/bin/node" -e 'for (const f of require(process.argv[1]).files) console.log(f)' "$pet/package.json" |
  while IFS= read -r entry; do
    if [ -e "$pet/$entry" ]; then
      ditto "$pet/$entry" "$stage/lib/dsh-pet/$entry"
    else
      echo "dsh-pet 的 files 里有 $entry，但没找到，跳过"
    fi
  done
cp -R "$work/pet-deps/node_modules" "$stage/lib/dsh-pet/node_modules"
cp "$pet/LICENSE" "$stage/lib/licenses/dsh-pet.txt"
pet_version="$("$stage/lib/node/bin/node" -p "require('$pet/package.json').version")"

echo "== Electron"
electron_version="$(sed -n 's/^electronVersion:[[:space:]]*//p' "$pet/electron-builder.yml" | tr -d "\"' ")"
if [ -z "$electron_version" ]; then
  echo "dsh-pet 的 electron-builder.yml 里没找到 electronVersion" >&2
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
dsh-pet   $pet_version ($(commit_of "$DSH_PET_DIR"))
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
