# 文档更新记录

## 2026-10-26

* **Update**: 跟上 ctx 0.2（机械迁移）。架构的「怎么用 ctx」：线程改叫会话（`sessionFor`），记录写明 `record: false` 连 `ctx.run.*` 也不写，工具用 `addTool`、MCP hub 经 `executors` 交给上下文，压缩写明框架事件 `ctx.*` 不计入阈值、`context tail` 不列，迁移加上 `ctx_entries.thread` 列改名（`migrateSessionColumn`）。运行时原则的线程改成会话。开发里的 `overrides` 列出六个包（新加 `ctx-protocol`），版本改成 `^0.2.0`。从旧版升级加「从上一版升级（ctx 0.2）」：更新 ctx、对话记忆自动改名迁移。

## 2026-10-23

* **Creation**: 补上命令原则和运行时原则。顶层索引只链到这两篇。
* **Creation**: 代码改成分层的 TypeScript 工作区以后，补上架构：分层和依赖方向、各目录做什么、yoyo 怎么用 ctx 和 dsh-pet、三条数据流、扩展方法。索引加上这一篇，三个仓库的分工改指 ctx 仓库的 `docs/repos.md`，不在这里另写。
* **Update**: 命令原则和运行时原则改指新的源文件（`src/cli/commands.ts`、`src/cli/registry.ts`、`src/runtime/director.ts`、`src/kernel/pace.ts`），并跟上行为变化：上下文存进 ctx 的表，桌宠右键对话拿本机令牌，粘贴板进提示词，压缩按配置才做，命令用到什么才打开什么。
* **Update**: README 按新目录重写：要求、安装 ctx、pnpm 脚本、完整的配置表、数据位置、老用户要知道的变化。
* **Update**: 跟上一轮修正：配置和旧版一样宽松（写错按缺省值，`listen` 缺省关闭，`mcpServers` 写错的服务器跳过）；控制台舞台不要求语音，别的系统不播放；对话渠道接不上时每 30 秒再接；压缩有 60 秒超时；按键助手由组装根给；`node src/main.js` 照旧能用。
* **Update**: 文档分成产品和技术两类。README 只留产品介绍、快速开始和文档入口。原来 README 里的内容拆进 `product/`：功能介绍、安装与运行、日常使用、配置、数据、从旧版升级；脚本、工具链、ctx 联调和 CI 进 `tech/development.md`。架构、命令原则、运行时原则移到 `tech/`。索引按两类重排。
