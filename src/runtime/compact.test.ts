import assert from 'node:assert/strict';
import { describe, test } from 'vite-plus/test';

import {
  createContext,
  createMemoryStore,
  eventEntry,
  findLossySummaries,
  userEntry,
  type Context,
} from '@modelctx-ai/ctx';
import { MockLanguageModelV4 } from 'ai/test';

import { yoyoProjection } from '../brain/context.ts';
import { COMPACT_INSTRUCTIONS } from '../brain/prompts.ts';
import { compactContext, historyTokens, recompactLossySummaries } from './compact.ts';
import { lossyContext, memoryLogger } from './testing.ts';

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

const texts = async (context: Context) =>
  (await context.view()).messages.map((message) => JSON.stringify(message.content));

describe('recompactLossySummaries', () => {
  test('旧摘要盖住了晚到的记录：用 yoyo 的压缩指令重新压缩，新摘要取代旧摘要，再找为空', async () => {
    const model = new MockLanguageModelV4({ doGenerate: textResult('新摘要：问题一和二，还有晚到的回答') });
    const context = await lossyContext();
    const logger = memoryLogger();
    assert.equal((await findLossySummaries(context.store)).length, 1);
    assert.ok(!(await texts(context)).some((text) => text.includes('晚到的回答')), '修复前模型看不到它');

    assert.equal(await recompactLossySummaries(context, { model, logger }), 1);
    assert.equal(model.doGenerateCalls.length, 1);
    const call = model.doGenerateCalls[0]!;
    assert.deepEqual(call.prompt[0], { role: 'system', content: COMPACT_INSTRUCTIONS });
    const input = JSON.stringify(call.prompt[1]);
    assert.ok(input.includes('旧摘要：问题一和二') && input.includes('晚到的回答'), '输入是旧摘要加被盖住的记录');
    assert.deepEqual(await texts(context), ['"前面对话的摘要：\\n新摘要：问题一和二，还有晚到的回答"', '"之后的问题"']);
    assert.deepEqual(logger.lines, ['旧摘要盖住了 1 条记录，已重新压缩']);

    assert.deepEqual(await findLossySummaries(context.store), []);
    assert.equal(await recompactLossySummaries(context, { model, logger }), 0, '第二次启动什么也不做');
    assert.equal(model.doGenerateCalls.length, 1);
  });

  test('没有模型：只记一条警告，什么也不写，等下次带模型启动', async () => {
    const context = await lossyContext();
    const logger = memoryLogger();
    const before = (await context.entries()).length;
    assert.equal(await recompactLossySummaries(context, { model: null, logger }), 0);
    assert.deepEqual(logger.lines, ['旧摘要盖住了 1 条较晚写进来的记录，没配模型，等下次带着模型启动时再重新压缩']);
    assert.equal((await context.entries()).length, before);
    assert.equal((await findLossySummaries(context.store)).length, 1, '还在，下次启动再做');
  });

  test('没有旧摘要的问题就不调模型、不出声', async () => {
    const model = new MockLanguageModelV4({ doGenerate: async () => textResult('不该用到') });
    const context = createContext({ store: createMemoryStore(), session: 'pet:main', projection: yoyoProjection });
    await context.append(userEntry('一句话'));
    const logger = memoryLogger();
    assert.equal(await recompactLossySummaries(context, { model, logger }), 0);
    assert.equal(model.doGenerateCalls.length, 0);
    assert.deepEqual(logger.lines, []);
  });

  test('模型出错或没给摘要：记一条警告，不抛，旧摘要留着下次再试', async () => {
    const broken = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('socket hang up');
      },
    });
    const context = await lossyContext();
    const logger = memoryLogger();
    assert.equal(await recompactLossySummaries(context, { model: broken, logger }), 0);
    assert.deepEqual(logger.lines, ['旧摘要没重新压缩成：socket hang up']);

    const empty = new MockLanguageModelV4({ doGenerate: async () => textResult('   ') });
    assert.equal(await recompactLossySummaries(context, { model: empty, logger }), 0);
    assert.equal(logger.lines.at(-1), '旧摘要没重新压缩成：模型没有给出完整的摘要，等下次启动再试');
    assert.equal((await findLossySummaries(context.store)).length, 1);
  });
});
