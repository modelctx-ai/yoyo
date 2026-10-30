---
type: Guide
title: 读写文件
description: 主线程和子 agent 内置的 read、write、edit 三个工具：工作区能读能写，只读目录只能读，配置、yoyo 自己的数据和密钥读不到；最具体的规则说了算；转告那一轮不给。
resource: src/brain/files.ts
tags: [brain, tools, files]
status: stable
sources:
  - id: files
    resource: src/brain/files.ts
    title: 读写文件的工具
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

yoyo 的主线程和子 agent 内置三个工具，照 Claude Code 和 pi 的 read、write、edit。跑命令（`bash`）是下一步，见 #37。[^files]

| 工具 | 做什么 |
| --- | --- |
| `read` | 读一个文件，带行号，一次最多 2000 行，长文件用 `offset`、`limit` 分段；一行超过 2000 字截断，一次最多交回 6 万字；二进制只报大小；目录列出来（目录带 `/`，文件带大小，最多 200 项） |
| `write` | 写一个文本文件，已有的整个换掉，目录不在就建；最大 5 MB |
| `edit` | 把一段原文换成新的：原文要一字不差、只出现一次，`all: true` 全换；新文里的 `$` 照原样写 |

`llm.tools` 打开才有。`files.read`、`files.write`、`files.edit` 各自能设 `deny` 不给。

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

* **主线程**：回复、右键对话、工作台聊天这几轮有。**转告子任务结果的那一轮没有**：编排器按注册表里的名字去掉这三个，别的工具照给。碎碎念那一轮本来就不给工具。[^orchestrator]
* **子 agent**：`general` 全部；`research` 有 `read`；`writer` 有 `read`、`write`、`edit`。主人自己加的类型在 `tools` 里写名字。
* **交付物**：`task_deliver` 多一个 `path`，把工作区里已有的文件（例如用 `write` 写好的）交上来，按 `read` 的规则查，名字缺省用原来的。[^container]

# 还没做

* `bash`：经 srt 沙箱跑命令，只能写工作区，网络按配置放行，见 #37。
* 「先问」：要等子任务能中途提问（#30），在工作台里问。

[^files]: 读写文件的工具
[^access]: 范围
[^config]: 配置
[^container]: 组装根
[^orchestrator]: 编排器
