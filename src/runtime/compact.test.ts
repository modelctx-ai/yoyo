import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createContext, createMemoryStore, userEntry, type Context } from '@modelctx-ai/ctx';
import { MockLanguageModelV4 } from 'ai/test';

import { yoyoProjection } from '../brain/context.ts';
import { compactContext } from './compact.ts';

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

function textResult(text: string): GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [],
  };
}

async function longContext(): Promise<Context> {
  const context = createContext({ store: createMemoryStore(), thread: 'pet:main', projection: yoyoProjection });
  for (let i = 0; i < 12; i += 1) await context.append(userEntry(`第 ${i} 句话，说得稍微长一点`));
  return context;
}

describe('compact', () => {
  test('压缩带着超时去调模型，压完报出前后的 token', async () => {
    let signalled = false;
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        signalled = options.abortSignal !== undefined;
        return textResult('主人说了很多话');
      },
    });
    const done = await compactContext(await longContext(), { keep: 2, model });
    assert.ok(done);
    assert.ok(done.after < done.before);
    assert.equal(signalled, true, '模型收到了超时用的 abortSignal');
  });

  test('模型一直不回就按时放弃，不卡住常驻循环', async () => {
    const hanging = new MockLanguageModelV4({
      doGenerate: (options) =>
        new Promise<GenerateResult>((_, reject) => {
          options.abortSignal?.addEventListener('abort', () => reject(new Error('超时了')));
        }),
    });
    // 超时用的计时器不拖住进程；常驻进程里有每秒一拍的计时器，这里补一个
    const alive = setTimeout(() => {}, 10_000);
    const started = Date.now();
    try {
      await assert.rejects(compactContext(await longContext(), { keep: 2, model: hanging, timeoutMs: 50 }));
    } finally {
      clearTimeout(alive);
    }
    assert.ok(Date.now() - started < 5000);
  });
});
