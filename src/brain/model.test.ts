import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';

import { createContext, createMemoryStore } from '@modelctx-ai/ctx';

import { parseConfig, type LlmConfig } from '../app/config.ts';
import { generateWhisper } from './compose.ts';
import { recordUser, yoyoProjection } from './context.ts';
import { createLanguageModel } from './model.ts';

function llm(fields: Record<string, unknown>): LlmConfig {
  return parseConfig({ llm: fields }).llm;
}

interface Seen {
  readonly path: string;
  readonly auth: string | undefined;
  readonly body: { model?: string; temperature?: number; messages?: { role: string; content: unknown }[] };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

describe('brain/model', () => {
  test('模型没配齐就不建', () => {
    assert.equal(createLanguageModel(llm({})), null);
    assert.equal(createLanguageModel(llm({ baseUrl: 'https://llm.example/v1', model: 'demo' })), null);
    assert.equal(createLanguageModel(llm({ baseUrl: 'https://llm.example/v1', apiKey: 'sk-x' })), null);
    assert.equal(createLanguageModel(llm({ apiKey: 'sk-x', model: 'demo' })), null, 'openai-compatible 要有 baseUrl');
  });

  test('配齐了按 provider 建模型；anthropic 可以不写 baseUrl', () => {
    const compatible = createLanguageModel(llm({ baseUrl: 'https://llm.example/v1', apiKey: 'sk-x', model: 'demo' }));
    assert.ok(compatible && typeof compatible === 'object');
    assert.equal(compatible.modelId, 'demo');
    assert.match(compatible.provider, /^yoyo/);
    const claude = createLanguageModel(llm({ provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-test' }));
    assert.ok(claude && typeof claude === 'object');
    assert.equal(claude.modelId, 'claude-test');
    assert.match(claude.provider, /anthropic/);
  });

  describe('接到 openai-compatible 接口', () => {
    const seen: Seen[] = [];
    let status = 200;
    let baseUrl = '';
    const upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
      void readBody(req).then((raw) => {
        seen.push({ path: req.url ?? '', auth: req.headers.authorization, body: JSON.parse(raw) as Seen['body'] });
        res.writeHead(status, { 'content-type': 'application/json' });
        if (status !== 200) {
          res.end(JSON.stringify({ error: { message: 'invalid api key sk-real-key' } }));
          return;
        }
        res.end(
          JSON.stringify({
            id: 'x',
            created: 0,
            model: 'demo',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: '「肩膀放松一点，再接着写」' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      });
    });

    before(async () => {
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1/`;
    });

    after(() => {
      upstream.close();
    });

    test('碎碎念打到 baseUrl/chat/completions，带真密钥和温度', async () => {
      status = 200;
      const model = createLanguageModel(llm({ baseUrl, apiKey: 'sk-real-key', model: 'demo' }));
      assert.ok(model);
      const context = createContext({ store: createMemoryStore(), thread: 'pet:main', projection: yoyoProjection });
      await recordUser(context, '我在写周报', 1);
      const line = await generateWhisper(context, { tone: 'warm', model });
      assert.equal(line.text, '肩膀放松一点，再接着写');
      const call = seen.at(-1)!;
      assert.equal(call.path, '/v1/chat/completions');
      assert.equal(call.auth, 'Bearer sk-real-key');
      assert.equal(call.body.model, 'demo');
      assert.equal(call.body.temperature, 0.8);
      assert.deepEqual(
        call.body.messages?.map((message) => message.role),
        ['system', 'user', 'user'],
      );
    });

    test('接口报错时文案和旧代码一样，密钥不出现', async () => {
      status = 401;
      const model = createLanguageModel(llm({ baseUrl, apiKey: 'sk-real-key', model: 'demo' }));
      const context = createContext({ store: createMemoryStore(), thread: 'pet:main', model: model! });
      await assert.rejects(generateWhisper(context, { tone: 'warm', secrets: ['sk-real-key'] }), {
        message: '模型接口返回 401：{"error":{"message":"invalid api key ***"}}',
      });
    });
  });
});
