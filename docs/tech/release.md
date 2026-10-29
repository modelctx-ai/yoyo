---
type: Guide
title: 发版
description: 推 v* tag 时在 GitHub Actions 里打 macOS 安装包：包里有什么、各部分从哪来、启动脚本做什么、冒烟测试查什么、为什么这样做。
resource: .github/workflows/release.yml
tags: [dev, release, ci]
status: proposed
sources:
  - id: workflow
    resource: .github/workflows/release.yml
    title: 发版流水线
  - id: package
    resource: scripts/release/package.sh
    title: 组装安装包
  - id: tools
    resource: scripts/release/tools.sh
    title: 编 whisper-cli 和 ffmpeg
  - id: smoke
    resource: scripts/release/smoke.sh
    title: 冒烟测试
  - id: launcher
    resource: scripts/release/yoyo
    title: 启动脚本
  - id: vite
    resource: vite.config.ts
    title: Vite+ 配置
  - id: paths
    resource: src/app/paths.ts
    title: 读写位置
  - id: pet
    resource: src/pet.ts
    title: 桌宠入口
  - id: release-pet
    resource: scripts/release/pet/package.json
    title: 发版用的桌宠包
---

# 形态

使用者下载一个压缩包，解压，在终端里运行 `./yoyo start`，填好 `~/.yoyo/config.json` 再运行一次就能用。机器上不用克隆仓库，也不用装 Node、pnpm、Homebrew、Xcode 命令行工具。使用者那边怎么装、怎么用，见[安装与运行](../product/getting-started.md#安装包)。

第一版只出 macOS、Apple 芯片：语音、听写、按键和桌宠都靠 macOS，别的系统只有控制台模式。不做 `.pkg`、`.dmg`，不签名、不公证。

```text
yoyo-<版本>-macos-arm64/
├── yoyo                    启动脚本，命令都从这里走
├── config.example.json
├── README.txt
└── lib/
    ├── yoyo/               yoyo 打成的 ESM：main.mjs（常驻）、cli.mjs（命令行）、pet.mjs（开桌宠），不依赖 node_modules
    ├── node/               官方 Node 22 运行时，带 npm、npx
    ├── dsh-pet/            桌宠：npm 上的 dsh-pet（打过 yoyo 的补丁）和它的运行依赖
    ├── electron/           桌宠窗口用的 Electron.app
    ├── bin/                ffmpeg、whisper-cli、yoyo-hotkey
    ├── models/             听写模型 ggml-tiny.bin
    ├── licenses/           各部分的许可
    ├── VERSION
    └── VERSIONS.txt        这一包里每一部分的版本和提交
```

# 怎么发

1. 改 `package.json` 的 `version`，合进 `main`。
2. 在那个提交上打 `v<version>` 的 tag 并推上去。tag 和 `version` 对不上，流水线第一步就停。
3. 流水线打包、冒烟测试，再挂到这个 tag 的 Release；Release 还没有就建一个，说明由 GitHub 按提交生成，之后可以在网页上改。重跑会覆盖同名的包。

想先试一下，在 Actions 页手动跑 Release：版本号带上 `-dev.<短提交>`，只上传成构建产物（留 7 天），不碰 Release。手动跑可以指定 ctx 用哪个分支、tag 或提交；dsh-pet 跟着 yoyo 的锁文件，不用指定。[^workflow]

# 流水线

一个 job，跑在 `macos-15`（Apple 芯片）上：

1. 检出 yoyo；ctx 检出在旁边（和 CI 一样，`overrides` 的 `link:../ctx/packages/*` 才找得到），缺省取 `main`。dsh-pet 不检出，跟着 yoyo 的锁文件从 npm 装。
2. 构建 ctx，装 yoyo 的依赖，跑测试。
3. `scripts/release/package.sh` 组装、冒烟测试、压缩。
4. 上传构建产物；推 tag 时挂到 Release，连同 `.sha256`。

whisper-cli 和 ffmpeg 编一次要几分钟，按 `tools.sh` 的内容缓存：改了版本或参数，缓存自然失效。[^workflow]

# 各部分

| 部分        | 从哪来                                                                                                                                                                           | 版本                                                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| yoyo        | `pnpm pack:app`（`vp pack`）把三个入口连同 ctx、zod、AI SDK 打进 `dist/yoyo/`                                                                                                    | 这个 tag                                                         |
| Node        | nodejs.org 的 `latest-v22.x`，按 `SHASUMS256.txt` 校验，二进制原样放进去                                                                                                         | 打包当天最新的 22.x                                              |
| dsh-pet     | npm 上上游发的包，装时打上 yoyo 的补丁：`pnpm deploy` 只为发版存在的工作区包 `scripts/release/pet`，按锁文件平铺成真目录；去掉跟进来的 ctx 链接和 `.bin`，查补丁在、没有符号链接 | `package.json` 钉的版本                                          |
| Electron    | GitHub 上 Electron 的发布，按同一发布的 `SHASUMS256.txt` 校验                                                                                                                    | dsh-pet 第一次运行时缺省下载的版本（`lib/standalone.js` 里写的） |
| whisper-cli | 源码编译：静态链接，Metal 着色器内嵌，不用 OpenMP，不按本机 CPU 优化                                                                                                             | `tools.sh` 固定                                                  |
| ffmpeg      | 源码编译最小版：只开 avfoundation 输入、wav 读写、PCM 编解码和重采样，关掉自动探测；LGPL，不带 GPL 组件                                                                          | `tools.sh` 固定，按 sha256 校验                                  |
| 按键助手    | `swiftc` 编 `src/adapters/platform/hotkey.swift`                                                                                                                                 | 这个 tag                                                         |
| 听写模型    | Hugging Face 上 whisper.cpp 的 `ggml-tiny.bin`，按 sha256 校验                                                                                                                   | `package.sh` 固定                                                |

[^package] [^tools] [^vite] [^release-pet]

# 启动脚本

`./yoyo` 是一个 bash 脚本（macOS 自带的 3.2 就能跑）。它先设好这些，再把命令交给 Node：[^launcher]

| 设什么                  | 值                                                   | 为什么                                                                                    |
| ----------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `YOYO_CONFIG`           | `$YOYO_HOME/config.json`，缺省 `~/.yoyo/config.json` | 配置放在数据目录，换新版本替换整个程序目录也不丢                                          |
| `YOYO_HOTKEY`           | `lib/bin/yoyo-hotkey`                                | 用包里编好的按键助手，使用者不用装 Xcode 命令行工具                                       |
| `DSH_PET_ELECTRON_PATH` | `lib/electron/Electron.app/…/Electron`               | 桌宠用包里的 Electron，不再第一次运行时去下载                                             |
| `YOYO_PET_ENTRY`        | `lib/dsh-pet/lib/standalone.js`                      | 桌宠经 `lib/yoyo/pet.mjs` 开：先按 `pet.menu` 设好右键菜单，再加载包里的 dsh-pet          |
| `PATH`                  | 前面加上 `lib/node/bin`、`lib/bin`                   | 录音、听写找到包里的 ffmpeg、whisper-cli；MCP 服务器和搜索脚本的 `node`、`npx` 也用包里的 |

* `start`：配置不存在就从示例复制过去，提示填好再来，然后退出。听写模型数据目录里没有就从包里复制。桌宠没在跑（看 `~/.dsh/dsh-pet/standalone-runtime.json` 里的进程还在不在）就在后台开一个，输出写到 `$YOYO_HOME/pet.log`，最多等 30 秒到它写好运行状态。然后常驻进程放在后台、脚本等着：收到 INT、TERM、HUP 都转给常驻进程，常驻进程收尾退出以后，再给自己开的桌宠发 TERM。别人开的桌宠不动。
* `once`、`bake`：同样先查配置、放模型，再跑常驻进程的 `--once`、`--bake`。
* `pet`：前台跑桌宠，参数原样交过去（`--check`、`--port`）。
* 桌宠都经 `lib/yoyo/pet.mjs` 开，右键菜单怎么排见[架构](architecture.md#怎么用-dsh-pet)。[^pet]
* 别的都交给命令行；不带参数先打一段启动脚本自己的用法，再打命令行的领域列表。
* 浏览器下载、再解压出来的文件带 `com.apple.quarantine`。包里自己编的程序没公证，第一次运行会被系统拦下。脚本发现 Node 带着这个属性，就把整个包目录的清掉。只清自己这个目录。

yoyo 这边为安装包改的：`YOYO_HOTKEY` 给了编好的按键助手就直接用，不再编译；`YOYO_PET_ENTRY` 指出 dsh-pet 的入口，不给就用依赖里的。[^paths] [^pet]

# 冒烟测试

组装完、压缩前，在 runner 上对包目录跑 `smoke.sh`，任何一项不过就不发：[^smoke]

* `lib/bin` 里的程序和 Node 只链 `/usr/lib`、`/System/Library` 下的库，没有链进 runner 上 Homebrew 的东西。
* Node 版本够，`node:sqlite` 能加载。
* ffmpeg 列得出 avfoundation 设备。
* 用 `say` 生成一段话，`afconvert` 转成 44.1 kHz 双声道浮点（和麦克风给的一样），ffmpeg 按 yoyo 录音的参数转成 16 kHz 单声道，whisper-cli 认出文字。GPU 跑不成（runner 是虚拟机）就换 CPU 再试。
* 按键助手是 macOS 程序（要辅助功能权限，跑不了）。
* `./yoyo once` 在控制台舞台说一句，`./yoyo log tail` 有记录，模型复制进了数据目录。
* `./yoyo pet --check` 通过；`./yoyo pet` 开起来，`/health` 有回应。

另外每次推送和 PR 的 CI 也跑一次 `pnpm pack:app`，把产物拷到仓库外的临时目录说一句、读一次记录：哪天加了打不进单文件的依赖，PR 上就会红，不用等到发版。它还按锁文件 deploy 一份打过补丁的 dsh-pet，经打出来的 `pet.mjs` 开到帮助为止：补丁打不上、桌宠入口找不到，也在 PR 上就红。

# 为什么这样

* **yoyo 打成单文件，只在发版时。** 平时照旧直接跑 `.ts`，不构建。安装包里不放 `node_modules`：`overrides` 的 `link:` 指到包外，拷不走；Node 不对 `node_modules` 里的 `.ts` 做类型剥离，而 `@yoyo/dsh-pet` 导出的就是 `src/index.ts`。打成单文件和 ctx 发没发到 npm 无关。`paths.ts` 按 `import.meta.url` 往上两级找根目录，产物因此放在两层目录里（`dist/yoyo/`、`lib/yoyo/`）。[^vite] [^paths]
* **Node 二进制原样放。** 不做成单文件可执行（SEA）：改二进制会让官方签名失效。
* **桌宠从 npm 装，补丁随 yoyo 走。** 我们 fork 的 dsh-pet 只用来跟上游，不在上面改；npm 上的包是上游发的，版本钉死，补丁打不上时安装就失败，不会悄悄发出没打补丁的包。开发时和安装包里是同一份。
* **桌宠用独立模式，不用 dsh-pet 的 Electron 应用。** yoyo 按 `pet.baseUrl` 连 3080 端口，从运行状态文件里拿令牌；dsh-pet 的应用模式监听随机端口，也不写那个文件。
* **ffmpeg 自己编最小的。** 现成的静态版大多带 GPL 组件、体积大；只录音用不着那些。关掉自动探测，免得链进 runner 上 Homebrew 的库。
* **不签名、不公证，启动脚本清隔离属性。** 签名要 Apple 开发者账号和放在 CI 里的证书。等做 `.pkg` 或 `.dmg` 时再加。

# 还没做

* Intel Mac：流水线里加一个 `macos-15-intel` 的矩阵就行，ffmpeg 已经关了 x86 汇编。
* 签名、公证、`.dmg`。
* ctx 固定到 tag：现在还没有可用的 tag，先取 `main`，实际用的提交写进 `VERSIONS.txt`。
* 单文件里打进去的 npm 依赖（AI SDK、zod 等）还没有单独列许可。

[^workflow]: 发版流水线
[^package]: 组装安装包
[^tools]: 编 whisper-cli 和 ffmpeg
[^smoke]: 冒烟测试
[^launcher]: 启动脚本
[^vite]: Vite+ 配置
[^paths]: 读写位置
[^pet]: 桌宠入口
[^release-pet]: 发版用的桌宠包
