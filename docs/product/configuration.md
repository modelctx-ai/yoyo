---
type: Reference
title: 配置
description: config.json 的每个选项、缺省值，以及写错时怎么办。
resource: src/app/config.ts
tags: [product, config]
status: stable
---

# 写法

配置写在 yoyo 目录的 `config.json`，可以从 `config.example.json` 复制。`YOYO_CONFIG` 可以换一个位置。

配置是宽松的，写错不会挡住启动：

* 每个键都有缺省值，认不出的键保留不报错；整段写成 `null` 当没写。
* 数字可以写成字符串（`"600"`）；不是数、或者超出范围就按缺省值。
* 开关只认 `true`、`false` 和字符串 `"true"`、`"false"`，别的按缺省值；选项写错或空着也按缺省值。
* `mcpServers` 里写错的服务器（没有 `command` 也没有 `url`）启动时跳过，记一行。
* `speech.model`、`speech.referenceId` 原样保留，不去空白。

# 选项

| 键                                         | 缺省                                             | 作用                                                                                                |
| ------------------------------------------ | ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `stage`                                    | `dsh-pet`                                        | `console` 只在终端打印台词                                                                          |
| `pet.baseUrl`                              | `http://127.0.0.1:3080/dsh-pet-7340`             | 桌宠接口                                                                                            |
| `pet.id`、`pet.surface`                    | `main`、`desktop`                                | 哪一只、哪一端；不同的 `pet.id` 各有一份对话记忆                                                    |
| `intervalSec`                              | `300`                                            | 日常碎碎念的间隔，最少 60                                                                           |
| `speech.apiKey`、`speech.referenceId`      | 空                                               | Fish Audio 的密钥和声音；驱动桌宠时必填，控制台模式没填就只出字                                     |
| `speech.baseUrl`、`speech.model`           | `https://api.fish.audio/v1/tts`、`s2.1-pro-free` | Fish Audio 的接口和模型                                                                             |
| `speech.autoplay`                          | `true`                                           | `false` 只出字，不放语音                                                                            |
| `speech.tone`                              | `lively`                                         | 朗读右键对话回复用的语气                                                                            |
| `llm.provider`                             | `openai-compatible`                              | 或 `anthropic`；`anthropic` 时右键对话不经过 yoyo                                                   |
| `llm.baseUrl`、`llm.apiKey`、`llm.model`   | 空                                               | 配齐了才让模型写碎碎念和回复；`anthropic` 可以不写 `baseUrl`                                        |
| `llm.tools`                                | `false`                                          | 回复时让模型调用工具：搜索、天气、闹钟，以及 `mcpServers` 里的工具                                  |
| `listen.enabled`、`listen.seconds`         | `false`、`5`                                     | 说完听回应，听几秒（1–10）；不写就不听，示例配置里打开了                                            |
| `listen.device`                            | `:0`                                             | 录音设备（ffmpeg 的 avfoundation 编号）                                                             |
| `listen.action`                            | `碎碎念-对屏碎碎念`                              | 开始听时播的动作                                                                                    |
| `asr.model`、`asr.bin`                     | `tiny`、`whisper-cli`                            | 识别模型和 whisper.cpp 命令行                                                                       |
| `anysearch.script`、`anysearch.command`    | 空                                               | anysearch 脚本（`node <script>`），或整条命令（数组，给了就不用 `script`）；都没有就不搜            |
| `anysearch.apiKey`、`anysearch.maxResults` | 空、`3`                                          | 搜索密钥和条数；密钥只经环境变量交给搜索进程                                                        |
| `clipboard.enabled`                        | `true`                                           | `false` 不读粘贴板，也不交给模型                                                                    |
| `hotkey.enabled`                           | `true`                                           | Control+Option+Y                                                                                    |
| `context.maxTokens`                        | 不写                                             | 交给模型的历史上限（估算 token）；不写就整段带上                                                    |
| `context.compactAt`                        | 不写                                             | 历史超过这么多估算 token 时，把较早的部分压成摘要；不写就不压缩。`pnpm yoyo context compact` 手动压 |
| `context.keep`                             | `40`                                             | 压缩时原样保留最近几条消息                                                                          |
| `memory.enabled`                           | `false`                                          | 记住主人：画像和记得的事交给模型，夜里整理。关着什么都不建，见[记忆](#记忆)                         |
| `memory.topics`                            | 六个主题                                         | 记哪些主题：名字 → 说明；写错的项丢掉，一项不剩用缺省                                               |
| `memory.gate.theta`                        | `0.6`                                            | 值不值得记的门槛，0 到 1；会按最近一周的笔记自动调                                                  |
| `memory.decay.d`、`memory.decay.archiveAt` | `0.5`、`0.55`                                    | 忘得多快（正数）、低于多少归档（0 到 1）                                                            |
| `memory.core.budgetTokens`                 | `600`                                            | 画像多长（估算 token）                                                                              |
| `memory.consolidateAt`                     | `03:00`                                          | 每天过了这个本地时间、主人 30 分钟没说话，就整理一次                                                |
| `memory.decision`、`memory.extraction`     | 不写                                             | System One 的决策、提取模型；不写就用内置的判断和 `llm` 的模型，见[记忆](#记忆)                     |
| `mcpServers`                               | `{}`                                             | MCP 服务器，见下一节；只在 `llm.tools` 打开时连接                                                   |

# 接 MCP 服务器

打开 `llm.tools`，再按常见的 `mcpServers` 写法加服务器，回复时模型就能用它们的工具：

```json
{
  "llm": { "tools": true },
  "mcpServers": {
    "notes": { "command": "node", "args": ["/path/to/notes-server.js"], "include": ["search_notes"] },
    "docs": { "url": "https://mcp.example.com/mcp", "headers": { "authorization": "Bearer <token>" } }
  }
}
```

* 有 `command` 走 stdio（`args`、`env`、`cwd`），有 `url` 走 Streamable HTTP，`"type": "sse"` 走 SSE。
* `include`、`exclude` 用服务器上的原名挑工具，`"enabled": false` 先不连。
* 工具名加服务器前缀，例如 `notes__search_notes`。
* 连不上只记一行，其余照常。

# 记忆

打开 `memory.enabled`，yoyo 会把你说过的、值得记的话夜里整理成「记得的事」和一段画像，碎碎念和回复时带上；`llm.tools` 也打开时，回复还能自己翻记忆。缺省关着。

```json
{
  "memory": {
    "enabled": true,
    "topics": { "owner": "主人的偏好、作息、称呼", "work": "手头的项目和工具链" },
    "consolidateAt": "03:00",
    "decision": { "provider": "cloudflare", "model": "clef-flash", "accountId": "<账号 ID>", "apiKey": "<令牌>" },
    "extraction": { "provider": "cloudflare", "model": "clairic", "accountId": "<账号 ID>", "apiKey": "<令牌>" }
  }
}
```

* 缺省的六个主题是 `owner`（偏好、作息、称呼）、`work`（项目、工具链）、`people`（提到的人）、`routine`（日程习惯、地点）、`taste`（喜欢的梗、表情包风格）、`fix`（纠正过 yoyo 的说法）。
* `decision`、`extraction` 可以不写：不写时判断哪些话值得记用内置的规则，夜里提取交给 `llm` 的模型。`provider` 是 `cloudflare` 时要写 `accountId`；写得不对启动时记一行，退回不写的样子。
* 没配 `llm` 也没配 `extraction`：话照样记下，但夜里只做遗忘和画像的简单整理，要提取的留着，等配好模型再整理。
* 密钥和 `llm.apiKey` 一样只留在本机，报错和记录里都抹掉。

主人怎么看、怎么删，见[日常使用](usage.md#记忆)。

# 环境变量

| 变量               | 作用                                                         |
| ------------------ | ------------------------------------------------------------ |
| `YOYO_HOME`        | 数据目录，缺省 `~/.yoyo`                                     |
| `YOYO_CONFIG`      | 配置文件                                                     |
| `YOYO_PET_RUNTIME` | 桌宠运行状态文件，缺省 `~/.dsh/dsh-pet/standalone-runtime.json` |
| `YOYO_WHISPER`     | `whisper-cli` 的位置                                         |
