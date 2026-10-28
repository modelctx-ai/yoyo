#!/bin/bash
# 在 macOS 上编出安装包里带的两个原生程序，放到 $1（缺省 .cache/release-tools）：
#   bin/whisper-cli  whisper.cpp 的听写命令行，静态链接，Metal 着色器内嵌
#   bin/ffmpeg       只够录音的最小 ffmpeg：avfoundation 输入、转 16 kHz 单声道、写 wav，LGPL，不带 GPL 组件
# 和 licenses/ 里两者的许可。版本或参数变了就改下面的变量，CI 按这个文件的哈希缓存产物。
set -euo pipefail

WHISPER_REF=v1.9.5
FFMPEG_VERSION=8.1.3
FFMPEG_SHA256=7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3
MACOS_MIN=12.0

out="$(mkdir -p "${1:-.cache/release-tools}" && cd "${1:-.cache/release-tools}" && pwd)"
stamp="$out/.stamp"
want="whisper=$WHISPER_REF ffmpeg=$FFMPEG_VERSION macos=$MACOS_MIN arch=$(uname -m)"
if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$want" ] && [ -x "$out/bin/whisper-cli" ] && [ -x "$out/bin/ffmpeg" ]; then
  echo "原生程序已经编好：$want"
  exit 0
fi

if [ "$(uname -s)" != Darwin ]; then
  echo "原生程序要在 macOS 上编" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
jobs="$(sysctl -n hw.ncpu)"
rm -rf "$out/bin" "$out/licenses"
mkdir -p "$out/bin" "$out/licenses"

echo "== whisper.cpp $WHISPER_REF"
git clone --quiet --depth 1 --branch "$WHISPER_REF" https://github.com/ggml-org/whisper.cpp "$work/whisper.cpp"
# 静态链接；不用 OpenMP（runner 上 Homebrew 的 libomp 会被链进来，用户机器上没有）；不按本机 CPU 优化
cmake -S "$work/whisper.cpp" -B "$work/whisper-build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_DEPLOYMENT_TARGET="$MACOS_MIN" \
  -DBUILD_SHARED_LIBS=OFF \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_SERVER=OFF \
  -DWHISPER_BUILD_EXAMPLES=ON \
  -DWHISPER_CURL=OFF \
  -DWHISPER_SDL2=OFF \
  -DGGML_NATIVE=OFF \
  -DGGML_OPENMP=OFF \
  -DGGML_METAL=ON \
  -DGGML_METAL_EMBED_LIBRARY=ON
cmake --build "$work/whisper-build" --config Release --target whisper-cli -j "$jobs"
cp "$work/whisper-build/bin/whisper-cli" "$out/bin/whisper-cli"
cp "$work/whisper.cpp/LICENSE" "$out/licenses/whisper.cpp.txt"

echo "== ffmpeg $FFMPEG_VERSION"
curl -fsSL -o "$work/ffmpeg.tar.xz" "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"
echo "$FFMPEG_SHA256  $work/ffmpeg.tar.xz" | shasum -a 256 -c -
tar -xf "$work/ffmpeg.tar.xz" -C "$work"
# 关掉全部组件和自动探测（免得链进 runner 上 Homebrew 的库），只打开录音用到的：
# avfoundation 输入，wav 读写（读只给冒烟测试用），各种 PCM 解码，16 位 PCM 编码，重采样。
# ffmpeg 命令行自己会带上 aformat、anull、atrim。
(
  cd "$work/ffmpeg-$FFMPEG_VERSION"
  ./configure \
    --prefix="$work/ffmpeg-out" \
    --disable-everything \
    --disable-autodetect \
    --enable-avfoundation \
    --disable-doc \
    --disable-debug \
    --disable-ffplay \
    --disable-ffprobe \
    --disable-network \
    --disable-x86asm \
    --enable-indev=avfoundation \
    --enable-protocol=file \
    --enable-demuxer=wav \
    --enable-muxer=wav \
    --enable-decoder=pcm_f32le,pcm_f32be,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be \
    --enable-encoder=pcm_s16le \
    --enable-filter=aresample \
    --extra-cflags="-mmacosx-version-min=$MACOS_MIN" \
    --extra-ldflags="-mmacosx-version-min=$MACOS_MIN"
  make -j "$jobs" ffmpeg
  cp ffmpeg "$out/bin/ffmpeg"
  cp COPYING.LGPLv2.1 "$out/licenses/ffmpeg-LGPL-2.1.txt"
  {
    echo "ffmpeg $FFMPEG_VERSION，LGPL 2.1，未修改。源码：https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"
    echo "构建脚本：scripts/release/tools.sh（https://github.com/modelctx-ai/yoyo）"
  } > "$out/licenses/ffmpeg.txt"
)

strip "$out/bin/whisper-cli" "$out/bin/ffmpeg"
# strip 以后重新做一次临时签名：Apple 芯片上没签名的程序不让跑
codesign --force --sign - "$out/bin/whisper-cli" "$out/bin/ffmpeg"
echo "$want" > "$stamp"
echo "原生程序编好了：$out/bin"
