---
type: Architecture Decision
title: 运行时原则
description: yoyo 决定说什么和什么时候说，dsh-pet 只负责显示和做动作。
resource: src/runtime/director.ts
tags: [runtime, pet]
generated: { by: okf-docs-organizer/v0.2, at: 2026-10-23T13:00:00Z }
status: stable
sources:
  - id: director
    resource: src/runtime/director.ts
    title: 导演
  - id: pace
    resource: src/kernel/pace.ts
    title: 碎碎念让路
  - id: context
    resource: src/brain/context.ts
    title: 上下文
  - id: channel
    resource: src/brain/channel.ts
    title: 对话渠道
---

# 边界

dsh-pet 保持官方行为。yoyo 只用它的占用锁、投喂文字、点名动作、状态、对话记忆、菜单、工作状态和独立模式的对话设置，都经 `@yoyo/dsh-pet` 调用。不改宠物仓库，也不调用它在独立模式下不会生成文字的 `POST /whisper` 和 `POST /chat`。[^director]

台词、语气、语音、天气、搜索、听写和日程都在 yoyo 里决定。上下文怎么存、怎么交给模型，用 ctx。

# 什么时候开口

1. **日常碎碎念会让路。** 30 秒内还有别的对话或提醒，日常碎碎念就顺延到那些话停下来之后 30 秒。中间又说话，再顺延一次。到点了却没说成（桌宠没开、锁被占着），隔一分钟再试，不每秒重来。[^pace]
2. **同一句 3 小时内不重复。** 当前语气的句子用完了就换别的语气。预制句子都用完了，再用模型写一句。模型看到的是完整上下文，由 ctx 存在 `~/.yoyo/yoyo.db` 里，每只宠物一条线程 `pet:<id>`：用户和回复按原句保留，不截断；连续的碎碎念收成一条助手消息。这一刻的当前任务和粘贴板最近一条也交给模型，但不写进历史。生成时先不记，说出口以后才写进上下文。没配 `context.maxTokens` 就整段带上；配了 `context.compactAt` 才压缩：较早的部分压成一条摘要，最近 `context.keep` 条原样保留。右键对话的记录会并进这份上下文。桌宠自己的对话记忆仍由它保存，用户配置里的 `chatMemoryRounds` 设为 200，避免只带着最近几轮。[^context]
3. **需要回应才听。** `listen.enabled` 打开、模型也配好时（`listen` 缺省关闭，和旧版一样不写就不听），碎碎念和模型现写的话念完，麦克风听 5 秒。一开始切到面向你的动作。素材里没有名为「侧耳听」的片段，默认用 `碎碎念-对屏碎碎念`，可以在 `listen.action` 里改。听写结果先在本机页面里确认：发送按钮倒计时 3 秒，没人动就用原文发送；鼠标、键盘或改字都会停下倒计时，等用户自己按发送或取消。天气播报和闹钟不听。主动听用右键 yoyo 分组里的「听一句」、`yoyo listen`，或 Control+Option+Y。
4. **宠物自带的「碎碎念」到不了 yoyo。** 那一项只打到宠物自己的接口。要主动说，用右键 yoyo 分组里的「碎碎念」，或 `yoyo whisper`。右键「对话」仍是桌宠自己的输入框。导演启动后，桌宠的模型地址改成本机网关，真正的请求由 yoyo 转发到 `config.json` 的 `llm.baseUrl`。桌宠拿到的密钥是每次启动新生成的本机令牌，真密钥只留在 yoyo 进程里。桌宠带来的截断历史会被换成 yoyo 的全文，再带上当前这句。只有 `llm.provider` 是 `openai-compatible` 才这样接；别的协议只记一行日志，右键对话不经过 yoyo。桌宠还没开、接不上时，网关照开，每 30 秒再让桌宠接一次，日志只记第一次失败。自动碎碎念仍由 yoyo 发，不打开桌宠自己的周期碎碎念。需要重接时运行 `yoyo chat sync`。`speech.autoplay` 开着时，这种对话回复也会转成语音播放；yoyo 自己刚投喂的句子不重复念。设为 `false` 就只出字。[^channel]
5. **提问才搜索。** 听写像在问事实时才调用本机 anysearch。打开 `llm.tools` 以后不再先按问句搜，由模型自己决定要不要搜。密钥留在本机配置，不进仓库，也不出现在命令参数里。
6. **没事干可以去找表情包。** 离下一句日常碎碎念还有一段时间，就搜一套图，记在 SQLite 里。没搜成就隔 10 分钟再找。碎碎念大约四成会连同文字带上一张。天气和闹钟不带。找到或用上都会记一笔行为。

# 记下什么

联系人、日程、粘贴板、上下文、表情包、行为记录、说过的句子、地点和天气日期都在 `~/.yoyo/yoyo.db`。上下文在 ctx 的表 `ctx_entries` 里；旧版的 `context_items` 第一次启动时迁进去，改名成 `context_items_migrated` 留着。做过的事包括说话、听写、搜索、提醒、顺延、配音、加联系人、加日程、粘贴板变化。记录里不写密钥。

粘贴板历史是 yoyo 运行期间看到的变化。这不是操作系统里更早的全部复制记录。最近一条会交给模型；`clipboard.enabled` 设为 `false` 就不读，也不交。

联系人现在只保存名字和对方的 yoyo 地址。以后用这个地址联系对方的 yoyo，现在还不发起连接。

日程可以是每天、每个工作日、每周某一天，或某一天一次。到点后 15 分钟内说一次。

# 声音

每个动作同时放一段大约两成音量的短配音，不盖过说话。写代码是轻轻的按键，伸懒腰是一声拉长，发呆几乎听不见。

语音合成走 Fish Audio。固定台词可以预先合成。天气和现写的句子第一次现合成，同一句再遇到就用缓存。

驱动桌宠时语音必须配好。控制台舞台可以不配，没配就只出字。播放和配音只在 macOS 上用 `afplay`；别的系统不播放，第一次要播时记一行。

[^director]: 导演
[^pace]: 碎碎念让路
[^context]: 上下文
[^channel]: 对话渠道
