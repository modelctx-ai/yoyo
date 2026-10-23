import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

/** 没人动就到点发送。任何介入只打断自动发送，不代替用户按发送。 */
export function reduceConfirm(state, event) {
  if (state.done) return state;
  if (event.type === 'intervene') return { ...state, held: true };
  if (event.type === 'cancel') return { ...state, done: true, action: 'cancel' };
  if (event.type === 'send') {
    const text = String(event.text ?? state.text).trim();
    if (!text) return { ...state, held: true };
    return { ...state, done: true, action: 'send', text };
  }
  if (event.type === 'tick' && !state.held && event.now >= state.deadline) {
    return { ...state, done: true, action: 'send', text: state.text };
  }
  return state;
}

function page(text, seconds) {
  const safe = JSON.stringify(text);
  return `<!doctype html>
<meta charset="utf-8">
<title>确认发送</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f1ea; color: #1c1915; font: 16px/1.5 "Iowan Old Style", Palatino, serif; }
  main { width: min(32rem, calc(100vw - 2rem)); }
  p { margin: 0 0 0.75rem; color: #5c564c; }
  textarea { width: 100%; box-sizing: border-box; min-height: 7rem; padding: 0.75rem; border: 1px solid #d9d2c5; border-radius: 8px; font: inherit; background: #fff; }
  div { display: flex; gap: 0.75rem; margin-top: 0.75rem; }
  button { font: inherit; border-radius: 8px; padding: 0.45rem 0.9rem; }
  button.send { background: #1c1915; color: #f4f1ea; border: 0; }
  button.cancel { background: transparent; border: 1px solid #d9d2c5; }
</style>
<main>
  <p>听写结果。3 秒内没有操作会自动发送。</p>
  <textarea id="text"></textarea>
  <div>
    <button class="send" id="send" type="button"></button>
    <button class="cancel" id="cancel" type="button">取消</button>
  </div>
</main>
<script>
const original = ${safe};
const seconds = ${seconds};
const text = document.querySelector('#text');
const send = document.querySelector('#send');
const cancel = document.querySelector('#cancel');
text.value = original;
let held = false;
let done = false;
let arm = false;
const deadline = Date.now() + seconds * 1000;
function paint() {
  if (held) send.textContent = '发送';
  else send.textContent = '发送 ' + Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
}
function hold() { held = true; paint(); }
async function finish(action, value) {
  if (done) return;
  done = true;
  await fetch('/decision', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, text: value }) });
  document.body.textContent = action === 'send' ? '已发送' : '已取消';
}
send.addEventListener('pointerdown', () => { if (held) arm = true; else hold(); });
send.addEventListener('click', () => { if (arm) finish('send', text.value); arm = false; });
cancel.addEventListener('pointerdown', () => hold());
cancel.addEventListener('click', () => finish('cancel', ''));
text.addEventListener('input', hold);
window.addEventListener('keydown', hold);
window.addEventListener('pagehide', () => finish('cancel', ''));
paint();
setInterval(() => {
  paint();
  if (!held && !done && Date.now() >= deadline) finish('send', original);
}, 200);
</script>`;
}

/** 打开确认页。返回要发送的文字；取消或页面没人理则返回空字符串。 */
export function confirmSend(text, { seconds = 3, open, timeoutMs = 120_000 } = {}) {
  const opener = open ?? ((url) => {
    const child = spawn('open', [url], { stdio: 'ignore' });
    child.unref();
  });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      resolve(value);
    };
    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page(text, seconds));
        return;
      }
      if (req.method === 'POST' && req.url === '/decision') {
        let raw = '';
        req.on('data', (chunk) => {
          raw += chunk;
        });
        req.on('end', () => {
          let body = {};
          try {
            body = JSON.parse(raw);
          } catch {
            body = {};
          }
          res.writeHead(204);
          res.end();
          finish(body.action === 'send' ? String(body.text ?? '').trim() : '');
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const timer = setTimeout(() => finish(''), timeoutMs);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      opener(`http://127.0.0.1:${address.port}/`);
    });
  });
}
