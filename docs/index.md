---
okf_version: "0.2"
---

# yoyo 文档

用 yoyo 看产品；改 yoyo 看技术。

## 产品

* [功能介绍](product/overview.md) - 碎碎念、说话、听写、右键对话、闹钟、天气、表情包、工作台。
* [安装与运行](product/getting-started.md) - 安装包（dmg、app 内更新）和从源码两种装法、配置、启动桌宠、开关、控制台模式。
* [日常使用](product/usage.md) - 右键菜单、工作台、按键、命令行。
* [配置](product/configuration.md) - 开关、每个选项和缺省值、MCP 服务器和它们的沙箱、环境变量。
* [数据](product/data.md) - 存在哪里、记下什么、改天气地点。
* [从旧版升级](product/upgrading.md) - 换成安装包、要做的和变化。

## 技术

* [架构](tech/architecture.md) - 分层和依赖方向、各目录做什么、编排器和导演各管什么、和 ctx 组件的对应、怎么用 ctx 和 dsh-pet、三条数据流、怎么扩展（含把 MCP 服务器关进沙箱）。
* [开发](tech/development.md) - 工具链、脚本、和 ctx 联调、CI、调试、文档约定。
* [发版](tech/release.md) - 推 tag 时打 macOS 的 yoyo.app 和 dmg：包里有什么、各部分从哪来、app 外壳和启动脚本、app 内更新、冒烟测试（提案，第一次发版验证后转为已实现）。
* [命令原则](tech/cli-principles.md) - 命令怎么分层、怎么被发现、默认输出为什么短。
* [运行时原则](tech/runtime-principles.md) - 桌宠边界、碎碎念让路、记录、粘贴板和联系人各自守什么。
* [管理页](tech/web.md) - 常驻进程在本机开的网页（工作台）：接口、安全边界（令牌、Host、Origin、CSP）、页面怎么做、怎么打开。
* [工作台](tech/workbench.md) - 桌宠和工作台两种形态；已经有的主聊天、子任务和交付物。
* [子任务](tech/tasks.md) - 主线程派给后台子 agent 的事：目标、验收标准、todo，工具和规则，怎么跑，怎么回到主线程。
* [读写文件和跑命令](tech/files.md) - 主线程和子 agent 的 read、write、edit、bash：工作区、只读目录、读不到的位置，最具体的规则说了算；bash 经 srt 沙箱，只能写工作区、网络缺省关，转告那一轮不给；开关写 ask 时每次先在工作台里批准。
* [记忆](tech/memory.md) - 桌宠记什么主题、哪些话进门控、画像和召回放在哪个 agent、夜里什么时候整理、主人怎么看和删、分期（M0–M2 已做，M3 只做了接线）。机制在 ctx。

## 其他

* [更新记录](log.md) - 文档本身的变更。

ctx、yoyo、dsh-pet 三个仓库怎么分工，见 [ctx 仓库](https://github.com/modelctx-ai/ctx)的 `docs/repos.md`。
