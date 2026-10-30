import assert from 'node:assert/strict';
import { describe, test } from 'vite-plus/test';

import { createContext, createMemoryStore, createOrchestrator, type Harness } from '@modelctx-ai/ctx';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';

import { sessionFor, yoyoProjection } from './context.ts';
import { createYoyoHarness, tapDeltas } from './harness.ts';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** 一段一段吐字的假模型；流式和非流式给的是同一段话，看走了哪条路。 */
function talkingModel(pieces: readonly string[]) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text: pieces.join('') }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage,
      warnings: [],
    }),
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: '1' },
        ...pieces.map((delta) => ({ type: 'text-delta' as const, id: '1', delta })),
        { type: 'text-end', id: '1' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
      ]),
    }),
  });
}

function rig(inner?: (harness: Harness) => Harness) {
  const context = createContext({
    store: createMemoryStore(),
    session: sessionFor('main'),
    projection: yoyoProjection,
  });
  const harness = createYoyoHarness(context);
  const tap = tapDeltas(inner ? inner(harness) : harness);
  return { tap, runs: createOrchestrator({ harness: tap.harness }), session: context.session };
}

describe('tapDeltas', () => {
  test('登记过的那一轮改走流式：增量按顺序交给登记的函数，结果和不登记时一样', async () => {
    const { tap, runs, session } = rig();
    const model = talkingModel(['带', '伞', '了']);
    const pieces: string[] = [];
    const unwatch = tap.watch('run-1', (text) => pieces.push(text));
    const handle = await runs.submit({ session, agent: { model }, prompt: '伞带了吗', record: false, runId: 'run-1' });
    const result = await handle.done;
    unwatch();
    assert.deepEqual(pieces, ['带', '伞', '了']);
    assert.equal(result.text, '带伞了');
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(model.doStreamCalls.length, 1);
    assert.equal(model.doGenerateCalls.length, 0);
  });

  test('没登记的、撤掉了的、编号不一样的，还是原来的 run', async () => {
    const { tap, runs, session } = rig();
    const model = talkingModel(['好']);
    const pieces: string[] = [];
    tap.watch('run-a', (text) => pieces.push(text))();
    for (const runId of ['run-a', 'run-b', undefined]) {
      const handle = await runs.submit({
        session,
        agent: { model },
        prompt: '在吗',
        record: false,
        ...(runId ? { runId } : {}),
      });
      assert.equal((await handle.done).text, '好');
    }
    assert.deepEqual(pieces, []);
    assert.equal(model.doStreamCalls.length, 0);
    assert.equal(model.doGenerateCalls.length, 3);
  });

  test('模型出错：照 run 的样子，stopReason 是 error 并带原因，不抛', async () => {
    const { tap, runs, session } = rig();
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error('接口挂了');
      },
    });
    tap.watch('run-1', () => {});
    const handle = await runs.submit({ session, agent: { model }, prompt: '在吗', record: false, runId: 'run-1' });
    const result = await handle.done;
    assert.equal(result.stopReason, 'error');
    assert.match(result.error?.message ?? '', /接口挂了/);
  });

  test('harness 没有 stream 就原样 run；看增量的函数抛错不连累这一轮', async () => {
    const plain = rig((harness) => ({ run: (request) => harness.run(request) }));
    const model = talkingModel(['好']);
    plain.tap.watch('run-1', () => assert.fail('没有流，不该有增量'));
    const done = await plain.runs.submit({
      session: plain.session,
      agent: { model },
      record: false,
      prompt: '嗯',
      runId: 'run-1',
    });
    assert.equal((await done.done).text, '好');

    const noisy = rig();
    noisy.tap.watch('run-2', () => {
      throw new Error('看的人出错了');
    });
    const handle = await noisy.runs.submit({
      session: noisy.session,
      agent: { model: talkingModel(['好', '的']) },
      prompt: '嗯',
      record: false,
      runId: 'run-2',
    });
    assert.equal((await handle.done).text, '好的');
  });
});
