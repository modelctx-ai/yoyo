import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';

export interface ConfirmState {
  readonly text: string;
  readonly held: boolean;
  readonly done: boolean;
  readonly deadline: number;
  readonly action?: 'send' | 'cancel';
}

export type ConfirmEvent =
  | { readonly type: 'intervene' }
  | { readonly type: 'cancel' }
  | { readonly type: 'send'; readonly text?: string }
  | { readonly type: 'tick'; readonly now: number };

/** 没人动就到点发送。任何介入只打断自动发送，不代替用户按发送。 */
export function reduceConfirm(state: ConfirmState, event: ConfirmEvent): ConfirmState {
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

/** 放进 <script> 的字符串字面量。`<` 要转义，原文里有 </script> 也不会提前结束脚本。 */
function scriptString(text: string): string {
  return JSON.stringify(text).replace(/</g, '\\u003c');
}

function page(text: string, seconds: number): string {
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
  <p>听写结果。${seconds} 秒内没有操作会自动发送。</p>
  <textarea id="text"></textarea>
  <div>
    <button class="send" id="send" type="button"></button>
    <button class="cancel" id="cancel" type="button">取消</button>
  </div>
</main>
<script>
const original = ${scriptString(text)};
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
  await fetch('/decision', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, text: value }) });
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

/** 只认这一页发来的请求：Host 要是本机这个端口，带了 Origin 也得是这一页。别的网页借浏览器发不进来。 */
function fromPage(req: IncomingMessage, origin: string): boolean {
  if (`http://${req.headers.host ?? ''}` !== origin) return false;
  const from = req.headers.origin;
  return from === undefined || from === origin;
}

/** 页面发回的决定：send 带上（可能改过的）文字，其余都算取消。 */
function decisionText(raw: string): string {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return '';
  }
  if (!body || typeof body !== 'object') return '';
  const { action, text } = body as { readonly action?: unknown; readonly text?: unknown };
  return action === 'send' ? String(text ?? '').trim() : '';
}

/** 打开确认页，返回要发送的文字；取消或超时返回空字符串。 */
export function confirmSend(
  text: string,
  options: { readonly open: (url: string) => void; readonly seconds?: number; readonly timeoutMs?: number },
): Promise<string> {
  const { open, seconds = 3, timeoutMs = 120_000 } = options;
  return new Promise((resolve, reject) => {
    let settled = false;
    let origin = '';
    const server = createServer((req, res) => {
      if (!fromPage(req, origin)) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page(text, seconds));
        return;
      }
      if (req.method === 'POST' && req.url === '/decision') {
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', (chunk: string) => {
          raw += chunk;
        });
        req.on('end', () => {
          const decision = decisionText(raw);
          // 回应发完再关服务，页面里的 fetch 才能正常结束
          res.once('close', () => settle(() => resolve(decision)));
          res.writeHead(204);
          res.end();
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const timer = setTimeout(() => settle(() => resolve('')), timeoutMs);

    function settle(done: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      done();
    }

    server.once('error', (error) => settle(() => reject(error)));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
      try {
        open(`${origin}/`);
      } catch (error) {
        settle(() => reject(error));
      }
    });
  });
}
