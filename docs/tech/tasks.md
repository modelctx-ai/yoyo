---
type: Guide
title: 子任务
description: 主线程把要花时间的事派给后台的子 agent：结构化的目标、验收标准和 todo，子 agent 边做边更新，做完把结果和交付物交回主线程。存在哪、工具、交付物、规则、怎么跑、怎么回到主线程、命令行和工作台。
resource: src/runtime/tasks.ts
tags: [runtime, brain, tasks]
status: stable
sources:
  - id: runner
    resource: src/runtime/tasks.ts
    title: 子任务的跑法
  - id: artifacts
    resource: src/features/tasks/artifacts.ts
    title: 交付物
  - id: files
    resource: src/storage/artifacts.ts
    title: 交付物的文件
  - id: rules
    resource: src/features/tasks/tasks.ts
    title: 子任务的规则
  - id: tools
    resource: src/brain/tools.ts
    title: 本地工具
  - id: agents
    resource: src/features/tasks/agents.ts
    title: 子 agent 类型
  - id: agent-config
    resource: src/brain/agents.ts
    title: agent 配置
  - id: prompts
    resource: src/brain/prompts.ts
    title: 指令
  - id: context
    resource: src/brain/context.ts
    title: 上下文
  - id: container
    resource: src/app/container.ts
    title: 组装根
  - id: orchestrator
    resource: src/runtime/orchestrator.ts
    title: 编排器
  - id: repos
    resource: src/storage/repos.ts
    title: 存储
---

# 做什么

主人平时只和主线程说话：桌宠、语音、工作台的主聊天都是同一个 yoyo。要花时间、要好几步的事（整理周报、查一圈资料再下结论），主线程不当场做，派成一个子任务交给后台的子 agent，马上回主人一句「开了个子任务」。子 agent 做完把结果交回主线程：一条通知进主会话，叫醒主线程跑一轮，用自己的话转告主人，桌宠说出来。

这套机制照着 Claude Code 的后台子 agent 做，见[和 Claude Code 的对应](#和-claude-code-的对应)。

子任务是结构化的：

| 部分     | 谁写的       | 说明                                                                 |
| -------- | ------------ | -------------------------------------------------------------------- |
| 标题     | 主线程       | 一句话，像待办事项                                                   |
| 目标     | 主线程       | 要做成什么样、背景、范围、交回什么。子 agent 只看得到这段            |
| 验收标准 | 主线程       | 一条一句、能检查的，最多 8 条。可以没有，但最好有                    |
| todo     | 子 agent     | 自己拆，最多 20 项；每项待做、在做、做完、跳过，跳过要写原因         |
| 验收     | 子 agent     | 交结果时逐条对验收标准：满足没有、凭什么                             |
| 结果     | 子 agent     | 主人能直接看的样子，原样交回主线程                                   |
| 状态     | 常驻进程     | 排队、在做、做完、没做成（带原因）、取消了                           |

[^rules]

# 存在哪

`yoyo.db` 的 `agent_tasks` 表，一个子任务一行，编号从 1 往上数；验收标准、todo、验收结果存成 JSON 列。子 agent 每一轮的输入、说的话、工具调用和结果，记在 ctx 的会话 `task:<编号>` 里，和主线程的会话在同一个存储。[^repos] [^context]

交付物另外放：文件在 `~/.yoyo/artifacts/<编号>/<文件名>`，`yoyo.db` 的 `artifacts` 表一个文件一行（编号、子任务、文件名、类型、大小、时间），同一个子任务里文件名不重复。见下面的「交付物」。

# 工具

主线程和子 agent 用两份注册表，各自看不到对方的：[^tools] [^container]

| 谁       | 工具                                                       | 说明                                                                                                     |
| -------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 主线程   | `task_create`                                              | 派出去：标题、目标、验收标准、子 agent 类型（不写是 `general`）。马上返回编号，不等做完                  |
| 主线程   | `yoyo`                                                     | 看进度和结果：跑命令行的 `task list`、`task show <编号>`、`task log <编号>`、`search`，见[命令原则](cli-principles.md#给-agent-用) |
| 主线程   | `task_cancel`                                              | 主人说不用做了时用                                                                                       |
| 子 agent | `task_plan`                                                | 拆 todo（或重新拆）：给整份清单，和原来一字不差的项保留状态                                              |
| 子 agent | `task_todo`                                                | 改一项的状态：开始标在做，做完马上标做完，不用做标跳过并写原因                                           |
| 子 agent | `task_deliver`                                             | 交一个文件：写出的内容（Markdown、CSV、JSON，图片给 base64），或者 `path` 指工作区里已有的（写好的、跑命令生成的），见下面的「交付物」 |
| 子 agent | `task_finish`                                              | 交结果和逐条验收                                                                                         |
| 子 agent | `task_fail`                                                | 确实做不了：说清楚卡在哪、要什么                                                                         |

* `task_create`、`task_cancel` 只在 `llm.tools` 和 `tasks.enabled` 都打开时有；`yoyo` 在 `llm.tools` 打开时就有。看子任务不另做工具，和主人在终端里敲的是同一套命令。此外每一轮的事实里列着还在排队和在做的子任务（来源 `tasks`），主人问「周报弄好没」不用先查。
* 子 agent 那份：本地工具（搜索、天气、日程、`yoyo`、[读写文件和跑命令](files.md)），主线程那边经 MCP 和记忆执行的工具原样带过去，加上上面五个；没有派子任务的，子 agent 不会再派子任务。
* 子 agent 的工具都要带上任务编号，只对正在做的那个有效。工具调用不知道自己在哪个会话里，所以由参数带；编号对不上、任务已经结束，都回一句话说明。

# 交付物

子任务交回来的不只一段文字：整理好的周报、对比表、图，用 `task_deliver({ id, name, content, encoding? })` 交成文件；已经在工作区里的用 `path` 交，按 `read` 的规则查，名字缺省用原来的。用 `write` 写好的，或者 `general` 用 `bash` 跑脚本生成的（例如画图脚本输出的 `plot.png`，脚本把它写在工作区里），都能这样交，不用再抄一遍内容。[^artifacts] [^files]

* **只能写进自己那个目录。** 文件放在 `~/.yoyo/artifacts/<编号>/`。文件名只留最后一段（`../../x.md` 变成 `x.md`），去掉控制字符；空的、`.` 开头的、超过 100 字的不收。存的时候再挡一次：拼出来的路径出了这个子任务的目录就报错。目录 0700、文件 0600。不给通用的写文件工具。
* **只交给在做的那个子任务。** 排队的、已经结束的交不了。
* **大小和个数。** 单个最多 5 MB，一个子任务最多 20 个；同名的再交一次换成新的，编号不变。
* **类型按扩展名。** `md`、`txt`、`csv`、`tsv`、`json` 是文本，`png`、`jpg`、`gif`、`webp` 是图片，工作台里直接看；HTML、SVG 能带脚本，和别的一样只给下载。
* **回到主线程。** 写回主会话的那条加一行「交付物（在工作台里）：周报.md（1.2 KB）」，`<task-notification>` 里多一段 `<artifacts>`，转告时让它说「周报放在工作台里了」。`yoyo task show` 也列出来。
* **删。** 子任务不删，交付物跟着留着；不要了在工作台或命令行里一个个删，文件和记录一起删。

# 子 agent 类型

照 Claude Code 的 `subagent_type`：每种类型有名字、什么时候用、自己的指令和工具清单，主线程派子任务时挑一种。`task_create` 的说明里列着每种类型的名字和「什么时候用」，主线程按它挑；挑了没有的，回一句「没有「x」这种子 agent，有：……」。[^agents] [^tools]

| 内置       | 什么时候用                                         | 工具                                                     |
| ---------- | -------------------------------------------------- | -------------------------------------------------------- |
| `general`  | 什么都能做，拿不准就用它                           | 全部（包括 `bash`）                                      |
| `research` | 上网查、对比、下结论，结论带出处；只读             | `web_search`、`weather_forecast`、`list_alarms`、`recall`、`yoyo`、`read`（没有 `bash`） |
| `writer`   | 把给的材料整理成周报、清单、摘要；不上网           | `recall`、`yoyo`、`read`、`write`、`edit`（没有 `bash`） |

主人自己加：`~/.yoyo/agents/<名字>.md`，一个文件一种，格式和 Claude Code 的 `.claude/agents/*.md` 一样：

```markdown
---
name: reviewer
description: 帮主人看 PR 描述写得清不清楚
tools: web_search, github__*
model: claude-haiku-5-5
---
你是看 PR 描述的子 agent。挑出说不清的地方，给改法。
```

* `name` 只能用小写字母、数字和 `-`，不写就用文件名；和内置的同名就盖掉内置的。
* `description` 必填，主线程按它挑。正文是这种类型的指令，接在做事的协议（拆 todo、一项一项标、验收、交结果）后面。
* `tools` 逗号分隔，`*` 结尾按前缀匹配（MCP 工具是 `<服务器>__<工具>`）；不写就是全部。清单里写了但没有的跳过。四个任务工具总是在。
* `model` 换一个模型，服务商、地址和密钥照 `llm`；建不起来就记一行，先用 `llm.model`。
* 写错的文件跳过、记一行，别的照用。常驻进程启动时读；改了文件要等下一次换配置或者重开 yoyo。

子任务记下派的是哪种（`agent_tasks.agent`，旧库启动时补上这一列，以前的都算 `general`）。做的时候按它配子 agent：指令、工具清单、模型；那种类型不在了（文件删了）就记成没做成。[^runner] [^repos]

# 规则

规则只有一份，在 `features/tasks`：子 agent 的工具、命令行、工作台都走它。不让做的事抛 `TaskError`，工具把这句话原样交回模型，模型据此改正。[^rules]

* 交结果前：todo 都要做完或跳过；每条验收标准都要有一项检查，原文对得上；都要满足。差什么就把差的那几项列出来交回去。
* 同一时间只有一项 todo 在做：上一项没标做完或跳过，就不能开始下一项。和 Claude Code 的 TodoWrite 一样，逼它做完一项马上标。
* 跳过 todo 要写原因。
* 重新拆 todo 时，做完的不会被冲掉。
* 交不了（`task_fail`）随时可以；取消只对排队和在做的有效。

# 怎么跑

常驻进程里一个 `TaskRunner`，同时做 `tasks.concurrency` 件（缺省 2，最多 8），多的排队，按编号先后。各自的会话、各自的取消，一件出错、取消、超时不碍着别的。[^runner]

1. 开始时先让子任务专用的编排器 `recover()`，再把状态还是「在做」的放回排队：上次常驻进程没做完就退出了。
2. 有空位就取最早排队的补上，标成在做；一件结束马上补下一件，不等下一次看。第一轮把任务说明（编号、目标、验收标准）作为输入交给子 agent；接着做的那次，换成下面的「催一句」。
3. 子 agent 在会话 `task:<编号>` 上跑一轮（`record: true`），一轮最多 20 步，一次模型调用最多等 90 秒。做法写在它的指令里：先 `task_plan`，边做边 `task_todo`，对完验收标准 `task_finish`，做不了 `task_fail`；后面接着这种类型自己的指令。[^agent-config] [^prompts]
4. 一轮停下了但任务还在做：带上 todo 的现状催它接着做（「还没交结果，现在的 todo……」），最多 6 轮；6 轮还没交就记成没做成。模型出错也记成没做成，原因是那句错误（密钥抹掉）。
5. 每 2 秒看一眼有没有在别处被取消（命令行、工作台、主线程的 `task_cancel`）：取消了就停下这一轮。
6. 常驻进程要退出：在做的都停下这一轮，放回排队，下次启动接着做（从「催一句」开始，todo 都还在）。

几件同时做时碰到共享的数据：库在常驻进程里同步读写，两件同时写不会写坏；两件同时加一模一样的日程（标题、时间、日期、重复、类型都一样），第二次交回已有的那条，不重复加。转告照旧排队，一个一个说，不抢话。[^rules]

子任务专用的编排器配了 `owner: 'yoyo-tasks'`：它的运行写 `ctx.run.*`，崩溃后 `recover` 只收自己的。主线程的碎碎念和回复照旧 `record: false`。[^container]

# 回到主线程

做完、没做成、取消，都往主会话写一条 `task` 事件：「子任务 #3「整理周报」做完了。结果：……」。主线程的投影把它变成一条「系统消息：……」的用户消息，下一轮就看得到，主人问起能直接答；工作台的主聊天里是一张卡片，点开看详情。[^runner] [^context]

结果写进主会话以后，`TaskRunner` 叫一声编排器的 `relayTask(编号)`，这个子任务排进转告的队列。先写、后叫，所以主线程被叫醒时历史里已经有结果。编排器下一拍处理队列，按结束的先后：[^runner] [^orchestrator]

1. 做完和没做成的叫醒主线程：用回复的 agent 跑一轮（工具、记忆、事实都和回复一样），最后一条临时用户消息是通知加一句该怎么转告：

   ```text
   <task-notification>
   <task-id>3</task-id>
   <status>completed</status>
   <title>整理周报</title>
   <result>
   ……
   </result>
   <checks>
   ✓ 三个项目都有：A、B、C 各一段
   </checks>
   </task-notification>

   你派出去的子任务做完了。用一两句话把结论告诉主人，挑最要紧的说；细节在工作台里，不用全念。
   ```

   没做成时状态是 `failed`，带 `<error>`，要它说清楚卡在哪、要主人做什么。
2. 它回的那句由桌宠说出来，记进主会话，和回复一样；算作说过话，碎碎念照样让路。模型出错就说一句固定的「「整理周报」做好啦，结果放在工作台里。」。
3. 取消的不叫醒。`tasks.notify` 关掉也不叫醒，结果照样在主会话里，主人问起能答。
4. 处理过的记下 `announcedAt`，不再说。常驻进程开始时，上次没转告完的补进队列。

# 和 Claude Code 的对应

| Claude Code                                                        | yoyo                                                                                                  |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Agent（Task）工具：`description` 加 `prompt`，子 agent 另起上下文 | `task_create`：标题、目标，另加验收标准；子 agent 在自己的会话 `task:<编号>` 上跑                     |
| `subagent_type`：`.claude/agents/*.md` 定义名字、什么时候用、指令、工具、模型 | `task_create` 的 `agent`：内置三种，`~/.yoyo/agents/*.md` 同样的格式                              |
| 子 agent 的工具按定义挑，不能再派子 agent                          | 按类型的清单从子 agent 那份注册表里挑，没有派子任务的工具                                             |
| `run_in_background`：后台跑，主线程接着聊                          | 子任务总在后台跑，`task_create` 马上返回                                                              |
| 一次派出多个后台子 agent，同时跑                                   | 同时跑 `tasks.concurrency` 件，多的排队                                                               |
| 看输出、停下                                                       | `yoyo` 工具跑 `task show`、`task log`（和终端里一样），`task_cancel`                                  |
| TodoWrite：整份清单、待做 / 在做 / 做完，同一时间一项在做          | `task_plan` 给整份清单，`task_todo` 改一项；多一个跳过（要原因），同一时间一项在做由规则挡住          |
| 子 agent 最后一条消息就是结果                                      | `task_finish` 交的结果，交之前逐条对验收标准                                                          |
| 后台任务结束，`<task-notification>` 进主会话、叫醒主线程           | 同样：结果写进主会话，`<task-notification>` 交给主线程跑一轮，转告由桌宠说出来                        |

# 命令行和工作台

| 命令                                          | 说明                                                       |
| --------------------------------------------- | ---------------------------------------------------------- |
| `yoyo task list [--state running,queued]`     | 最近 20 个：编号、状态、todo 进度、标题；`--state` 只列这几种 |
| `yoyo task show <编号>`                       | 目标、验收标准、todo、验收、结果或原因                     |
| `yoyo task log <编号>`                        | 子 agent 一步步做了什么：收到的话、说的话、调的工具和结果  |
| `yoyo task add --title … --goal … --criteria "a；b" --agent …` | 自己派一个，验收标准用分号隔开，类型不写是 `general` |
| `yoyo task agents`                            | 有哪些类型：名字、什么时候用、工具、模型、从哪来           |
| `yoyo task cancel <编号>`                     | 取消                                                       |
| `yoyo artifact list [--task <编号>]`           | 交付物：编号、子任务、大小、类型、文件名                   |
| `yoyo artifact show <编号>`                    | 文本的打出内容，别的打出类型和位置                         |
| `yoyo artifact rm <编号>`                      | 删一个，文件和记录一起删                                   |

工作台侧栏列着子任务（在做的排最前，标题旁写着几件在做、几件排队），点开是详情：状态、进度条、目标、验收标准（交了以后带上满足没有和凭什么）、todo、结果、交付物、过程。交付物一行一个：文本和图片能展开预览，浏览器里能下载，yoyo.app 的窗口里换成「在访达里显示」（WKWebView 下载不了），都能删。在做的每 4 秒刷新。接口见[管理页](web.md#接口)。

# 还没做

* 用别的程序生成的文件（例如画图脚本的输出）还交不了，要等能跑命令的工具（#37 第二步）。
* 子任务过程里要问主人的事：现在只能交不了，说清楚要什么，由主线程转告。
* 工作台里自己派子任务（现在只能经主线程或命令行）。

[^runner]: 子任务的跑法
[^artifacts]: 交付物
[^files]: 交付物的文件
[^rules]: 子任务的规则
[^tools]: 本地工具
[^agents]: 子 agent 类型
[^agent-config]: agent 配置
[^prompts]: 指令
[^context]: 上下文
[^container]: 组装根
[^orchestrator]: 编排器
[^repos]: 存储
