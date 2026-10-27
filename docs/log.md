# 文档更新记录

## 2026-10-27

* **Update**: 配置加「把 MCP 服务器关进沙箱」：`sandbox` 的字段、yoyo 追加的设置、启动不了就不启动、装 srt 和 Linux 上的三个依赖、Ubuntu 24.04 的 AppArmor profile、沙箱里的文件、进程和网络（经代理，Node `fetch` 要 `NODE_USE_ENV_PROXY=1`）、经 `via serve` 的零改动路线、它不是凭证隔离。架构的目录表、常驻进程、执行环境跟上，「扩展」加「把 MCP 服务器关进沙箱」写做法和理由。索引、README、`config.example.json` 跟上。
* **Update**: 记忆从提案改为已实现（`status: stable`），M0–M2 做完，M3 做了接线、没校准 `theta`。和提案不一样的地方以实现为准改了：碎碎念和回复各用一个记忆来源（`memory-whisper` 按当前任务召回，`memory` 按最近一条用户话召回），因为来源不知道这一轮是哪个 agent，两个 agent 的 `context.facts.sources` 由组装根给名单；天气和提醒由 `memorySessions` 在读日志这一层滤掉（`gate.entries` 挑不了 `meta`）；门控和整理都在后台跑，门控跳过时留到下一拍，整理失败当天不再试、成功记在 kv；过了 `consolidateAt` 当天都算，不是推到第二天；`yoyo memory consolidate` 不用模型，只做衰减归档和画像的缺省渲染；`forget` 对程序只能退役（ctx 没有删程序的方法）；`rules` 列没退役的程序并标出生效与否；`tail` 列状态（待整理、已整理、不记）。配置表写明每项的范围和写错时的处理，`decision`、`extraction` 是 `SystemOneSpec` 的写法，建模型出错记一行退回缺省。分期表加「状态」一列。
* **Update**: 架构：目录表加 `brain/memory.ts`；常驻进程的一拍加第 8、9 步（门控、整理）；「和 ctx 组件的对应」的记忆一行去掉「提案」；「怎么用 ctx」的写入（`meta.kind`）、来源、事实（两份来源名单）、工具（`recall`）、执行环境跟上。开发：`overrides` 是七个包，加 `ctx-memory`，写明记忆要 ctx 带记忆的版本、合进 `main` 之前 CI 会红。索引的记忆一行去掉「提案」。
* **Update**: 产品文档跟上记忆：功能介绍加「记住你」；配置的选项表加 `memory.*`，新加「记忆」一节；日常使用加 `memory` 命令；数据加 `memory_` 表和删除。README 的功能列表加一条，技术文档表加记忆。

* **Creation**: 补上记忆（提案，`status: proposed`）：机制在 ctx（`docs/memory.md`、ADR 0006），这里只写 yoyo 决定的事。桌宠记什么（六个主题：owner、work、people、routine、taste、fix）；哪些条目进门控（用户话、回复、右键对话并进来的；碎碎念、天气、提醒不进）；门控在拍子末尾异步跑；画像和召回经来源 `memory` 给两个 agent，位置和现有事实一样（碎碎念 `prompt`、回复 `instructions`），`recall` 工具只给回复且要 `llm.tools`；巩固在 `memory.consolidateAt`（缺省 03:00）且 30 分钟没对话时跑；存在 `yoyo.db` 的 `memory_*` 表；`config.json` 的 `memory` 一节；`yoyo memory` 命令（core、facts、history、rules、forget、consolidate、tail）；运行时原则五条；分期 M0–M3 和各期依赖的 ctx 包。索引加这一篇；架构的「和 ctx 组件的对应」加记忆一行。
* **Update**: 架构「怎么用 dsh-pet」的 `POST /menu/item` 注明 `target: 'desktop'` 是照 dsh-pet 源码用的，`openapi.yaml` 里还没写。其余接口对照 dsh-pet `dfc0396` 核对过，都一致。
* **Update**: 开发的「和 ctx 联调」补三条：要的是 ctx `main`（0.3.x），`link:` 不看版本范围；核心包的 `zod` peer 由 yoyo 的 `zod` 满足；`ai` 只在测试里用。CI 写明 ctx 取 `main` 最新提交、不固定版本。ctx 0.3 里删掉的弃用别名（`thread`、`ContextStore`、`add(name, tool)` 等）yoyo 都没用到，不用改。

## 2026-10-26

* **Update**: 跟上 ctx 0.3（会话位置、消息格式、`AgentSpec.context`）。架构：事实的收法和位置写进两个 agent 的 `context`（碎碎念 `prompt`、回复 `instructions`），harness 直接用上下文的 builder；`yoyo context tail` 和桌宠对话按 `(at, seq)` 排；迁移加上 schema 3；新加「旧摘要」一行（常驻进程启动时、开拍子之前重新压缩被旧摘要盖住的记录，没有模型记警告，命令行不做）。运行时原则、开发（依赖 `^0.3.0`）同步；从旧版升级加「从上一版升级（ctx 0.3）」：先停常驻进程，库结构自动升级，旧版读不了。碎碎念最后一条用户消息里，事实和「请再说一句碎碎念。」之间由一个换行变成一个空行（builder 接提示的写法），其余交给模型的指令、消息和事实不变。
* **Update**: 删掉绕开 ctx 缺口的代码（ctx 已合并「版本化迁移」和「小缺口」两处修复）。架构的「报错」改成直接读 `RunResult.error` 的 `statusCode`、`responseBody`，不再包一层模型记原始错误；「迁移」改成由 `createSqliteStore` 打开库时升级（`thread` 列改名、schema 升到 2），yoyo 只剩旧表 `context_items` 的迁移。运行时原则同步。用户可见的行为和文案不变。
* **Update**: 编排改成实现 ctx 的 `Orchestrator`。架构：分层图和目录表加上编排器（`runtime/orchestrator.ts`）、harness（`brain/harness.ts`）和 agent 配置（`brain/agents.ts`）；「常驻进程」改成编排器、harness、导演、常驻循环各管什么和调用关系，拍子由编排器打；新加「和 ctx 组件的对应」；「怎么用 ctx」加上 agent、一轮、事实、报错的新做法；两条数据流改成编排器提交 → harness 跑 → 导演表演 → 记录；扩展里的「要开口」「要跑模型」跟上，工具例子改用 `addTool`。运行时原则：让路和记录写到编排器上，`resource` 改指编排器。索引的架构一行跟上。用户可见的行为和文案不变。
* **Update**: 跟上 ctx 0.2（机械迁移）。架构的「怎么用 ctx」：线程改叫会话（`sessionFor`），记录写明 `record: false` 连 `ctx.run.*` 也不写，工具用 `addTool`、MCP hub 经 `executors` 交给上下文，压缩写明框架事件 `ctx.*` 不计入阈值、`context tail` 不列，迁移加上 `ctx_entries.thread` 列改名（`migrateSessionColumn`）。运行时原则的线程改成会话。开发里的 `overrides` 列出六个包（新加 `ctx-protocol`），版本改成 `^0.2.0`。从旧版升级加「从上一版升级（ctx 0.2）」：更新 ctx、对话记忆自动改名迁移。

## 2026-10-23

* **Creation**: 补上命令原则和运行时原则。顶层索引只链到这两篇。
* **Creation**: 代码改成分层的 TypeScript 工作区以后，补上架构：分层和依赖方向、各目录做什么、yoyo 怎么用 ctx 和 dsh-pet、三条数据流、扩展方法。索引加上这一篇，三个仓库的分工改指 ctx 仓库的 `docs/repos.md`，不在这里另写。
* **Update**: 命令原则和运行时原则改指新的源文件（`src/cli/commands.ts`、`src/cli/registry.ts`、`src/runtime/director.ts`、`src/kernel/pace.ts`），并跟上行为变化：上下文存进 ctx 的表，桌宠右键对话拿本机令牌，粘贴板进提示词，压缩按配置才做，命令用到什么才打开什么。
* **Update**: README 按新目录重写：要求、安装 ctx、pnpm 脚本、完整的配置表、数据位置、老用户要知道的变化。
* **Update**: 跟上一轮修正：配置和旧版一样宽松（写错按缺省值，`listen` 缺省关闭，`mcpServers` 写错的服务器跳过）；控制台舞台不要求语音，别的系统不播放；对话渠道接不上时每 30 秒再接；压缩有 60 秒超时；按键助手由组装根给；`node src/main.js` 照旧能用。
* **Update**: 文档分成产品和技术两类。README 只留产品介绍、快速开始和文档入口。原来 README 里的内容拆进 `product/`：功能介绍、安装与运行、日常使用、配置、数据、从旧版升级；脚本、工具链、ctx 联调和 CI 进 `tech/development.md`。架构、命令原则、运行时原则移到 `tech/`。索引按两类重排。
