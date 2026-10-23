---
type: Architecture Decision
title: 命令原则
description: yoyo 命令按层展开，默认输出短，新功能从同一张领域表里被发现。
resource: src/commands.js
tags: [cli, discovery]
generated: { by: okf-docs-organizer/v0.2, at: 2026-10-23T12:00:00Z }
status: stable
sources:
  - id: registry
    resource: src/commands.js
    title: 领域表
  - id: dispatch
    resource: src/cli.js
    title: 分层输出
---

# 原则

命令会越来越多。默认只给下一层需要的那几行，不把整本手册一次打出来。[^dispatch]

1. **渐进式发现。** `yoyo` 只列领域。`yoyo alarm` 只列这个领域的动作。参数和一句说明只在 `yoyo inspect alarm` 出现。
2. **默认输出要短。** 一行一个领域或动作，名字对齐，后面一句摘要。不要在顶层打印 `--title` 这类参数。
3. **动态发现。** 领域和动作都写在 `src/commands.js` 的一张表里。`find` 和 `inspect` 读这张表，不另维护一份帮助文本。[^registry]
4. **检索只返回命中的领域。** `yoyo find 粘贴` 按领域名、别名、摘要和说明匹配。没有命中就一行「没有」。
5. **看用法才展开一个领域。** `inspect` 一次只讲一个领域：每个动作一行，参数紧跟在该动作下面。
6. **只有一个动作的领域可以直接跑。** `listen` 和 `whisper` 的动作叫 `now`，所以 `yoyo listen` 就是开始听，不必再写 `now`。有多个动作的领域，光写领域名只列动作。
7. **别名指向正式名字。** `contract` 打开的是 `contact`。正式名字只有一个，别名只为了少打错。
8. **导演在跑时，听和说交给它。** `yoyo listen` 和 `yoyo whisper` 发现已有导演进程，就把请求放进收件队列，不另开进程抢桌宠。

# 加一条命令时

在领域表加一条记录即可。记录里要有 `name`、`summary`，动作还要有 `run`。需要参数就写 `flags`。需要别名就写 `aliases`。不要在 README 里再抄一份完整帮助。

# 不这样做

* 不在 `yoyo` 不带参数时展开所有领域的所有参数。
* 不把 `inspect` 做成一次打印全部领域。
* 不写一套和领域表各写各的帮助。

[^registry]: 领域表
[^dispatch]: 分层输出
