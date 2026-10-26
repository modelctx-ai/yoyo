import assert from 'node:assert/strict';
import { describe, test } from 'vite-plus/test';

import { createContext, createMemoryStore, eventEntry, userEntry, type Context } from '@modelctx-ai/ctx';
import { MockLanguageModelV4 } from 'ai/test';

import { yoyoProjection } from '../brain/context.ts';
import { compactContext, historyTokens } from './compact.ts';

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
  const context = createContext({ store: createMemoryStore(), session: 'pet:main', projection: yoyoProjection });
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

  test('框架事件（压缩记下的 ctx.compacted、ctx.run.*）不计入整段历史', async () => {
    const context = await longContext();
    const model = new MockLanguageModelV4({ doGenerate: async () => textResult('主人说了很多话') });
    const done = await compactContext(context, { keep: 2, model });
    assert.ok(done);
    const kinds = (await context.entries()).flatMap((entry) => (entry.type === 'event' ? [entry.kind] : []));
    assert.deepEqual(kinds, ['ctx.compacted']);
    await context.append(eventEntry('ctx.run.started', { text: '很长的一段'.repeat(200) }));
    assert.equal(await historyTokens(context), done.after);
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
