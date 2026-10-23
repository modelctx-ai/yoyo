<p align="center"><img src="assets/character.svg" width="200" height="200" alt="yoyo"></p>

# yoyo

个人桌宠导演。dsh-pet 保持官方行为，只负责显示气泡和播放动作。说什么、用什么语气、配哪段动作、语音怎么合成，都在这个仓库里决定。上下文交给 [ctx](https://github.com/modelctx-ai/ctx)。

## 要求

| 项       | 要求                                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------- |
| Node     | ≥22.18，直接运行 `.ts`，不构建                                                                                  |
| pnpm     | 10，版本由 `packageManager` 固定                                                                                |
| ctx      | 克隆在 yoyo 旁边，见[安装](#安装)                                                                               |
| 桌宠     | dsh-pet 独立模式，见[它怎么驱动宠物](#它怎么驱动宠物)                                                           |
| 语音合成 | Fish Audio，驱动桌宠时 `speech.apiKey` 和 `speech.referenceId` 必填；控制台模式可以不配                         |
| macOS    | 播放用 `afplay`，录音用 `ffmpeg`（avfoundation），粘贴板用 `pbpaste`，确认页用 `open`，按键助手用 `swiftc` 编译 |
| 听写     | whisper.cpp 的 `whisper-cli`                                                                                    |
| 可选     | 模型（`openai-compatible` 或 `anthropic`）、本机 anysearch                                                      |

没有桌宠或不在 macOS 上时，用 `"stage": "console"` 调试：台词打印成 `[动作] 文字`，不连桌宠，没有菜单和右键对话。这时语音可以不配，Fish 的四项没填齐就只出字、不合成。不在 macOS 上不播放声音也不做配音，第一次要播时记一行；粘贴板读到的总是空的，按键助手不起。听写要 macOS 的 ffmpeg，别的系统上让 `listen.enabled` 保持关着（缺省就是关的）。

## 安装

ctx 还没发到 npm。在 yoyo 目录里把它克隆到旁边、构建，再装 yoyo 的依赖：

```sh
git clone https://github.com/modelctx-ai/ctx ../ctx
pnpm -C ../ctx install && pnpm -C ../ctx build
pnpm install
```

`pnpm-workspace.yaml` 的 `overrides` 把 `@modelctx-ai/ctx*` 链到 `../ctx/packages/*`，读的是 ctx 的 `dist/`。改了 ctx 要在 ctx 里重新 `pnpm build`。ctx 发布以后删掉 `overrides`，同样的 `^0.1.0` 从 npm 解析。三个仓库怎么分工、怎么一起联调，见 [ctx 仓库](https://github.com/modelctx-ai/ctx)的 `docs/repos.md`。

## 运行

复制 `config.example.json` 为 `config.json`，填上 Fish Audio 的 `apiKey` 和 `referenceId`。`config.json` 不进版本库。示例里打开了 `listen.enabled`，不想说完就听就改成 `false`。

| 命令                                | 作用                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `pnpm start`                        | 常驻：马上说一句，之后按 `intervalSec` 重复，默认 5 分钟                  |
| `pnpm once`                         | 只说一句                                                                  |
| `pnpm bake`                         | 把固定台词预先合成到 `~/.yoyo/speech-cache`                               |
| `pnpm yoyo <领域>`                  | 命令行，等于 `node bin/yoyo.js`，见[命令](#命令)                          |
| `pnpm test`                         | `vp test`：Vitest 跑 `src/` 和 `packages/` 下的 `*.test.ts`               |
| `pnpm typecheck`                    | `vp check --no-fmt --no-lint`：只做类型检查（tsgolint，TS 7），不产出文件 |
| `pnpm lint`                         | `vp lint`：Oxlint，带类型信息的规则，同时报类型错误；有警告也算失败       |
| `pnpm format` / `pnpm format:check` | `vp fmt`：Oxfmt 改写 / 检查                                               |
| `pnpm check`                        | `vp check`（格式、lint、类型）再 test；CI 跑同样几步                      |

测试、lint、格式和类型检查用 [Vite+](https://viteplus.dev/)（`vite-plus`，命令 `vp`），配置在 `vite.config.ts`。应用本身仍由 Node 直接运行 `.ts`，没有构建步骤。

## 配置

旧的 `config.json` 原样可用，和旧版一样宽松：

- 每个键都有缺省值，认不出的键保留不报错；整段写成 `null` 当没写。
- 数字可以写成字符串（`"600"`）；不是数、或者超出范围就按缺省值。
- 开关只认 `true`、`false` 和字符串 `"true"`、`"false"`，别的按缺省值；选项写错或空着也按缺省值。
- `mcpServers` 里写错的服务器（没有 `command` 也没有 `url`）启动时跳过，记一行，不挡启动。
- `speech.model`、`speech.referenceId` 原样保留，不去空白：语音缓存按原文算文件名。

| 键                                         | 缺省                                             | 作用                                                                                                |
| ------------------------------------------ | ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `stage`                                    | `dsh-pet`                                        | `console` 只在终端打印台词                                                                          |
| `pet.baseUrl`                              | `http://127.0.0.1:3080/dsh-pet-7340`             | 桌宠接口                                                                                            |
| `pet.id`、`pet.surface`                    | `main`、`desktop`                                | 哪一只、哪一端；`pet.id` 也决定上下文线程 `pet:<id>`                                                |
| `intervalSec`                              | `300`                                            | 日常碎碎念的间隔，最少 60                                                                           |
| `speech.apiKey`、`speech.referenceId`      | 空                                               | Fish Audio 的密钥和声音；驱动桌宠时必填，控制台模式没填就只出字                                     |
| `speech.baseUrl`、`speech.model`           | `https://api.fish.audio/v1/tts`、`s2.1-pro-free` |                                                                                                     |
| `speech.autoplay`                          | `true`                                           | `false` 只出字，不放语音                                                                            |
| `speech.tone`                              | `lively`                                         | 朗读右键对话回复用的语气                                                                            |
| `llm.provider`                             | `openai-compatible`                              | 或 `anthropic`                                                                                      |
| `llm.baseUrl`、`llm.apiKey`、`llm.model`   | 空                                               | 配齐了才让模型写碎碎念和回复；`anthropic` 可以不写 `baseUrl`                                        |
| `llm.tools`                                | `false`                                          | 回复时让模型调用工具：搜索、天气、闹钟，以及 `mcpServers` 里的工具                                  |
| `listen.enabled`、`listen.seconds`         | `false`、`5`                                     | 说完听回应，听几秒（1–10）；和旧版一样，不写就不听，示例配置里打开了                                |
| `listen.device`                            | `:0`                                             | ffmpeg 的 avfoundation 音频设备                                                                     |
| `listen.action`                            | `碎碎念-对屏碎碎念`                              | 开始听时播的动作                                                                                    |
| `asr.model`、`asr.bin`                     | `tiny`、`whisper-cli`                            | 识别模型和 whisper.cpp 命令行                                                                       |
| `anysearch.script`、`anysearch.command`    | 空                                               | anysearch 脚本（`node <script>`），或整条命令（argv 数组，给了就不用 `script`）；都没有就不搜       |
| `anysearch.apiKey`、`anysearch.maxResults` | 空、`3`                                          | 密钥只经环境变量交给子进程                                                                          |
| `clipboard.enabled`                        | `true`                                           | `false` 不读粘贴板，提示词里也不带                                                                  |
| `hotkey.enabled`                           | `true`                                           | macOS 上的 Control+Option+Y                                                                         |
| `context.maxTokens`                        | 不写                                             | 交给模型的历史上限（估算 token）；不写就整段带上                                                    |
| `context.compactAt`                        | 不写                                             | 历史超过这么多估算 token 时，把较早的部分压成摘要；不写就不压缩。`pnpm yoyo context compact` 手动压 |
| `context.keep`                             | `40`                                             | 压缩时原样保留最近几条消息                                                                          |
| `mcpServers`                               | `{}`                                             | MCP 服务器，常见的 `mcpServers` 写法；只在 `llm.tools` 打开时连接，写错的服务器跳过                 |

## 它怎么驱动宠物

桌宠需要已经用官方独立模式跑起来，例如：

```sh
cd /path/to/dsh-pet/dsh-pet
npm run build && npm run standalone
```

独立模式的写接口要带本机令牌。yoyo 每次请求都从 `~/.dsh/dsh-pet/standalone-runtime.json` 重新读，不把令牌抄进自己的配置。

说一句话时只调用这些官方接口：

1. `POST /lock` 占住这只宠物，避免它自己的事件插进来。
2. `POST /broadcast` 投喂台词。`anim` 固定为 `false`，不让它从碎碎念池里随机抽动作。
3. `POST /anim` 点名播放和这句话匹配的动作。
4. 本机 `afplay` 播放事先合成好的 mp3。天气这种当场才知道的句子，第一次会现合成，之后同一句走缓存。
5. `POST /lock/release` 放开。

另外用 `GET /state` 读工作状态和气泡变化，`GET /chat` 读桌宠的对话记忆，`POST /menu/item` 和 `GET /menu/events` 挂右键菜单，`POST /standalone-ai/settings` 把右键对话接到 yoyo。这些调用都在 `packages/dsh-pet`（`@yoyo/dsh-pet`）里。

`POST /whisper` 和 `POST /chat` 不调用。独立模式下那两条本来也不会生成文字。

## 命令

设计原则在 [docs/cli-principles.md](docs/cli-principles.md)。运行时怎么让路、听写、记日志，在 [docs/runtime-principles.md](docs/runtime-principles.md)。

顶层只列领域，不把参数一次倒出来。要看某个领域怎么用，再 `inspect`。

```sh
pnpm yoyo
pnpm yoyo alarm
pnpm yoyo alarm add --title 喝水 --time 15:30 --repeat daily
pnpm yoyo inspect alarm
pnpm yoyo find 粘贴
pnpm yoyo contact list
pnpm yoyo clip history
pnpm yoyo context tail
pnpm yoyo listen
pnpm yoyo whisper
```

`contact` 也可以写成 `contract`。`listen` 和 `whisper` 只有一个动作，所以不用再写 `now`。导演正在跑的时候，这两条交给它，不会再开一个进程去抢桌宠。

右键菜单的 yoyo 分组里有「碎碎念」和「听一句」。宠物原来的「碎碎念」仍然只打到它自己的接口，独立模式下不会叫到 yoyo。主动听语音也可以按 Control+Option+Y，这需要系统允许辅助功能。

## 说什么

语气按钟点选：凌晨和深夜平静，早上和晚上温和，上午中午明快，下午活泼。每档里大约一半概率抽一段稍长的笑话。同一句在 3 小时内不会再说，当前语气用完了就换别的语气。

预制台词都用完后，用 `llm` 按完整上下文再写一句：说过的碎碎念、听写和回复、桌宠右键对话，再加上这一刻的当前任务和粘贴板最近一条。任务来自宠物的工作状态，也可以放进本地任务（见[数据](#数据)）。

离下一句日常碎碎念还有一段时间，就用 anysearch 找一套表情包。碎碎念大约四成会带上一张，天气和闹钟不带。

工作日 17:00–18:59 每天先报一次未来几小时的天气。地点第一次按系统时区选城市（`Asia/Taipei` 用台北），认不出时区就按 IP 查，找到就记进库里。不对的话，在 `~/.yoyo/place.json` 写上 `name`、`latitude`、`longitude`，yoyo 下次打开库时导进去。

## 听和回复

`listen.enabled` 打开、`llm` 也配好时，碎碎念和模型现写的话念完会用麦克风听 5 秒，宠物同时面向你。素材里没有「侧耳听」这段动画，默认播 `碎碎念-对屏碎碎念`，可用 `listen.action` 改。识别用本机的 Whisper tiny（`~/.yoyo/models/ggml-tiny.bin`，第一次用时下载，由 `whisper-cli` 加载）。听写结果先弹出确认页，发送按钮倒计时 3 秒，没人动就用原文发送；有鼠标、键盘或改字就停下，等你自己发送或取消。天气播报和闹钟不听。`listen.enabled` 不写或设成 `false` 就不听。

听起来像提问时，用本机 anysearch 搜一下再回复。打开 `llm.tools` 以后不再按问句先搜，由模型自己决定要不要搜索、查天气、看或加闹钟。

右键「对话」仍是桌宠自己的输入框。常驻进程启动时开一个本机网关，把桌宠的模型地址改成它：桌宠带来的截断历史换成 yoyo 的完整上下文，再转发到 `llm.baseUrl`。桌宠拿到的密钥是每次启动新生成的本机令牌，真密钥只留在 yoyo 进程里。自动碎碎念仍由 yoyo 发，不打开桌宠自己的周期碎碎念。桌宠还没开、接不上时，每 30 秒再接一次，日志只记第一次。需要手动重接时运行 `pnpm yoyo chat sync`。`llm.provider` 是 `anthropic` 时不开网关，右键对话不经过 yoyo。

`speech.autoplay` 开着时，右键对话的回复也会转成语音播放；yoyo 自己刚投喂的句子不重复念。

## 让路和声音

日常碎碎念如果 30 秒内还有别的对话或提醒，就顺延到那些话停下来之后 30 秒。中间又说话，就再顺延一次。

每个动作会同时放一段很轻的配音，写代码是轻轻的按键，伸懒腰是一声拉长，发呆几乎听不见。音量大约是说话的两成。

## 联系人和日程

联系人现在只保存名字和对方的 yoyo 地址，后面用这个地址去联系别人的 yoyo。

```sh
pnpm yoyo contact list
pnpm yoyo contact add --name 小王 --yoyo yoyo://xiaowang@example --note 同事
```

日程可以是每天、每个工作日、每周某天，或某一天的一次闹钟。到点后 15 分钟内会说一次。`--kind task` 的任务到点先说「到点了。」。

```sh
pnpm yoyo alarm list
pnpm yoyo alarm add --title 喝水 --time 15:30 --repeat daily
pnpm yoyo alarm add --title 周报 --time 18:00 --repeat weekdays --kind task
pnpm yoyo alarm add --title 周会 --time 10:00 --repeat weekly --weekday 1
pnpm yoyo alarm add --title 开会 --time 09:30 --date 2026-10-24
```

## 数据

都在 `~/.yoyo`，`YOYO_HOME` 可以换：

| 位置                          | 内容                                                                                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `yoyo.db`                     | 联系人、日程、粘贴板（最近 50 条）、表情包、行为记录、说过的句子、本地任务、地点、天气日期、对话渠道地址；上下文在 ctx 的表 `ctx_entries`、`ctx_meta` 里 |
| `speech-cache/`               | 合成好的 mp3，文件名和以前一样，老缓存继续可用                                                                                                           |
| `sfx/`                        | 配音                                                                                                                                                     |
| `models/`                     | whisper.cpp 模型                                                                                                                                         |
| `bin/yoyo-hotkey`             | 第一次启动时编译的按键助手                                                                                                                               |
| `inbox.jsonl`、`director.pid` | 命令、菜单和按键交给常驻进程的请求；常驻进程的 pid                                                                                                       |

说过的话、听写、搜索、提醒、顺延、配音、加联系人、加日程、粘贴板变化，都记成行为记录，`pnpm yoyo log tail` 看最后 20 条。记录里不写密钥。

数据目录里有旧版的 JSON（`contacts.json`、`schedule.json`、`clipboard.json`、`context.json`、`memes.json`、`spoken.json`、`weather-reported.json`、`place.json`、`tasks.json`、`activity.jsonl`）时，yoyo 打开库时导进去一次，再改名成 `*.migrated`。想加本地任务，就写一份 `~/.yoyo/tasks.json`：`{"items": ["写周报"]}`。

`YOYO_CONFIG` 换配置文件，`YOYO_PET_RUNTIME` 换桌宠运行状态文件，`YOYO_WHISPER` 换 `whisper-cli`。

## 老用户

| 变化     | 说明                                                                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 命令     | `npm` 换成 `pnpm`，先按[安装](#安装)把 ctx 放到旁边。`node bin/yoyo.js` 照旧；`node src/main.js` 也照旧能启动常驻进程，它只是转到 `src/main.ts`    |
| 配置     | 旧 `config.json` 原样可用，新加的键都有缺省值，写错的值按缺省值算，和旧版一样不报错。`listen` 不写仍然不听                                         |
| 上下文   | 第一次启动把旧表 `context_items` 迁进 ctx（线程 `pet:<pet.id>`），旧表改名成 `context_items_migrated` 留着。迁移在一个事务里，失败就回滚，下次再试 |
| 右键对话 | 桌宠拿到的是本机令牌，不再是真的 `llm.apiKey`。升级后启动一次常驻进程，桌宠设置里存的旧密钥就被换掉                                                |
| 粘贴板   | 最近一条现在真的进了碎碎念和回复的提示词。以前的说明一直这么写，旧代码收集了却没交给模型。不想要就把 `clipboard.enabled` 设成 `false`              |
| 其余     | `yoyo.db` 里原有的表结构不变，语音缓存不用重新合成                                                                                                 |

## 文档

[docs/index.md](docs/index.md)：架构、命令原则、运行时原则。
