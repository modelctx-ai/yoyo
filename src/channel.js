import { createServer } from 'node:http';
import { Readable } from 'node:stream';

import { loadContext, toMessages } from './context.js';
import { setKv } from './db.js';

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
}

/** 丢掉桌宠自己截过的历史，换上 yoyo 的全文。当前这句用户话留在最后。 */
export function channelMessages(incoming, contextMessages) {
  const list = Array.isArray(incoming) ? incoming : [];
  const system = list.find((message) => message?.role === 'system');
  let user = '';
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.role === 'user') {
      user = textOf(list[i].content);
      break;
    }
  }
  const history = (contextMessages ?? []).filter((message) => message.role === 'user' || message.role === 'assistant');
  const last = history.at(-1);
  const thread = user && !(last?.role === 'user' && last.content === user)
    ? [...history, { role: 'user', content: user }]
    : history;
  return [
    ...(system ? [{ role: 'system', content: textOf(system.content) }] : []),
    ...thread,
  ];
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function startChannel(llm, dataDir) {
  const upstream = String(llm.baseUrl ?? '').replace(/\/+$/, '');
  const server = createServer(async (req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method !== 'POST' || !path.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    try {
      const body = await readJson(req);
      const messages = channelMessages(body.messages, toMessages(loadContext(dataDir)));
      const response = await fetch(`${upstream}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${llm.apiKey}`,
        },
        body: JSON.stringify({ ...body, messages }),
      });
      res.writeHead(response.status, {
        'content-type': response.headers.get('content-type') || 'application/json',
      });
      if (!response.body) {
        res.end(await response.text());
        return;
      }
      Readable.fromWeb(response.body).pipe(res);
    } catch (error) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(error instanceof Error ? error.message : 'channel failed');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const baseUrl = `http://127.0.0.1:${address.port}/v1`;
      setKv(dataDir, 'channel-base', baseUrl);
      resolve({
        baseUrl,
        close() {
          server.close();
        },
      });
    });
  });
}
