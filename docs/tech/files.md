---
type: Guide
title: 读写文件和跑命令
description: 主线程和子 agent 内置的 read、write、edit、bash 四个工具：工作区能读能写，只读目录只能读，配置、yoyo 自己的数据和密钥读不到，最具体的规则说了算；bash 一律经 srt 沙箱跑，只能写工作区，网络缺省全关；转告那一轮不给；开关写 ask 时每次动手前要主人在工作台里批准。
resource: src/brain/files.ts
tags: [brain, tools, files]
status: stable
sources:
  - id: files
    resource: src/brain/files.ts
    title: 读写文件的工具
  - id: bash
    resource: src/brain/bash.ts
    title: bash 工具
  - id: sandbox
    resource: src/brain/sandbox.ts
    title: 沙箱设置
  - id: action
    resource: src/brain/action.ts
    title: 工具的动作和 ask 的接法
  - id: gate
    resource: src/brain/approvals.ts
    title: 记批准请求
  - id: approvals
    resource: src/features/approvals/approvals.ts
    title: 批准请求的规则
  - id: runner
    resource: src/runtime/approvals.ts
    title: 批准以后照做
  - id: access
    resource: src/features/files/access.ts
    title: 范围
  - id: config
    resource: src/app/config.ts
    title: 配置
  - id: container
    resource: src/app/container.ts
    title: 组装根
  - id: orchestrator
    resource: src/runtime/orchestrator.ts
    title: 编排器
---

# 做什么

yoyo 的主线程和子 agent 内置四个工具，照 Claude Code 和 pi 的 read、write、edit、bash。[^files]

| 工具 | 做什么 |
| --- | --- |
| `read` | 读一个文件，带行号，一次最多 2000 行，长文件用 `offset`、`limit` 分段；一行超过 2000 字截断，一次最多交回 6 万字；二进制只报大小；目录列出来（目录带 `/`，文件带大小，最多 200 项） |
| `write` | 写一个文本文件，已有的整个换掉，目录不在就建；最大 5 MB |
| `edit` | 把一段原文换成新的：原文要一字不差、只出现一次，`all: true` 全换；新文里的 `$` 照原样写 |
| `bash` | 在工作区里跑一条命令，一律经沙箱程序，见[跑命令](#跑命令)；沙箱程序找不到就没有这个工具 |

`llm.tools` 打开才有。`files.read`、`files.write`、`files.edit`、`files.bash` 各自有三个值：`allow` 直接做（缺省），`ask` 给，但每次动手前要主人在工作台里批准（见[先问](#先问)），`deny` 不给。

# 能碰哪里

碎碎念和转告是 yoyo 自己发起的，语音会听错，桌宠气泡里也没法弹「要不要」。所以主要靠范围把关，要问的时候也不在这些地方问，而是[在工作台里问](#先问)。[^access]

| 哪里 | 读 | 写 |
| --- | --- | --- |
| 工作区：`files.workspace`，缺省 `~/.yoyo/workspace`，启动时建好 | 能 | 能 |
| 子任务的交付物 `~/.yoyo/artifacts/` | 能 | 不能（交文件用 `task_deliver`） |
| `files.readable` 里的 | 能 | 不能 |
| 数据目录 `~/.yoyo`、`config.json`、`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.kube`、`~/.docker`、`~/.netrc`、`~/.config/gcloud`、`~/Library/Keychains`、`files.denyRead` 里的 | 不能 | 不能 |
| 别处 | 不能 | 不能 |

* **最具体的那条说了算。** 一条路径落在好几条规则里时，目录最深的那条定，一样深时不给。所以数据目录整个不给，它下面的工作区和交付物照样能读；`files.readable` 给了 `~/Documents`，`files.denyRead` 再挡掉 `~/Documents/private`。
* **先解析成真实路径再比。** `~` 开头算主目录，相对路径从工作区算起，再顺着符号链接解析（还不存在的部分原样接上），所以工作区里指到外面的链接也出不去。规则里的路径也一样先解析。
* **范围先查，批准不能扩大范围。** 开关是 `ask` 时也一样：不在范围里的调用不会变成批准请求，直接像平时一样拒绝；批准以后照做之前再查一遍（文件这时可能变了）。
* **写和改记进轨迹。** `file-write`（路径、大小）、`file-edit`（路径、换了几处）；路径在工作区里的写相对路径。

# 谁有

* **主线程**：回复、右键对话、工作台聊天这几轮有。**转告子任务结果的那一轮没有**：编排器按 `OWNER_TOOL_NAMES`（`read`、`write`、`edit`、`bash`）去掉这几个，别的工具照给。碎碎念那一轮本来就不给工具。[^orchestrator]
* **子 agent**：`general` 全部（包括 `bash`）；`research` 有 `read`；`writer` 有 `read`、`write`、`edit`，两个都没有 `bash`。主人自己加的类型在 `tools` 里写名字，写了 `bash` 才有。
* **交付物**：`task_deliver` 多一个 `path`，把工作区里已有的文件交上来，按 `read` 的规则查，名字缺省用原来的。用 `write` 写好的、用 `bash` 跑脚本生成的（例如画图脚本输出的 `plot.png`）都在工作区里，照样能交。[^container]

# 跑命令

`bash({ command, timeout? })`：每次新开一个 shell（`bash -c`，找不到 `bash` 用 `/bin/sh -c`），工作目录是工作区，`cd` 和变量不留到下一次，没有输入（读输入马上读到结尾）。[^bash]

**一律经沙箱。** 命令行是 `<sandbox.command…> --settings <文件> -- <shell> -c <命令>`，和 [MCP 服务器的沙箱](architecture.md#把-mcp-服务器关进沙箱)同一套：用 `sandbox.command` 找程序（缺省 srt），设置文件写到 `YOYO_HOME/sandbox/`，`brain/sandbox.ts` 是 yoyo 唯一知道 srt 设置形状的地方。`sandbox.enabled` 只管 MCP 服务器，和这里无关：`files.bash` 给了、沙箱程序找得到，`bash` 就在沙箱里跑。[^sandbox]

**设置怎么拼。** `bash` 另拼一份设置，不直接用 MCP 的那份，因为两边要的范围不同（MCP 服务器要连自己的服务、写自己的目录，`bash` 只该碰工作区）：

| 字段 | 内容 |
| --- | --- |
| `filesystem.allowWrite` | 工作区，加一个专用临时目录（`<系统临时目录>/yoyo-bash-<uid>`，0700，命令的 `TMPDIR` 指向它）。别处都写不了 |
| `filesystem.denyRead` | 和 `read` 读不到的位置是同一份：数据目录、`config.json`、`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.kube`、`~/.docker`、`~/.netrc`、`~/.config/gcloud`、`~/Library/Keychains`、`files.denyRead`，再加 `sandbox.policy` 里写的 |
| `filesystem.allowRead` | 工作区缺省在数据目录里，数据目录整个读不到，所以把落在被挡目录里面的工作区、交付物、`files.readable` 放回来（srt 里 `allowRead` 盖过 `denyRead`） |
| `filesystem.denyWrite` | `sandbox.policy` 里写的，加上数据目录、`config.json`、`policy` 文件里**落在工作区里面**的（工作区设成 `~` 这类大目录时用得上）。包着工作区的不加：`denyWrite` 盖过 `allowWrite`，加了工作区就写不了 |
| `network.allowedDomains` | `files.bashNetwork`，缺省空，网络全关。`sandbox.policy` 给 MCP 服务器放行的域名不借给 `bash` |
| `network.deniedDomains` | `sandbox.policy` 里写的 |
| 别的字段 | `sandbox.policy` 里和范围无关的原样保留，例如 `enableWeakerNestedSandbox` |

* **和 `read` 不一样的地方：** 读不限于工作区。srt 是「哪里读不到就列哪里」，所以 `bash` 能读工作区和 `files.readable` 以外、又不在上面清单里的文件（例如 `~/Documents`），`read` 读不到。真要拦就写进 `files.denyRead`。另外 `files.denyRead` 里落在工作区里面的位置，对 `bash` 不起作用（`allowRead` 盖过它）。
* **环境变量只带几个：** `PATH`、`HOME`、`USER`、`LOGNAME`、`SHELL`、`LANG`、`LANGUAGE`、`LC_*`、`TERM`、`TZ`，加 `TMPDIR`。yoyo 进程里的别的环境变量（例如密钥）进不去。
* **超时：** `timeout` 秒（可以带小数），缺省 `files.bashTimeout`（120），最多 `files.bashMaxTimeout`（600），要得更多按上限算并在结果里说一声。到点先对整组进程发 SIGTERM，2 秒后还在就 SIGKILL，结果写「超时了（N 秒），已经杀掉」，带上超时前的输出。命令正常结束时留在后台的进程也一并收掉（输出收完后最多等 0.3 秒）。
* **输出：** stdout、stderr 按到达的顺序合在一起，第一行是 `退出码 N`（被信号杀掉写信号名）。超过 6 万字节只留开头 2 万和结尾 4 万，中间写「省略了 N 字节」（报错通常在结尾）；内存里只留这么多，输出再大也不涨。
* **记进轨迹：** 每次一条 `bash`：命令的前 120 个字（压成一行）、`code`（退出码，被杀是空）、有的话 `signal`、`timedOut`、`failed`，不带输出。
* **没装沙箱就没有这个工具。** 启动时找 `sandbox.command` 的程序，找不到、`sandbox.policy` 指向的文件读不出、设置写不下，就不注册 `bash`，记一行，常驻进程照常起，也不退回到不加沙箱的跑法：

  ```text
  没有 bash 工具：沙箱程序 srt 找不到（命令一律经沙箱跑，不退回不加沙箱的跑法）
  ```

  `files.bash` 设成 `deny` 时不找也不记。srt 自己拒绝（缺依赖、设置不对）时，它的报错就在命令的输出里，退出码不是 0。
* **测试：** 用一个包着 `fixtures/fake-srt.mjs` 的假 `srt` 放进临时 PATH，它把收到的参数、`cwd` 和设置文件内容记下来再照跑，什么也不限制。设置的内容、命令行、超时、输出上限、环境变量、轨迹都在 `bash.test.ts` 里验；真的 srt 不进自动测试，限制本身（写不出工作区、读不到密钥、断网）要在装了 srt 的机器上手动验。

# 先问

开关写成 `ask`：工具照样注册，模型照样能调，但每次真正动手前要主人在工作台里批准。缺省还是 `allow`。思路照 opencode 每个工具 `allow`、`ask`、`deny`，和 Claude Code 按工具问一句；不一样的是 yoyo 不在桌宠气泡和语音里问（没法弹，语音还会听错），统一在工作台的「待批准」里问，也能用命令行批。[^approvals]

**一条批准请求。** 模型调了 `ask` 的工具：先查参数和范围（不对就像平时那样告诉模型），对了就在表 `approvals` 记一条：工具名、给人看的一句摘要（「写 notes/周报.md（新建，12 行，300 B）」「跑命令：python plot.py」）、完整参数 JSON（写的内容、改的原文和新文、命令）、哪个子任务要的（主线程那一轮是空）、哪一轮、状态 `pending`、时间。状态只往前走：

```text
pending ──批准──▶ approved ──开始做──▶ 做完，结果存进 result ──交回──▶ announced
   │
   ├─ 拒绝 ──▶ denied ──交回──▶ announced
   └─ 过期 ──▶ expired ──交回──▶ announced
```

* **谁能批。** 只有主人：工作台的按钮（`POST /api/approvals/:id/approve`、`deny`）和命令行（`yoyo approval approve <编号>`、`deny <编号>`）。模型没有批准的工具，`yoyo` 工具只开 `approval list`、`show`，`bash` 的沙箱读写不到数据目录，所以模型批不了自己的请求。批准、拒绝、过期、照做、请求本身都记进轨迹（`approval-ask`、`approval-approve`、`approval-deny`、`approval-expire`、`approval-run`），批的人是在 `web` 还是 `cli` 记在 `via` 里。
* **点了只改状态。** 批准和拒绝只是把 `pending` 改成 `approved` 或 `denied`（一条条件更新，两边同时点只会成一次）。真正的活由常驻进程做，所以命令行批的也一样做；工作台点了会 `poke` 一下，马上做，命令行批的最多等一秒（`APPROVAL_POLL_MS`）。
* **照做一次。** 常驻进程里的 `ApprovalRunner` 先记下开始做的时间再做（`ran_at`），照原参数调一次这个工具的动作（`Action.perform`，和 `allow` 时同一份代码，`bash` 照样经沙箱、有超时和输出上限），工具回的话存进 `result`。进程停在做的中途，下次启动不重做，补一句「做到一半 yoyo 停了，不知道做成没有，看一眼再说」再交回。[^runner]批准以后开关被改成 `deny`（工具没了）就不做，结果写「现在没有 X 这个工具了」。
* **过期。** `files.askTimeout`（小时，缺省 24，0 不过期）：等批准等太久按拒绝算，状态 `expired`，原因写进 `note`，也交回。

**主线程那一轮**（回复、右键对话、工作台聊天）：不当场等，一轮有时限，桌宠还在等回话。工具立刻回一句话：「这件事要主人在工作台里批准才会做：「……」（批准请求 #3）。已经记下，现在还没做。告诉主人去工作台批准……别说成已经做了，也别为同一件事再调一遍。」模型据此告诉主人。主人批准以后：

1. 常驻进程照做，结果写回主会话，一条 `approval` 事件（「批准请求 #3「写 notes/周报.md」：主人在工作台里批准了，已经照做，下面一行写结果。」，meta 里 `id`、`state`），主线程的投影把它变成一条系统消息，下一轮就看得到；工作台的主聊天里是一张卡片。
2. 然后叫一声编排器的 `relayApproval(编号)`，下一拍叫醒主线程跑一轮转告，复用转告那一轮（工具照给、读写文件和跑命令的不给，ask 的也一样去掉），通知是 `<approval-notification>`（编号、状态、工具、摘要、结果或原因）加一句该怎么说：批准了讲结果，拒绝了问问要不要换个办法、别自己再试，过期了说一声没做。受 `tasks.notify` 管：关着就不说，结果照样在主会话里。模型出错说固定的一句（「「写 notes/周报.md」照你批准的做好了，结果在工作台里。」等）。转告排在内存里，进程在转告前停了就不补，结果已经在主会话里。

**子任务**：复用[中途问主人](tasks.md#中途问主人)的「等回答」，不新加状态。子 agent 调 `ask` 的工具时，记下批准请求（带着子任务编号），再调 `askTask`：子任务进入 `waiting`，问题是请求的摘要（「想做下面这件事，要你批准（在工作台的「待批准」里点批准或拒绝）：#3 跑命令：python plot.py」，几件就一件一行），工具回「这一轮到此为止：别再调别的工具，直接结束」。同一步里又调了几个，请求都记，一起等，问题跟着更新。问题写回主会话、叫醒主线程转告，转告的话不同于提问：告诉主人去工作台批准，不要用 `task_answer` 代答，也别替主人批准（每一轮的事实里也这样列）。主人批准或拒绝后：

* 子任务的请求**都有了结论**（做完、拒绝、过期）才交回，不是批一个交一个。
* 交回就是[回答](tasks.md#中途问主人)：`ApprovalRunner` 把每件的结果合成一段话（批准了的带结果，拒绝了的写「主人没批准，没有做。别再试同一件事：换个办法，做不了就用 task_fail 说明」），经 `resumeTask` 交给子任务，状态回 `queued`，下一轮输入照常是「你问主人：……、主人回答了：……」。这一段不受 2000 字的回答上限限制（最多 1.2 万字，每件按份额留头尾）。
* 在等批准的子任务**不收一句话回答**（`answerTask` 报「在等你批准 N 件事，不是提问」）：批不批要在工作台里点。
* 子任务取消、没做成或超时了：它没批的请求按过期算（原因「子任务 #3 已经不在等了」），批了没做的不做。

选「子任务调用时建请求、立刻返回，并进入 waiting」而不是让工具在 runner 里阻塞等，是因为后者要占着并行名额、模型调用有时限，而且重启就丢；现在的做法不新加状态，重启后请求和等回答的子任务都还在。

**怎么拦住调用。** 每个工具是一个 `Action`（`brain/action.ts`）：`summarize`（查参数和范围，回摘要）和 `perform`（照参数做一次）。`addGated` 按开关放进注册表：`allow` 的函数直接 `perform`；`ask` 的函数换成「查一遍、记请求」，它从执行环境的上下文里拿到这一轮的会话（`task:<编号>` 还是主线程）和运行编号；没接上批准的地方（没给 `gate`）时 `ask` 的工具只会拒绝，绝不放行。所有 `Action` 同时记进一张表，批准以后常驻进程照这张表做。[^action] [^gate]

# 还没做

* 按命令内容匹配的规则（opencode 的 `bash` 按命令 glob 分别 `allow`、`ask`、`deny`），现在是整个工具一个开关。
* 批准一次后同类的不再问（Claude Code 的「总是允许」）。

[^files]: 读写文件的工具
[^bash]: bash 工具
[^sandbox]: 沙箱设置
[^access]: 范围
[^config]: 配置
[^container]: 组装根
[^orchestrator]: 编排器
[^action]: 工具的动作和 ask 的接法
[^gate]: 记批准请求
[^approvals]: 批准请求的规则
[^runner]: 批准以后照做
