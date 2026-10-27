---
okf_version: "0.2"
---

# yoyo 文档

用 yoyo 看产品；改 yoyo 看技术。

## 产品

* [功能介绍](product/overview.md) - 碎碎念、说话、听写、右键对话、闹钟、天气、表情包。
* [安装与运行](product/getting-started.md) - 要求、安装、配置、启动桌宠、控制台模式。
* [日常使用](product/usage.md) - 右键菜单、按键、命令行。
* [配置](product/configuration.md) - 每个选项和缺省值、MCP 服务器和它们的沙箱、环境变量。
* [数据](product/data.md) - 存在哪里、记下什么、改天气地点。
* [从旧版升级](product/upgrading.md) - 要做的和变化。

## 技术

* [架构](tech/architecture.md) - 分层和依赖方向、各目录做什么、编排器和导演各管什么、和 ctx 组件的对应、怎么用 ctx 和 dsh-pet、三条数据流、怎么扩展（含把 MCP 服务器关进沙箱）。
* [开发](tech/development.md) - 工具链、脚本、和 ctx 联调、CI、调试、文档约定。
* [命令原则](tech/cli-principles.md) - 命令怎么分层、怎么被发现、默认输出为什么短。
* [运行时原则](tech/runtime-principles.md) - 桌宠边界、碎碎念让路、记录、粘贴板和联系人各自守什么。
* [记忆](tech/memory.md) - 桌宠记什么主题、哪些话进门控、画像和召回放在哪个 agent、夜里什么时候整理、主人怎么看和删、分期（M0–M2 已做，M3 只做了接线）。机制在 ctx。

## 其他

* [更新记录](log.md) - 文档本身的变更。

ctx、yoyo、dsh-pet 三个仓库怎么分工，见 [ctx 仓库](https://github.com/modelctx-ai/ctx)的 `docs/repos.md`。
