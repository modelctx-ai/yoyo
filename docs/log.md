# 文档更新记录

## 2026-10-30

* **新增** [工作台](tech/workbench.md)（提案，`status: proposed`，已做的部分以实现为准）：桌宠和工作台两种形态、同一份上下文和记忆；已经有的主聊天、聊天列表、心迹、日程、轨迹；工作台里聊一句走 `talk`、记进日志、不念；子聊天、子 agent 任务（`delegate`、后台跑、状态、取消、做完冒泡）、交付物（`deliver`、存放、面板）的提案和接口；分期 W0–W4；还没定的。索引、README 的技术文档表加这一篇。
* **更新** 管理页长成工作台：管理页的技术文档「做什么」「页面」改写，接口表加 `POST /api/chat` 和上下文的 `via`，写明 CSP 不许 `style` 属性。日常使用、功能介绍的「管理页」一节改名「工作台」，写明能打字聊、桌宠不念、状态在聊天列表下面、心迹和轨迹；安装与运行、配置里指向它的链接跟上；README 的功能列表改成「工作台」。
* **更新** [发版](tech/release.md)改成 yoyo.app 和拖动安装的 dmg：形态和目录结构、怎么发（Release 上挂 dmg 和 `.sha256`）、流水线；各部分加 app 外壳；启动脚本加 `YOYO_APP`；新加「app 外壳」（起常驻进程、窗口里放管理页、退出、没跑起来时、菜单、`app.pid`）和「app 内更新」（`yoyo update check`、`install`、`swap.sh` 每一步）；冒烟测试加外壳、`swap.sh`、跑完再验签名、挂上 dmg；「为什么」改写签名一条，加外壳很薄、窗口放管理页、只出 dmg、不用 Sparkle；「还没做」跟上。
* **更新** 安装与运行的「安装包」改成下载 dmg、拖进「应用程序」、第一次在「隐私与安全性」里点「仍要打开」、填配置再打开；新加「更新」「在终端里用」两节，对照表加「更新」一行。README 的快速开始跟上。
* **更新** 日常使用的「管理」和管理页写明用 yoyo.app 时在它的窗口里；命令行改用 `yoyo`。配置的「写法」、右键菜单跟上；数据加 `app.log`、`app.pid`、`updates/`；从旧版升级的「换成安装包」改成拖进「应用程序」。管理页的技术文档加 `yoyo web url` 和 app 的窗口；架构的读写位置加 `YOYO_APP`，目录表加 `src/app/update.ts`，右键「管理」跟上。索引跟上。

## 2026-10-29

* **更新** 配置热加载和在管理页改配置：管理页的技术文档加「改配置」「热加载」两节，接口表加 `/api/config` 三条，「还没做」去掉改配置；架构的「常驻进程」写明外层的 `supervise`。配置的「写法」写明改了不用重启、改坏了接着用原来的、`pet.menu` 和 `web.port` 的例外，「开关」改成存好一两秒内生效；安装与运行的「开关」、日常使用的管理页（加「设置」）、安装包的 README.txt 跟上。
* **新增** [管理页](tech/web.md)：做什么、在哪跑、安全（只听本机、Host、Origin、跨站、令牌、只收 JSON、CSP，令牌放在地址片段里）、接口表、页面怎么做、还没做的。索引和 README 的技术文档表加这一篇。
* **更新** 管理页跟上其余文档：日常使用的右键菜单加「管理」、新加「管理页」一节、常用命令加 `yoyo web open`；配置的开关表加 `web.enabled`，选项表加 `web.enabled`、`web.port`；功能介绍加「管理页」；README 的功能列表加一条。架构的分层图加 `web`，目录表加 `src/web`，常驻循环开管理页，`POST /menu/item` 一行加「管理」。运行时原则的「边界」写明菜单靠补丁、`POST /whisper` 和 `POST /chat` 是桌宠自己用的。
* **更新** 右键对话改由 yoyo 回答：架构的「右键对话」改成桌宠的请求交给编排器的 `chat` 跑回复的 agent（记忆、工具、MCP、搜索），只取最后一条用户消息、去掉配图清单，不写日志、问答照旧从桌宠并进来，算作说过话，55 秒取消，流式先回角色块；桌宠自带的「碎碎念」交给碎碎念的 agent；时序图重画；网关一行改成 `fetch` 换成 yoyo、哪种 `llm.provider` 都行；`POST /standalone-ai/settings` 一行加 `timeoutMs`。运行时原则第 4 条改写；记忆的 `lastTalk` 算上右键对话。功能介绍、配置的 `llm.provider`、README 跟上。
* **更新** 桌宠改用 npm 上上游发的 `dsh-pet`，右键菜单靠 yoyo 自带的补丁：配置的选项表加 `pet.menu.hide`、`pet.menu.top`，新加「右键菜单」一节（藏得掉哪些自带项、改了要重开桌宠、自己开的桌宠不认）；日常使用的「右键菜单」改成 yoyo 的两项在第一层、自带的三项缺省藏起来；安装与运行的「启动桌宠」改成 `pnpm pet`，另外要装的不再有 dsh-pet；README 的功能列表加一条，从源码运行加 `pnpm pet`。`config.example.json` 跟上。
* **更新** 架构：目录表加 `src/pet.ts`、`patches/` 和 `adapters/dsh-pet/patch.ts`；「怎么用 dsh-pet」写明桌宠从 npm 装、fork 只跟上游不改，补丁碰哪几处、`YOYO_PET_MENU` 怎么从 `pet.menu` 传到菜单页，`POST /menu/item` 一行跟上。开发：脚本加 `pnpm pet`、`pack:app` 是三个入口；新加「桌宠」一节（两处钉版本、peer 标成可选、怎么改补丁和升版本、上游已拆菜单文件）；CI 加上 deploy 桌宠的检查。发版：dsh-pet 不再检出和构建，改为按锁文件 `pnpm deploy`，Electron 版本取 dsh-pet 缺省下载的那个；启动脚本加 `YOYO_PET_ENTRY`，桌宠都经 `pet.mjs` 开；「为什么」加一条，「还没做」去掉固定 dsh-pet 版本。

## 2026-10-28

* **新增** 补上发版（提案，`status: proposed`，第一次推 tag 在真机上验证以后转为已实现）：推 `v*` tag 时 GitHub Actions 在 macOS 上打安装包并挂到 Release，手动跑只出构建产物；包的目录结构；yoyo 打成不依赖 node_modules 的单文件，Node、Electron、dsh-pet 独立模式、最小 LGPL ffmpeg、静态 whisper-cli、听写模型、按键助手各从哪来、怎么固定版本；启动脚本 `./yoyo` 设的环境变量、`start` 怎么开关桌宠、清隔离属性；冒烟测试查什么；为什么这样做；还没做的（Intel、签名公证、固定 ctx 和 dsh-pet 的 tag、单文件里依赖的许可）。索引和 README 的技术文档表加这一篇。
* **更新** 安装与运行改成两种装法：安装包（下载、解压、`./yoyo start`、配置在 `~/.yoyo/config.json`、换新版本替换目录）和从源码运行（原来的步骤，加上按键助手要 Xcode 命令行工具）；新加「开关」一节。README 的快速开始先写安装包。
* **更新** 配置：「写法」写明安装包的配置位置；新加「开关」一节，列出所有开关和缺省值，写明关掉的只是自动的那一下；选项表加 `weather.enabled`、`memes.enabled`、`sfx.enabled`；环境变量加 `YOYO_HOTKEY`。`config.example.json` 跟上。
* **更新** 功能介绍的音效、听你回应、天气、表情包各加一句怎么关；日常使用写明安装包用 `./yoyo`；数据加安装包的 `config.json`、`pet.log`，`models/` 和 `bin/yoyo-hotkey` 写明安装包怎么来；从旧版升级加「换成安装包」。
* **更新** 开发：工具链写明只有发版时构建、安装包里带着哪些程序；脚本加 `pnpm pack:app`；CI 加打包检查，并指向发版。架构：读写位置加 `YOYO_HOTKEY`，按键助手写明编好的直接用；编排器一拍的第 5 步和两张时序图注上 `memes.enabled`、`weather.enabled`、`sfx.enabled`；沙箱一节写明安装包的 `config.json` 在 `YOYO_HOME` 里。运行时原则加第 7 条「自动的那一下都能关」。

## 2026-10-27

* **更新** [更新记录](log.md)的条目标签从英文 `Update` / `Creation` 改成中文「更新 / 新增」，和 ctx 的 `docs/log.md` 一致；[开发](tech/development.md)「和 ctx 联调」里「记忆合进 ctx `main` 之前 CI 会红」的说明改成已合并后的写法。
* **新增** 补上 `AGENTS.md`：给人和 coding agent 的工作约定。文档的两类和 README 的边界、技术文档 frontmatter 各字段和脚注的写法、`proposed` 到 `stable` 的流程、`log.md` 记什么、`docs/` 不归格式化管；改代码时的依赖方向、改配置的四件事、密钥不进日志、测试不联网、依赖 ctx 未合并改动时 CI 会红的处理；提交信息的写法。开发的「文档」一节改指它。
* **更新** 配置加「把 MCP 服务器关进沙箱」：`sandbox` 的字段、yoyo 追加的设置、启动不了就不启动、装 srt 和 Linux 上的三个依赖、Ubuntu 24.04 的 AppArmor profile、沙箱里的文件、进程和网络（经代理，Node `fetch` 要 `NODE_USE_ENV_PROXY=1`）、经 `via serve` 的零改动路线、它不是凭证隔离。架构的目录表、常驻进程、执行环境跟上，「扩展」加「把 MCP 服务器关进沙箱」写做法和理由。索引、README、`config.example.json` 跟上。
* **更新** 记忆从提案改为已实现（`status: stable`），M0–M2 做完，M3 做了接线、没校准 `theta`。和提案不一样的地方以实现为准改了：碎碎念和回复各用一个记忆来源（`memory-whisper` 按当前任务召回，`memory` 按最近一条用户话召回），因为来源不知道这一轮是哪个 agent，两个 agent 的 `context.facts.sources` 由组装根给名单；天气和提醒由 `memorySessions` 在读日志这一层滤掉（`gate.entries` 挑不了 `meta`）；门控和整理都在后台跑，门控跳过时留到下一拍，整理失败当天不再试、成功记在 kv；过了 `consolidateAt` 当天都算，不是推到第二天；`yoyo memory consolidate` 不用模型，只做衰减归档和画像的缺省渲染；`forget` 对程序只能退役（ctx 没有删程序的方法）；`rules` 列没退役的程序并标出生效与否；`tail` 列状态（待整理、已整理、不记）。配置表写明每项的范围和写错时的处理，`decision`、`extraction` 是 `SystemOneSpec` 的写法，建模型出错记一行退回缺省。分期表加「状态」一列。
* **更新** 架构：目录表加 `brain/memory.ts`；常驻进程的一拍加第 8、9 步（门控、整理）；「和 ctx 组件的对应」的记忆一行去掉「提案」；「怎么用 ctx」的写入（`meta.kind`）、来源、事实（两份来源名单）、工具（`recall`）、执行环境跟上。开发：`overrides` 是七个包，加 `ctx-memory`，写明记忆要 ctx 带记忆的版本、合进 `main` 之前 CI 会红。索引的记忆一行去掉「提案」。
* **更新** 产品文档跟上记忆：功能介绍加「记住你」；配置的选项表加 `memory.*`，新加「记忆」一节；日常使用加 `memory` 命令；数据加 `memory_` 表和删除。README 的功能列表加一条，技术文档表加记忆。

* **新增** 补上记忆（提案，`status: proposed`）：机制在 ctx（`docs/memory.md`、ADR 0006），这里只写 yoyo 决定的事。桌宠记什么（六个主题：owner、work、people、routine、taste、fix）；哪些条目进门控（用户话、回复、右键对话并进来的；碎碎念、天气、提醒不进）；门控在拍子末尾异步跑；画像和召回经来源 `memory` 给两个 agent，位置和现有事实一样（碎碎念 `prompt`、回复 `instructions`），`recall` 工具只给回复且要 `llm.tools`；巩固在 `memory.consolidateAt`（缺省 03:00）且 30 分钟没对话时跑；存在 `yoyo.db` 的 `memory_*` 表；`config.json` 的 `memory` 一节；`yoyo memory` 命令（core、facts、history、rules、forget、consolidate、tail）；运行时原则五条；分期 M0–M3 和各期依赖的 ctx 包。索引加这一篇；架构的「和 ctx 组件的对应」加记忆一行。
* **更新** 架构「怎么用 dsh-pet」的 `POST /menu/item` 注明 `target: 'desktop'` 是照 dsh-pet 源码用的，`openapi.yaml` 里还没写。其余接口对照 dsh-pet `dfc0396` 核对过，都一致。
* **更新** 开发的「和 ctx 联调」补三条：要的是 ctx `main`（0.3.x），`link:` 不看版本范围；核心包的 `zod` peer 由 yoyo 的 `zod` 满足；`ai` 只在测试里用。CI 写明 ctx 取 `main` 最新提交、不固定版本。ctx 0.3 里删掉的弃用别名（`thread`、`ContextStore`、`add(name, tool)` 等）yoyo 都没用到，不用改。

## 2026-10-26

* **更新** 跟上 ctx 0.3（会话位置、消息格式、`AgentSpec.context`）。架构：事实的收法和位置写进两个 agent 的 `context`（碎碎念 `prompt`、回复 `instructions`），harness 直接用上下文的 builder；`yoyo context tail` 和桌宠对话按 `(at, seq)` 排；迁移加上 schema 3；新加「旧摘要」一行（常驻进程启动时、开拍子之前重新压缩被旧摘要盖住的记录，没有模型记警告，命令行不做）。运行时原则、开发（依赖 `^0.3.0`）同步；从旧版升级加「从上一版升级（ctx 0.3）」：先停常驻进程，库结构自动升级，旧版读不了。碎碎念最后一条用户消息里，事实和「请再说一句碎碎念。」之间由一个换行变成一个空行（builder 接提示的写法），其余交给模型的指令、消息和事实不变。
* **更新** 删掉绕开 ctx 缺口的代码（ctx 已合并「版本化迁移」和「小缺口」两处修复）。架构的「报错」改成直接读 `RunResult.error` 的 `statusCode`、`responseBody`，不再包一层模型记原始错误；「迁移」改成由 `createSqliteStore` 打开库时升级（`thread` 列改名、schema 升到 2），yoyo 只剩旧表 `context_items` 的迁移。运行时原则同步。用户可见的行为和文案不变。
* **更新** 编排改成实现 ctx 的 `Orchestrator`。架构：分层图和目录表加上编排器（`runtime/orchestrator.ts`）、harness（`brain/harness.ts`）和 agent 配置（`brain/agents.ts`）；「常驻进程」改成编排器、harness、导演、常驻循环各管什么和调用关系，拍子由编排器打；新加「和 ctx 组件的对应」；「怎么用 ctx」加上 agent、一轮、事实、报错的新做法；两条数据流改成编排器提交 → harness 跑 → 导演表演 → 记录；扩展里的「要开口」「要跑模型」跟上，工具例子改用 `addTool`。运行时原则：让路和记录写到编排器上，`resource` 改指编排器。索引的架构一行跟上。用户可见的行为和文案不变。
* **更新** 跟上 ctx 0.2（机械迁移）。架构的「怎么用 ctx」：线程改叫会话（`sessionFor`），记录写明 `record: false` 连 `ctx.run.*` 也不写，工具用 `addTool`、MCP hub 经 `executors` 交给上下文，压缩写明框架事件 `ctx.*` 不计入阈值、`context tail` 不列，迁移加上 `ctx_entries.thread` 列改名（`migrateSessionColumn`）。运行时原则的线程改成会话。开发里的 `overrides` 列出六个包（新加 `ctx-protocol`），版本改成 `^0.2.0`。从旧版升级加「从上一版升级（ctx 0.2）」：更新 ctx、对话记忆自动改名迁移。

## 2026-10-23

* **新增** 补上命令原则和运行时原则。顶层索引只链到这两篇。
* **新增** 代码改成分层的 TypeScript 工作区以后，补上架构：分层和依赖方向、各目录做什么、yoyo 怎么用 ctx 和 dsh-pet、三条数据流、扩展方法。索引加上这一篇，三个仓库的分工改指 ctx 仓库的 `docs/repos.md`，不在这里另写。
* **更新** 命令原则和运行时原则改指新的源文件（`src/cli/commands.ts`、`src/cli/registry.ts`、`src/runtime/director.ts`、`src/kernel/pace.ts`），并跟上行为变化：上下文存进 ctx 的表，桌宠右键对话拿本机令牌，粘贴板进提示词，压缩按配置才做，命令用到什么才打开什么。
* **更新** README 按新目录重写：要求、安装 ctx、pnpm 脚本、完整的配置表、数据位置、老用户要知道的变化。
* **更新** 跟上一轮修正：配置和旧版一样宽松（写错按缺省值，`listen` 缺省关闭，`mcpServers` 写错的服务器跳过）；控制台舞台不要求语音，别的系统不播放；对话渠道接不上时每 30 秒再接；压缩有 60 秒超时；按键助手由组装根给；`node src/main.js` 照旧能用。
* **更新** 文档分成产品和技术两类。README 只留产品介绍、快速开始和文档入口。原来 README 里的内容拆进 `product/`：功能介绍、安装与运行、日常使用、配置、数据、从旧版升级；脚本、工具链、ctx 联调和 CI 进 `tech/development.md`。架构、命令原则、运行时原则移到 `tech/`。索引按两类重排。
