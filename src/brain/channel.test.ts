import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, test } from 'vite-plus/test';

import { createContext, createMemoryStore } from '@modelctx-ai/ctx';

import { parseConfig, type LlmConfig } from '../app/config.ts';
import type { Line } from '../kernel/types.ts';
import type { KvRepo } from '../ports/index.ts';
import { startChannel, type Channel } from './channel.ts';
import { createYoyoContext, recordLine, recordUser, storePetChat } from './context.ts';

interface Seen {
  readonly path: string;
  readonly auth: string | undefined;
  readonly body: string;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function memoryKv(): KvRepo & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: (key) => data.get(key) ?? null,
    set: (key, value) => {
      data.set(key, value);
    },
  };
}

function llm(fields: Record<string, unknown>): LlmConfig {
  return parseConfig({ llm: { apiKey: 'real-key', model: 'demo', ...fields } }).llm;
}

const whisper: Line = {
  text: '先把这一小步做完',
  tone: 'brisk',
  cue: '[confident]',
  action: '写代码',
  kind: 'whisper',
};

describe('brain/channel', () => {
  const seen: Seen[] = [];
  let upstreamUrl = '';
  const upstream = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      seen.push({ path: req.url ?? '', auth: req.headers.authorization, body });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"带"}}]}\n\n');
      res.end('data: [DONE]\n\n');
    })();
  });

  let channel: Channel;
  const kv = memoryKv();

  beforeAll(async () => {
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
    const db = new DatabaseSync(':memory:');
    const context = await createYoyoContext({ db, petId: 'main' });
    await recordLine(context, whisper, 1);
    await storePetChat(context, [{ role: 'user', content: '昨天说过要带伞', ts: 2 }]);
    await recordLine(context, { ...whisper, text: '带了', kind: 'reply' }, 3);
    channel = await startChannel({ llm: llm({ baseUrl: upstreamUrl }), context, kv });
  });

  afterAll(async () => {
    await channel.close();
    upstream.close();
  });

  test('桌宠发来的截断历史换成全文，当前这句还在；上游拿到真密钥', async () => {
    const response = await fetch(`${channel.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${channel.token}` },
      body: JSON.stringify({
        model: 'demo',
        stream: true,
        messages: [
          { role: 'system', content: '你是女仆' },
          { role: 'user', content: '只剩最近一轮' },
          { role: 'assistant', content: '旧回复' },
          { role: 'user', content: '今天呢' },
        ],
      }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /"带"[\s\S]*\[DONE\]/);
    const last = seen.at(-1)!;
    assert.equal(last.path, '/v1/chat/completions');
    assert.equal(last.auth, 'Bearer real-key');
    const sent = JSON.parse(last.body) as {
      model: string;
      stream: boolean;
      messages: { role: string; content: string }[];
    };
    assert.equal(sent.model, 'demo');
    assert.equal(sent.stream, true);
    assert.deepEqual(
      sent.messages.map((message) => `${message.role}:${message.content}`),
      [
        'system:你是女仆',
        'assistant:碎碎念：\n先把这一小步做完',
        'user:昨天说过要带伞',
        'assistant:带了',
        'user:今天呢',
      ],
    );
  });

  test('只认本机令牌；地址和令牌记进 kv', async () => {
    assert.match(channel.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    assert.equal(Buffer.from(channel.token, 'base64url').length, 24);
    assert.equal(kv.data.get('channel-base'), channel.baseUrl);
    assert.equal(kv.data.get('channel-token'), channel.token);
    const before = seen.length;
    const missing = await fetch(`${channel.baseUrl}/chat/completions`, { method: 'POST', body: '{}' });
    assert.equal(missing.status, 401);
    const real = await fetch(`${channel.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer real-key' },
      body: '{}',
    });
    assert.equal(real.status, 401, '真密钥在这里也不好使');
    assert.equal(seen.length, before);
  });

  test('只支持 openai-compatible；模型没配齐不开', async () => {
    const context = createContext({ store: createMemoryStore(), thread: 'pet:main' });
    await recordUser(context, '在吗', 1);
    await assert.rejects(
      startChannel({ llm: llm({ provider: 'anthropic', baseUrl: upstreamUrl }), context, kv: memoryKv() }),
      { message: '对话渠道只支持 openai-compatible 的模型接口' },
    );
    await assert.rejects(startChannel({ llm: llm({ baseUrl: '' }), context, kv: memoryKv() }), {
      message: 'config.json 的 llm 不完整',
    });
  });
});
