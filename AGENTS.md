# AGENTS.md

给在这个仓库里写代码的人和 coding agent 的工作约定。工具链、脚本、和 ctx 联调、CI 见[开发](docs/tech/development.md)；文档入口是 [docs/index.md](docs/index.md)。

## 文档

- 分两类：`docs/product/` 给用 yoyo 的人，`docs/tech/` 给改 yoyo 的人；`README.md` 只放产品介绍、快速开始和文档入口。产品文档不写源码路径、接口和内部表名。
- 技术文档的 frontmatter：`type`、`title`、`description`、`tags`、`status`（`stable` / `proposed`），`resource` 指这篇对应的主源文件，`sources` 列出正文依据的源文件（`id`、`resource`、`title`）。正文里用脚注 `[^id]` 标注依据，文末 `[^id]: <title>`，`id` 和 `title` 和 `sources` 里的一致。改了源文件的路径或职责，连带改 `sources`。
- `generated`、`okf_version` 是生成工具留下的标记，保留不改。
- 设计类文档先以 `status: proposed` 合入，实现后改成 `stable`，并以实现为准修订和提案不一样的地方，在 [docs/log.md](docs/log.md) 写明改了哪些。
- 改了 `docs/` 或 README 就在 [docs/log.md](docs/log.md) 记一笔：按日期倒序，条目以「新增 / 更新 / 删除」开头，写改了哪篇、改了什么。
- `docs/` 不归 Oxfmt 管，手写对齐；`README.md` 归，改完跑 `pnpm format`。
- 三个仓库怎么分工见 ctx 仓库的 `docs/repos.md`，不在这里另写。

## 改代码时

- 依赖只朝一个方向：`kernel` ← `ports` ← `features` / `brain` / `adapters` ← `runtime` ← `cli` / `web` / `app`，`features` 和 `brain` 只认端口，见[架构](docs/tech/architecture.md#分层)。换实现在组装根 `src/app/container.ts` 里挑，不在业务代码里判断平台。
- 改配置是四件事一起：`src/app/config.ts` 的 zod 结构（缺省值都在这里，写错按缺省值、不报错）、`config.example.json`、[配置](docs/product/configuration.md)的选项表、`src/app/config.test.ts`。
- 加命令照[命令原则](docs/tech/cli-principles.md)「加一条命令时」；改开口、让路、记录的行为先对照[运行时原则](docs/tech/runtime-principles.md)。
- 密钥（`llm.apiKey`、`speech.apiKey` 等）不进日志、报错和测试快照。
- AI SDK 的类型和函数从 `@modelctx-ai/ctx` 拿，不直接引 `ai`；`ai` 只是测试用的开发依赖。
- 测试用 `createApp(config, paths, overrides)` 换服务，替身在 `src/runtime/testing.ts`；测试不联网、不开子进程，要跑外部程序时用 `src/brain/fixtures/` 里的假程序。
- 依赖 ctx 还没合进 `main` 的改动时，yoyo 的 CI 会红（CI 检出 ctx `main`）；先合 ctx，再重跑 yoyo 的 CI，不要为了绕过去改 CI 或复制 ctx 的代码。
- 用户看到的文案是中文，桌宠口吻；报错和日志一行说清，不打英文的框架告警。

## 提交

- 提交信息按 Conventional Commits，标题中文，scope 用目录名（`brain`、`cli`、`runtime`、`memory`……）或 `docs`、`arch`、`dev`。
