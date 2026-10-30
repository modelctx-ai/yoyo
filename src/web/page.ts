/**
 * 工作台本身：一个 HTML，样式和脚本都内联，不用构建，打包时跟着进单文件。浏览器和 yoyo.app 的窗口里是同一页。
 * 令牌放在地址的 `#token=` 里（不会发给服务器、不进日志），脚本读出来存进 sessionStorage，再从地址栏抹掉。
 * 数据一律用 textContent 放进页面，不拼 HTML。脚本里不用反引号和 `${`，整页才能放进这个模板字符串。
 * CSP 不许写 style 属性：样式都在下面的样式表里，脚本要改样式就改 class 或 `node.style`。
 */

const STYLE = String.raw`
:root {
  --rail: #f4f2ee; --list: #f8f6f3; --bg: #fcfbf9; --panel: #ffffff; --bubble: #f1eee9;
  --text: #1f1d1a; --muted: #8a857e; --line: #ebe7e1; --hover: #efece7;
  --accent: #f26b1d; --accent-soft: #fde9dc; --accent-text: #ffffff;
  --ok: #2f9e44; --warn: #e8590c; --danger: #c92a2a;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --rail: #181716; --list: #1d1c1b; --bg: #222120; --panel: #2a2826; --bubble: #33302d;
    --text: #ece9e4; --muted: #9a958e; --line: #36332f; --hover: #2f2d2a;
    --accent: #ff8a3d; --accent-soft: #3d2a1d; --accent-text: #1a1206;
    --ok: #69db7c; --warn: #ffa94d; --danger: #ff8787;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; overflow: hidden; }
button { font: inherit; color: inherit; }
svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; flex: none; }

.app { display: flex; height: 100%; }
.rail { flex: none; width: 76px; background: var(--rail); display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 14px 0; border-right: 1px solid var(--line); }
.rail button { width: 60px; border: 0; background: none; border-radius: 12px; padding: 8px 0 6px; display: flex; flex-direction: column; align-items: center; gap: 2px; cursor: pointer; color: var(--muted); font-size: 12px; }
.rail button:hover { background: var(--hover); color: var(--text); }
.rail button[aria-current="page"] { color: var(--accent); }
.rail button[aria-current="page"] svg { stroke-width: 2.1; }
.rail .spacer { flex: 1; }
.ring { display: inline-block; width: 30px; height: 30px; border-radius: 50%; border: 5px solid var(--accent); background: var(--panel); flex: none; }
.ring.sm { width: 22px; height: 22px; border-width: 4px; }
.rail .brand { margin-bottom: 10px; }

.list { flex: none; width: 260px; background: var(--list); border-right: 1px solid var(--line); display: flex; flex-direction: column; padding: 14px 12px; gap: 2px; overflow-y: auto; }
.list[hidden] { display: none; }
.list-head { font-weight: 600; padding: 2px 8px 10px; }
.group { color: var(--muted); font-size: 13px; padding: 12px 8px 4px; }
.session { display: flex; align-items: center; gap: 10px; width: 100%; border: 0; background: none; border-radius: 10px; padding: 9px 10px; cursor: pointer; text-align: left; }
.session.active { background: var(--hover); }
.hint { color: var(--muted); font-size: 13px; padding: 4px 10px; }
.hint[hidden] { display: none; }
.session .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session .meta { flex: none; color: var(--muted); font-size: 12px; }
.dot.run { background: var(--accent); } .dot.fail { background: var(--danger); }
.task-card { cursor: pointer; }
.task-card:hover { border-color: var(--accent); }
.task-card .sub { white-space: pre-wrap; max-height: 3.2em; overflow: hidden; }
.task-head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 14px; }
.task-head .side { flex: 1; }
.badge { font-size: 12px; border-radius: 999px; padding: 2px 10px; background: var(--bubble); color: var(--muted); }
.badge.running { background: var(--accent-soft); color: var(--accent); }
.badge.done { color: var(--ok); } .badge.failed { color: var(--danger); }
.bar-track { height: 6px; border-radius: 3px; background: var(--bubble); overflow: hidden; margin: 6px 0 14px; }
.bar-track > span { display: block; height: 100%; width: 0; background: var(--accent); transition: width .3s; }
.panel .text { white-space: pre-wrap; word-break: break-word; padding: 4px 0 12px; }
.todo { display: flex; gap: 10px; padding: 8px 0; border-top: 1px solid var(--line); align-items: flex-start; }
.todo:first-of-type { border-top: 0; }
.todo .mark { flex: none; width: 18px; height: 18px; border-radius: 5px; border: 1.5px solid var(--muted); margin-top: 3px; display: flex; align-items: center; justify-content: center; font-size: 12px; line-height: 1; }
.todo.done .mark { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
.todo.in_progress .mark { border-color: var(--accent); }
.todo.in_progress .mark::after { content: ""; width: 8px; height: 8px; border-radius: 2px; background: var(--accent); }
.todo.done .main, .todo.skipped .main { color: var(--muted); }
.todo.skipped .main { text-decoration: line-through; }
.todo .note { color: var(--muted); font-size: 13px; }
.step { display: flex; gap: 10px; font-size: 13px; padding: 6px 0; border-top: 1px solid var(--line); }
.step .k { flex: none; width: 170px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.step .t { flex: 1; min-width: 0; white-space: pre-wrap; word-break: break-word; }
.step.call .t, .step.result .t { font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); }
details.steps > summary { cursor: pointer; padding: 12px 0; font-weight: 600; }
.status { margin-top: auto; padding: 12px 8px 4px; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.status .item { display: flex; align-items: center; gap: 8px; color: var(--muted); min-width: 0; }
.status .item span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--muted); flex: none; }
.dot.ok { background: var(--ok); } .dot.off { background: var(--warn); }
.quick { display: flex; gap: 6px; padding: 8px 8px 0; }

main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.bar { flex: none; height: 52px; display: flex; align-items: center; gap: 12px; padding: 0 20px; border-bottom: 1px solid var(--line); }
.bar h1 { flex: 1; margin: 0; font-size: 16px; font-weight: 600; text-align: center; }
.bar .tool { border: 0; background: none; display: flex; align-items: center; gap: 6px; color: var(--muted); cursor: pointer; padding: 6px 8px; border-radius: 8px; font-size: 14px; }
.bar .tool:hover { background: var(--hover); color: var(--text); }
.bar input[type="search"] { width: 160px; }
.bar .left { flex: none; width: 200px; }

.view { display: none; flex: 1; min-height: 0; }
.view.active { display: flex; flex-direction: column; }
.scroll { overflow-y: auto; }
.page { width: 100%; max-width: 880px; margin: 0 auto; padding: 20px; }

.thread { flex: 1; overflow-y: auto; padding: 24px 0 12px; }
.thread-inner { max-width: 860px; margin: 0 auto; padding: 0 28px; display: flex; flex-direction: column; gap: 18px; }
.when { align-self: center; color: var(--muted); font-size: 12px; padding: 4px 0; }
.msg { display: flex; gap: 12px; align-items: flex-start; }
.msg .body { min-width: 0; flex: 1; white-space: pre-wrap; word-break: break-word; }
.msg .via { display: table; font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 6px; padding: 0 6px; margin-bottom: 4px; }
.msg.me { justify-content: flex-end; }
.msg.me .body { flex: none; max-width: 75%; background: var(--bubble); padding: 9px 14px; border-radius: 16px 16px 4px 16px; }
.msg.me .via { margin-left: auto; }
.msg.aside .body { color: var(--muted); }
.msg.aside .body::before { content: "• "; }
.msg.pending .body { color: var(--muted); }
.typing::after { content: "…"; animation: blink 1.2s infinite; }
@keyframes blink { 50% { opacity: .2; } }
.summary { align-self: center; max-width: 80%; color: var(--muted); font-size: 13px; border: 1px dashed var(--line); border-radius: 10px; padding: 8px 12px; white-space: pre-wrap; }
.summary summary { cursor: pointer; }
.alarm-card { margin-left: 42px; display: flex; gap: 14px; align-items: center; border: 1px solid var(--line); background: var(--panel); border-radius: 14px; padding: 14px 16px; }
.alarm-card .icon { width: 44px; height: 44px; border-radius: 10px; background: var(--bubble); display: flex; align-items: center; justify-content: center; }
.alarm-card .icon svg { width: 22px; height: 22px; }
.alarm-card .title { font-weight: 600; }
.alarm-card .sub { color: var(--muted); font-size: 13px; }
.thread .empty { text-align: center; padding: 64px 0; }

.composer { flex: none; max-width: 860px; width: calc(100% - 56px); margin: 0 auto 20px; border: 1px solid var(--line); border-radius: 18px; background: var(--panel); padding: 10px 12px 8px 16px; box-shadow: 0 2px 12px rgba(0,0,0,.04); }
.composer textarea { display: block; width: 100%; border: 0; outline: 0; background: none; resize: none; min-height: 26px; max-height: 200px; padding: 4px 0; font: inherit; color: var(--text); }
.composer .row2 { display: flex; align-items: center; gap: 10px; }
.composer .row2 .side:first-child { flex: 1; }
.send { width: 34px; height: 34px; border-radius: 50%; border: 0; background: var(--accent); color: var(--accent-text); display: flex; align-items: center; justify-content: center; cursor: pointer; }
.send:disabled { background: var(--hover); color: var(--muted); cursor: default; }
.send svg { width: 18px; height: 18px; stroke-width: 2.2; }

.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 4px 16px; margin-bottom: 16px; }
.panel > h2 { font-size: 15px; margin: 14px 0 4px; }
.row { display: flex; gap: 10px; align-items: baseline; padding: 10px 0; border-top: 1px solid var(--line); }
.row:first-of-type { border-top: 0; }
.row .who { flex: none; width: 64px; color: var(--muted); font-size: 13px; }
.row .main { flex: 1; min-width: 0; white-space: pre-wrap; word-break: break-word; }
.day { color: var(--muted); font-size: 13px; padding: 14px 0 2px; }
.day + .row { border-top: 0; }
.side { color: var(--muted); font-size: 12px; }
.row .side { flex: none; }
.empty { color: var(--muted); padding: 12px 0; }
.actions { display: flex; gap: 8px; margin: 14px 0; flex-wrap: wrap; align-items: center; }
button.primary, button.plain, button.danger { border-radius: 9px; padding: 6px 14px; cursor: pointer; border: 1px solid var(--line); }
button.primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
button.plain { background: var(--panel); }
button.plain.small { padding: 3px 10px; font-size: 13px; flex: 1; }
button.danger { background: none; color: var(--danger); border-color: transparent; padding: 2px 6px; }
button:disabled { opacity: .5; cursor: default; }
form.inline { display: flex; gap: 8px; flex-wrap: wrap; padding: 12px 0; }
input, select, textarea { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 9px; padding: 6px 10px; min-width: 0; }
.page textarea { width: 100%; min-height: 160px; resize: vertical; }
textarea.code { min-height: 420px; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
label.row { cursor: pointer; }
label.row input { flex: none; width: 18px; height: 18px; accent-color: var(--accent); }
form.inline input[name="title"], form.inline input[name="name"], form.inline input[name="yoyo"] { flex: 1 1 160px; }

#toast { position: fixed; bottom: 96px; left: 50%; transform: translateX(-50%); background: var(--text); color: var(--bg); padding: 8px 14px; border-radius: 9px; opacity: 0; transition: opacity .2s; pointer-events: none; max-width: calc(100% - 32px); z-index: 2; }
#toast.show { opacity: 1; }
#locked { display: none; padding: 64px 16px; text-align: center; color: var(--muted); }

@media (max-width: 860px) { .list { display: none; } .bar .left { width: auto; } }
@media (max-width: 560px) {
  .rail { width: 56px; } .rail button { width: 46px; font-size: 0; }
  .bar { padding: 0 12px; } .bar input[type="search"] { width: 100px; } .bar .tool span { display: none; }
  .thread-inner { padding: 0 14px; } .composer { width: calc(100% - 24px); }
  .alarm-card { margin-left: 0; } .msg.me .body { max-width: 88%; } .composer .keys { display: none; }
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
    side ? h("div", { class: "side", text: side }) : null,
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

var thread = { signature: "", pending: false, query: "" };
var VIA = { "dsh-pet": "桌宠对话" };
var TASK_STATES = { queued: "排队", running: "在做", done: "做完", failed: "没做成", cancelled: "取消了" };
var TODO_MARKS = { pending: "", in_progress: "", done: "✓", skipped: "–" };
var openTask = 0;

function stateDot(state) {
  return state === "running" ? "run" : state === "done" ? "ok" : state === "failed" ? "fail" : "";
}

function nearBottom(box) { return box.scrollHeight - box.scrollTop - box.clientHeight < 80; }

function avatar() { return h("span", { class: "ring sm" }); }

function message(item) {
  var via = VIA[item.via] || (item.kind === "user" && !item.via ? "语音" : "");
  var tag = via ? h("div", { class: "via", text: via }) : null;
  if (item.kind === "user") {
    return h("div", { class: "msg me", "data-text": item.text }, [h("div", { class: "body" }, [tag].concat(rich(item.text)))]);
  }
  if (item.kind === "summary") {
    return h("details", { class: "summary", "data-text": item.text }, [h("summary", { text: "更早的对话压成了摘要" }), document.createTextNode(item.text)]);
  }
  var aside = item.kind === "whisper";
  return h("div", { class: "msg" + (aside ? " aside" : ""), "data-text": item.text }, [
    avatar(),
    h("div", { class: "body" }, [tag].concat(rich(item.text))),
  ]);
}

function alarmCard(event) {
  var repeat = REPEATS[event.repeat] || "一次";
  return h("div", { class: "alarm-card", "data-text": event.title || "" }, [
    h("div", { class: "icon" }, [iconNode("alarm")]),
    h("div", {}, [
      h("div", { class: "title", text: (event.kind === "task" ? "任务：" : "闹钟：") + (event.title || "") }),
      h("div", { class: "sub", text: repeat + " " + (event.time || "") }),
    ]),
  ]);
}

/** 子任务的卡片：派出去的那一刻、做完写回来的那一刻；点开看详情 */
function taskCard(id, title, sub, text) {
  return h("div", { class: "alarm-card task-card", "data-text": text, role: "button", tabindex: "0", onclick: function () { if (id) openTaskView(id); } }, [
    h("div", { class: "icon" }, [iconNode("task")]),
    h("div", {}, [h("div", { class: "title", text: title }), h("div", { class: "sub", text: sub })]),
  ]);
}

function taskResultCard(item) {
  var lines = item.text.split("\n");
  // 卡片里只放纯文字：去掉加粗的星号
  var sub = lines.slice(1).join("\n").replace(/^结果：\n?/, "").replace(/\*\*/g, "");
  return taskCard(item.task, lines[0], sub, item.text);
}

function taskAddedCard(event) {
  var who = event.origin === "main" ? "yoyo 派了子任务" : "派了子任务";
  return taskCard(event.id, who + " #" + event.id + "「" + (event.title || "") + "」", "在后台做，做完结果会回到这里", event.title || "");
}

/** 对话和新加的日程按时间排在一起，隔了一刻钟以上就插一行时间 */
function renderThread(items, events, force) {
  var merged = items.map(function (item) { return { at: item.at, item: item }; });
  events.forEach(function (event) {
    if (event.type === "schedule-add" || event.type === "task-add") merged.push({ at: Date.parse(event.at), event: event });
  });
  merged.sort(function (a, b) { return a.at - b.at; });
  var signature = merged.length + ":" + (merged.length ? merged[merged.length - 1].at : 0);
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
  var waiting = h("div", { class: "msg pending" }, [avatar(), h("div", { class: "body typing", text: "在想" })]);
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
    $("#model-name").textContent = s.llm.model ? s.llm.model + (s.llm.tools ? " · 能用工具" : "") : "没配模型，回不了话";
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
  chat: { title: "yoyo", load: function () { return Promise.all([loadThread(false), loadStatus(), loadTasks()]); } },
  task: { title: "子任务", load: function () {
    if (!openTask) return Promise.resolve();
    return Promise.all([api("GET", "/api/tasks/" + openTask).then(renderTask), loadTasks()]);
  } },
  memory: { title: "心迹", load: function () {
    return api("GET", "/api/memory").then(function (m) {
      $("#core-text").value = m.core ? m.core.text : "";
      $("#core-at").textContent = m.core ? "更新于 " + when(m.core.at) : "";
      $("#memory-off").hidden = m.enabled;
      fill($("#facts"), m.facts.map(function (fact) {
        var forget = h("button", { class: "danger", text: "忘掉", onclick: confirmThen("真的忘掉这条？删了就找不回来。", function () {
          api("DELETE", "/api/memory/facts/" + encodeURIComponent(fact.id)).then(function () { toast("忘掉了"); views.memory.load(); }, fail);
        }) });
        return row(fact.topic || "", fact.text, when(fact.validFrom), forget);
      }), "还没记住什么");
      fill($("#rules"), m.rules.map(function (rule) {
        var retire = h("button", { class: "danger", text: "退役", onclick: confirmThen("让这条不再生效？", function () {
          api("DELETE", "/api/memory/rules/" + encodeURIComponent(rule.id)).then(function () { toast("退役了"); views.memory.load(); }, fail);
        }) });
        return row(rule.topic || "", rule.when + " → " + rule.do, "确认 " + rule.confirmations + " 次", retire);
      }), "还没有");
    });
  } },
  alarms: { title: "日程和闹钟", load: function () {
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
  activity: { title: "行为轨迹", load: function () {
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
  contacts: { title: "联系人", load: function () {
    return api("GET", "/api/contacts").then(function (items) {
      fill($("#contact-list"), items.map(function (item) {
        var remove = h("button", { class: "danger", text: "删除", onclick: confirmThen("删掉「" + item.name + "」？", function () {
          api("DELETE", "/api/contacts/" + encodeURIComponent(item.id)).then(function () { views.contacts.load(); }, fail);
        }) });
        return row(item.name, item.yoyo + (item.note ? "  " + item.note : ""), null, remove);
      }), "还没有联系人");
    });
  } },
  settings: { title: "设置", load: function () {
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
      return h("button", { class: "session" + (active ? " active" : ""), type: "button", title: TASK_STATES[task.state], onclick: function () { openTaskView(task.id); } }, [
        h("span", { class: "dot " + stateDot(task.state) }),
        h("span", { class: "name", text: task.title }),
        h("span", { class: "meta", text: count }),
      ]);
    }), "");
    $("#task-empty").hidden = tasks.length > 0;
  });
}

function section(title, children) {
  return h("div", { class: "panel" }, [h("h2", { text: title })].concat(children));
}

function renderTask(task) {
  $("#title").textContent = "#" + task.id + " " + task.title;
  var open = task.state === "queued" || task.state === "running";
  var nodes = [];
  var cancel = open ? h("button", { class: "plain", type: "button", text: "取消", onclick: confirmThen("取消子任务 #" + task.id + "？", function () {
    api("POST", "/api/tasks/" + task.id + "/cancel", {}).then(function () { toast("取消了"); views.task.load(); loadTasks(); }, fail);
  }) }) : null;
  var origins = { main: "yoyo 派的", cli: "命令行派的", web: "工作台派的" };
  nodes.push(h("div", { class: "task-head" }, [
    h("span", { class: "badge " + task.state, text: TASK_STATES[task.state] }),
    h("span", { class: "side", text: (origins[task.origin] || task.origin) + " · " + when(task.createdAt) + (task.finishedAt ? " · 结束于 " + when(task.finishedAt) : "") }),
    cancel,
  ]));
  if (task.progress.total) {
    var fillBar = h("span");
    fillBar.style.width = Math.round((task.progress.done / task.progress.total) * 100) + "%";
    nodes.push(h("div", { class: "bar-track", title: task.progress.done + "/" + task.progress.total }, [fillBar]));
  }
  nodes.push(section("目标", [h("div", { class: "text", text: task.goal })]));
  if (task.criteria.length) {
    nodes.push(section("验收标准", task.criteria.map(function (criterion) {
      var check = task.checks.filter(function (c) { return c.criterion === criterion; })[0];
      var mark = check ? (check.met ? "✓" : "✗") : "";
      return h("div", { class: "todo" + (check && check.met ? " done" : "") }, [
        h("span", { class: "mark", text: mark }),
        h("div", { class: "main" }, [document.createTextNode(criterion), check ? h("div", { class: "note", text: check.evidence }) : null]),
      ]);
    })));
  }
  nodes.push(section("todo" + (task.progress.total ? "（" + task.progress.done + "/" + task.progress.total + "）" : ""), task.todos.length ? task.todos.map(function (todo, i) {
    return h("div", { class: "todo " + todo.state }, [
      h("span", { class: "mark", text: TODO_MARKS[todo.state] }),
      h("div", { class: "main" }, [document.createTextNode((i + 1) + ". " + todo.text), todo.note ? h("div", { class: "note", text: todo.note }) : null]),
    ]);
  }) : [h("div", { class: "empty", text: task.state === "queued" ? "还在排队，开始做时会先拆 todo" : "还没拆" })]));
  if (task.result) nodes.push(section("结果", [h("div", { class: "text" }, rich(task.result))]));
  if (task.error) nodes.push(section("没做成", [h("div", { class: "text", text: task.error })]));
  var steps = task.steps.map(function (step) {
    var labels = { input: "收到", say: "说", call: "调用 " + (step.name || ""), result: "结果 " + (step.name || "") };
    return h("div", { class: "step " + step.kind }, [h("div", { class: "k", text: clock(step.at) + " " + labels[step.kind] }), h("div", { class: "t", text: step.text })]);
  });
  var details = h("details", { class: "steps" }, [h("summary", { text: "过程（" + task.steps.length + " 步）" })].concat(steps));
  if (open) details.open = true;
  if (steps.length) nodes.push(h("div", { class: "panel" }, [details]));
  fill($("#task-page"), nodes, "");
}

function openTaskView(id) {
  openTask = id;
  show("task");
}

var current = "chat";

function show(name) {
  current = name;
  document.querySelectorAll("[data-view]").forEach(function (button) {
    if (button.dataset.view === name && button.closest(".rail")) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  document.querySelectorAll("main .view").forEach(function (section) {
    section.classList.toggle("active", section.id === name);
  });
  $("#chat-list").hidden = name !== "chat" && name !== "task";
  $("#main-session").classList.toggle("active", name === "chat");
  $("#search").hidden = name !== "chat";
  $("#title").textContent = views[name].title;
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
  $("#main-session").addEventListener("click", function () { show("chat"); });
  setInterval(function () {
    if (document.hidden || current !== "chat") return;
    loadStatus().catch(function () {});
  }, 20000);
  var view = "chat";
  try { view = sessionStorage.getItem("yoyo-view") || view; } catch (e) {}
  show(views[view] ? view : "chat");
});
`;

function railButton(view: string, name: string, label: string): string {
  return `<button data-view="${view}" title="${label}">${icon(name)}<span>${label}</span></button>`;
}

const BODY = String.raw`
<div id="locked">从桌宠右键的「管理」或 <code>yoyo web open</code> 打开这一页。</div>
<div id="icons" hidden><span data-icon="alarm">${icon('alarm')}</span><span data-icon="task">${icon('task')}</span></div>
<div class="app" id="app">
  <nav class="rail">
    <div class="brand" title="yoyo"><span class="ring"></span></div>
    ${railButton('chat', 'chat', '对话')}
    ${railButton('memory', 'memory', '心迹')}
    ${railButton('alarms', 'alarm', '日程')}
    ${railButton('activity', 'trail', '轨迹')}
    ${railButton('contacts', 'people', '联系人')}
    <div class="spacer"></div>
    ${railButton('settings', 'gear', '设置')}
  </nav>
  <aside class="list" id="chat-list">
    <div class="list-head">聊天列表</div>
    <div class="group">主聊天</div>
    <button class="session active" id="main-session" type="button"><span class="ring sm"></span><span class="name">yoyo</span></button>
    <div class="group">子任务</div>
    <div id="task-list"></div>
    <div class="hint" id="task-empty">还没有。要花时间的事跟 yoyo 说，它会派出去在后台做。</div>
    <div class="status" id="status"></div>
    <div class="quick">
      <button class="plain small" id="do-whisper" type="button">说一句</button>
      <button class="plain small" id="do-listen" type="button">听一句</button>
    </div>
  </aside>
  <main>
    <header class="bar">
      <div class="left"></div>
      <h1 id="title">yoyo</h1>
      <button class="tool" data-view="alarms" type="button">${icon('alarm')}<span>智能闹钟</span></button>
      <input id="search" type="search" placeholder="搜索对话" aria-label="搜索对话">
    </header>
    <section class="view" id="chat">
      <div class="thread" id="thread"><div class="thread-inner" id="thread-inner"></div></div>
      <form class="composer" id="composer">
        <textarea id="say" rows="1" placeholder="和 yoyo 说点什么…" aria-label="和 yoyo 说"></textarea>
        <div class="row2">
          <span class="side" id="model-name"></span>
          <span class="side keys">Enter 发送 · Shift+Enter 换行</span>
          <button class="send" id="send" type="submit" aria-label="发送" disabled>${icon('up')}</button>
        </div>
      </form>
    </section>
    <section class="view scroll" id="memory"><div class="page">
      <div class="panel">
        <h2>画像</h2>
        <p class="empty" id="memory-off" hidden>记忆没打开：config.json 的 memory.enabled 设成 true 才会记新的。</p>
        <textarea id="core-text" aria-label="画像"></textarea>
        <div class="actions"><button class="primary" id="core-save">保存</button><span class="side" id="core-at"></span></div>
      </div>
      <div class="panel"><h2>记得的事</h2><div id="facts"></div></div>
      <div class="panel"><h2>规矩</h2><div id="rules"></div></div>
    </div></section>
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
        <div class="actions"><button class="primary" id="config-save">保存</button><span class="side" id="config-file"></span></div>
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
