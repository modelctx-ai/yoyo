---
type: Guide
title: 开发
description: 本地开发的工具链、脚本、和 ctx 联调的方式，以及 CI 跑什么。
resource: package.json
tags: [dev, tooling, ci]
status: stable
sources:
  - id: package
    resource: package.json
    title: 脚本
  - id: workspace
    resource: pnpm-workspace.yaml
    title: 工作区和 overrides
  - id: vite
    resource: vite.config.ts
    title: Vite+ 配置
  - id: ci
    resource: .github/workflows/ci.yml
    title: CI
---

# 工具链

* Node ≥22.18 直接运行 `.ts`，应用没有构建步骤。
* pnpm 10，版本由 `package.json` 的 `packageManager` 固定。
* 测试、lint、格式和类型检查用 [Vite+](https://viteplus.dev/)（`vite-plus`，命令 `vp`），配置在 `vite.config.ts`。[^vite]
* `docs/` 不归格式化管；`README.md` 归，改完跑一次 `pnpm format`。
* macOS 上用到的系统命令：播放 `afplay`，录音 `ffmpeg`（avfoundation），粘贴板 `pbpaste`，确认页 `open`，按键助手用 `swiftc` 编译；听写用 whisper.cpp 的 `whisper-cli`，模型第一次用时下载到 `~/.yoyo/models/ggml-<asr.model>.bin`。别的系统换成静音和空实现，见[架构](architecture.md#目录)。

# 脚本

| 命令                                | 作用                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `pnpm start`                        | 常驻进程，`node src/main.ts`                                              |
| `pnpm once`                         | 只说一句，`--once`                                                        |
| `pnpm bake`                         | 预合成固定台词到 `~/.yoyo/speech-cache`，`--bake`                         |
| `pnpm yoyo <领域>`                  | 命令行，等于 `node bin/yoyo.js`                                           |
| `pnpm test`                         | `vp test`：Vitest 跑 `src/` 和 `packages/` 下的 `*.test.ts`               |
| `pnpm typecheck`                    | `vp check --no-fmt --no-lint`：只做类型检查（tsgolint，TS 7），不产出文件 |
| `pnpm lint`                         | `vp lint`：Oxlint，带类型信息的规则，同时报类型错误；有警告也算失败       |
| `pnpm format` / `pnpm format:check` | `vp fmt`：Oxfmt 改写 / 检查                                               |
| `pnpm check`                        | `vp check`（格式、lint、类型）再 test；CI 跑同样几步                      |

[^package]

# 和 ctx 联调

ctx 还没发到 npm。`pnpm-workspace.yaml` 的 `overrides` 把用到的七个包链到 `../ctx/packages/*`，读的是 ctx 的 `dist/`：`@modelctx-ai/ctx`（`core`）、`ctx-protocol`（`protocol`，核心包把它当 peer）、`ctx-sqlite`、`ctx-mcp`、`ctx-gateway`、`ctx-models`、`ctx-memory`（`memory`）。`ctx-exec`、`ctx-remote` 用不到，不链。改了 ctx 要在 ctx 里重新 `pnpm build`。ctx 发布以后删掉 `overrides`，同样的 `^0.3.0` 从 npm 解析。[^workspace]

* 要的是 ctx `main`（0.3.x）。`link:` 不看版本范围，`../ctx` 停在旧版也装得上，要到类型检查或打开 `yoyo.db` 时才报错；拉了 ctx 记得重新构建。
* 记忆要 ctx 的 `memory` 包、`ctx-sqlite` 的 `createSqliteMemoryStore` 和 `ctx-models` 的 System One 工厂（ctx 的记忆实现，ADR 0006），ctx `main` 上都有。之后 yoyo 再依赖 ctx 还没合并的改动时同理：`../ctx` 要切到那个分支再构建，CI 取的是 ctx `main`，ctx 合并之前会红。
* `ctx-memory` 和 `ctx-models` 一样把 `ai` 当 peer，链接时由 ctx 自己的 `node_modules` 满足。
* 核心包另把 `zod` 当 peer，yoyo 自己依赖的 `zod` 4 满足它。
* `ai` 只是开发依赖：测试里用 `ai/test` 的 `MockLanguageModelV4` 和 `APICallError`。运行时的 AI SDK 类型和函数都从 `@modelctx-ai/ctx` 拿，不直接引 `ai`。

三个仓库怎么分工、怎么一起联调，见 [ctx 仓库](https://github.com/modelctx-ai/ctx)的 `docs/repos.md`。

# CI

`.github/workflows/ci.yml` 在每次推送和 PR 上跑：把 yoyo 和 ctx 并排检出（ctx 取 `main` 的最新提交，不固定版本，所以 ctx 的不兼容改动会直接让 yoyo 的 CI 变红），构建 ctx，`pnpm install --frozen-lockfile`，再 `vp check --deny-warnings` 和 `pnpm test`。[^ci]

# 调试

* `"stage": "console"` 不连桌宠，台词打印成 `[动作] 文字`。配合单独的 `YOYO_HOME` 和 `YOYO_CONFIG` 在任何机器上跑，见[架构](architecture.md#不接桌宠跑)。
* 测试里用 `createApp(config, paths, overrides)` 换掉任意一项服务；`src/runtime/testing.ts` 有内存里的替身，不联网、不开子进程。
* `pnpm yoyo log tail` 看最后 20 条行为记录，`pnpm yoyo context tail` 看上下文的最后几条。

# 文档

* `README.md` 只放产品介绍和快速开始；使用说明在 `docs/product/`，实现和原则在 `docs/tech/`。
* 产品文档不写源码路径、接口和内部表名；技术文档用 frontmatter 的 `resource`、`sources` 指向源文件。
* 改了文档，在 [docs/log.md](../log.md) 记一笔。
* 完整的约定（frontmatter 字段、脚注、`proposed` 到 `stable`、改配置和加命令时要连带改什么）在仓库根目录的 [AGENTS.md](../../AGENTS.md)。

[^vite]: Vite+ 配置
[^package]: 脚本
[^workspace]: 工作区和 overrides
[^ci]: CI
