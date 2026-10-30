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
.nav-item[aria-current="page"] { background: var(--panel); color: var(--accent-strong); font-weight: 600; box-shadow: 0 1px 2px rgba(20, 30, 60, .06); }
.section-title { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; font-weight: 600; letter-spacing: 1px; padding: 18px 10px 6px; }
.section-title .count { margin-left: auto; font-weight: 400; letter-spacing: 0; }
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
.card.pending { background: var(--side); border-style: dashed; color: var(--muted); }
.card-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; }
.card-head .side-note { margin-left: auto; }
.label { margin: 0; font-size: 13px; color: var(--muted); font-weight: 600; letter-spacing: 1px; }
.card h2.title { margin: 0; font-size: 16px; }

.thread { flex: 1; overflow-y: auto; padding: 20px 0 8px; }
.thread-inner { max-width: 820px; margin: 0 auto; padding: 0 28px; display: flex; flex-direction: column; gap: 14px; }
.when { align-self: center; color: var(--muted); font-size: 12px; padding: 6px 0 0; letter-spacing: .5px; }
.msg { display: flex; gap: 10px; align-items: flex-end; max-width: 86%; }
.msg .bubble { min-width: 0; white-space: pre-wrap; word-break: break-word; padding: 10px 14px; border-radius: 18px 18px 18px 6px; background: var(--yoyo); }
.msg .meta { color: var(--muted); font-size: 11px; margin-top: 3px; padding: 0 6px; }
.msg.me { align-self: flex-end; flex-direction: row-reverse; }
.msg.me .bubble { background: var(--accent); color: var(--accent-text); border-radius: 18px 18px 6px 18px; }
.msg.me .meta { text-align: right; }
.msg.pending .bubble { color: var(--muted); }
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
button.danger { background: none; color: var(--danger); border-color: transparent; padding: 2px 6px; }
button:disabled { opacity: .5; cursor: default; }
form.inline { display: flex; gap: 8px; flex-wrap: wrap; padding: 12px 0; }
input, select, textarea { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 9px; padding: 6px 10px; min-width: 0; }
.page textarea { width: 100%; min-height: 160px; resize: vertical; }
textarea.code { min-height: 420px; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
label.row { cursor: pointer; }
label.row input { flex: none; width: 18px; height: 18px; accent-color: var(--accent); }
form.inline input[name="title"], form.inline input[name="name"], form.inline input[name="yoyo"] { flex: 1 1 160px; }

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
.badge { font-size: 13px; font-weight: 600; border-radius: 999px; padding: 3px 12px; background: var(--hover); color: var(--muted); }
.badge.running { background: var(--accent-soft); color: var(--accent-strong); }
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
}
@media (max-width: 560px) {
  .bar { padding: 10px 14px; } .bar input[type="search"] { width: 110px; }
  .thread-inner { padding: 0 14px; } .composer { padding: 10px 12px 12px; }
  .msg { max-width: 94%; } .event { margin-left: 0; max-width: 100%; }
  .composer .keys { display: none; }
  .row { flex-wrap: wrap; } .row .who { width: auto; }
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

var thread = { signature: "", pending: false, query: "", tasks: "" };
var VIA = { "dsh-pet": "桌宠对话" };
var TASK_STATES = { queued: "排队", running: "在做", done: "做完", failed: "没做成", cancelled: "取消了" };
var TODO_MARKS = { pending: "", in_progress: "", done: "✓", skipped: "–" };
var openTask = 0;
/** 最近的子任务，按编号：对话里的卡片据此显示进度 */
var taskIndex = {};
var factFilter = "";
var memoryFacts = [];
var TOPICS = { owner: "主人", work: "工作", people: "身边的人", routine: "作息", taste: "喜好", fix: "纠正" };

function stateDot(state) {
  return state === "running" ? "run" : state === "done" ? "ok" : state === "failed" ? "fail" : "";
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
  var kind = item.state === "done" ? "done" : item.state === "failed" ? "failed" : "task";
  var iconName = item.state === "done" ? "check" : item.state === "failed" ? "cross" : "task";
  return eventRow(kind, iconName, lines[0], detail, null, item.text, function () { if (item.task) openTaskView(item.task); });
}

/** 对话和新加的日程按时间排在一起，隔了一刻钟以上就插一行时间 */
function renderThread(items, events, force) {
  var merged = items.map(function (item) { return { at: item.at, item: item }; });
  events.forEach(function (event) {
    if (event.type === "schedule-add" || event.type === "task-add") merged.push({ at: Date.parse(event.at), event: event });
  });
  merged.sort(function (a, b) { return a.at - b.at; });
  var signature = merged.length + ":" + (merged.length ? merged[merged.length - 1].at : 0) + ":" + thread.tasks;
  if (!force && signature === thread.signature) return;
  thread.signature = signature;
  var box = $("#thread");
  var stick = force || nearBottom(box);
  var nodes = [];
  var last = 0;
  merged.forEach(function (entry) {
    if (entry.at - last > 15 * 60000) nodes.push(h("div", { class: "when", text: when(entry.at) }));
    last = entry.at;
    if (entry.item) nodes.push(entry.item.kind === "task" ? taskResultCard(entry.item) : message(entry.item));
    else nodes.push(entry.event.type === "task-add" ? taskAddedCard(entry.event) : alarmCard(entry.event));
  });
  var inner = $("#thread-inner");
  fill(inner, nodes, "还没聊过。在下面打一句话，或者右键桌宠的「对话」。");
  applySearch();
  if (stick) box.scrollTop = box.scrollHeight;
}

function loadThread(force) {
  if (thread.pending) return Promise.resolve();
  return Promise.all([api("GET", "/api/context?limit=200"), api("GET", "/api/activity?limit=200")]).then(function (both) {
    if (!thread.pending) renderThread(both[0], both[1], force);
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
  var waiting = h("div", { class: "msg pending" }, [avatar(), h("div", { class: "bubble typing", text: "在想" })]);
  inner.appendChild(mine);
  inner.appendChild(waiting);
  $("#thread").scrollTop = $("#thread").scrollHeight;
  api("POST", "/api/chat", { text: text }).then(function () {
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
    var items = [];
    function item(state, text) {
      items.push(h("div", { class: "item" }, [h("span", { class: "dot" + (state === undefined ? "" : state ? " ok" : " off") }), h("span", { text: text })]));
    }
    if (s.pet) item(s.pet.reachable, s.pet.reachable ? "桌宠连着" : "桌宠没连上");
    else item(undefined, "控制台舞台");
    item(Boolean(s.llm.model), s.llm.model ? "模型 " + s.llm.model : "没配模型");
    if (s.pet) item(s.channel, s.channel ? "右键对话由 yoyo 回答" : "右键对话没接上");
    item(s.memory.enabled, s.memory.enabled ? "记住了 " + s.memory.facts + " 件事" : "记忆没打开");
    if (s.pet && s.pet.work && s.pet.work.task) item(undefined, "在忙：" + s.pet.work.task);
    if (s.nextWhisper) item(undefined, "下一句碎碎念 " + when(s.nextWhisper));
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
  "listen-request": "听一句", "search": "搜索", "schedule-add": "加日程", "schedule-remove": "删日程",
  "contact-add": "加联系人", "contact-remove": "删联系人", "memory-forget": "忘掉一件事", "memory-retire": "退役一条规矩",
  "memory-core-edit": "改画像", "memory-consolidate": "整理记忆", "config-edit": "改配置", "config-switch": "改开关",
  "delay": "让路", "clipboard": "读粘贴板", "tool-call": "用工具", "send": "发消息", "remind": "提醒",
};

/** 整份配置：读到时的指纹，和框里改过没有。开关改了以后，框里没动过就跟着刷新。 */
var configVersion = "";
var configDirty = false;

var views = {
  chat: { title: "和 yoyo", sub: "桌宠上聊的、语音说的、这里打的，都在这一条里", load: function () {
    // 先拿子任务：对话里派出去的那张卡片要显示进度
    return Promise.all([loadTasks().catch(function () {}).then(function () { return loadThread(false); }), loadStatus()]);
  } },
  task: { title: "子任务", sub: "yoyo 派到后台的事", load: function () {
    if (!openTask) return Promise.resolve();
    return Promise.all([api("GET", "/api/tasks/" + openTask).then(renderTask), loadTasks()]);
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
  alarms: { title: "日程", sub: "到点由桌宠提醒", load: function () {
    return api("GET", "/api/alarms").then(function (items) {
      fill($("#alarm-list"), items.map(function (item) {
        var on = item.repeat === "weekly" ? DAYS[item.weekday] : (REPEATS[item.repeat] || item.date);
        var remove = h("button", { class: "danger", text: "删除", onclick: confirmThen("删掉「" + item.title + "」？", function () {
          api("DELETE", "/api/alarms/" + encodeURIComponent(item.id)).then(function () { views.alarms.load(); }, fail);
        }) });
        return row(item.time, item.title + (item.kind === "task" ? "（任务）" : ""), on, remove);
      }), "还没有日程");
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
        var detail = item.text || item.title || item.query || item.name || item.until || "";
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
      if (!configDirty) $("#config-text").value = c.text;
      $("#config-file").textContent = c.file;
    });
  } },
};

function loadTasks() {
  return api("GET", "/api/tasks").then(function (tasks) {
    fill($("#task-list"), tasks.map(function (task) {
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
    $("#task-count").textContent = running ? running + " 件在做" : queued ? queued + " 件排队" : "";
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

function renderTask(task) {
  var open = task.state === "queued" || task.state === "running";
  var origins = { main: "yoyo 派的", cli: "命令行派的", web: "工作台派的" };
  $("#title").textContent = task.title;
  $("#subtitle").textContent = "子任务 #" + task.id + " · " + (origins[task.origin] || task.origin) + " · " + when(task.createdAt) + (task.finishedAt ? " · 结束于 " + when(task.finishedAt) : "");
  var cancel = open ? h("button", { class: "plain", type: "button", text: "取消", onclick: confirmThen("取消子任务 #" + task.id + "？", function () {
    api("POST", "/api/tasks/" + task.id + "/cancel", {}).then(function () { toast("取消了"); views.task.load(); loadTasks(); }, fail);
  }) }) : null;
  $("#bar-actions").replaceChildren(h("span", { class: "badge " + task.state, text: TASK_STATES[task.state] }));
  if (cancel) $("#bar-actions").appendChild(cancel);

  var main = [card([labelRow("目标"), h("div", { class: "text", text: task.goal })])];
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
  if (task.result) main.push(card([labelRow("结果"), h("div", { class: "text" }, rich(task.result))]));
  else if (task.error) main.push(card([labelRow("没做成"), h("div", { class: "text", text: task.error })]));
  else if (open) main.push(card([labelRow("结果"), h("div", { text: "还在做。交了以后结果放在这里，也会回到和 yoyo 的对话里。" })], "pending"));

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
  if (name !== "task") $("#bar-actions").replaceChildren();
  $("#title").textContent = views[name].title;
  $("#subtitle").textContent = views[name].sub;
  try { sessionStorage.setItem("yoyo-view", name === "task" ? "chat" : name); } catch (e) {}
  views[name].load().catch(fail);
  if (name === "chat") setTimeout(function () { $("#say").focus(); }, 0);
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
  $("#core-save").addEventListener("click", function () {
    api("PUT", "/api/memory/core", { text: $("#core-text").value }).then(function () { toast("画像存好了"); views.memory.load(); }, fail);
  });
  $("#config-text").addEventListener("input", function () { configDirty = true; });
  $("#config-save").addEventListener("click", function () {
    var button = $("#config-save");
    button.disabled = true;
    api("PUT", "/api/config", { text: $("#config-text").value, version: configVersion }).then(function () {
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
    if (current === "task") views.task.load().catch(function () {});
    if (current === "chat" || current === "task") loadTasks().catch(function () {});
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
<div id="icons" hidden>${['alarm', 'task', 'check', 'cross'].map((name) => `<span data-icon="${name}">${icon(name)}</span>`).join('')}</div>
<div class="app" id="app">
  <aside class="side">
    <div class="me">
      <img class="avatar lg" id="avatar" src="${AVATAR}" alt="yoyo">
      <div class="who"><div class="name">yoyo</div><div class="mood" id="mood"></div></div>
    </div>
    <nav class="nav">
      ${navButton('chat', 'chat', '对话')}
      ${navButton('memory', 'memory', '记忆')}
      ${navButton('alarms', 'alarm', '日程')}
      ${navButton('activity', 'trail', '轨迹')}
      ${navButton('contacts', 'people', '联系人')}
    </nav>
    <div class="section-title">子任务<span class="count" id="task-count"></span></div>
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
    <section class="view scroll" id="task"><div class="page" id="task-page"></div></section>
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
