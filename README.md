<p align="center"><img src="assets/character.svg" width="200" height="200" alt="yoyo"></p>

# yoyo

让桌宠 dsh-pet 真正陪着你：按时间换语气碎碎念、开口说话、听你回应、提醒日程、傍晚报天气，还记得你们聊过的所有事。

## 它会做什么

- **碎碎念**：深夜平静，下午活泼，偶尔讲个笑话；同一句 3 小时内不重复，说完了让模型按你们的对话再写一句。
- **开口说话**：每句台词都有配音，动作也配一段轻轻的音效。
- **听你回应**：说完听你几秒，听写后先给你确认，再回复；像在提问就先搜一下。
- **右键对话更聪明**：桌宠自己的对话框由 yoyo 回答，带上完整记忆、工具和搜索。
- **右键菜单换成 yoyo 的**：碎碎念、听一句放在第一层，用不上的自带项藏起来。
- **记住你**（可选）：夜里把值得记的话整理成画像和记得的事，碎碎念和回复时带上；随时能看、能删。
- **闹钟和日程**：每天、工作日、每周或某一天，到点就提醒。
- **天气**：工作日傍晚报一次接下来几小时的天气。
- **表情包**：空闲时自己找一套图，碎碎念时配上一张。
- **不抢话**：你正和它聊着，日常碎碎念会往后让。
- **子任务**：要花时间的事跟 yoyo 说一声，它派到后台去做：自己拆 todo、做完一条勾一条，按验收标准对过再把结果带回来。你只管和 yoyo 说话。
- **工作台**：yoyo.app 的窗口（也能在浏览器里开）：打字和它聊，翻桌宠那边的对话和它做过的事，改画像、删记错的事，管日程和联系人、改配置。平时让桌宠陪着，干活时再打开。
- **MCP 工具关进沙箱**：可选地让每台本机 MCP 服务器在 srt 沙箱里运行，写不了 yoyo 的配置和数据，只连你放行的域名。

## 快速开始

在 Apple 芯片的 Mac 上，到 [Releases](https://github.com/modelctx-ai/yoyo/releases) 下载 `yoyo-<版本>-macos-arm64.dmg`，把 yoyo 拖进「应用程序」。包里带着桌宠、Node、录音和听写，不用另外安装。

第一次打开会生成 `~/.yoyo/config.json`，填上 Fish Audio 的 `apiKey` 和 `referenceId` 再打开一次：桌宠出来，yoyo 的窗口里是工作台。有新版本时 yoyo 会问你，点一下就换上。没经过 Apple 公证，第一次打开要在「系统设置 → 隐私与安全性」里点「仍要打开」，见[安装与运行](docs/product/getting-started.md#安装包)。

说完要不要听你回应、报不报天气、配不配表情包和音效，都是 `config.json` 里的开关。

从源码运行需要 Node 22.18+ 和 pnpm 10，桌宠 dsh-pet 跟着依赖装上：

```sh
git clone https://github.com/modelctx-ai/ctx ../ctx
pnpm -C ../ctx install && pnpm -C ../ctx build
pnpm install
cp config.example.json config.json   # 填上 Fish Audio 的 apiKey 和 referenceId
pnpm pet                             # 另开一个终端：桌宠
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
| [数据](docs/product/data.md)                  | [记忆](docs/tech/memory.md)                   |
| [从旧版升级](docs/product/upgrading.md)       | [发版](docs/tech/release.md)                  |
|                                               | [管理页](docs/tech/web.md)                    |
|                                               | [工作台](docs/tech/workbench.md)              |
|                                               | [子任务](docs/tech/tasks.md)                  |
|                                               | [读写文件](docs/tech/files.md)                |

图标素材的许可见 [assets/NOTICE](assets/NOTICE)。
