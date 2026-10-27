<p align="center"><img src="assets/character.svg" width="200" height="200" alt="yoyo"></p>

# yoyo

让桌宠 dsh-pet 真正陪着你：按时间换语气碎碎念、开口说话、听你回应、提醒日程、傍晚报天气，还记得你们聊过的所有事。

## 它会做什么

- **碎碎念**：深夜平静，下午活泼，偶尔讲个笑话；同一句 3 小时内不重复，说完了让模型按你们的对话再写一句。
- **开口说话**：每句台词都有配音，动作也配一段轻轻的音效。
- **听你回应**：说完听你几秒，听写后先给你确认，再回复；像在提问就先搜一下。
- **右键对话更聪明**：桌宠自己的对话框用上 yoyo 的完整记忆。
- **闹钟和日程**：每天、工作日、每周或某一天，到点就提醒。
- **天气**：工作日傍晚报一次接下来几小时的天气。
- **表情包**：空闲时自己找一套图，碎碎念时配上一张。
- **不抢话**：你正和它聊着，日常碎碎念会往后让。
- **MCP 工具关进沙箱**：可选地让每台本机 MCP 服务器在 srt 沙箱里运行，写不了 yoyo 的配置和数据，只连你放行的域名。

## 快速开始

需要 macOS、Node 22.18+、pnpm 10，以及独立模式运行的 dsh-pet。

```sh
git clone https://github.com/modelctx-ai/ctx ../ctx
pnpm -C ../ctx install && pnpm -C ../ctx build
pnpm install
cp config.example.json config.json   # 填上 Fish Audio 的 apiKey 和 referenceId
pnpm start
```

完整步骤见[安装与运行](docs/product/getting-started.md)。

## 文档

| 产品                                          | 技术                                          |
| --------------------------------------------- | --------------------------------------------- |
| [功能介绍](docs/product/overview.md)          | [架构](docs/tech/architecture.md)             |
| [安装与运行](docs/product/getting-started.md) | [开发](docs/tech/development.md)              |
| [日常使用](docs/product/usage.md)             | [命令原则](docs/tech/cli-principles.md)       |
| [配置](docs/product/configuration.md)         | [运行时原则](docs/tech/runtime-principles.md) |
| [数据](docs/product/data.md)                  |                                               |
| [从旧版升级](docs/product/upgrading.md)       |                                               |

图标素材的许可见 [assets/NOTICE](assets/NOTICE)。
