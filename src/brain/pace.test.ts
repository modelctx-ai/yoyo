import assert from 'node:assert/strict';
import { describe, test } from 'vite-plus/test';

import { assistantEntry, createMemoryStore, eventEntry, userEntry, type DecisionModel } from '@modelctx-ai/ctx';
import { createScriptedDecisionModel } from '@modelctx-ai/ctx-protocol/testing';

import { parseConfig } from '../app/config.ts';
import { paceOptions, type PaceInput } from '../kernel/pace.ts';
import type { Logger } from '../ports/index.ts';
import {
  PACE_QUESTION,
  createWhisperPacer,
  decisionPacer,
  fixedPacer,
  paceQuestion,
  paceSecrets,
  paceState,
  recentLines,
} from './pace.ts';

function memoryLogger(): Logger & { readonly lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (message) => lines.push(message),
    warn: (message) => lines.push(message),
    error: (message) => lines.push(message),
  };
}

/** 周五下午三点二十，刚说完一句没人理。 */
const AT = new Date(2026, 9, 30, 15, 20, 0).getTime();
const INPUT: PaceInput = {
  now: AT,
  tone: 'brisk',
  line: { text: '喝口水吧', kind: 'whisper' },
  talked: false,
  unanswered: 2,
  sinceTalkMs: 25 * 60_000,
};
const OPTIONS = paceOptions([]);

function scored(probabilities: readonly number[]): DecisionModel {
  return createScriptedDecisionModel({
    answers: { [PACE_QUESTION]: { type: 'score', score: 0, probabilities } },
  });
}

function pacer(
  model: DecisionModel,
  logger = memoryLogger(),
  extra: Partial<Parameters<typeof decisionPacer>[0]> = {},
) {
  return decisionPacer({ model, options: OPTIONS, fallbackMs: 300_000, minConfidence: 0.4, logger, ...extra });
}

describe('brain/pace', () => {
  test('没配决策模型：总是 intervalSec', async () => {
    assert.deepEqual(await fixedPacer(300_000).next(INPUT), { source: 'fixed', ms: 300_000 });
  });

  test('量表从短到长，最短偏想有人陪，最长偏别打扰', () => {
    const question = paceQuestion(OPTIONS);
    assert.equal(question.type, 'score');
    assert.deepEqual(question.type === 'score' ? question.criteria : [], [
      '5 分钟后再说一句：主人想有人陪着说话',
      '15 分钟后再说一句',
      '30 分钟后再说一句',
      '1 小时后再说一句：主人在忙或者不想被打扰',
    ]);
  });

  test('交给模型的情况：本地时间、刚说的、有没有回应、离上次对话几分钟、在做什么、最近几句', () => {
    assert.deepEqual(
      paceState(INPUT, {
        work: { state: 'coding', task: '写周报' },
        recent: [{ role: 'user', text: '好累' }],
      }),
      {
        now: '周五 15:20',
        tone: 'brisk',
        said: { text: '喝口水吧', kind: 'whisper' },
        replied: false,
        unanswered: 2,
        minutesSinceTalk: 25,
        work: { state: 'coding', task: '写周报' },
        recent: [{ role: 'user', text: '好累' }],
      },
    );
    assert.equal(
      (paceState({ ...INPUT, sinceTalkMs: null }, { work: null, recent: [] }) as { minutesSinceTalk: unknown })
        .minutesSinceTalk,
      null,
    );
  });

  test('挑概率最大的一档；问一道题，带上工作状态和最近几句', async () => {
    const model = createScriptedDecisionModel({
      answers: { [PACE_QUESTION]: { type: 'score', score: 1, probabilities: [0, 0.2, 0.7, 0.1] } },
    });
    const decision = await pacer(model, memoryLogger(), {
      work: async () => ({ state: null, task: '写周报' }),
      recent: async () => [{ role: 'assistant', text: '我在呢' }],
    }).next(INPUT);
    assert.deepEqual(decision, { source: 'decided', ms: 1_800_000, option: '30m', confidence: 0.7 });
    const [request] = model.requests;
    assert.deepEqual(Object.keys(request?.questions ?? {}), [PACE_QUESTION]);
    const state = request?.state as { work: unknown; recent: unknown };
    assert.deepEqual(state.work, { state: null, task: '写周报' });
    assert.deepEqual(state.recent, [{ role: 'assistant', text: '我在呢' }]);
  });

  test('把握不够：这一次按 intervalSec，不记日志', async () => {
    const logger = memoryLogger();
    assert.deepEqual(await pacer(scored([0.3, 0.3, 0.2, 0.2]), logger).next(INPUT), {
      source: 'fallback',
      ms: 300_000,
      reason: 'unsure',
    });
    assert.deepEqual(logger.lines, []);
  });

  test('出错、回错题型、档数不对：按 intervalSec，同一个问题只记一次，密钥抹掉；取不到工作状态当没有', async () => {
    const logger = memoryLogger();
    const failing: DecisionModel = {
      name: 'jev',
      decide: async () => {
        throw new Error('HTTP 401 key=ts-secret');
      },
    };
    const broken = pacer(failing, logger, { secrets: ['ts-secret'] });
    assert.deepEqual(await broken.next(INPUT), { source: 'fallback', ms: 300_000, reason: 'error' });
    await broken.next(INPUT);
    assert.deepEqual(logger.lines, ['下一句碎碎念的间隔没判成，先按 intervalSec：HTTP 401 key=***']);

    const noul = createScriptedDecisionModel({ answers: { [PACE_QUESTION]: { type: 'noul', noul: 1 } } });
    assert.equal((await pacer(noul, logger).next(INPUT)).source, 'fallback');
    assert.match(logger.lines.at(-1)!, /回的不是量表：noul/);

    const short = pacer(scored([1, 0]), logger, {
      work: async () => {
        throw new Error('桌宠没开');
      },
    });
    assert.equal((await short.next(INPUT)).source, 'fallback');
    assert.match(logger.lines.at(-1)!, /回了 2 档，问的是 4 档/);
  });

  test('超时按 intervalSec；停下了不记日志', async () => {
    const hanging: DecisionModel = {
      name: 'jev',
      decide: ({ signal }) =>
        new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true })),
    };
    const logger = memoryLogger();
    assert.deepEqual(await pacer(hanging, logger, { timeoutMs: 10 }).next(INPUT), {
      source: 'fallback',
      ms: 300_000,
      reason: 'timeout',
    });
    assert.deepEqual(logger.lines, ['下一句碎碎念的间隔没判成，先按 intervalSec：0 秒没回']);

    const quiet = memoryLogger();
    const stop = new AbortController();
    const pending = pacer(hanging, quiet).next(INPUT, stop.signal);
    stop.abort();
    assert.equal((await pending).source, 'fallback');
    assert.deepEqual(quiet.lines, []);
  });

  test('按配置挑：没配按 intervalSec；写得不对记一行也按 intervalSec；配了问决策模型，recent 是 0 时不读对话', async () => {
    const logger = memoryLogger();
    assert.equal(createWhisperPacer(parseConfig({ intervalSec: 600 }), { logger }).name, 'fixed');
    assert.deepEqual(await createWhisperPacer(parseConfig({ intervalSec: 600 }), { logger }).next(INPUT), {
      source: 'fixed',
      ms: 600_000,
    });

    const wrong = parseConfig({ pace: { decision: { provider: 'cloudflare', model: 'clef', apiKey: 'cf-secret' } } });
    assert.equal(createWhisperPacer(wrong, { logger }).name, 'fixed');
    assert.equal(logger.lines.length, 1);
    assert.match(logger.lines[0]!, /^config\.json 的 pace\.decision 不对：.*accountId.*，碎碎念按 intervalSec$/);
    assert.ok(!logger.lines[0]!.includes('cf-secret'));

    const jev = parseConfig({
      pace: { decision: { provider: 'typesafe', model: 'jev-latest', apiKey: 'ts-key' }, recent: 0 },
    });
    let read = 0;
    const made = createWhisperPacer(jev, {
      logger,
      recent: async () => {
        read++;
        return [];
      },
    });
    assert.equal(made.name, 'typesafe:jev-latest');
    assert.deepEqual(paceSecrets(jev), ['ts-key']);
    assert.equal(read, 0);
  });

  test('最近几句：用户、回复和碎碎念，按先后，取最后几句', async () => {
    const store = createMemoryStore();
    await store.append('pet:main', [
      userEntry('早'),
      eventEntry('whisper', { text: '喝口水吧' }),
      eventEntry('task', { text: '不算' }),
      assistantEntry('好的'),
    ]);
    assert.deepEqual(await recentLines(store, 'pet:main', 2), [
      { role: 'assistant', text: '喝口水吧' },
      { role: 'assistant', text: '好的' },
    ]);
    assert.deepEqual(await recentLines(store, 'pet:main', 0), []);
  });
});
