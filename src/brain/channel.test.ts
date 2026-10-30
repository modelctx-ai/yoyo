import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, test } from 'vite-plus/test';

import type { ChatCompletionRequest } from '@modelctx-ai/ctx-gateway';

import type { KvRepo, Logger } from '../ports/index.ts';
import { petAsk, startChannel, type Channel, type PetAsk } from './channel.ts';

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

function memoryLogger(): Logger & { readonly lines: string[] } {
  const lines: string[] = [];
  const push = (message: string): void => {
    lines.push(message);
  };
  return { lines, info: push, warn: push, error: push };
}

function request(messages: ChatCompletionRequest['messages']): ChatCompletionRequest {
  return { model: 'demo', messages };
}

/** SSE 正文里的每个 data 块；`[DONE]` 原样。 */
function events(body: string): unknown[] {
  return body
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => block.slice('data: '.length))
    .map((data) => (data === '[DONE]' ? data : (JSON.parse(data) as unknown)));
}

describe('brain/channel 桌宠要什么', () => {
  test('只看最后一条用户消息：桌宠自己的人设和截断历史不要', () => {
    assert.deepEqual(
      petAsk(
        request([
          { role: 'system', content: '你是女仆' },
          { role: 'user', content: '只剩最近一轮' },
          { role: 'assistant', content: '旧回复' },
          { role: 'user', content: [{ type: 'text', text: ' 今天呢 ' }] },
        ]),
      ),
      { kind: 'chat', text: '今天呢' },
    );
  });

  test('开着对话配图时，去掉桌宠接在后面的表情包清单', () => {
    const text = '今天呢\n\n[配图] 回复结尾可选附一张表情包给用户看，从下列清单里挑最贴合当前语境的：\n- 开心';
    assert.deepEqual(petAsk(request([{ role: 'user', content: text }])), { kind: 'chat', text: '今天呢' });
  });

  test('桌宠自己的碎碎念认得出来；没有用户话就不要', () => {
    assert.deepEqual(petAsk(request([{ role: 'user', content: '随便说一句日常碎碎念，一句就好，20 字以内。' }])), {
      kind: 'whisper',
    });
    assert.equal(petAsk(request([{ role: 'system', content: '你是女仆' }])), null);
    assert.equal(petAsk(request([{ role: 'user', content: '  ' }])), null);
  });
});

const silent = async (): Promise<string> => '';

describe('brain/channel 渠道', () => {
  const kv = memoryKv();
  const logger = memoryLogger();
  const asks: PetAsk[] = [];
  let next: (ask: PetAsk, signal: AbortSignal) => Promise<string> = silent;
  let channel: Channel;

  beforeAll(async () => {
    channel = await startChannel({
      answer: (ask, signal) => {
        asks.push(ask);
        return next(ask, signal);
      },
      kv,
      logger,
    });
  });

  afterAll(async () => {
    await channel.close();
  });

  function post(body: unknown, init: RequestInit = {}): Promise<Response> {
    return fetch(`${channel.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${channel.token}` },
      body: JSON.stringify(body),
      ...init,
    });
  }

  test('流式：先回角色块，再回 yoyo 的回答，最后 [DONE]', async () => {
    next = async () => '带伞了，放心';
    const response = await post({
      model: 'demo',
      stream: true,
      messages: [
        { role: 'system', content: '你是女仆' },
        { role: 'user', content: '今天呢' },
      ],
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
    const seen = events(await response.text()) as {
      model?: string;
      choices?: { delta: Record<string, string>; finish_reason: string | null }[];
    }[];
    assert.deepEqual(
      seen.map((event) => (typeof event === 'string' ? event : event.choices?.[0])),
      [
        { index: 0, delta: { role: 'assistant' }, finish_reason: null },
        { index: 0, delta: { content: '带伞了，放心' }, finish_reason: null },
        { index: 0, delta: {}, finish_reason: 'stop' },
        '[DONE]',
      ],
    );
    assert.equal(seen[0]?.model, 'demo');
    assert.deepEqual(asks.at(-1), { kind: 'chat', text: '今天呢' });
  });

  test('不要流式就回一次性 JSON', async () => {
    next = async () => '在呢';
    const response = await post({ model: 'demo', messages: [{ role: 'user', content: '在吗' }] });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { object: string; choices: { message: unknown; finish_reason: string }[] };
    assert.equal(body.object, 'chat.completion');
    assert.deepEqual(body.choices[0], {
      index: 0,
      message: { role: 'assistant', content: '在呢' },
      finish_reason: 'stop',
    });
  });

  test('没回成：流里给 error，不要流式时回 502；日志记一行', async () => {
    next = async () => {
      throw new Error('模型接口返回 500');
    };
    const streamed = await post({ stream: true, messages: [{ role: 'user', content: '在吗' }] });
    assert.deepEqual(events(await streamed.text()).at(-1), {
      error: { message: '模型接口返回 500', type: 'yoyo_error' },
    });
    const plain = await post({ messages: [{ role: 'user', content: '在吗' }] });
    assert.equal(plain.status, 502);
    assert.ok(logger.lines.includes('右键对话没回成：模型接口返回 500'), logger.lines.join('\n'));
  });

  test('桌宠断开，回答这一轮跟着取消', async () => {
    let aborted: Promise<void> = Promise.resolve();
    next = (_ask, signal) => {
      aborted = new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      return new Promise(() => {});
    };
    const controller = new AbortController();
    const response = await post(
      { stream: true, messages: [{ role: 'user', content: '在吗' }] },
      { signal: controller.signal },
    );
    assert.equal(response.status, 200);
    controller.abort();
    await aborted;
  });

  test('只认本机令牌；别的路径 404；坏正文 400；地址和令牌记进 kv', async () => {
    assert.match(channel.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    assert.equal(Buffer.from(channel.token, 'base64url').length, 24);
    assert.equal(kv.data.get('channel-base'), channel.baseUrl);
    assert.equal(kv.data.get('channel-token'), channel.token);
    const before = asks.length;
    const missing = await post({ messages: [{ role: 'user', content: '在吗' }] }, { headers: {} });
    assert.equal(missing.status, 401);
    const models = await fetch(`${channel.baseUrl}/models`, { headers: { authorization: `Bearer ${channel.token}` } });
    assert.equal(models.status, 404);
    const bad = await fetch(`${channel.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${channel.token}` },
      body: '{',
    });
    assert.equal(bad.status, 400);
    const empty = await post({ messages: [{ role: 'system', content: '你是女仆' }] });
    assert.equal(empty.status, 400);
    assert.equal(asks.length, before);
  });
});
