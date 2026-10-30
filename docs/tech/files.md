---
type: Guide
title: 读写文件和跑命令
description: 主线程和子 agent 内置的 read、write、edit、bash 四个工具：工作区能读能写，只读目录只能读，配置、yoyo 自己的数据和密钥读不到，最具体的规则说了算；bash 一律经 srt 沙箱跑，只能写工作区，网络缺省全关；转告那一轮不给。
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

`llm.tools` 打开才有。`files.read`、`files.write`、`files.edit`、`files.bash` 各自能设 `deny` 不给。

# 能碰哪里

不问主人：碎碎念和转告是 yoyo 自己发起的，语音会听错，桌宠气泡里也没法弹「要不要」。所以靠范围把关。[^access]

| 哪里 | 读 | 写 |
| --- | --- | --- |
| 工作区：`files.workspace`，缺省 `~/.yoyo/workspace`，启动时建好 | 能 | 能 |
| 子任务的交付物 `~/.yoyo/artifacts/` | 能 | 不能（交文件用 `task_deliver`） |
| `files.readable` 里的 | 能 | 不能 |
| 数据目录 `~/.yoyo`、`config.json`、`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.kube`、`~/.docker`、`~/.netrc`、`~/.config/gcloud`、`~/Library/Keychains`、`files.denyRead` 里的 | 不能 | 不能 |
| 别处 | 不能 | 不能 |

* **最具体的那条说了算。** 一条路径落在好几条规则里时，目录最深的那条定，一样深时不给。所以数据目录整个不给，它下面的工作区和交付物照样能读；`files.readable` 给了 `~/Documents`，`files.denyRead` 再挡掉 `~/Documents/private`。
* **先解析成真实路径再比。** `~` 开头算主目录，相对路径从工作区算起，再顺着符号链接解析（还不存在的部分原样接上），所以工作区里指到外面的链接也出不去。规则里的路径也一样先解析。
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

# 还没做

* 「先问」：要等子任务能中途提问（#30），在工作台里问。

[^files]: 读写文件的工具
[^bash]: bash 工具
[^sandbox]: 沙箱设置
[^access]: 范围
[^config]: 配置
[^container]: 组装根
[^orchestrator]: 编排器
