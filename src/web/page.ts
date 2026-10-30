/**
 * 工作台本身：一个 HTML，样式和脚本都内联，不用构建，打包时跟着进单文件。浏览器和 yoyo.app 的窗口里是同一页。
 * 令牌放在地址的 `#token=` 里（不会发给服务器、不进日志），脚本读出来存进 sessionStorage，再从地址栏抹掉。
 * 数据一律用 textContent 放进页面，不拼 HTML。脚本里不用反引号和 `${`，整页才能放进这个模板字符串。
 * CSP 不许写 style 属性：样式都在下面的样式表里，脚本要改样式就改 class 或 `node.style`。
 */

import { AVATAR } from './avatar.ts';

const STYLE = String.raw`
:root {
  --bg: #f7f8fc; --side: #eef1fa; --panel: #ffffff; --hover: #e4e8f5;
  --text: #1d2333; --muted: #5f6779; --soft-text: #4a5266; --line: #e0e4ef; --line-strong: #b8bfd0;
  --accent: #4f6bed; --accent-strong: #3a55d6; --accent-soft: #e5eafd; --accent-text: #ffffff; --yoyo: #edf1fe;
  --ok: #2f9e44; --ok-strong: #2b8a3e; --ok-soft: #e3f4e6; --warm: #b35c00; --warm-soft: #fff1e0;
  --warn: #e8590c; --danger: #c2255c; --danger-soft: #fde7ef; --violet: #6741d9; --violet-soft: #efe9fe;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #131722; --side: #181d2b; --panel: #1e2433; --hover: #252c3e;
    --text: #e6e9f2; --muted: #9aa2b5; --soft-text: #b4bbcc; --line: #2a3142; --line-strong: #4a5368;
    --accent: #7c93ff; --accent-strong: #a3b3ff; --accent-soft: #263056; --accent-text: #0e1220; --yoyo: #20283d;
    --ok: #69db7c; --ok-strong: #8ce99a; --ok-soft: #1f3a2a; --warm: #ffc078; --warm-soft: #3d2c17;
    --warn: #ffa94d; --danger: #f783ac; --danger-soft: #42202f; --violet: #b197fc; --violet-soft: #2e2550;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; overflow: hidden; }
button { font: inherit; color: inherit; }
svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; flex: none; }
[hidden] { display: none !important; }

.app { display: flex; height: 100%; }
.side { flex: none; width: 256px; background: var(--side); border-right: 1px solid var(--line); display: flex; flex-direction: column; padding: 16px 12px 12px; gap: 2px; overflow-y: auto; }
.me { display: flex; align-items: center; gap: 12px; padding: 4px 6px 16px; }
.avatar { width: 30px; height: 30px; border-radius: 50%; flex: none; object-fit: cover; background: var(--yoyo); }
.avatar.lg { width: 48px; height: 48px; box-shadow: 0 0 0 3px var(--accent-soft); }
.me .name { font-weight: 700; font-size: 17px; letter-spacing: .5px; }
.me .mood { color: var(--muted); font-size: 13px; display: flex; align-items: center; gap: 6px; }
.nav { display: flex; flex-direction: column; gap: 2px; }
.nav-item { display: flex; align-items: center; gap: 10px; width: 100%; border: 0; background: none; border-radius: 10px; padding: 9px 10px; cursor: pointer; text-align: left; color: var(--soft-text); }
.nav-item:hover { background: var(--hover); color: var(--text); }
.nav-item .count { margin-left: auto; min-width: 20px; padding: 0 7px; border-radius: 999px; background: var(--warm-soft); color: var(--warm); font-size: 12px; font-style: normal; font-weight: 700; text-align: center; font-variant-numeric: tabular-nums; }
.nav-item[aria-current="page"] { background: var(--panel); color: var(--accent-strong); font-weight: 600; box-shadow: 0 1px 2px rgba(20, 30, 60, .06); }
.section-title { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; font-weight: 600; letter-spacing: 1px; padding: 18px 10px 6px; }
.section-title .count { margin-left: auto; font-weight: 400; letter-spacing: 0; }
.section-title .add { border: 0; background: none; color: var(--accent-strong); font-size: 12px; font-weight: 600; letter-spacing: 0; padding: 2px 8px; border-radius: 999px; cursor: pointer; }
.section-title .add:hover { background: var(--hover); }
.nav-item.only-narrow { display: none; }
.task-item { display: flex; flex-direction: column; gap: 6px; width: 100%; border: 0; background: none; border-radius: 10px; padding: 8px 10px; cursor: pointer; text-align: left; }
.task-item .line { display: flex; align-items: center; gap: 9px; }
.task-item .mini { display: block; height: 4px; margin-left: 16px; border-radius: 2px; background: var(--hover); overflow: hidden; }
.task-item .mini > span { display: block; height: 100%; width: 0; background: var(--accent); }
.task-item:hover { background: var(--hover); }
.task-item.active { background: var(--panel); box-shadow: 0 1px 2px rgba(20, 30, 60, .06); }
.task-item.active .name { font-weight: 600; }
.task-item .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
.task-item .meta { flex: none; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.hint { color: var(--muted); font-size: 13px; padding: 2px 10px; }
.side-foot { margin-top: auto; padding-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.status { display: flex; flex-direction: column; gap: 3px; font-size: 12px; padding: 10px; border-radius: 10px; background: var(--panel); }
.status .item { display: flex; align-items: center; gap: 8px; color: var(--muted); min-width: 0; }
.status .item span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status .item.wrap { align-items: flex-start; }
.status .item.wrap .dot { margin-top: 5px; }
.status .item.wrap span:last-child { white-space: normal; overflow-wrap: anywhere; }
.dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--muted); flex: none; }
.dot.ok { background: var(--ok); } .dot.off { background: var(--warn); } .dot.run { background: var(--accent); } .dot.fail { background: var(--danger); }
.quick { display: flex; gap: 6px; }

main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.bar { flex: none; display: flex; align-items: center; gap: 16px; padding: 14px 28px; border-bottom: 1px solid var(--line); background: var(--bg); }
.bar .titles { flex: 1; min-width: 0; }
.bar h1 { margin: 0; font-size: 18px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar .sub { color: var(--muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.search { display: flex; align-items: center; gap: 8px; padding: 6px 14px; border: 1px solid var(--line); border-radius: 999px; background: var(--panel); color: var(--muted); }
.search input { border: 0; outline: 0; background: none; padding: 0; width: 150px; }
.bar-actions { display: flex; align-items: center; gap: 10px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

.view { display: none; flex: 1; min-height: 0; }
.view.active { display: flex; flex-direction: column; }
.scroll { overflow-y: auto; }
.page { width: 100%; max-width: 1040px; margin: 0 auto; padding: 24px 32px; }
.columns { display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start; }
.col-main { flex: 3 1 420px; min-width: 0; display: flex; flex-direction: column; gap: 16px; }
.col-side { flex: 2 1 300px; min-width: 0; display: flex; flex-direction: column; gap: 16px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 18px 20px; }
.card.ask { border-color: var(--warm); }
.card.ask .question { white-space: pre-wrap; word-break: break-word; margin-bottom: 10px; }
.card.ask textarea { min-height: 84px; }
.card.ask .acts { display: flex; justify-content: flex-end; margin-top: 8px; }
.apv { display: flex; flex-direction: column; gap: 12px; }
.apv-group { display: flex; flex-direction: column; gap: 12px; }
.apv-head { display: flex; gap: 10px; align-items: flex-start; }
.apv-head .what { flex: 1; min-width: 0; font-weight: 600; word-break: break-word; }
.apv-head .side-note { flex: none; padding-top: 3px; }
.apv .acts { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
.apv .param { display: flex; flex-direction: column; gap: 4px; }
.apv .param .k { color: var(--muted); font-size: 12px; font-weight: 600; letter-spacing: 1px; }
.apv .preview { margin: 0; }
.apv .why { color: var(--muted); font-size: 13px; }
.apv.settled { opacity: .88; }
.card.pending { background: var(--side); border-style: dashed; color: var(--muted); }
.card-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; }
.card-head .side-note { margin-left: auto; }
.label { margin: 0; font-size: 13px; color: var(--muted); font-weight: 600; letter-spacing: 1px; }
.card h2.title { margin: 0; font-size: 16px; }

.thread { flex: 1; overflow-y: auto; overflow-anchor: none; padding: 20px 0 8px; }
.thread-inner { max-width: 820px; margin: 0 auto; padding: 0 28px; display: flex; flex-direction: column; gap: 14px; }
.when { align-self: center; color: var(--muted); font-size: 12px; padding: 6px 0 0; letter-spacing: .5px; }
.msg { display: flex; gap: 10px; align-items: flex-end; max-width: 86%; }
.msg .bubble { min-width: 0; white-space: pre-wrap; word-break: break-word; padding: 10px 14px; border-radius: 18px 18px 18px 6px; background: var(--yoyo); }
.msg .meta { color: var(--muted); font-size: 11px; margin-top: 3px; padding: 0 6px; }
.msg.me { align-self: flex-end; flex-direction: row-reverse; }
.msg.me .bubble { background: var(--accent); color: var(--accent-text); border-radius: 18px 18px 6px 18px; }
.msg.me .meta { text-align: right; }
.msg.pending .bubble { color: var(--muted); }
.msg.streaming .bubble::after { content: "\258D"; color: var(--accent); margin-left: 1px; animation: blink 1s infinite; }
.edge { align-self: center; color: var(--muted); font-size: 12px; padding: 2px 0 6px; }
.edge-btn { align-self: center; border: 1px solid var(--line); background: var(--panel); color: var(--soft-text); border-radius: 999px; padding: 4px 14px; font-size: 13px; cursor: pointer; }
.typing::after { content: "…"; animation: blink 1.2s infinite; }
@keyframes blink { 50% { opacity: .2; } }
.whisper { align-self: center; max-width: 80%; color: var(--muted); font-size: 13px; text-align: center; white-space: pre-wrap; }
.whisper::before { content: "碎碎念 · "; color: var(--accent); }
.summary { align-self: center; max-width: 80%; color: var(--muted); font-size: 13px; border: 1px dashed var(--line); border-radius: 10px; padding: 8px 12px; white-space: pre-wrap; }
.summary summary { cursor: pointer; }
.event { margin-left: 40px; align-self: flex-start; max-width: calc(86% - 40px); display: flex; gap: 12px; align-items: center; border: 1px solid var(--line); background: var(--panel); border-radius: 14px; padding: 10px 16px 10px 10px; font-size: 14px; color: var(--text); }
.event .chip { width: 34px; height: 34px; border-radius: 10px; display: flex; align-items: center; justify-content: center; flex: none; background: var(--accent-soft); color: var(--accent-strong); }
.event.done .chip { background: var(--ok-soft); color: var(--ok-strong); }
.event.failed .chip { background: var(--danger-soft); color: var(--danger); }
.event.ask .chip { background: var(--warm-soft); color: var(--warm); }
.event.alarm .chip { background: var(--warm-soft); color: var(--warm); }
.event .text { display: flex; flex-direction: column; min-width: 0; }
.event .what { font-weight: 600; }
.event .detail { color: var(--muted); font-size: 13px; white-space: pre-wrap; max-height: 4.8em; overflow: hidden; }
.event .tail { margin-left: 8px; color: var(--accent-strong); font-size: 13px; white-space: nowrap; }
button.event { font: inherit; text-align: left; }
.event.link { cursor: pointer; }
.event.link:hover { border-color: var(--accent); }
.thread .empty { text-align: center; padding: 64px 0; }

.composer { flex: none; border-top: 1px solid var(--line); background: var(--bg); padding: 12px 28px 16px; }
.composer .field { max-width: 820px; margin: 0 auto; display: flex; gap: 10px; align-items: flex-end; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 8px 8px 8px 14px; }
.composer .field:focus-within { border-color: var(--accent); }
.composer textarea { flex: 1; display: block; border: 0; outline: 0; background: none; resize: none; min-height: 26px; max-height: 200px; padding: 4px 0; font: inherit; color: var(--text); }
.composer .hints { max-width: 820px; margin: 6px auto 0; display: flex; gap: 12px; color: var(--muted); font-size: 12px; }
.composer .hints span:first-child { flex: 1; }
.send { width: 44px; height: 44px; border-radius: 12px; border: 0; background: var(--accent); color: var(--accent-text); display: flex; align-items: center; justify-content: center; cursor: pointer; flex: none; }
.send:disabled { background: var(--hover); color: var(--muted); cursor: default; }
.send svg { stroke-width: 2.2; }

.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 4px 18px; margin-bottom: 16px; }
.panel > h2 { font-size: 15px; margin: 14px 0 4px; }
.row { display: flex; gap: 10px; align-items: baseline; padding: 10px 0; border-top: 1px solid var(--line); }
.row:first-of-type { border-top: 0; }
.row .who { flex: none; width: 64px; color: var(--muted); font-size: 13px; }
.row .main { flex: 1; min-width: 0; white-space: pre-wrap; word-break: break-word; }
.day { color: var(--muted); font-size: 13px; padding: 14px 0 2px; }
.day + .row { border-top: 0; }
.side-note { color: var(--muted); font-size: 12px; }
.row .side-note { flex: none; }
.empty { color: var(--muted); padding: 12px 0; }
.actions { display: flex; gap: 8px; margin: 14px 0; flex-wrap: wrap; align-items: center; }
.actions.end { justify-content: flex-end; margin-bottom: 0; }
button.primary, button.plain, button.danger { border-radius: 9px; padding: 6px 14px; cursor: pointer; border: 1px solid var(--line); }
button.primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
button.plain { background: var(--panel); }
button.plain.small { padding: 4px 10px; font-size: 13px; flex: 1; }
button.plain.mini { padding: 2px 10px; font-size: 13px; }
button.danger { background: none; color: var(--danger); border-color: transparent; padding: 2px 6px; }
button:disabled { opacity: .5; cursor: default; }
form.inline { display: flex; gap: 8px; flex-wrap: wrap; padding: 12px 0; }
input, select, textarea { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 9px; padding: 6px 10px; min-width: 0; }
.page textarea { width: 100%; min-height: 160px; resize: vertical; }
textarea.code { min-height: 420px; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
label.row { cursor: pointer; }
label.row input { flex: none; width: 18px; height: 18px; accent-color: var(--accent); }
form.inline input[name="title"], form.inline input[name="name"], form.inline input[name="yoyo"] { flex: 1 1 160px; }

.row.alarm .main { flex: 1 1 140px; }
.row.alarm .acts { flex: none; margin-left: auto; display: flex; gap: 4px; align-items: center; }
.row.alarm.paused .who, .row.alarm.paused .main, .row.alarm.paused .side-note { color: var(--muted); }
.row.alarm.paused .main { text-decoration: line-through; text-decoration-color: var(--line-strong); }
.row.alarm.paused .who { opacity: .7; }
.row.alarm .tag { flex: none; }
form.inline.editing { border-top: 1px solid var(--line); background: var(--accent-soft); margin: 0 -18px; padding: 12px 18px; }
form.inline.editing input[name="title"] { flex: 1 1 200px; }
.setgroup { border-top: 1px solid var(--line); padding: 6px 0 8px; }
.setgroup:first-of-type { border-top: 0; }
.setgroup h3 { font-size: 13px; color: var(--muted); letter-spacing: 1px; font-weight: 600; margin: 10px 0 4px; }
.setfield { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 2px 14px; align-items: center; padding: 6px 0; }
.setfield .k { font-size: 14px; }
.setfield input, .setfield select { width: 100%; max-width: 440px; }
.setfield .note { grid-column: 2; color: var(--muted); font-size: 12px; }
.taskform { max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
.taskform label { display: flex; flex-direction: column; gap: 6px; }
.taskform .k { color: var(--muted); font-size: 13px; font-weight: 600; }
.taskform input, .taskform select, .taskform textarea { width: 100%; }
.taskform .note { color: var(--muted); font-size: 13px; }
.taskform .acts { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
#task-goal { min-height: 140px; }
#task-criteria { min-height: 96px; }
.todo { display: flex; gap: 12px; padding: 10px 0; border-top: 1px solid var(--line); align-items: flex-start; }
.todo:first-of-type { border-top: 0; }
.todo .mark { flex: none; width: 20px; height: 20px; border-radius: 50%; border: 2px solid var(--line-strong); box-sizing: border-box; margin-top: 2px; display: flex; align-items: center; justify-content: center; }
.todo .mark svg { width: 12px; height: 12px; stroke-width: 3; }
.todo.done .mark { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
.todo.in_progress .mark { border-color: var(--accent); }
.todo.in_progress .mark::after { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
.todo.in_progress .main { font-weight: 600; }
.todo.done .main, .todo.skipped .main { color: var(--muted); }
.todo.skipped .main { text-decoration: line-through; }
.todo .note { color: var(--muted); font-size: 13px; font-weight: 400; text-decoration: none; }
.criterion { display: flex; gap: 10px; padding: 6px 0; }
.criterion .mark { flex: none; width: 18px; height: 18px; border-radius: 5px; border: 2px solid var(--line-strong); box-sizing: border-box; margin-top: 3px; display: flex; align-items: center; justify-content: center; }
.criterion .mark svg { width: 11px; height: 11px; stroke-width: 3; }
.criterion.met .mark { background: var(--ok-strong); border-color: var(--ok-strong); color: #ffffff; }
.criterion.unmet .mark { border-color: var(--danger); color: var(--danger); }
.criterion .note { color: var(--muted); font-size: 13px; }
.bar-track { height: 6px; border-radius: 3px; background: var(--hover); overflow: hidden; margin-bottom: 10px; }
.bar-track > span { display: block; height: 100%; width: 0; background: var(--accent); transition: width .3s; }
.card .text { white-space: pre-wrap; word-break: break-word; }
.file { display: flex; gap: 12px; align-items: center; padding: 10px 0; border-top: 1px solid var(--line); }
.file:first-of-type { border-top: 0; }
.file .chip { width: 34px; height: 34px; border-radius: 10px; display: flex; align-items: center; justify-content: center; flex: none; background: var(--accent-soft); color: var(--accent-strong); }
.file .chip svg { width: 18px; height: 18px; }
.file .main { flex: 1; min-width: 0; }
.file .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.file .note { color: var(--muted); font-size: 13px; }
.file .acts { display: flex; gap: 4px; flex: none; }
.file .acts button.plain { padding: 4px 10px; font-size: 13px; }
.preview { margin: 0 0 10px; border: 1px solid var(--line); border-radius: 12px; background: var(--side); padding: 12px 14px; max-height: 420px; overflow: auto; white-space: pre-wrap; word-break: break-word; font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
.preview-img { display: block; max-width: 100%; max-height: 420px; margin: 0 0 10px; border-radius: 12px; border: 1px solid var(--line); }
.badge { font-size: 13px; font-weight: 600; border-radius: 999px; padding: 3px 12px; background: var(--hover); color: var(--muted); }
.badge.running { background: var(--accent-soft); color: var(--accent-strong); }
.badge.waiting { background: var(--warm-soft); color: var(--warm); }
.badge.done { background: var(--ok-soft); color: var(--ok-strong); }
.badge.failed { background: var(--danger-soft); color: var(--danger); }
.tl { display: flex; gap: 12px; }
.tl .rail { display: flex; flex-direction: column; align-items: center; flex: none; }
.tl .node { width: 9px; height: 9px; border-radius: 50%; background: var(--line-strong); margin-top: 7px; flex: none; }
.tl.say .node, .tl.call .node { background: var(--accent); }
.tl.result .node { background: var(--ok); }
.tl .stem { flex: 1; width: 2px; background: var(--hover); }
.tl:last-child .stem { display: none; }
.tl .body { padding-bottom: 14px; min-width: 0; }
.tl .k { color: var(--muted); font-size: 12px; }
.tl .t { font-size: 14px; white-space: pre-wrap; word-break: break-word; }
.tl.call .t, .tl.result .t { font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--soft-text); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 4px 0 10px; }
.chips button { min-height: 30px; padding: 0 12px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel); color: var(--soft-text); font-size: 13px; cursor: pointer; }
.chips button[aria-pressed="true"] { background: var(--text); border-color: var(--text); color: var(--bg); }
.fact { display: flex; gap: 12px; align-items: center; padding: 10px 0; border-top: 1px solid var(--line); }
.fact .main { flex: 1; min-width: 0; }
.fact .side-note { flex: none; }
.tag { flex: none; padding: 1px 8px; border-radius: 6px; font-size: 12px; background: var(--hover); color: var(--soft-text); }
.tag.work { background: var(--accent-soft); color: var(--accent-strong); }
.tag.routine { background: var(--ok-soft); color: var(--ok-strong); }
.tag.taste { background: var(--warm-soft); color: var(--warm); }
.tag.people { background: var(--violet-soft); color: var(--violet); }
.tag.fix { background: var(--danger-soft); color: var(--danger); }
.tag.on { background: var(--ok-soft); color: var(--ok-strong); }
.core-head { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.core-head .avatar { width: 36px; height: 36px; }
.card textarea { width: 100%; min-height: 220px; resize: vertical; background: var(--bg); border-radius: 12px; padding: 12px 14px; line-height: 1.7; font-size: 14px; }
#toast { position: fixed; bottom: 100px; left: 50%; transform: translateX(-50%); background: var(--text); color: var(--bg); padding: 8px 14px; border-radius: 9px; opacity: 0; transition: opacity .2s; pointer-events: none; max-width: calc(100% - 32px); z-index: 2; }
#toast.show { opacity: 1; }
#locked { display: none; padding: 64px 16px; text-align: center; color: var(--muted); }

@media (max-width: 860px) {
  .side { width: 64px; padding: 12px 8px; align-items: center; }
  .me { padding: 4px 0 12px; } .me .who, .nav-item span, .section-title, .tasks, .hint, .status, .quick { display: none !important; }
  .avatar.lg { width: 40px; height: 40px; }
  .nav-item { justify-content: center; padding: 10px; }
  .nav-item.only-narrow { display: flex; }
}
@media (max-width: 560px) {
  .bar { padding: 10px 14px; } .bar input[type="search"] { width: 110px; }
  .thread-inner { padding: 0 14px; } .composer { padding: 10px 12px 12px; }
  .msg { max-width: 94%; } .event { margin-left: 0; max-width: 100%; }
  .composer .keys { display: none; }
  .row { flex-wrap: wrap; } .row .who { width: auto; }
  .setfield { grid-template-columns: minmax(0, 1fr); } .setfield .note { grid-column: 1; }
  .row.alarm .acts { flex-basis: 100%; justify-content: flex-end; }
  .apv-head { flex-wrap: wrap; } .apv-head .side-note { flex-basis: 100%; padding-top: 0; }
}
`;

/** 线条图标，24×24。 */
const ICONS: Readonly<Record<string, string>> = {
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  memory: '<path d="M6 3h11a1 1 0 0 1 1 1v16H7a2 2 0 0 1-2-2V4a1 1 0 0 1 1-1z"/><path d="M9 3v8l2.5-1.5L14 11V3"/>',
  alarm: '<circle cx="12" cy="13" r="7"/><path d="M12 9v4l2.5 2M5 4 2.5 6.5M19 4l2.5 2.5"/>',
  trail:
    '<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 18h6a3 3 0 0 0 0-6h-4a3 3 0 0 1 0-6h6"/>',
  people:
    '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  cross: '<path d="M6 6l12 12M18 6 6 18"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  task: '<path d="M10 6h10M10 12h10M10 18h10"/><path d="m3.5 6 1.5 1.5L7.5 5M3.5 12l1.5 1.5L7.5 11M3.5 18l1.5 1.5L7.5 17"/>',
  doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
  image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m21 16-5-5-8 8"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  shield: '<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z"/><path d="m9 12 2 2 4-4"/>',
};

function icon(name: string): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
}

const SCRIPT = String.raw`
"use strict";
var KEY = "yoyo-token";
var token = "";
var match = /(?:^#|&)token=([^&]+)/.exec(location.hash);
if (match) {
  token = decodeURIComponent(match[1]);
  try { sessionStorage.setItem(KEY, token); } catch (e) {}
  history.replaceState(null, "", location.pathname);
} else {
  try { token = sessionStorage.getItem(KEY) || ""; } catch (e) {}
}

function $(selector) { return document.querySelector(selector); }

function h(tag, props, children) {
  var node = document.createElement(tag);
  Object.keys(props || {}).forEach(function (key) {
    if (props[key] === null || props[key] === undefined) return;
    if (key === "text") node.textContent = props[key];
    else if (key.slice(0, 2) === "on") node.addEventListener(key.slice(2), props[key]);
    else node.setAttribute(key, props[key]);
  });
  (children || []).forEach(function (child) { if (child) node.appendChild(typeof child === "string" ? document.createTextNode(child) : child); });
  return node;
}

/** 复制页面里现成的图标（只有 SVG，没有数据） */
function iconNode(name) {
  var source = document.querySelector("#icons [data-icon='" + name + "']");
  return source ? source.firstElementChild.cloneNode(true) : null;
}

function toast(message) {
  var box = $("#toast");
  box.textContent = message;
  box.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(function () { box.classList.remove("show"); }, 3000);
}

function api(method, path, body) {
  var init = { method: method, headers: { authorization: "Bearer " + token } };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return fetch(path, init).then(function (response) {
    return response.json().catch(function () { return {}; }).then(function (data) {
      if (response.status === 401) lock();
      if (!response.ok) {
        var error = new Error(data.error || ("出错了（" + response.status + "）"));
        error.status = response.status;
        throw error;
      }
      return data;
    });
  });
}

/** 读 SSE：一个事件是 event: 名字 加 data: JSON，空行结束；注释行（冒号开头）跳过。读完（连接关了）才返回 */
function readEvents(response, onEvent) {
  var reader = response.body.getReader();
  var decoder = new TextDecoder();
  var buffer = "";
  function frame(text) {
    var name = "message";
    var data = [];
    text.split("\n").forEach(function (line) {
      if (line.slice(0, 6) === "event:") name = line.slice(6).trim();
      else if (line.slice(0, 5) === "data:") data.push(line.slice(5).replace(/^ /, ""));
    });
    if (!data.length) return;
    var parsed = null;
    try { parsed = JSON.parse(data.join("\n")); } catch (e) { return; }
    onEvent(name, parsed);
  }
  function pump() {
    return reader.read().then(function (chunk) {
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      var cut = buffer.indexOf("\n\n");
      while (cut >= 0) {
        frame(buffer.slice(0, cut));
        buffer = buffer.slice(cut + 2);
        cut = buffer.indexOf("\n\n");
      }
      return pump();
    });
  }
  return pump();
}

/** 开一个要带令牌的 SSE 连接（EventSource 带不了 Authorization）：不是 2xx 就按普通接口的样子抛错 */
function openStream(method, path, body, signal) {
  var init = { method: method, headers: { authorization: "Bearer " + token }, signal: signal };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return fetch(path, init).then(function (response) {
    if (response.ok) return response;
    if (response.status === 401) lock();
    return response.json().catch(function () { return {}; }).then(function (data) {
      var error = new Error(data.error || ("出错了（" + response.status + "）"));
      error.status = response.status;
      throw error;
    });
  });
}

/** 聊一句，边写边交增量；整段回复在 done 里，返回它 */
function streamChat(text, onDelta) {
  return openStream("POST", "/api/chat/stream", { text: text }).then(function (response) {
    var reply = null;
    var failure = "";
    return readEvents(response, function (name, data) {
      if (name === "delta") onDelta(data.text);
      else if (name === "done") reply = data.reply;
      else if (name === "error") failure = data.error;
    }).then(function () {
      if (failure) throw new Error(failure);
      if (reply === null) throw new Error("连接断了，没等到完整的回复");
      return reply;
    });
  });
}

function fail(error) { toast(error.message || String(error)); }

function pad(n) { return (n < 10 ? "0" : "") + n; }
function dayOf(ms) {
  var d = new Date(ms);
  var today = new Date();
  var yesterday = new Date(today.getTime() - 86400000);
  if (d.toDateString() === today.toDateString()) return "今天";
  if (d.toDateString() === yesterday.toDateString()) return "昨天";
  return (d.getMonth() + 1) + "月" + d.getDate() + "日";
}
function clock(ms) { var d = new Date(ms); return pad(d.getHours()) + ":" + pad(d.getMinutes()); }
function when(ms) {
  if (!ms) return "";
  var day = dayOf(ms);
  return day === "今天" ? clock(ms) : day + " " + clock(ms);
}

function fill(target, nodes, emptyText) {
  target.replaceChildren();
  if (nodes.length === 0 && emptyText) target.appendChild(h("div", { class: "empty", text: emptyText }));
  nodes.forEach(function (node) { target.appendChild(node); });
}

function row(who, main, side, extra) {
  return h("div", { class: "row" }, [
    who === null ? null : h("div", { class: "who", text: who }),
    h("div", { class: "main", text: main }),
    side ? h("div", { class: "side-note", text: side }) : null,
    extra || null,
  ]);
}

function confirmThen(question, action) {
  return function () { if (confirm(question)) action(); };
}

/** 只认 **加粗**：拆成文字和 strong，仍然只用 textContent */
function rich(text) {
  var parts = String(text).split(/\*\*([^*\n]+)\*\*/);
  return parts.map(function (part, i) { return i % 2 ? h("strong", { text: part }) : document.createTextNode(part); });
}

var REPEATS = { daily: "每天", weekdays: "工作日", weekly: "每周" };
var DAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

// ---- 对话 ----

var thread = { signature: "", pending: false, query: "", tasks: "", approvals: "", items: {}, cards: {}, loaded: false, start: false, older: false };
/** 最新的一页取多少条，往前翻时每次翻多少条 */
var PAGE = 200;
var OLDER = 50;
/** 对话里穿插的小卡片，来自这几种行为记录 */
var CARD_TYPES = "schedule-add,task-add,approval-ask";
var VIA = { "dsh-pet": "桌宠对话" };
var TASK_STATES = { queued: "排队", running: "在做", waiting: "等回答", done: "做完", failed: "没做成", cancelled: "取消了" };
var TODO_MARKS = { pending: "", in_progress: "", done: "✓", skipped: "–" };
var openTask = 0;
/** 交付物：展开预览的那个，和取回来的原文（按编号和时间，交了新的就重新取） */
var artifactOpen = 0;
var artifactBlobs = {};
/** 常驻进程能在访达里显示；在 yoyo.app 的窗口里下载不了，只给在访达里显示 */
var canReveal = false;
var inApp = false;
/** 最近的子任务，按编号：对话里的卡片据此显示进度 */
var taskIndex = {};
/** 待批准：最近一次取回来的列表、按编号的摘要、展开了哪几条、取回来的完整参数 */
var approvalList = [];
var approvalIndex = {};
var approvalOpen = {};
var approvalDetails = {};
var APPROVAL_STATES = { pending: "等批准", approved: "批准了", denied: "拒绝了", expired: "过期了" };
var TOOL_LABELS = { read: "读文件", write: "写文件", edit: "改文件", bash: "跑命令" };
var PARAM_LABELS = { path: "路径", content: "内容", old: "原文", "new": "换成", all: "每处都换", command: "命令", timeout: "最长几秒", offset: "从第几行", limit: "读几行" };
var factFilter = "";
var memoryFacts = [];
var TOPICS = { owner: "主人", work: "工作", people: "身边的人", routine: "作息", taste: "喜好", fix: "纠正" };

function stateDot(state) {
  return state === "running" ? "run" : state === "waiting" ? "off" : state === "done" ? "ok" : state === "failed" ? "fail" : "";
}

function nearBottom(box) { return box.scrollHeight - box.scrollTop - box.clientHeight < 80; }

function avatar() {
  var img = h("img", { class: "avatar", alt: "" });
  img.src = $("#avatar").src;
  return img;
}

function message(item) {
  var via = VIA[item.via] || (item.kind === "user" && !item.via ? "语音" : "");
  if (item.kind === "whisper") return h("div", { class: "whisper", "data-text": item.text, text: item.text });
  if (item.kind === "summary") {
    return h("details", { class: "summary", "data-text": item.text }, [h("summary", { text: "更早的对话压成了摘要" }), document.createTextNode(item.text)]);
  }
  var mine = item.kind === "user";
  return h("div", { class: "msg" + (mine ? " me" : ""), "data-text": item.text }, [
    mine ? null : avatar(),
    h("div", {}, [h("div", { class: "bubble" }, rich(item.text)), via ? h("div", { class: "meta", text: "来自" + via }) : null]),
  ]);
}

/** 对话里插进来的一件事：记下了闹钟、派了子任务、子任务做完了。能点的是按钮，点开看详情 */
function eventRow(kind, iconName, what, detail, tail, text, onclick) {
  var parts = [
    h("span", { class: "chip" }, [iconNode(iconName)]),
    h("span", { class: "text" }, [h("span", { class: "what", text: what }), detail ? h("span", { class: "detail", text: detail }) : null]),
    tail ? h("span", { class: "tail", text: tail }) : null,
  ];
  if (!onclick) return h("div", { class: "event " + kind, "data-text": text }, parts);
  return h("button", { class: "event link " + kind, type: "button", "data-text": text, onclick: onclick }, parts);
}

function alarmCard(event) {
  var repeat = REPEATS[event.repeat] || "一次";
  var what = "记下了" + (event.kind === "task" ? "任务" : "闹钟") + "：" + (event.title || "");
  return eventRow("alarm", "alarm", what, repeat + " " + (event.time || "") + " · 桌宠到点提醒", null, event.title || "", null);
}

/** 子任务派出去的那一刻：还在做就带上进度 */
function taskAddedCard(event) {
  var task = taskIndex[event.id];
  var who = event.origin === "main" ? "派了子任务" : "开了子任务";
  var tail = task && task.state === "running" && task.progress.total ? task.progress.done + "/" + task.progress.total + " 在做" : task ? TASK_STATES[task.state] : "";
  return eventRow("task", "task", who + " #" + event.id + "「" + (event.title || "") + "」", "在后台做，做完结果会回到这里", tail, event.title || "", function () { openTaskView(event.id); });
}

/** 子任务做完、没做成、取消，写回主线程的那一条 */
function taskResultCard(item) {
  var lines = item.text.split("\n");
  // 卡片里只放纯文字：去掉加粗的星号
  var detail = lines.slice(1).join("\n").replace(/^结果：\n?/, "").replace(/\*\*/g, "");
  var kind = item.state === "done" ? "done" : item.state === "failed" ? "failed" : item.state === "waiting" ? "ask" : "task";
  var iconName = item.state === "done" ? "check" : item.state === "failed" ? "cross" : "task";
  return eventRow(kind, iconName, lines[0], detail, null, item.text, function () { if (item.task) openTaskView(item.task); });
}

/** yoyo 想做一件要批准的事：还在等就提醒去批，批过了写结论。点开去「待批准」 */
function approvalAskCard(event) {
  var item = approvalIndex[event.id];
  var who = event.task ? "子任务 #" + event.task + " 想做的" : "yoyo 想做的";
  var pending = !item || item.state === "pending";
  var kind = !item || item.state === "pending" ? "ask" : item.state === "approved" ? "done" : "failed";
  return eventRow(kind, "shield", "要你批准：" + (event.text || ""), who + (pending ? " · 在「待批准」里点批准或拒绝" : ""), item ? APPROVAL_STATES[item.state] : "", event.text || "", function () { show("approvals"); });
}

/** 批准请求有了结论，写回主线程的那一条 */
function approvalResultCard(item) {
  var lines = item.text.split("\n");
  var detail = lines.slice(1).join("\n").replace(/^结果：\n?/, "").replace(/\*\*/g, "");
  var kind = item.state === "approved" ? "done" : "failed";
  return eventRow(kind, item.state === "approved" ? "check" : "cross", lines[0], detail, null, item.text, function () { show("approvals"); });
}

/** 取回来的对话和小卡片并进已有的：翻出来的旧消息、滑出最新一页的消息都留着，不会被轮询丢掉 */
function absorb(items, events) {
  items.forEach(function (item) { thread.items[item.seq] = item; });
  events.forEach(function (event) { thread.cards[JSON.stringify(event)] = event; });
}

function loadedItems() {
  return Object.keys(thread.items).map(function (key) { return thread.items[key]; }).sort(function (a, b) { return a.at - b.at || a.seq - b.seq; });
}

/** 对话和新加的日程按时间排在一起，隔了一刻钟以上就插一行时间。keep：往上加载了旧的，保持眼前这一条不动 */
function renderThread(force, keep) {
  var items = loadedItems();
  // 比最早一条消息还早的小卡片先不显示（翻到了再出现），免得悬在最上面
  var floor = items.length ? items[0].at : 0;
  var merged = items.map(function (item) { return { at: item.at, item: item }; });
  Object.keys(thread.cards).forEach(function (key) {
    var event = thread.cards[key];
    var at = Date.parse(event.at);
    if (at < floor && !thread.start) return;
    if (event.type === "schedule-add" || event.type === "task-add" || event.type === "approval-ask") merged.push({ at: at, event: event });
  });
  merged.sort(function (a, b) { return a.at - b.at; });
  var signature = merged.length + ":" + (merged.length ? merged[merged.length - 1].at : 0) + ":" + thread.tasks + ":" + thread.approvals + ":" + thread.start + thread.older;
  if (!force && signature === thread.signature) return;
  thread.signature = signature;
  var box = $("#thread");
  var stick = !keep && (force || nearBottom(box));
  var height = box.scrollHeight;
  var offset = box.scrollTop;
  var nodes = [];
  if (items.length) {
    nodes.push(thread.start ? h("div", { class: "edge", text: "更早的没有了" }) : h("button", { class: "edge-btn", type: "button", disabled: thread.older ? "" : null, text: thread.older ? "加载中……" : "加载更早的", onclick: loadOlder }));
  }
  var last = 0;
  merged.forEach(function (entry) {
    if (entry.at - last > 15 * 60000) nodes.push(h("div", { class: "when", text: when(entry.at) }));
    last = entry.at;
    if (entry.item) nodes.push(entry.item.kind === "task" ? taskResultCard(entry.item) : entry.item.kind === "approval" ? approvalResultCard(entry.item) : message(entry.item));
    else nodes.push(entry.event.type === "task-add" ? taskAddedCard(entry.event) : entry.event.type === "approval-ask" ? approvalAskCard(entry.event) : alarmCard(entry.event));
  });
  var inner = $("#thread-inner");
  fill(inner, nodes, "还没聊过。在下面打一句话，或者右键桌宠的「对话」。");
  applySearch();
  if (stick) box.scrollTop = box.scrollHeight;
  else if (keep) box.scrollTop = offset + (box.scrollHeight - height);
}

function loadThread(force) {
  if (thread.pending) return Promise.resolve();
  return Promise.all([api("GET", "/api/context?limit=" + PAGE), api("GET", "/api/activity?limit=200&types=" + CARD_TYPES)]).then(function (both) {
    if (thread.pending) return;
    // 第一次取就不满一页：整段对话都在这里了，上面没有更早的
    if (!thread.loaded) { thread.loaded = true; thread.start = both[0].length < PAGE; }
    absorb(both[0], both[1]);
    renderThread(force, false);
  });
}

/** 往上翻：取比现在最早一条更早的一页（游标是那条的 at:seq）；不满一页就是到头了 */
function loadOlder() {
  var items = loadedItems();
  if (thread.older || thread.start || thread.pending || !items.length) return;
  var first = items[0];
  thread.older = true;
  renderThread(true, true);
  Promise.all([
    api("GET", "/api/context?limit=" + OLDER + "&before=" + first.at + ":" + first.seq),
    api("GET", "/api/activity?limit=200&types=" + CARD_TYPES + "&before=" + encodeURIComponent(new Date(first.at).toISOString())),
  ]).then(function (both) {
    if (both[0].length < OLDER) thread.start = true;
    absorb(both[0], both[1]);
  }, fail).then(function () {
    thread.older = false;
    if (!thread.pending) renderThread(true, true);
  });
}

function applySearch() {
  var query = thread.query.toLowerCase();
  document.querySelectorAll("#thread-inner [data-text]").forEach(function (node) {
    node.hidden = Boolean(query) && node.getAttribute("data-text").toLowerCase().indexOf(query) < 0;
  });
  document.querySelectorAll("#thread-inner .when").forEach(function (node) { node.hidden = Boolean(query); });
}

function sendMessage(event) {
  event.preventDefault();
  var input = $("#say");
  var text = input.value.trim();
  if (!text || thread.pending) return;
  thread.pending = true;
  $("#send").disabled = true;
  input.value = "";
  grow();
  var inner = $("#thread-inner");
  var empty = inner.querySelector(".empty");
  if (empty) empty.remove();
  var mine = message({ kind: "user", text: text, via: "workbench" });
  var bubble = h("div", { class: "bubble typing", text: "在想" });
  var waiting = h("div", { class: "msg pending" }, [avatar(), bubble]);
  inner.appendChild(mine);
  inner.appendChild(waiting);
  var box = $("#thread");
  box.scrollTop = box.scrollHeight;
  var got = "";
  streamChat(text, function (piece) {
    var stick = nearBottom(box);
    got += piece;
    // 模型有时先吐换行：开头的空白不显示，免得气泡上面空一行
    waiting.className = "msg streaming";
    bubble.className = "bubble";
    bubble.replaceChildren.apply(bubble, rich(got.replace(/^\s+/, "")));
    if (stick) box.scrollTop = box.scrollHeight;
  }).then(function (reply) {
    // 记进日志的是这一份整段回复（去了首尾空白），用它换掉增量拼出来的
    waiting.className = "msg";
    bubble.className = "bubble";
    bubble.replaceChildren.apply(bubble, rich(reply));
    thread.pending = false;
    return loadThread(true);
  }, function (error) {
    thread.pending = false;
    mine.remove();
    waiting.remove();
    if (!input.value) { input.value = text; grow(); }
    fail(error);
  }).finally(function () {
    thread.pending = false;
    $("#send").disabled = !input.value.trim();
    input.focus();
  });
}

function grow() {
  var input = $("#say");
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 200) + "px";
  $("#send").disabled = thread.pending || !input.value.trim();
}

function loadStatus() {
  return api("GET", "/api/status").then(function (s) {
    canReveal = Boolean(s.reveal);
    inApp = Boolean(s.app);
    var items = [];
    function item(state, text, wrap) {
      items.push(h("div", { class: "item" + (wrap ? " wrap" : "") }, [h("span", { class: "dot" + (state === undefined ? "" : state ? " ok" : " off") }), h("span", { text: text })]));
    }
    if (s.pet) item(s.pet.reachable, s.pet.reachable ? "桌宠连着" : "桌宠没连上");
    else item(undefined, "控制台舞台");
    item(Boolean(s.llm.model), s.llm.model ? "模型 " + s.llm.model : "没配模型");
    if (s.pet) item(s.channel, s.channel ? "右键对话由 yoyo 回答" : "右键对话没接上");
    item(s.memory.enabled, s.memory.enabled ? "记住了 " + s.memory.facts + " 件事" : "记忆没打开");
    if (s.approvals) item(false, s.approvals + " 件事等你批准");
    if (s.pet && s.pet.work && s.pet.work.task) item(undefined, "在忙：" + s.pet.work.task);
    if (s.nextWhisper) item(undefined, "下一句碎碎念 " + when(s.nextWhisper) + (s.lastPace ? " · " + s.lastPace.note : ""), Boolean(s.lastPace));
    fill($("#status"), items, "");
    var mood = !s.pet ? "控制台里" : !s.pet.reachable ? "桌宠没连上" : s.pet.work && s.pet.work.task ? "陪你" + s.pet.work.task : "在桌面上";
    $("#mood").replaceChildren(h("span", { class: "dot " + (s.pet && s.pet.reachable ? "ok" : "off") }), h("span", { text: mood }));
    $("#model-name").textContent = s.llm.model ? s.llm.model + (s.llm.tools ? " · 能用工具，会派子任务" : "") : "没配模型，回不了话";
  });
}

// ---- 其余各页 ----

var SWITCHES = [
  ["listen.enabled", "说完听你回应"],
  ["speech.autoplay", "放语音"],
  ["sfx.enabled", "动作音效"],
  ["weather.enabled", "傍晚报天气"],
  ["memes.enabled", "碎碎念配表情包"],
  ["clipboard.enabled", "读粘贴板"],
  ["hotkey.enabled", "Control+Option+Y 听一句"],
  ["llm.tools", "回复时用工具"],
  ["memory.enabled", "记住主人"],
  ["sandbox.enabled", "MCP 服务器关进沙箱"],
];

var TRAIL = {
  "whisper": "说了一句", "whisper-skip": "这次没说", "chat-voice": "语音对话", "chat-workbench": "工作台对话",
  "listen-request": "听一句", "search": "搜索", "schedule-add": "加日程", "schedule-remove": "删日程", "schedule-edit": "改日程", "schedule-pause": "暂停日程", "schedule-resume": "恢复日程",
  "contact-add": "加联系人", "contact-remove": "删联系人", "memory-forget": "忘掉一件事", "memory-retire": "退役一条规矩",
  "memory-core-edit": "改画像", "memory-consolidate": "整理记忆", "config-edit": "改配置", "config-switch": "改开关", "config-fields": "改常用设置",
  "approval-ask": "要你批准", "approval-approve": "批准了", "approval-deny": "拒绝了", "approval-expire": "批准过期", "approval-run": "照做了",
  "task-ask": "子任务提问", "task-answer": "回答了子任务", "delay": "让路", "pace": "定了间隔", "clipboard": "读粘贴板", "tool-call": "用工具", "send": "发消息", "remind": "提醒",
};

var PACE_WHY = { error: "没判成", timeout: "超时", unsure: "没把握" };

/** 轨迹里「定了间隔」那一行：隔多久，挑的哪一档，或为什么退回固定间隔。 */
function paceDetail(item) {
  var gap = item.sec >= 3600 && item.sec % 3600 === 0 ? item.sec / 3600 + " 小时" : Math.round(item.sec / 60) + " 分钟";
  if (item.source === "decided") return "隔 " + gap + "（挑了 " + item.option + "）";
  return "隔 " + gap + "（" + (PACE_WHY[item.reason] || "没判成") + "，按固定间隔）";
}

// ---- 日程 ----
function alarmOn(item) {
  return item.repeat === "weekly" ? DAYS[item.weekday] : (REPEATS[item.repeat] || item.date);
}

/** 一条日程：时间、内容、什么时候，暂停的灰掉写「暂停中」，右边是编辑、暂停或恢复、删除 */
function alarmRow(item) {
  var reload = function () { views.alarms.load().catch(fail); };
  var edit = h("button", { class: "plain mini", type: "button", text: "编辑" });
  var pause = h("button", { class: "plain mini", type: "button", text: item.enabled ? "暂停" : "恢复", onclick: function () {
    pause.disabled = true;
    api("PATCH", "/api/alarms/" + encodeURIComponent(item.id), { enabled: !item.enabled }).then(function () {
      toast(item.enabled ? "暂停了，到点不会响" : "恢复了");
      reload();
    }, function (error) { pause.disabled = false; fail(error); });
  } });
  var remove = h("button", { class: "danger", type: "button", text: "删除", onclick: confirmThen("删掉「" + item.title + "」？", function () {
    api("DELETE", "/api/alarms/" + encodeURIComponent(item.id)).then(reload, fail);
  }) });
  var node = h("div", { class: "row alarm" + (item.enabled ? "" : " paused") }, [
    h("div", { class: "who", text: item.time }),
    h("div", { class: "main", text: item.title + (item.kind === "task" ? "（任务）" : "") }),
    item.enabled ? null : h("span", { class: "tag", text: "暂停中" }),
    h("div", { class: "side-note", text: alarmOn(item) }),
    h("div", { class: "acts" }, [edit, pause, remove]),
  ]);
  edit.addEventListener("click", function () {
    var form = alarmEditor(item, function () { form.replaceWith(node); }, reload);
    node.replaceWith(form);
    form.querySelector("input").focus();
  });
  return node;
}

function choices(select, pairs, value) {
  pairs.forEach(function (pair) { select.appendChild(h("option", { value: pair[0], text: pair[1] })); });
  select.value = value;
  return select;
}

/** 就地改一条日程：和上面的添加表单同样几项，保存只交回改的这一条 */
function alarmEditor(item, cancel, saved) {
  var title = h("input", { name: "title", value: item.title, required: "", "aria-label": "提醒什么" });
  var time = h("input", { name: "time", type: "time", value: item.time, required: "", "aria-label": "时间" });
  var repeat = choices(h("select", { name: "repeat", "aria-label": "重复" }),
    [["", "一次"], ["daily", "每天"], ["weekdays", "工作日"], ["weekly", "每周"]], item.repeat || "");
  var date = h("input", { name: "date", type: "date", value: item.date || "", "aria-label": "日期" });
  var weekday = choices(h("select", { name: "weekday", "aria-label": "星期" }),
    [[1, "周一"], [2, "周二"], [3, "周三"], [4, "周四"], [5, "周五"], [6, "周六"], [0, "周日"]], item.weekday === null ? 1 : item.weekday);
  var kind = choices(h("select", { name: "kind", "aria-label": "类型" }), [["alarm", "闹钟"], ["task", "任务"]], item.kind);
  var save = h("button", { class: "primary", type: "submit", text: "保存" });
  var form = h("form", { class: "inline editing" }, [
    title, time, repeat, date, weekday, kind, save,
    h("button", { class: "plain", type: "button", text: "取消", onclick: cancel }),
  ]);
  function sync() {
    date.hidden = repeat.value !== "";
    weekday.hidden = repeat.value !== "weekly";
  }
  repeat.addEventListener("change", sync);
  sync();
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var body = { title: title.value, time: time.value, kind: kind.value, repeat: repeat.value || null };
    body.date = repeat.value ? null : date.value;
    body.weekday = repeat.value === "weekly" ? Number(weekday.value) : null;
    save.disabled = true;
    api("PATCH", "/api/alarms/" + encodeURIComponent(item.id), body).then(function () {
      toast("改好了");
      saved();
    }, function (error) { save.disabled = false; fail(error); });
  });
  form.addEventListener("keydown", function (event) { if (event.key === "Escape") cancel(); });
  return form;
}

// ---- 设置：常用设置表单 ----
var TONES = [["", "不指定"], ["lively", "活泼 lively"], ["warm", "温柔 warm"], ["calm", "平静 calm"], ["brisk", "利落 brisk"]];

/** 表单分组。kind：text 文字、secret 密钥（读出来是码，不动就不改）、select 下拉、number 数、list 几档秒数 */
var FIELD_GROUPS = [
  { title: "模型", fields: [
    { path: "llm.provider", label: "协议", kind: "select", options: [["openai-compatible", "openai-compatible"], ["anthropic", "anthropic"]] },
    { path: "llm.baseUrl", label: "接口地址", kind: "text", placeholder: "https://…/v1", note: "anthropic 可以留空" },
    { path: "llm.model", label: "模型名", kind: "text", placeholder: "例如 deepseek-chat" },
    { path: "llm.apiKey", label: "密钥", kind: "secret" },
  ] },
  { title: "语音（Fish Audio）", fields: [
    { path: "speech.apiKey", label: "密钥", kind: "secret" },
    { path: "speech.referenceId", label: "音色 referenceId", kind: "text" },
    { path: "speech.model", label: "语音模型", kind: "text" },
    { path: "speech.tone", label: "对话的语气", kind: "select", options: TONES },
  ] },
  { title: "碎碎念", fields: [
    { path: "intervalSec", label: "固定间隔（秒）", kind: "number", min: 60, max: 86400, note: "最少 60 秒" },
    { path: "pace.options", label: "几档间隔（秒）", kind: "list", note: "逗号隔开，至少两档；配了决策模型才用，没配按上面的固定间隔" },
    { path: "pace.recent", label: "给决策模型的最近对话条数", kind: "number", min: 0, max: 20, note: "0 是只给信号，不给原文" },
  ] },
];

var fieldsDirty = false;
/** 当前这份表单：路径 → 读出现在的值、读到时的值 */
var fieldCtl = {};

function sameValue(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

/** 把一个框里的字读成要交回的值；几档里写了不是数的，原样交回让服务端说是哪一项错 */
function readField(spec, input) {
  if (spec.kind === "number") return input.value.trim() === "" ? input.value : Number(input.value);
  if (spec.kind === "list") {
    var words = input.value.split(/[,，\s]+/).filter(Boolean);
    var numbers = words.map(Number);
    return numbers.some(isNaN) ? words : numbers;
  }
  return input.value;
}

function renderFields(values) {
  fieldCtl = {};
  var groups = FIELD_GROUPS.map(function (group) {
    var nodes = group.fields.map(function (spec) {
      var value = values[spec.path];
      var input;
      if (spec.kind === "select") input = choices(h("select", { "aria-label": spec.label }), spec.options, value);
      else {
        var type = spec.kind === "secret" ? "password" : spec.kind === "number" ? "number" : "text";
        input = h("input", { type: type, "aria-label": spec.label, autocomplete: "off", spellcheck: "false",
          placeholder: spec.kind === "secret" ? "还没填" : (spec.placeholder || ""), min: spec.min, max: spec.max });
        input.value = spec.kind === "list" ? value.join(", ") : value;
      }
      // 密钥框里是码：点进去全选，打字就是换新的，删空是清掉，不动就不会交回去
      if (spec.kind === "secret") input.addEventListener("focus", function () { input.select(); });
      fieldCtl[spec.path] = { spec: spec, input: input, was: value };
      var note = spec.kind === "secret"
        ? (value ? "已填。要换就输入新的，清空是删掉，不动就不改" : "")
        : (spec.note || "");
      return h("label", { class: "setfield" }, [h("span", { class: "k", text: spec.label }), input, note ? h("span", { class: "note", text: note }) : null]);
    });
    return h("div", { class: "setgroup" }, [h("h3", { text: group.title })].concat(nodes));
  });
  $("#field-groups").replaceChildren.apply($("#field-groups"), groups);
  fieldsDirty = false;
}

/** 只交回动过的项，别的不动 */
function saveFields() {
  var changes = {};
  Object.keys(fieldCtl).forEach(function (path) {
    var ctl = fieldCtl[path];
    var now = readField(ctl.spec, ctl.input);
    if (!sameValue(now, ctl.was)) changes[path] = now;
  });
  if (Object.keys(changes).length === 0) { toast("没有改动"); return; }
  var button = $("#fields-save");
  button.disabled = true;
  api("PATCH", "/api/config/fields", { fields: changes, version: configVersion }).then(function () {
    fieldsDirty = false;
    toast("存好了，一两秒内生效");
    views.settings.load().catch(fail);
  }, function (error) {
    // 在别处改过了：换成最新的，刚才的改动要重新改
    if (error.status === 409) { fieldsDirty = false; views.settings.load().catch(fail); }
    fail(error);
  }).finally(function () { button.disabled = false; });
}

/** 整份配置：读到时的指纹，和框里改过没有。开关改了以后，框里没动过就跟着刷新。 */
var configVersion = "";
var textVersion = "";
var configDirty = false;

var views = {
  chat: { title: "和 yoyo", sub: "桌宠上聊的、语音说的、这里打的，都在这一条里", load: function () {
    // 先拿子任务：对话里派出去的那张卡片要显示进度
    return Promise.all([Promise.all([loadTasks().catch(function () {}), loadApprovals().catch(function () {})]).then(function () { return loadThread(false); }), loadStatus()]);
  } },
  approvals: { title: "待批准", sub: "yoyo 想做、要你点头的事：读写文件、跑命令", load: function () {
    return loadApprovals();
  } },
  task: { title: "子任务", sub: "yoyo 派到后台的事", load: function () {
    if (!openTask) return Promise.resolve();
    var id = openTask;
    return Promise.all([
      Promise.all([api("GET", "/api/tasks/" + id), api("GET", "/api/artifacts?task=" + id)]).then(function (got) { renderTask(got[0], got[1]); watchTask(got[0]); }),
      loadTasks(),
    ]);
  } },
  newtask: { title: "派一个子任务", sub: "写清楚目标和怎样算做好，yoyo 在后台做，进度在左边的子任务里", load: function () {
    return api("GET", "/api/agents").then(function (list) {
      var select = $("#task-agent");
      var chosen = select.value;
      agentList = list;
      fill(select, list.map(function (agent) { return h("option", { value: agent.name, text: agent.name }); }), "");
      if (chosen) select.value = chosen;
      syncAgent();
      $("#task-off").hidden = list.length > 0;
      $("#task-submit").disabled = list.length === 0;
    });
  } },
  memory: { title: "记忆", sub: "yoyo 记得的你：画像、记得的事、规矩。记错的可以删", load: function () {
    return api("GET", "/api/memory").then(function (m) {
      $("#core-text").value = m.core ? m.core.text : "";
      $("#core-at").textContent = m.core ? "更新于 " + when(m.core.at) + " · 能直接改" : "还没有画像，可以自己写";
      $("#memory-off").hidden = m.enabled;
      memoryFacts = m.facts;
      $("#fact-count").textContent = m.facts.length ? m.facts.length + " 件" : "";
      renderFacts();
      fill($("#rules"), m.rules.map(function (rule) {
        var retire = h("button", { class: "danger", type: "button", text: "退役", onclick: confirmThen("让这条不再生效？", function () {
          api("DELETE", "/api/memory/rules/" + encodeURIComponent(rule.id)).then(function () { toast("退役了"); views.memory.load(); }, fail);
        }) });
        var badge = rule.effective ? "生效 · 确认 " + rule.confirmations + " 次" : "待确认 · " + rule.confirmations + " 次";
        return h("div", { class: "fact" }, [
          h("span", { class: "main", text: rule.when + " → " + rule.do }),
          h("span", { class: "tag" + (rule.effective ? " on" : ""), text: badge }),
          retire,
        ]);
      }), "还没有");
    });
  } },
  alarms: { title: "日程", sub: "到点由桌宠提醒；暂停的不响，留着", load: function () {
    return api("GET", "/api/alarms").then(function (items) {
      fill($("#alarm-list"), items.map(alarmRow), "还没有日程");
    });
  } },
  activity: { title: "轨迹", sub: "yoyo 做过的事", load: function () {
    return api("GET", "/api/activity?limit=300").then(function (items) {
      // 记录按时间先后来，最新的放上面，按天分开
      var nodes = [];
      var lastDay = "";
      items.slice().reverse().forEach(function (item) {
        var at = Date.parse(item.at);
        var day = dayOf(at);
        if (day !== lastDay) { nodes.push(h("div", { class: "day", text: day })); lastDay = day; }
        var detail = item.text || item.title || item.query || item.name || item.until || (item.type === "pace" ? paceDetail(item) : "");
        nodes.push(row(clock(at), (TRAIL[item.type] || item.type) + (detail ? "  " + detail : ""), null));
      });
      fill($("#activity-list"), nodes, "还没有记录");
    });
  } },
  contacts: { title: "联系人", sub: "别的 yoyo", load: function () {
    return api("GET", "/api/contacts").then(function (items) {
      fill($("#contact-list"), items.map(function (item) {
        var remove = h("button", { class: "danger", text: "删除", onclick: confirmThen("删掉「" + item.name + "」？", function () {
          api("DELETE", "/api/contacts/" + encodeURIComponent(item.id)).then(function () { views.contacts.load(); }, fail);
        }) });
        return row(item.name, item.yoyo + (item.note ? "  " + item.note : ""), null, remove);
      }), "还没有联系人");
    });
  } },
  settings: { title: "设置", sub: "存好一两秒内生效", load: function () {
    return api("GET", "/api/config").then(function (c) {
      fill($("#switches"), SWITCHES.map(function (pair) {
        var box = h("input", { type: "checkbox", "aria-label": pair[1] });
        box.checked = Boolean(c.switches[pair[0]]);
        box.addEventListener("change", function () {
          var change = {};
          change[pair[0]] = box.checked;
          box.disabled = true;
          api("PATCH", "/api/config", { switches: change }).then(function () {
            toast("改好了，yoyo 一会儿就换上");
            if (!configDirty) views.settings.load().catch(fail);
          }, function (error) {
            box.checked = !box.checked;
            fail(error);
          }).finally(function () { box.disabled = false; });
        });
        return h("label", { class: "row" }, [h("div", { class: "main", text: pair[1] }), box]);
      }), "");
      configVersion = c.version;
      if (!fieldsDirty) renderFields(c.fields);
      if (!configDirty) { $("#config-text").value = c.text; textVersion = c.version; }
      $("#config-file").textContent = c.file;
    });
  } },
};

var agentList = [];

/** 选了哪种类型，下面写一句什么时候用 */
function syncAgent() {
  var name = $("#task-agent").value;
  var found = agentList.filter(function (agent) { return agent.name === name; })[0];
  $("#agent-note").textContent = found ? found.description : "";
}

/**
 * 子任务详情开着、任务还在做时，用 SSE 接着收它的过程（有新的才推），不再每 4 秒整份重取；
 * 连接断了或服务不支持就退回轮询：轮询那一拍会发现没有连着，重新连。
 */
var taskStream = { id: 0, alive: false, controller: null };

function stopWatch() {
  if (taskStream.controller) taskStream.controller.abort();
  taskStream = { id: 0, alive: false, controller: null };
}

function watchTask(task) {
  var live = task.state === "queued" || task.state === "running" || task.state === "waiting";
  if (!live) return stopWatch();
  if (taskStream.alive && taskStream.id === task.id) return;
  stopWatch();
  var controller = new AbortController();
  var mine = { id: task.id, alive: true, controller: controller };
  taskStream = mine;
  openStream("GET", "/api/tasks/" + task.id + "/events", undefined, controller.signal).then(function (response) {
    return readEvents(response, function (name, data) {
      if (name !== "task" || current !== "task" || openTask !== task.id) return;
      renderTask(data.task, data.artifacts);
      loadTasks().catch(function () {});
    });
  }).catch(function () {}).then(function () {
    mine.alive = false;
  });
}

function loadTasks() {
  return api("GET", "/api/tasks").then(function (tasks) {
    // 在做的几个排在最前，其余照旧新的在前
    var live = function (task) { return task.state === "running" || task.state === "waiting"; };
    var listed = tasks.filter(live).concat(tasks.filter(function (task) { return !live(task); }));
    fill($("#task-list"), listed.map(function (task) {
      var active = current === "task" && openTask === task.id;
      var count = task.progress.total ? task.progress.done + "/" + task.progress.total : TASK_STATES[task.state];
      var bar = null;
      if (task.state === "running" && task.progress.total) {
        var fillBar = h("span");
        fillBar.style.width = Math.round((task.progress.done / task.progress.total) * 100) + "%";
        bar = h("span", { class: "mini" }, [fillBar]);
      }
      var label = task.state === "running" && task.progress.total ? count : TASK_STATES[task.state];
      return h("button", { class: "task-item" + (active ? " active" : ""), type: "button", title: TASK_STATES[task.state], onclick: function () { openTaskView(task.id); } }, [
        h("span", { class: "line" }, [h("span", { class: "dot " + stateDot(task.state) }), h("span", { class: "name", text: task.title }), h("span", { class: "meta", text: label })]),
        bar,
      ]);
    }), "");
    taskIndex = {};
    tasks.forEach(function (task) { taskIndex[task.id] = task; });
    thread.tasks = tasks.map(function (task) { return task.id + task.state + task.progress.done; }).join(",");
    $("#task-empty").hidden = tasks.length > 0;
    var running = tasks.filter(function (task) { return task.state === "running"; }).length;
    var queued = tasks.filter(function (task) { return task.state === "queued"; }).length;
    var asking = tasks.filter(function (task) { return task.state === "waiting"; }).length;
    $("#task-count").textContent = [running ? running + " 件在做" : "", asking ? asking + " 件等回答" : "", queued ? queued + " 件排队" : ""].filter(Boolean).join(" · ");
  });
}

function section(title, children) {
  return h("div", { class: "panel" }, [h("h2", { text: title })].concat(children));
}

function card(children, extra) {
  return h("section", { class: "card" + (extra ? " " + extra : "") }, children);
}

function labelRow(text, note) {
  return h("div", { class: "card-head" }, [h("h2", { class: "label", text: text }), note ? h("span", { class: "side-note", text: note }) : null]);
}

function markIcon(name) {
  return iconNode(name);
}

/** 取一个交付物的原文：要带令牌，所以不用链接，取成 Blob */
function artifactBlob(artifact) {
  var key = artifact.id + ":" + artifact.createdAt;
  if (artifactBlobs[key]) return Promise.resolve(artifactBlobs[key]);
  return fetch("/api/artifacts/" + artifact.id, { headers: { authorization: "Bearer " + token } }).then(function (response) {
    if (response.status === 401) lock();
    if (!response.ok) return response.json().catch(function () { return {}; }).then(function (data) { throw new Error(data.error || ("出错了（" + response.status + "）")); });
    return response.blob();
  }).then(function (blob) {
    artifactBlobs[key] = blob;
    return blob;
  });
}

function download(artifact) {
  artifactBlob(artifact).then(function (blob) {
    var url = URL.createObjectURL(blob);
    var link = h("a", { href: url, download: artifact.name });
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }, fail);
}

/** 预览：文本原样显示，图片显示；取回来以后放进占好的位置 */
function previewNode(artifact) {
  var box = h("div", { class: "preview", text: "取回来……" });
  artifactBlob(artifact).then(function (blob) {
    if (artifact.view === "image") {
      var img = h("img", { class: "preview-img", alt: artifact.name });
      // 在做的子任务每 4 秒重画一次：同一张图只建一个地址
      blob.url = blob.url || URL.createObjectURL(blob);
      img.src = blob.url;
      box.replaceWith(img);
    } else {
      return blob.text().then(function (text) { box.textContent = text; });
    }
  }).catch(function (error) { box.textContent = error.message || String(error); });
  return box;
}

var FILE_ICONS = { text: "doc", image: "image", file: "file" };

function artifactsCard(task, artifacts) {
  var rows = [labelRow("交付物", artifacts.length ? artifacts.length + " 个" : "")];
  artifacts.forEach(function (artifact) {
    var opened = artifactOpen === artifact.id;
    var acts = [];
    if (artifact.view !== "file") acts.push(h("button", { class: "plain", type: "button", text: opened ? "收起" : "预览", onclick: function () {
      artifactOpen = opened ? 0 : artifact.id;
      renderTask(task, artifacts);
    } }));
    if (!inApp) acts.push(h("button", { class: "plain", type: "button", text: "下载", onclick: function () { download(artifact); } }));
    if (canReveal) acts.push(h("button", { class: "plain", type: "button", text: "在访达里显示", onclick: function () {
      api("POST", "/api/artifacts/" + artifact.id + "/reveal", {}).catch(fail);
    } }));
    acts.push(h("button", { class: "danger", type: "button", text: "删除", onclick: confirmThen("删掉「" + artifact.name + "」？文件一起删。", function () {
      api("DELETE", "/api/artifacts/" + artifact.id).then(function () { toast("删了"); views.task.load(); }, fail);
    }) }));
    rows.push(h("div", { class: "file" }, [
      h("span", { class: "chip" }, [iconNode(FILE_ICONS[artifact.view] || "file")]),
      h("div", { class: "main" }, [h("div", { class: "name", text: artifact.name, title: artifact.name }), h("div", { class: "note", text: sizeLabel(artifact.size) + " · " + when(artifact.createdAt) })]),
      h("div", { class: "acts" }, acts),
    ]));
    if (opened) rows.push(previewNode(artifact));
  });
  return card(rows);
}

function sizeLabel(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1).replace(/\.0$/, "") + " KB";
  return (bytes / 1048576).toFixed(1).replace(/\.0$/, "") + " MB";
}

/** 取回批准请求的列表：更新侧栏的个数和对话里卡片的状态，在「待批准」页就重画 */
function loadApprovals() {
  return api("GET", "/api/approvals").then(function (list) {
    approvalList = list;
    approvalIndex = {};
    list.forEach(function (item) { approvalIndex[item.id] = item; });
    var waiting = list.filter(function (item) { return item.state === "pending"; }).length;
    var count = $("#approval-count");
    count.textContent = String(waiting);
    count.hidden = waiting === 0;
    thread.approvals = list.map(function (item) { return item.id + item.state; }).join(",");
    if (current === "approvals") renderApprovals();
  });
}

/** 参数摊开：每个字段一块，内容、原文、命令原样放进去 */
function paramsNode(input) {
  var rows = [];
  if (input && typeof input === "object") {
    Object.keys(input).forEach(function (key) {
      var value = input[key];
      var text = typeof value === "string" ? value : JSON.stringify(value);
      rows.push(h("div", { class: "param" }, [h("div", { class: "k", text: PARAM_LABELS[key] || key }), h("pre", { class: "preview", text: text })]));
    });
  } else {
    rows.push(h("pre", { class: "preview", text: String(input) }));
  }
  return h("div", { class: "params" }, rows);
}

function reloadApprovals() {
  loadApprovals().catch(fail);
  loadTasks().catch(function () {});
  if (current === "task") views.task.load().catch(function () {});
  loadStatus().catch(function () {});
}

function decide(item, verdict, button, other) {
  button.disabled = true;
  other.disabled = true;
  api("POST", "/api/approvals/" + item.id + "/" + verdict, {}).then(function () {
    toast(verdict === "approve" ? "批准了，yoyo 马上照做" : "拒绝了，不做");
    reloadApprovals();
  }, function (error) {
    button.disabled = false;
    other.disabled = false;
    fail(error);
    reloadApprovals();
  });
}

/** 一条批准请求：工具、摘要、谁要的；能展开看完整参数；等批准的有「批准」「拒绝」，批过的写结论和结果 */
function approvalCard(item, redraw) {
  var open = Boolean(approvalOpen[item.id]);
  var pending = item.state === "pending";
  var who = item.task ? "子任务 #" + item.task : "yoyo";
  var head = h("div", { class: "apv-head" }, [
    h("span", { class: "tag work", text: TOOL_LABELS[item.tool] || item.tool }),
    h("div", { class: "what", text: item.summary }),
    h("span", { class: "side-note", text: who + " · " + when(item.createdAt) }),
  ]);
  var parts = [head];
  if (!pending) {
    parts.push(h("div", { class: "why" }, [h("span", { class: "badge " + (item.state === "approved" ? "done" : item.state === "denied" ? "failed" : "waiting"), text: APPROVAL_STATES[item.state] }), document.createTextNode(item.note ? " " + item.note : "")]));
  }
  var toggle = h("button", { class: "plain", type: "button", "aria-expanded": String(open), text: open ? "收起参数" : (pending ? "看完整参数" : "看参数和结果"), onclick: function () {
    approvalOpen[item.id] = !open;
    if (!open && !approvalDetails[item.id]) {
      api("GET", "/api/approvals/" + item.id).then(function (detail) { approvalDetails[item.id] = detail; redraw(); }, fail);
    }
    redraw();
  } });
  var acts = [toggle];
  if (pending) {
    var deny = h("button", { class: "plain", type: "button", text: "拒绝" });
    var approve = h("button", { class: "primary", type: "button", text: "批准" });
    deny.addEventListener("click", function () { decide(item, "deny", deny, approve); });
    approve.addEventListener("click", function () { decide(item, "approve", approve, deny); });
    acts.push(deny, approve);
  }
  if (open) {
    var detail = approvalDetails[item.id];
    if (!detail) parts.push(h("div", { class: "empty", text: "取回来……" }));
    else {
      parts.push(paramsNode(detail.input));
      if (detail.result) parts.push(h("div", { class: "param" }, [h("div", { class: "k", text: "做完的结果" }), h("pre", { class: "preview", text: detail.result })]));
    }
  }
  parts.push(h("div", { class: "acts" }, acts));
  return h("section", { class: "card apv" + (pending ? " ask" : " settled") }, parts);
}

/** 「待批准」页：等批准的在上面，下面是最近批过、拒绝过、过期的 */
function renderApprovals() {
  var pending = approvalList.filter(function (item) { return item.state === "pending"; });
  var settled = approvalList.filter(function (item) { return item.state !== "pending"; });
  var nodes = [];
  if (pending.length) {
    nodes.push(labelRow("等你批准", pending.length + " 件"));
    pending.forEach(function (item) { nodes.push(approvalCard(item, renderApprovals)); });
  } else {
    nodes.push(card([labelRow("等你批准"), h("div", { class: "empty", text: "没有要批准的。config.json 里 files.read、write、edit、bash 写成 ask，yoyo 想动手时就会停在这里等你点头。" })]));
  }
  if (settled.length) {
    nodes.push(labelRow("最近处理过的", settled.length + " 件"));
    settled.forEach(function (item) { nodes.push(approvalCard(item, renderApprovals)); });
  }
  fill($("#approvals-page"), [h("div", { class: "col-main" }, nodes)], "");
}

/** 回答框里写了一半的话：4 秒一刷新不能丢，按子任务记 */
var answerDraft = { id: 0, text: "" };

/** 子 agent 在等回答：问题，加一个回答框 */
function answerCard(task) {
  var box = h("textarea", { id: "answer-box", rows: "3", placeholder: "在这里回答，子任务会接着做", "aria-label": "回答子任务的问题" });
  if (answerDraft.id === task.id) box.value = answerDraft.text;
  box.addEventListener("input", function () { answerDraft = { id: task.id, text: box.value }; });
  var send = h("button", { class: "primary", type: "button", text: "回答" });
  send.addEventListener("click", function () {
    var value = box.value.trim();
    if (!value) return;
    send.disabled = true;
    api("POST", "/api/tasks/" + task.id + "/answer", { answer: value }).then(function () {
      answerDraft = { id: 0, text: "" };
      toast("回答交给它了，它会接着做");
      views.task.load(); loadTasks();
    }, function (error) { send.disabled = false; fail(error); });
  });
  return card([labelRow("等你回答", task.askedAt ? when(task.askedAt) : ""), h("div", { class: "question", text: task.question }), box, h("div", { class: "acts" }, [send])], "ask");
}

function renderTask(task, artifacts) {
  artifacts = artifacts || [];
  var typing = document.activeElement && document.activeElement.id === "answer-box";
  var open = task.state === "queued" || task.state === "running" || task.state === "waiting";
  var origins = { main: "yoyo 派的", cli: "命令行派的", web: "工作台派的" };
  $("#title").textContent = task.title;
  $("#subtitle").textContent = "子任务 #" + task.id + " · " + task.agent + " · " + (origins[task.origin] || task.origin) + " · " + when(task.createdAt) + (task.finishedAt ? " · 结束于 " + when(task.finishedAt) : "");
  var cancel = open ? h("button", { class: "plain", type: "button", text: "取消", onclick: confirmThen("取消子任务 #" + task.id + "？", function () {
    api("POST", "/api/tasks/" + task.id + "/cancel", {}).then(function () { toast("取消了"); views.task.load(); loadTasks(); }, fail);
  }) }) : null;
  $("#bar-actions").replaceChildren(h("span", { class: "badge " + task.state, text: TASK_STATES[task.state] }));
  if (cancel) $("#bar-actions").appendChild(cancel);

  var main = [card([labelRow("目标"), h("div", { class: "text", text: task.goal })])];
  var asking = (task.approvals || []).filter(function (item) { return item.state === "pending"; });
  if (task.state === "waiting" && asking.length) {
    main.unshift(h("div", { class: "apv-group" }, [labelRow("等你批准", task.askedAt ? when(task.askedAt) : ""), h("div", { class: "side-note", text: "子任务在等这几件事：批准了它接着做，拒绝了它换个办法。" })].concat(asking.map(function (item) { return approvalCard(item, function () { renderTask(task, artifacts); }); }))));
  } else if (task.state === "waiting" && task.question) main.unshift(answerCard(task));
  var progressNote = task.progress.total ? task.progress.done + " / " + task.progress.total : "";
  var todoNodes = [labelRow("todo", progressNote)];
  if (task.progress.total) {
    var fillBar = h("span");
    fillBar.style.width = Math.round((task.progress.done / task.progress.total) * 100) + "%";
    todoNodes.push(h("div", { class: "bar-track" }, [fillBar]));
  }
  if (task.todos.length) {
    task.todos.forEach(function (todo, i) {
      todoNodes.push(h("div", { class: "todo " + todo.state }, [
        h("span", { class: "mark" }, [todo.state === "done" ? markIcon("check") : null]),
        h("div", { class: "main" }, [document.createTextNode((i + 1) + ". " + todo.text), todo.note ? h("div", { class: "note", text: todo.note }) : null]),
      ]));
    });
  } else {
    todoNodes.push(h("div", { class: "empty", text: task.state === "queued" ? "还在排队，开始做时会先拆 todo" : "还没拆" }));
  }
  main.push(card(todoNodes));
  if (task.criteria.length) {
    var checked = task.checks.length > 0;
    main.push(card([labelRow("验收标准")].concat(task.criteria.map(function (criterion) {
      var check = task.checks.filter(function (c) { return c.criterion === criterion; })[0];
      var state = check ? (check.met ? " met" : " unmet") : "";
      return h("div", { class: "criterion" + state }, [
        h("span", { class: "mark" }, [check ? markIcon(check.met ? "check" : "cross") : null]),
        h("div", {}, [document.createTextNode(criterion), check ? h("div", { class: "note", text: check.evidence }) : null]),
      ]);
    }), checked ? [] : [h("div", { class: "side-note", text: "交结果时逐条对：满足没有、凭什么。对不上交不了。" })])));
  }
  if (task.question && task.state !== "waiting") {
    var asked = [labelRow("问过主人", task.askedAt ? when(task.askedAt) : ""), h("div", { class: "text", text: task.question })];
    if (task.answer) asked.push(h("div", { class: "note", text: "回答：" + task.answer }));
    main.push(card(asked));
  }
  if (task.result) main.push(card([labelRow("结果"), h("div", { class: "text" }, rich(task.result))]));
  else if (task.error) main.push(card([labelRow("没做成"), h("div", { class: "text", text: task.error })]));
  else if (open) main.push(card([labelRow("结果"), h("div", { text: task.state === "waiting" ? "在等你回答，回答以后接着做。交了以后结果放在这里，也会回到和 yoyo 的对话里。" : "还在做。交了以后结果放在这里，也会回到和 yoyo 的对话里。" })], "pending"));
  if (artifacts.length) main.push(artifactsCard(task, artifacts));

  var labels = { input: "收到", say: "说", call: "调用工具", result: "工具回了" };
  var steps = task.steps.map(function (step) {
    var head = clock(step.at) + " · " + labels[step.kind] + (step.name ? " · " + step.name : "");
    return h("div", { class: "tl " + step.kind }, [
      h("div", { class: "rail" }, [h("span", { class: "node" }), h("span", { class: "stem" })]),
      h("div", { class: "body" }, [h("div", { class: "k", text: head }), h("div", { class: "t", text: step.text })]),
    ]);
  });
  var side = card([labelRow("过程", task.steps.length ? task.steps.length + " 步" : "")].concat(steps.length ? steps : [h("div", { class: "empty", text: "还没开始" })]));
  fill($("#task-page"), [h("div", { class: "columns" }, [h("div", { class: "col-main" }, main), h("div", { class: "col-side" }, [side])])], "");
  var again = $("#answer-box");
  if (typing && again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
}

/** 记得的事按话题筛：话题按钮只列出有的 */
function renderFacts() {
  var topics = [];
  memoryFacts.forEach(function (fact) { if (fact.topic && topics.indexOf(fact.topic) < 0) topics.push(fact.topic); });
  if (factFilter && topics.indexOf(factFilter) < 0) factFilter = "";
  fill($("#fact-topics"), [""].concat(topics).map(function (topic) {
    return h("button", { type: "button", "aria-pressed": String(factFilter === topic), text: topic ? (TOPICS[topic] || topic) : "全部", onclick: function () { factFilter = topic; renderFacts(); } });
  }), "");
  $("#fact-topics").hidden = topics.length === 0;
  var shown = memoryFacts.filter(function (fact) { return !factFilter || fact.topic === factFilter; });
  fill($("#facts"), shown.map(function (fact) {
    var forget = h("button", { class: "danger", type: "button", text: "忘掉", onclick: confirmThen("真的忘掉这条？删了就找不回来。", function () {
      api("DELETE", "/api/memory/facts/" + encodeURIComponent(fact.id)).then(function () { toast("忘掉了"); views.memory.load(); }, fail);
    }) });
    return h("div", { class: "fact" }, [
      fact.topic ? h("span", { class: "tag " + fact.topic, text: TOPICS[fact.topic] || fact.topic }) : null,
      h("span", { class: "main", text: fact.text }),
      h("span", { class: "side-note", text: fact.recalls ? "召回 " + fact.recalls + " 次" : when(fact.validFrom) }),
      forget,
    ]);
  }), "还没记住什么");
}

function openTaskView(id) {
  openTask = id;
  show("task");
}

var current = "chat";

function show(name) {
  current = name;
  document.querySelectorAll(".nav-item").forEach(function (button) {
    if (button.dataset.view === name) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  document.querySelectorAll("main .view").forEach(function (section) {
    section.classList.toggle("active", section.id === name);
  });
  $("#search-box").hidden = name !== "chat";
  if (name !== "task") { $("#bar-actions").replaceChildren(); stopWatch(); }
  $("#title").textContent = views[name].title;
  $("#subtitle").textContent = views[name].sub;
  try { sessionStorage.setItem("yoyo-view", name === "task" || name === "newtask" ? "chat" : name); } catch (e) {}
  views[name].load().catch(fail);
  if (name === "chat") setTimeout(function () { $("#say").focus(); }, 0);
  if (name === "newtask") setTimeout(function () { $("#task-title").focus(); }, 0);
}

function lock() {
  $("#app").hidden = true;
  $("#locked").style.display = "block";
}

function act(type, label) {
  return function () { api("POST", "/api/actions/" + type, {}).then(function () { toast(label); }, fail); };
}

document.addEventListener("DOMContentLoaded", function () {
  if (!token) return lock();
  document.querySelectorAll("[data-view]").forEach(function (button) {
    button.addEventListener("click", function () { show(button.dataset.view); });
  });
  $("#do-whisper").addEventListener("click", act("whisper", "这就说一句"));
  $("#do-listen").addEventListener("click", act("listen", "在听了"));
  $("#composer").addEventListener("submit", sendMessage);
  $("#say").addEventListener("input", grow);
  $("#say").addEventListener("keydown", function (event) {
    // 输入法选字时的回车不算发送
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      $("#composer").requestSubmit();
    }
  });
  $("#search").addEventListener("input", function (event) { thread.query = event.target.value.trim(); applySearch(); });
  $("#thread").addEventListener("scroll", function (event) { if (event.target.scrollTop < 80) loadOlder(); });
  $("#task-agent").addEventListener("change", syncAgent);
  $("#task-cancel").addEventListener("click", function () { show("chat"); });
  $("#task-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var button = $("#task-submit");
    button.disabled = true;
    api("POST", "/api/tasks", {
      title: $("#task-title").value,
      goal: $("#task-goal").value,
      criteria: $("#task-criteria").value.split("\n"),
      agent: $("#task-agent").value,
    }).then(function (task) {
      $("#task-form").reset();
      toast("派出去了，在后台做");
      loadTasks().catch(function () {});
      openTaskView(task.id);
    }, fail).finally(function () { button.disabled = false; });
  });
  $("#core-save").addEventListener("click", function () {
    api("PUT", "/api/memory/core", { text: $("#core-text").value }).then(function () { toast("画像存好了"); views.memory.load(); }, fail);
  });
  $("#field-form").addEventListener("input", function () { fieldsDirty = true; });
  $("#field-form").addEventListener("submit", function (event) { event.preventDefault(); saveFields(); });
  $("#config-text").addEventListener("input", function () { configDirty = true; });
  $("#config-save").addEventListener("click", function () {
    var button = $("#config-save");
    button.disabled = true;
    api("PUT", "/api/config", { text: $("#config-text").value, version: textVersion }).then(function () {
      configDirty = false;
      toast("存好了，yoyo 一会儿就换上");
      setTimeout(function () { views.settings.load().catch(fail); }, 2500);
    }, function (error) {
      // 在别处改过了：换成最新的，刚才的改动要重新改
      if (error.status === 409) {
        configDirty = false;
        views.settings.load().catch(fail);
      }
      fail(error);
    }).finally(function () { button.disabled = false; });
  });
  $("#alarm-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var form = event.target;
    var repeat = form.repeat.value;
    var body = { title: form.title.value, time: form.time.value, kind: form.kind.value, repeat: repeat || null };
    if (!repeat) body.date = form.date.value;
    if (repeat === "weekly") body.weekday = Number(form.weekday.value);
    api("POST", "/api/alarms", body).then(function () { form.reset(); syncRepeat(); views.alarms.load(); }, fail);
  });
  function syncRepeat() {
    var form = $("#alarm-form");
    form.date.hidden = form.repeat.value !== "";
    form.weekday.hidden = form.repeat.value !== "weekly";
  }
  $("#alarm-form").repeat.addEventListener("change", syncRepeat);
  syncRepeat();
  $("#contact-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var form = event.target;
    api("POST", "/api/contacts", { name: form.name.value, yoyo: form.yoyo.value, note: form.note.value })
      .then(function () { form.reset(); views.contacts.load(); }, fail);
  });
  // 桌宠那边的对话、碎碎念会自己进来：开着对话页时隔几秒看一眼
  setInterval(function () {
    if (document.hidden) return;
    if (current === "chat") loadThread(false).catch(function () {});
    // 开着的子任务有 SSE 接着推，没连上（断了、还没连）才轮询
    if (current === "task" && !taskStream.alive) views.task.load().catch(function () {});
    if (current === "chat" || current === "task") loadTasks().catch(function () {});
    loadApprovals().catch(function () {});
  }, 4000);
  setInterval(function () {
    if (document.hidden || current !== "chat") return;
    loadStatus().catch(function () {});
  }, 20000);
  var view = "chat";
  try { view = sessionStorage.getItem("yoyo-view") || view; } catch (e) {}
  show(views[view] ? view : "chat");
});
`;

function navButton(view: string, name: string, label: string): string {
  return `<button class="nav-item" data-view="${view}" type="button">${icon(name)}<span>${label}</span></button>`;
}

const BODY = String.raw`
<div id="locked">从桌宠右键的「管理」或 <code>yoyo web open</code> 打开这一页。</div>
<div id="icons" hidden>${['alarm', 'task', 'check', 'cross', 'doc', 'image', 'file', 'shield'].map((name) => `<span data-icon="${name}">${icon(name)}</span>`).join('')}</div>
<div class="app" id="app">
  <aside class="side">
    <div class="me">
      <img class="avatar lg" id="avatar" src="${AVATAR}" alt="yoyo">
      <div class="who"><div class="name">yoyo</div><div class="mood" id="mood"></div></div>
    </div>
    <nav class="nav">
      ${navButton('chat', 'chat', '对话')}
      <button class="nav-item" data-view="approvals" type="button">${icon('shield')}<span>待批准</span><em class="count" id="approval-count" hidden>0</em></button>
      <button class="nav-item only-narrow" data-view="newtask" type="button" title="派一个子任务" aria-label="派一个子任务">${icon('task')}<span>派一个子任务</span></button>
      ${navButton('memory', 'memory', '记忆')}
      ${navButton('alarms', 'alarm', '日程')}
      ${navButton('activity', 'trail', '轨迹')}
      ${navButton('contacts', 'people', '联系人')}
    </nav>
    <div class="section-title">子任务<span class="count" id="task-count"></span><button class="add" data-view="newtask" type="button">派一个</button></div>
    <div class="tasks" id="task-list"></div>
    <div class="hint" id="task-empty">要花时间的事跟 yoyo 说，她会派到后台去做，进度在这里。</div>
    <div class="side-foot">
      <div class="status" id="status"></div>
      <div class="quick">
        <button class="plain small" id="do-whisper" type="button">说一句</button>
        <button class="plain small" id="do-listen" type="button">听一句</button>
      </div>
      ${navButton('settings', 'gear', '设置')}
    </div>
  </aside>
  <main>
    <header class="bar">
      <div class="titles"><h1 id="title">和 yoyo</h1><div class="sub" id="subtitle"></div></div>
      <div class="bar-actions" id="bar-actions"></div>
      <label class="search" id="search-box">${icon('search')}<span class="sr">搜对话</span><input id="search" type="search" placeholder="搜对话"></label>
    </header>
    <section class="view" id="chat">
      <div class="thread" id="thread"><div class="thread-inner" id="thread-inner"></div></div>
      <form class="composer" id="composer">
        <div class="field">
          <textarea id="say" rows="1" placeholder="跟 yoyo 说点什么，要花时间的事她会派到后台做" aria-label="跟 yoyo 说"></textarea>
          <button class="send" id="send" type="submit" aria-label="发送" disabled>${icon('up')}</button>
        </div>
        <div class="hints"><span id="model-name"></span><span class="keys">Enter 发送 · Shift+Enter 换行</span></div>
      </form>
    </section>
    <section class="view scroll" id="memory"><div class="page"><div class="columns">
      <div class="col-side">
        <section class="card">
          <div class="core-head">
            <img class="avatar" src="${AVATAR}" alt="">
            <div><h2 class="title">画像</h2><div class="side-note" id="core-at"></div></div>
          </div>
          <p class="empty" id="memory-off" hidden>记忆没打开：config.json 的 memory.enabled 设成 true 才会记新的。</p>
          <label><span class="sr">画像</span><textarea id="core-text"></textarea></label>
          <div class="actions end"><button class="primary" id="core-save" type="button">保存画像</button></div>
        </section>
      </div>
      <div class="col-main">
        <section class="card">
          <div class="card-head"><h2 class="title">记得的事</h2><span class="side-note" id="fact-count"></span></div>
          <div class="chips" id="fact-topics"></div>
          <div id="facts"></div>
        </section>
        <section class="card">
          <div class="card-head"><h2 class="title">规矩</h2><span class="side-note">确认够了才交给模型</span></div>
          <div id="rules"></div>
        </section>
      </div>
    </div></div></section>
    <section class="view scroll" id="alarms"><div class="page">
      <div class="panel">
        <form class="inline" id="alarm-form">
          <input name="title" placeholder="提醒什么" required>
          <input name="time" type="time" required>
          <select name="repeat" aria-label="重复">
            <option value="">一次</option>
            <option value="daily">每天</option>
            <option value="weekdays">工作日</option>
            <option value="weekly">每周</option>
          </select>
          <input name="date" type="date" aria-label="日期">
          <select name="weekday" aria-label="星期">
            <option value="1">周一</option><option value="2">周二</option><option value="3">周三</option>
            <option value="4">周四</option><option value="5">周五</option><option value="6">周六</option><option value="0">周日</option>
          </select>
          <select name="kind" aria-label="类型"><option value="alarm">闹钟</option><option value="task">任务</option></select>
          <button class="primary" type="submit">添加</button>
        </form>
        <div id="alarm-list"></div>
      </div>
    </div></section>
    <section class="view scroll" id="approvals"><div class="page" id="approvals-page"></div></section>
    <section class="view scroll" id="task"><div class="page" id="task-page"></div></section>
    <section class="view scroll" id="newtask"><div class="page">
      <form class="card taskform" id="task-form">
        <p class="empty" id="task-off" hidden>子任务没打开：config.json 里把 tasks.enabled 设成 true，存好就行。</p>
        <label><span class="k">标题</span><input id="task-title" maxlength="60" placeholder="一句话，例如：整理本周周报" required></label>
        <label><span class="k">目标</span><textarea id="task-goal" placeholder="要做成什么样、背景、范围、交回什么。子 agent 只看得到这段" required></textarea></label>
        <label><span class="k">验收标准（一行一条，可以不写）</span><textarea id="task-criteria" placeholder="例如：每个项目都有进展和风险"></textarea></label>
        <label><span class="k">类型</span><select id="task-agent"></select><span class="note" id="agent-note"></span></label>
        <div class="acts"><button class="plain" id="task-cancel" type="button">不派了</button><button class="primary" id="task-submit" type="submit">派出去</button></div>
      </form>
    </div></section>
    <section class="view scroll" id="activity"><div class="page"><div class="panel" id="activity-list"></div></div></section>
    <section class="view scroll" id="contacts"><div class="page">
      <div class="panel">
        <form class="inline" id="contact-form">
          <input name="name" placeholder="名字" required>
          <input name="yoyo" placeholder="yoyo://名字@地址" required>
          <input name="note" placeholder="备注">
          <button class="primary" type="submit">添加</button>
        </form>
        <div id="contact-list"></div>
      </div>
    </div></section>
    <section class="view scroll" id="settings"><div class="page">
      <div class="panel" id="switches"></div>
      <div class="panel">
        <h2>常用设置</h2>
        <form id="field-form" novalidate>
          <div id="field-groups"></div>
          <div class="actions"><button class="primary" id="fields-save" type="submit">保存常用设置</button><span class="side-note">只改你动过的项，别的原样留着；回复时用工具、念出来在上面的开关里</span></div>
        </form>
      </div>
      <div class="panel">
        <h2>整份配置</h2>
        <textarea class="code" id="config-text" spellcheck="false" aria-label="整份配置"></textarea>
        <div class="actions"><button class="primary" id="config-save">保存</button><span class="side-note" id="config-file"></span></div>
      </div>
    </div></section>
  </main>
</div>
<div id="toast" role="status"></div>
`;

/** 整页，`nonce` 给内联脚本和样式用（见 server.ts 的 CSP）。 */
export function pageHtml(nonce: string): string {
  return (
    '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>yoyo</title>\n' +
    `<style nonce="${nonce}">${STYLE}</style>\n</head>\n<body>${BODY}` +
    `<script nonce="${nonce}">${SCRIPT}</script>\n</body>\n</html>\n`
  );
}
