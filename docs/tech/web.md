---
type: Guide
title: 管理页
description: 常驻进程在本机开的网页：看状态和对话，管记忆、日程和联系人。接口、安全边界、页面怎么做、怎么打开。
resource: src/web/server.ts
tags: [web, runtime, security]
status: stable
sources:
  - id: server
    resource: src/web/server.ts
    title: 管理页服务
  - id: api
    resource: src/web/api.ts
    title: 管理页接口
  - id: page
    resource: src/web/page.ts
    title: 页面
  - id: container
    resource: src/app/container.ts
    title: 组装根
  - id: daemon
    resource: src/runtime/daemon.ts
    title: 常驻循环
  - id: commands
    resource: src/cli/commands.ts
    title: 领域表
---

# 做什么

主人在命令行里能看的、能改的，管理页都给一份网页：概览（桌宠连没连上、模型、右键对话、记忆、下一句碎碎念、在忙什么）、最近的对话、记忆（画像能改，事实能忘，规矩能退役）、日程和联系人（加、删）、做过的事。概览上还有「说一句」「听一句」，和右键菜单一样交给收件箱。

只做命令行也能做的事，用的是同一套函数：加日程是 `addSchedule`，忘掉事实是 `facts.forget`，退役规矩是 `procedures.retire`，都照旧记一笔行为记录。不改配置，也不碰模型和 MCP。[^api]

# 在哪跑

常驻进程启动时由组装根开，只开一次，关闭应用时一起关；`web.enabled` 关掉就不开。它和编排器在同一个进程，直接读编排器的排期（下一句碎碎念、最近一次说话）。记忆没打开时库里也可能有以前记的，管理页照样打开记忆库，能看、能删。[^container] [^daemon]

* 只听 `127.0.0.1`，端口缺省随机（`web.port` 可以固定）。日志记一行地址，不带令牌。
* 打开的地址是 `http://127.0.0.1:<端口>/#token=<令牌>`，记进 kv 的 `web-url`。
* 右键「管理」（`web.enabled` 打开时才挂）由常驻进程用 `UrlOpener` 打开这个地址；命令行的 `yoyo web open` 在常驻进程活着时读 kv 打开，并把地址打印出来。[^commands]

# 安全

防的是本机浏览器里别的网页来读写，和局域网里的人。不防本机能读 `~/.yoyo` 的程序：它本来就能直接开库。[^server]

| 检查 | 挡什么 |
| --- | --- |
| 只听 `127.0.0.1` | 局域网 |
| Host 只认 `127.0.0.1:<端口>`、`localhost:<端口>`，别的 403 | DNS rebinding |
| 带 Origin 的只认自己这两个，`Sec-Fetch-Site: cross-site` 一律 403 | 别的网页跨站请求 |
| `/api/` 都要 `Authorization: Bearer <令牌>`，常数时间比较；令牌每次启动新生成 | 没打开过页面的人 |
| 写操作只收 `application/json`，正文最多 64 KiB | 表单跨站提交 |
| 页面带 CSP：脚本和样式只认这次响应的 nonce，`connect-src 'self'`，`frame-ancestors 'none'`；`no-store`、`nosniff`、`no-referrer` | 注入、被嵌进别的页面、令牌随 Referer 带出去 |

令牌放在地址的片段（`#` 后面）里：浏览器不把它发给服务器，也就不进任何日志。页面脚本读出来存进 sessionStorage，再用 `history.replaceState` 从地址栏抹掉。页面本身谁都能取，里面没有数据；没有令牌时只显示一句「从右键「管理」或 `yoyo web open` 打开」。

# 接口

都是 JSON。出错回 `{ "error": "一句中文" }`：主人填错的回 400（文案和命令行一样，例如「时间要写成 HH:MM」），找不到的 404，没想到的 500 并在日志里记一行。[^api]

| 接口 | 做什么 |
| --- | --- |
| `GET /api/status` | 舞台、宠物 id、桌宠连没连上和工作状态（经 `workStatus`，控制台舞台是 null）、模型名和是否给工具（不含密钥）、记忆开没开和事实条数、右键对话接没接上（kv 里有没有 `channel-base`）、MCP 服务器名、下一句碎碎念、最近一次说话、日程和联系人条数 |
| `GET /api/context?limit=` | 最近的上下文，按 `(at, seq)` 排好；消息按角色，碎碎念、摘要单列。缺省 40 条，最多 200 |
| `GET /api/activity?limit=` | 做过的事，缺省 50 条，最多 500 |
| `GET /api/memory` | 画像、仍然成立的事实（按开始成立的时间）、没退役的规矩 |
| `PUT /api/memory/core` | 改画像：`{ text }`，去掉首尾空白，最多 4000 字；记 `memory-core-edit` |
| `DELETE /api/memory/facts/:id` | 真删除一条事实；记 `memory-forget` |
| `DELETE /api/memory/rules/:id` | 规矩退役；记 `memory-retire` |
| `GET`、`POST /api/alarms`，`DELETE /api/alarms/:id` | 日程：列、加、删；删记 `schedule-remove` |
| `GET`、`POST /api/contacts`，`DELETE /api/contacts/:id` | 联系人：列、加、删；删记 `contact-remove` |
| `POST /api/actions/whisper`、`/listen` | 写进收件箱，下一拍做 |

# 页面

一个 HTML，样式和脚本内联，放在 `page.ts` 的模板字符串里：不用构建，`pnpm pack:app` 时跟着进单文件。脚本是不用框架的原生 JS，数据一律用 `textContent` 放进页面，不拼 HTML。跟随系统的浅色、深色。手机宽度下也能用。[^page]

改页面时注意：脚本放在模板字符串里，不能写反引号和 `${`。

# 还没做

* 在页面上改 `config.json`：要先有配置的热加载，现在改配置要重启常驻进程。
* 联系人、日程的编辑（现在只能删了重加），日程的暂停。
* 记忆的「事实的来龙去脉」（命令行的 `memory history`）、笔记和整理。

[^server]: 管理页服务
[^api]: 管理页接口
[^page]: 页面
[^container]: 组装根
[^daemon]: 常驻循环
[^commands]: 领域表
