---
type: Guide
title: 子任务
description: 主线程把要花时间的事派给后台的子 agent：结构化的目标、验收标准和 todo，子 agent 边做边更新，做完把结果交回主线程。存在哪、工具、规则、怎么跑、怎么回到主线程、命令行和工作台。
resource: src/runtime/tasks.ts
tags: [runtime, brain, tasks]
status: stable
sources:
  - id: runner
    resource: src/runtime/tasks.ts
    title: 子任务的跑法
  - id: rules
    resource: src/features/tasks/tasks.ts
    title: 子任务的规则
  - id: tools
    resource: src/brain/tools.ts
    title: 本地工具
  - id: agents
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

主人平时只和主线程说话：桌宠、语音、工作台的主聊天都是同一个 yoyo。要花时间、要好几步的事（整理周报、查一圈资料再下结论），主线程不当场做，派成一个子任务交给后台的子 agent，马上回主人一句「开了个子任务」。子 agent 做完把结果交回主线程，主线程再转告主人；桌宠也会说一声。

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

# 工具

主线程和子 agent 用两份注册表，各自看不到对方的：[^tools] [^container]

| 谁       | 工具                                                       | 说明                                                                                                     |
| -------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 主线程   | `task_create`                                              | 派出去：标题、目标、验收标准。马上返回编号，不等做完                                                     |
| 主线程   | `task_list`、`task_show`                                   | 和命令行的 `yoyo task list`、`yoyo task show` 一样的文字                                                 |
| 主线程   | `task_cancel`                                              | 主人说不用做了时用                                                                                       |
| 子 agent | `task_plan`                                                | 拆 todo（或重新拆）：给整份清单，和原来一字不差的项保留状态                                              |
| 子 agent | `task_todo`                                                | 改一项的状态：开始标在做，做完马上标做完，不用做标跳过并写原因                                           |
| 子 agent | `task_finish`                                              | 交结果和逐条验收                                                                                         |
| 子 agent | `task_fail`                                                | 确实做不了：说清楚卡在哪、要什么                                                                         |

* 主线程的四个只在 `llm.tools` 和 `tasks.enabled` 都打开时有。此外每一轮的事实里列着还在排队和在做的子任务（来源 `tasks`），主人问「周报弄好没」不用先查。
* 子 agent 那份：本地工具（搜索、天气、日程），主线程那边经 MCP 和记忆执行的工具原样带过去，加上上面四个；没有派子任务的，子 agent 不会再派子任务。
* 子 agent 的工具都要带上任务编号，只对正在做的那个有效。工具调用不知道自己在哪个会话里，所以由参数带；编号对不上、任务已经结束，都回一句话说明。

# 规则

规则只有一份，在 `features/tasks`：子 agent 的工具、命令行、工作台都走它。不让做的事抛 `TaskError`，工具把这句话原样交回模型，模型据此改正。[^rules]

* 交结果前：todo 都要做完或跳过；每条验收标准都要有一项检查，原文对得上；都要满足。差什么就把差的那几项列出来交回去。
* 跳过 todo 要写原因。
* 重新拆 todo 时，做完的不会被冲掉。
* 交不了（`task_fail`）随时可以；取消只对排队和在做的有效。

# 怎么跑

常驻进程里一个 `TaskRunner`，一次做一件，排队的按编号先后。[^runner]

1. 开始时先让子任务专用的编排器 `recover()`，再把状态还是「在做」的放回排队：上次常驻进程没做完就退出了。
2. 取最早排队的，标成在做。第一轮把任务说明（编号、目标、验收标准）作为输入交给子 agent；接着做的那次，换成下面的「催一句」。
3. 子 agent 在会话 `task:<编号>` 上跑一轮（`record: true`），一轮最多 20 步，一次模型调用最多等 90 秒。做法写在它的指令里：先 `task_plan`，边做边 `task_todo`，对完验收标准 `task_finish`，做不了 `task_fail`。[^agents] [^prompts]
4. 一轮停下了但任务还在做：带上 todo 的现状催它接着做（「还没交结果，现在的 todo……」），最多 6 轮；6 轮还没交就记成没做成。模型出错也记成没做成，原因是那句错误（密钥抹掉）。
5. 每 2 秒看一眼有没有在别处被取消（命令行、工作台、主线程的 `task_cancel`）：取消了就停下这一轮。
6. 常驻进程要退出：停下这一轮，任务放回排队，下次启动接着做（从「催一句」开始，todo 都还在）。

子任务专用的编排器配了 `owner: 'yoyo-tasks'`：它的运行写 `ctx.run.*`，崩溃后 `recover` 只收自己的。主线程的碎碎念和回复照旧 `record: false`。[^container]

# 回到主线程

做完、没做成、取消，都往主会话写一条 `task` 事件：「子任务 #3「整理周报」做完了。结果：……」。主线程的投影把它变成一条「系统消息：……」的用户消息，下一轮就看得到，主人问起能直接答；工作台的主聊天里是一张卡片，点开看详情。[^runner] [^context]

编排器每一拍看一眼：做完和没做成、还没报过的，桌宠说一声「「整理周报」做好啦，结果放在工作台里。」，记下报过了；取消的不说。`tasks.notify` 关掉就只记下不说。[^orchestrator]

# 命令行和工作台

| 命令                                          | 说明                                                       |
| --------------------------------------------- | ---------------------------------------------------------- |
| `yoyo task list`                              | 最近 20 个：编号、状态、todo 进度、标题                    |
| `yoyo task show <编号>`                       | 目标、验收标准、todo、验收、结果或原因                     |
| `yoyo task log <编号>`                        | 子 agent 一步步做了什么：收到的话、说的话、调的工具和结果  |
| `yoyo task add --title … --goal … --criteria "a；b"` | 自己派一个，验收标准用分号隔开                      |
| `yoyo task cancel <编号>`                     | 取消                                                       |

工作台的聊天列表里列着子任务（状态、进度），点开是详情：状态、进度条、目标、验收标准（交了以后带上满足没有和凭什么）、todo、结果、过程。在做的每 4 秒刷新。接口见[管理页](web.md#接口)。

# 还没做

* 一次只做一件；排队的多了要等。
* 交付物（文件、表格、图）：现在结果只有文字，见[工作台](workbench.md)的提案。
* 子任务过程里要问主人的事：现在只能交不了，说清楚要什么，由主线程转告。
* 工作台里自己派子任务（现在只能经主线程或命令行）。

[^runner]: 子任务的跑法
[^rules]: 子任务的规则
[^tools]: 本地工具
[^agents]: agent 配置
[^prompts]: 指令
[^context]: 上下文
[^container]: 组装根
[^orchestrator]: 编排器
[^repos]: 存储
