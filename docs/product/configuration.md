---
type: Reference
title: 配置
description: config.json 的每个选项、缺省值，以及写错时怎么办；MCP 服务器和它们的沙箱。
resource: src/app/config.ts
tags: [product, config]
status: stable
---

# 写法

从源码运行时，配置写在 yoyo 目录的 `config.json`，可以从 `config.example.json` 复制。安装包的配置在 `~/.yoyo/config.json`，第一次打开 yoyo 时从包里的示例复制过去；放在数据目录里，换新版本时替换整个 app 也不会丢。菜单「yoyo → 打开配置」能直接打开它。`YOYO_CONFIG` 可以换一个位置。

改了不用重启：常驻进程每秒看一眼 `config.json`，内容变了、读得出来，就在一两秒内换上，正在说的那句说完为止，下一句碎碎念的时间照旧。改坏了（不是 JSON，或者驱动桌宠却把语音删空了）只记一行，接着用原来的，改好了再换。两样要另外动一下：`pet.menu` 要关掉桌宠再开；没固定 `web.port` 时管理页的地址不变，固定成别的端口就换到那个端口。也可以在[工作台](usage.md#工作台)的「设置」里改。

配置是宽松的，写错不会挡住启动：

* 每个键都有缺省值，认不出的键保留不报错；整段写成 `null` 当没写。
* 数字可以写成字符串（`"600"`）；不是数、或者超出范围就按缺省值。
* 开关只认 `true`、`false` 和字符串 `"true"`、`"false"`，别的按缺省值；选项写错或空着也按缺省值。
* `mcpServers` 里写错的服务器（没有 `command` 也没有 `url`）启动时跳过，记一行。
* `sandbox` 写错的字段按缺省；但沙箱打开了却启动不了时，要放进沙箱的服务器都不启动，见[把 MCP 服务器关进沙箱](#把-mcp-服务器关进沙箱)。
* `speech.model`、`speech.referenceId` 原样保留，不去空白。

# 开关

想关掉哪样，就在 `config.json` 里把它写成 `false`，存好一两秒内生效；管理页的「设置」里也能直接点。

| 开关                | 缺省                         | 管什么                                                   |
| ------------------- | ---------------------------- | -------------------------------------------------------- |
| `listen.enabled`    | `false`，示例配置里是 `true` | 碎碎念说完听你回应                                       |
| `speech.autoplay`   | `true`                       | 放语音；关掉只出字                                       |
| `sfx.enabled`       | `true`                       | 每个动作配的轻音效                                       |
| `weather.enabled`   | `true`                       | 工作日傍晚报一次天气                                     |
| `memes.enabled`     | `true`                       | 空闲时找表情包，碎碎念时配一张                           |
| `clipboard.enabled` | `true`                       | 读粘贴板、交给模型                                       |
| `hotkey.enabled`    | `true`                       | Control+Option+Y 马上听一句                              |
| `llm.tools`         | `false`                      | 回复时让模型调用工具                                     |
| `memory.enabled`    | `false`                      | 记住主人，见[记忆](#记忆)                                |
| `sandbox.enabled`   | `false`                      | MCP 服务器放进沙箱，见[后面一节](#把-mcp-服务器关进沙箱) |
| `web.enabled`       | `true`                       | 管理页，见[日常使用](usage.md#工作台)                    |
| `tasks.enabled`     | `true`                       | 子任务：yoyo 把要花时间的事派到后台做，见[日常使用](usage.md#子任务) |
| `tasks.notify`      | `true`                       | 子任务做完或没做成时桌宠说一声                           |

关掉的只是自动的那一下：`weather.enabled` 关了，回复时打开工具的模型照样能查天气；`memes.enabled` 关了，`yoyo meme refresh` 照样能找。

# 选项

| 键                                         | 缺省                                             | 作用                                                                                                |
| ------------------------------------------ | ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `stage`                                    | `dsh-pet`                                        | `console` 只在终端打印台词                                                                          |
| `pet.baseUrl`                              | `http://127.0.0.1:3080/dsh-pet-7340`             | 桌宠接口                                                                                            |
| `pet.id`、`pet.surface`                    | `main`、`desktop`                                | 哪一只、哪一端；不同的 `pet.id` 各有一份对话记忆                                                    |
| `pet.menu.hide`                            | `["open-site", "show-balance", "whisper"]`       | 藏起来的桌宠自带菜单项，写 `[]` 全留着；见[右键菜单](#右键菜单)                                     |
| `pet.menu.top`                             | `true`                                           | yoyo 的菜单项放第一层；`false` 收进「更多」                                                         |
| `intervalSec`                              | `300`                                            | 日常碎碎念的间隔，最少 60                                                                           |
| `speech.apiKey`、`speech.referenceId`      | 空                                               | Fish Audio 的密钥和声音；驱动桌宠时必填，控制台模式没填就只出字                                     |
| `speech.baseUrl`、`speech.model`           | `https://api.fish.audio/v1/tts`、`s2.1-pro-free` | Fish Audio 的接口和模型                                                                             |
| `speech.autoplay`                          | `true`                                           | `false` 只出字，不放语音                                                                            |
| `speech.tone`                              | `lively`                                         | 朗读右键对话回复用的语气                                                                            |
| `llm.provider`                             | `openai-compatible`                              | 或 `anthropic`；两种右键对话都由 yoyo 回答                                                          |
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
| `weather.enabled`                          | `true`                                           | `false` 傍晚不报天气                                                                                |
| `memes.enabled`                            | `true`                                           | `false` 空闲时不找表情包，碎碎念也不配                                                              |
| `sfx.enabled`                              | `true`                                           | `false` 动作不配音效                                                                                |
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
| `sandbox`                                  | 关闭                                             | 把本机的 MCP 服务器放进沙箱程序（缺省 srt）里启动，见[后面一节](#把-mcp-服务器关进沙箱)             |
| `web.enabled`、`web.port`                  | `true`、`0`                                      | 管理页开不开、用哪个端口；`0` 是每次随机                                                            |
| `tasks.enabled`、`tasks.notify`            | `true`、`true`                                   | 子任务开不开（yoyo 要 `llm.tools` 打开才能派，命令行和工作台照样能看）、做完桌宠说不说              |

# 右键菜单

yoyo.app、`yoyo start`、`yoyo pet` 和从源码运行时 `pnpm pet` 开的桌宠，右键菜单按 `pet.menu` 排：`top` 打开时「碎碎念」「听一句」放在第一层，`hide` 里列的自带项藏起来。桌宠开的时候读一次，改了要关掉桌宠再开（`./yoyo start` 开的桌宠随 Control+C 一起关）。

| `hide` 里写    | 藏掉的自带项                                                                     |
| -------------- | -------------------------------------------------------------------------------- |
| `open-site`    | 打开网站：桌宠自己的模型设置页，右键对话交给 yoyo 以后用不上                     |
| `show-balance` | 查看余额：桌宠单独开的时候查不了                                                 |
| `whisper`      | 桌宠自己的碎碎念：内容也由 yoyo 写，但不配图、不记、说完不听，和 yoyo 的那项重复 |
| `chat`         | 对话                                                                             |
| `home`         | 回到初始位置                                                                     |
| `reload`       | 重载配置                                                                         |

「显示位置」「动作」「更多」藏不掉，别的程序加的菜单项还在「更多」里。自己另外开的桌宠不认这些设置，菜单和原来一样，yoyo 的两项在「更多」里。

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

# 把 MCP 服务器关进沙箱

有 `command` 的服务器是 yoyo 以你的身份启动的进程，能读写你能读写的所有文件，能连任何网络。打开 `sandbox` 后，yoyo 把每台这样的服务器改成由沙箱程序启动：

```text
srt --settings <设置文件> -- <command> <args…>
```

srt 是 Claude Code 用的沙箱程序（npm 包 `@anthropic-ai/sandbox-runtime`）。yoyo 不安装、不加载它，只改写启动命令；任何接受这条命令行的程序都可以写进 `sandbox.command`。有 `url` 的服务器不受影响。

```json
{
  "llm": { "tools": true },
  "sandbox": {
    "enabled": true,
    "command": "srt",
    "policy": {
      "network": { "allowedDomains": ["api.example.com"] },
      "filesystem": { "allowWrite": ["/home/me/notes"], "denyRead": ["~/.ssh"] }
    }
  },
  "mcpServers": {
    "notes": { "command": "node", "args": ["/path/to/notes-server.js"] },
    "via": { "command": "via", "args": ["serve"], "sandbox": false }
  }
}
```

| 键 | 缺省 | 作用 |
| --- | --- | --- |
| `sandbox.enabled` | `false` | 打开后，`mcpServers` 里有 `command` 的服务器都在沙箱程序里启动 |
| `sandbox.command` | `srt` | 沙箱程序和它自己的选项：一个字符串当一个程序名（可以是路径），或者一个数组，例如 `["srt", "--debug"]`。yoyo 在后面接 `--settings <文件> -- <命令…>` |
| `sandbox.policy` | 不写 | 交给沙箱程序的设置（srt 的 settings 格式），或一个 JSON 文件的路径（相对 `config.json` 所在目录），每次启动时读。yoyo 不检查里面的字段，由沙箱程序检查 |
| `mcpServers.<名字>.sandbox` | 不写 | 写 `false` 这台服务器不放进沙箱，例如自己会加沙箱的 `via serve` |

yoyo 在 `policy` 之上加几项，写成 yoyo 数据目录里的 `sandbox/settings-<哈希>.json`（目录只有你能进，文件只有你能读写，内容相同就复用）：

* `filesystem.denyWrite` 加上 yoyo 的数据目录（`YOYO_HOME`，缺省 `~/.yoyo`）、`config.json`，以及 `policy` 指向的文件。沙箱里的服务器改不了 yoyo 的库和配置，也就关不掉沙箱、放宽不了设置。
* `network.allowedDomains`、`network.deniedDomains`、`filesystem.denyRead`、`filesystem.allowWrite` 没写的补成空数组。

服务器的 `env`、`cwd` 照常生效：srt 在 `cwd` 里启动，把环境变量交给里面的进程。

**启动不了就不启动。** 沙箱打开了，但 `sandbox.command` 在 PATH 上找不到，或者 `policy` 指向的文件读不出、不是 JSON 对象，yoyo 记一行，例如：

```text
沙箱程序 srt 找不到，sandbox.enabled 打开了，这些 MCP 不启动：notes
```

这些服务器都不启动，不会退回到不加沙箱运行。有 `url` 的和写了 `"sandbox": false` 的照常连。srt 自己拒绝启动时（例如 `policy` 里的字段写错，`network.allowedDomains: Expected array, received string`；或者缺依赖），它的报错打在 yoyo 的标准错误上，这台服务器记一行「MCP notes 没连上：Attempted to send a request from a closed client」，同样不退回到不加沙箱。

## 装 srt

```sh
npm install -g @anthropic-ai/sandbox-runtime
srt --version
```

* **Linux** 上 srt 要 bubblewrap、ripgrep（`rg`）、socat 三个程序都在 PATH 上，缺一个就报 `Sandbox dependencies not available: …`。Debian、Ubuntu 上：`sudo apt install bubblewrap ripgrep socat`。
* **Ubuntu 24.04** 缺省 `kernel.apparmor_restrict_unprivileged_userns = 1`，bubblewrap 会报 `loopback: Failed RTM_NEWADDR: Operation not permitted`。给 `/usr/bin/bwrap` 一个 AppArmor profile 就行，不用改全局的 sysctl。写到 `/etc/apparmor.d/bwrap`：

  ```text
  abi <abi/4.0>,
  include <tunables/global>

  profile bwrap /usr/bin/bwrap flags=(unconfined) {
    userns,
  }
  ```

  再加载：`sudo apparmor_parser -r /etc/apparmor.d/bwrap`。
* **macOS** 上 srt 用系统自带的 Seatbelt。yoyo 只在 Linux（srt 0.0.81）上验证过。

## 沙箱里是什么样

* **文件**：整个文件系统只读，只有 `filesystem.allowWrite` 里的目录能写。HOME 也只读，写的时候报 `EROFS`。服务器要存东西，就把它的目录写进 `allowWrite`。
* **进程**：每台服务器在自己的 PID 命名空间里，看不到别的进程。
* **网络**：缺省全部拒绝。要连的域名写进 `network.allowedDomains`（用 `npx -y` 启动的服务器还要 `registry.npmjs.org`）。放行的流量经 srt 在本机开的代理走，沙箱里的进程拿到 `HTTPS_PROXY`、`HTTP_PROXY` 环境变量。`curl` 自动走代理；Node 的全局 `fetch` 缺省不看这两个变量，用 Node 写、靠 `fetch` 联网的服务器会解析不了域名（`EAI_AGAIN`）。给这台服务器加 `"env": { "NODE_USE_ENV_PROXY": "1" }`（Node 24.0、22.21 起有），`fetch` 就走代理。Node 22 会在标准错误上打一行 `EnvHttpProxyAgent is experimental`，不影响使用。
* **开销**：srt 每启动一台服务器大约多半秒，之后的调用不再经过 srt，和不加沙箱一样快。

## 不想逐台配置：经 via

[via](https://github.com/modelctx-ai/via) 能把它管的所有 MCP 服务器一起放进 srt。yoyo 只登记一台 `via serve`，并给它写 `"sandbox": false`（via 自己会加沙箱，srt 里再起 srt 会出问题）：

```json
{
  "llm": { "tools": true },
  "mcpServers": {
    "via": { "command": "via", "args": ["serve"], "sandbox": false }
  }
}
```

再在 via 的用户配置 `~/.config/via/config.yaml` 里打开它的沙箱：

```yaml
sandbox:
  enabled: true
```

经 via 调的服务器就都在 srt 里，yoyo 这边不用打开 `sandbox`。在一台 Linux 上测过：`via serve` 连上大约 540 ms，每调一次大约 400 ms（via 在沙箱里每次调用都重新启动服务器）。

## 它防什么、不防什么

沙箱限制的是服务器能写哪里、能连哪里，不是凭证隔离：

* 缺省能读的文件服务器照样能读，包括写着密钥的 `config.json` 和对话记忆所在的 `yoyo.db`。不想让它读，就写进 `filesystem.denyRead`。
* 服务器 `env` 里的密钥照样交给它。
* 它能连的域名上，它想发什么都能发。

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

| 变量               | 作用                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `YOYO_HOME`        | 数据目录，缺省 `~/.yoyo`                                                                                       |
| `YOYO_CONFIG`      | 配置文件                                                                                                       |
| `YOYO_PET_RUNTIME` | 桌宠运行状态文件，缺省 `~/.dsh/dsh-pet/standalone-runtime.json`                                                |
| `YOYO_WHISPER`     | `whisper-cli` 的位置                                                                                           |
| `YOYO_HOTKEY`      | 编好的按键助手；不设就第一次启动时用 `swiftc` 编到数据目录的 `bin/yoyo-hotkey`。安装包的启动脚本指向包里带的 |
