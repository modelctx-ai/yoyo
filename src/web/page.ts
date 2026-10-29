/**
 * 管理页本身：一个 HTML，样式和脚本都内联，不用构建，打包时跟着进单文件。
 * 令牌放在地址的 `#token=` 里（不会发给服务器、不进日志），脚本读出来存进 sessionStorage，再从地址栏抹掉。
 * 数据一律用 textContent 放进页面，不拼 HTML。脚本里不用反引号和 `${`，整页才能放进这个模板字符串。
 */

const STYLE = String.raw`
:root {
  --bg: #f6f5f2; --panel: #ffffff; --text: #1f2328; --muted: #6b7280; --line: #e5e3de;
  --accent: #3b5bdb; --accent-text: #ffffff; --ok: #2f9e44; --warn: #e8590c; --danger: #c92a2a;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #15171a; --panel: #1d2024; --text: #e6e6e6; --muted: #9aa0a6; --line: #2c3036;
    --accent: #7b93ff; --accent-text: #0b0d12; --ok: #69db7c; --warn: #ffa94d; --danger: #ff8787;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; }
header { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--line); background: var(--panel); position: sticky; top: 0; z-index: 1; flex-wrap: wrap; }
header h1 { font-size: 17px; margin: 0; }
nav { display: flex; gap: 4px; flex-wrap: wrap; }
nav button { background: none; border: 0; color: var(--muted); padding: 6px 10px; border-radius: 8px; font: inherit; cursor: pointer; }
nav button[aria-current="page"] { background: var(--bg); color: var(--text); font-weight: 600; }
main { max-width: 920px; margin: 0 auto; padding: 16px; }
section { display: none; }
section.active { display: block; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px; }
.card h3 { margin: 0 0 6px; font-size: 13px; color: var(--muted); font-weight: 500; }
.card .value { font-size: 17px; font-weight: 600; word-break: break-word; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; background: var(--muted); }
.dot.ok { background: var(--ok); } .dot.off { background: var(--warn); }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 4px 14px; margin-bottom: 16px; }
.panel > h2 { font-size: 15px; margin: 12px 0 4px; }
.row { display: flex; gap: 10px; align-items: baseline; padding: 10px 0; border-top: 1px solid var(--line); }
.row:first-of-type { border-top: 0; }
.row .who { flex: none; width: 56px; color: var(--muted); font-size: 13px; }
.row .main { flex: 1; min-width: 0; white-space: pre-wrap; word-break: break-word; }
.side { color: var(--muted); font-size: 12px; }
.row .side { flex: none; }
.actions .side { align-self: center; }
.empty { color: var(--muted); padding: 12px 0; }
.actions { display: flex; gap: 8px; margin: 16px 0; flex-wrap: wrap; }
button.primary, button.plain, button.danger { font: inherit; border-radius: 8px; padding: 7px 14px; cursor: pointer; border: 1px solid var(--line); }
button.primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
button.plain { background: var(--panel); color: var(--text); }
button.danger { background: none; color: var(--danger); border-color: transparent; padding: 2px 6px; }
button:disabled { opacity: .5; cursor: default; }
form { display: flex; gap: 8px; flex-wrap: wrap; padding: 12px 0; }
input, select, textarea { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; min-width: 0; }
textarea { width: 100%; min-height: 160px; resize: vertical; }
form input[name="title"], form input[name="name"], form input[name="yoyo"] { flex: 1 1 160px; }
#toast { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); background: var(--text); color: var(--bg); padding: 8px 14px; border-radius: 8px; opacity: 0; transition: opacity .2s; pointer-events: none; max-width: calc(100% - 32px); }
#toast.show { opacity: 1; }
#locked { display: none; padding: 48px 16px; text-align: center; color: var(--muted); }
@media (max-width: 560px) { .row { flex-wrap: wrap; } .row .who { width: auto; } }
`;

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
  (children || []).forEach(function (child) { if (child) node.appendChild(child); });
  return node;
}

function toast(message) {
  var box = $("#toast");
  box.textContent = message;
  box.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(function () { box.classList.remove("show"); }, 2600);
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
      if (!response.ok) throw new Error(data.error || ("出错了（" + response.status + "）"));
      return data;
    });
  });
}

function fail(error) { toast(error.message || String(error)); }

function pad(n) { return (n < 10 ? "0" : "") + n; }
function when(ms) {
  if (!ms) return "";
  var d = new Date(ms);
  var today = new Date();
  var time = pad(d.getHours()) + ":" + pad(d.getMinutes());
  if (d.toDateString() === today.toDateString()) return time;
  return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + time;
}

function fill(target, nodes, emptyText) {
  target.replaceChildren();
  if (nodes.length === 0) target.appendChild(h("div", { class: "empty", text: emptyText }));
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

function card(title, value, state) {
  var dot = state === undefined ? null : h("span", { class: "dot " + (state ? "ok" : "off") });
  return h("div", { class: "card" }, [h("h3", { text: title }), h("div", { class: "value" }, [dot, document.createTextNode(value)])]);
}

function confirmThen(question, action) {
  return function () { if (confirm(question)) action(); };
}

var loaders = {
  overview: function () {
    return api("GET", "/api/status").then(function (s) {
      var cards = [];
      if (s.pet) cards.push(card("桌宠", s.pet.reachable ? "连着" : "没连上", s.pet.reachable));
      else cards.push(card("舞台", "控制台"));
      cards.push(card("模型", s.llm.model || "没配", Boolean(s.llm.model)));
      if (s.pet) cards.push(card("右键对话", s.channel ? "yoyo 在回答" : "没接上", s.channel));
      cards.push(card("记忆", s.memory.enabled ? s.memory.facts + " 条" : "没打开", s.memory.enabled));
      if (s.nextWhisper) cards.push(card("下一句碎碎念", when(s.nextWhisper)));
      if (s.pet && s.pet.work && s.pet.work.task) cards.push(card("在忙", s.pet.work.task));
      cards.push(card("日程", String(s.alarms)));
      if (s.mcpServers.length) cards.push(card("MCP", s.mcpServers.join("、")));
      fill($("#status"), cards, "");
    });
  },
  context: function () {
    var names = { user: "主人", assistant: "yoyo", whisper: "碎碎念", summary: "摘要" };
    return api("GET", "/api/context?limit=80").then(function (items) {
      fill($("#context-list"), items.slice().reverse().map(function (item) {
        return row(names[item.kind] || item.kind, item.text, when(item.at));
      }), "还没聊过");
    });
  },
  memory: function () {
    return api("GET", "/api/memory").then(function (m) {
      $("#core-text").value = m.core ? m.core.text : "";
      $("#core-at").textContent = m.core ? "更新于 " + when(m.core.at) : "";
      $("#memory-off").hidden = m.enabled;
      fill($("#facts"), m.facts.map(function (fact) {
        var forget = h("button", { class: "danger", text: "忘掉", onclick: confirmThen("真的忘掉这条？删了就找不回来。", function () {
          api("DELETE", "/api/memory/facts/" + encodeURIComponent(fact.id)).then(function () { toast("忘掉了"); loaders.memory(); }, fail);
        }) });
        return row(fact.topic || "", fact.text, when(fact.validFrom), forget);
      }), "还没记住什么");
      fill($("#rules"), m.rules.map(function (rule) {
        var retire = h("button", { class: "danger", text: "退役", onclick: confirmThen("让这条不再生效？", function () {
          api("DELETE", "/api/memory/rules/" + encodeURIComponent(rule.id)).then(function () { toast("退役了"); loaders.memory(); }, fail);
        }) });
        return row(rule.topic || "", rule.when + " → " + rule.do, "确认 " + rule.confirmations + " 次", retire);
      }), "还没有");
    });
  },
  alarms: function () {
    var days = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    var repeats = { daily: "每天", weekdays: "工作日", weekly: "每周" };
    return api("GET", "/api/alarms").then(function (items) {
      fill($("#alarm-list"), items.map(function (item) {
        var on = item.repeat === "weekly" ? days[item.weekday] : (repeats[item.repeat] || item.date);
        var remove = h("button", { class: "danger", text: "删除", onclick: confirmThen("删掉「" + item.title + "」？", function () {
          api("DELETE", "/api/alarms/" + encodeURIComponent(item.id)).then(function () { loaders.alarms(); }, fail);
        }) });
        return row(item.time, item.title + (item.kind === "task" ? "（任务）" : ""), on, remove);
      }), "还没有日程");
    });
  },
  contacts: function () {
    return api("GET", "/api/contacts").then(function (items) {
      fill($("#contact-list"), items.map(function (item) {
        var remove = h("button", { class: "danger", text: "删除", onclick: confirmThen("删掉「" + item.name + "」？", function () {
          api("DELETE", "/api/contacts/" + encodeURIComponent(item.id)).then(function () { loaders.contacts(); }, fail);
        }) });
        return row(item.name, item.yoyo + (item.note ? "  " + item.note : ""), null, remove);
      }), "还没有联系人");
    });
  },
  activity: function () {
    return api("GET", "/api/activity?limit=100").then(function (items) {
      // 记录按时间先后来，最新的放上面
      fill($("#activity-list"), items.slice().reverse().map(function (item) {
        var detail = item.text || item.title || item.query || item.name || item.id || "";
        return row(null, item.type + (detail ? "  " + detail : ""), when(Date.parse(item.at)));
      }), "还没有记录");
    });
  },
};

function show(name) {
  document.querySelectorAll("nav button").forEach(function (button) {
    if (button.dataset.tab === name) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  document.querySelectorAll("main section").forEach(function (section) {
    section.classList.toggle("active", section.id === name);
  });
  try { sessionStorage.setItem("yoyo-tab", name); } catch (e) {}
  loaders[name]().catch(fail);
}

function lock() {
  $("main").hidden = true;
  $("nav").hidden = true;
  $("#locked").style.display = "block";
}

function act(type, label) {
  return function () { api("POST", "/api/actions/" + type, {}).then(function () { toast(label); }, fail); };
}

document.addEventListener("DOMContentLoaded", function () {
  if (!token) return lock();
  document.querySelectorAll("nav button").forEach(function (button) {
    button.addEventListener("click", function () { show(button.dataset.tab); });
  });
  $("#do-whisper").addEventListener("click", act("whisper", "这就说一句"));
  $("#do-listen").addEventListener("click", act("listen", "在听了"));
  $("#core-save").addEventListener("click", function () {
    api("PUT", "/api/memory/core", { text: $("#core-text").value }).then(function () { toast("画像存好了"); loaders.memory(); }, fail);
  });
  $("#alarm-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var form = event.target;
    var repeat = form.repeat.value;
    var body = { title: form.title.value, time: form.time.value, kind: form.kind.value, repeat: repeat || null };
    if (!repeat) body.date = form.date.value;
    if (repeat === "weekly") body.weekday = Number(form.weekday.value);
    api("POST", "/api/alarms", body).then(function () { form.reset(); syncRepeat(); loaders.alarms(); }, fail);
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
      .then(function () { form.reset(); loaders.contacts(); }, fail);
  });
  var tab = "overview";
  try { tab = sessionStorage.getItem("yoyo-tab") || tab; } catch (e) {}
  show(loaders[tab] ? tab : "overview");
});
`;

const BODY = String.raw`
<header>
  <h1>yoyo</h1>
  <nav>
    <button data-tab="overview">概览</button>
    <button data-tab="context">对话</button>
    <button data-tab="memory">记忆</button>
    <button data-tab="alarms">日程</button>
    <button data-tab="contacts">联系人</button>
    <button data-tab="activity">记录</button>
  </nav>
</header>
<div id="locked">从桌宠右键的「管理」或 <code>yoyo web open</code> 打开这一页。</div>
<main>
  <section id="overview">
    <div class="grid" id="status"></div>
    <div class="actions">
      <button class="primary" id="do-whisper">说一句</button>
      <button class="plain" id="do-listen">听一句</button>
    </div>
  </section>
  <section id="context"><div class="panel" id="context-list"></div></section>
  <section id="memory">
    <div class="panel">
      <h2>画像</h2>
      <p class="empty" id="memory-off" hidden>记忆没打开：config.json 的 memory.enabled 设成 true 才会记新的。</p>
      <textarea id="core-text" aria-label="画像"></textarea>
      <div class="actions"><button class="primary" id="core-save">保存</button><span class="side" id="core-at"></span></div>
    </div>
    <div class="panel"><h2>记得的事</h2><div id="facts"></div></div>
    <div class="panel"><h2>规矩</h2><div id="rules"></div></div>
  </section>
  <section id="alarms">
    <div class="panel">
      <form id="alarm-form">
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
  </section>
  <section id="contacts">
    <div class="panel">
      <form id="contact-form">
        <input name="name" placeholder="名字" required>
        <input name="yoyo" placeholder="yoyo://名字@地址" required>
        <input name="note" placeholder="备注">
        <button class="primary" type="submit">添加</button>
      </form>
      <div id="contact-list"></div>
    </div>
  </section>
  <section id="activity"><div class="panel" id="activity-list"></div></section>
</main>
<div id="toast" role="status"></div>
`;

/** 整页，`nonce` 给内联脚本和样式用（见 server.ts 的 CSP）。 */
export function pageHtml(nonce: string): string {
  return (
    '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>yoyo 管理</title>\n' +
    `<style nonce="${nonce}">${STYLE}</style>\n</head>\n<body>${BODY}` +
    `<script nonce="${nonce}">${SCRIPT}</script>\n</body>\n</html>\n`
  );
}
