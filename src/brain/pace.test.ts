import assert from 'node:assert/strict';
import { describe, test } from 'vite-plus/test';

import {
  assistantEntry,
  createContext,
  createMemoryStore,
  eventEntry,
  userEntry,
  type DecisionAnswer,
  type DecisionModel,
  type DecisionRequest,
} from '@modelctx-ai/ctx';
import { createScriptedDecisionModel } from '@modelctx-ai/ctx-protocol/testing';

import { parseConfig } from '../app/config.ts';
import { paceOptionsFrom, type PaceInput } from '../kernel/pace.ts';
import type { Logger } from '../ports/index.ts';
import { PACE_QUESTION, createWhisperPacer, decisionPacer, fixedPacer, paceQuestion, paceSecrets } from './pace.ts';

const options = paceOptionsFrom(undefined);
const SECRET = 'jev-secret-key';

/** 下午三点一刻，周六。 */
const NOW = new Date(2026, 9, 24, 15, 15, 0).getTime();

const INPUT: PaceInput = {
  now: NOW,
  tone: 'warm',
  line: { text: '喝口水吧', kind: 'whisper' },
  talked: false,
  unanswered: 2,
  sinceTalkMs: 20 * 60_000,
};

/** 四档里挑第 `level` 档，概率 `p`，其余平分。 */
function scored(level: number, p = 0.8): DecisionAnswer {
  const rest = (1 - p) / (options.length - 1);
  const probabilities = options.map((_, index) => (index === level ? p : rest));
  return { type: 'score', score: level / (options.length - 1), probabilities };
}

function scriptedModel(answer: DecisionAnswer) {
  return createScriptedDecisionModel({ answers: { [PACE_QUESTION]: answer } });
}

function linesOf(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      info: (message) => void lines.push(message),
      warn: (message) => void lines.push(message),
      error: (message) => void lines.push(message),
    },
  };
}

function pacer(model: DecisionModel, extra: Partial<Parameters<typeof decisionPacer>[0]> = {}) {
  return decisionPacer({ model, options, fallbackMs: 300_000, minConfidence: 0.4, recent: 0, ...extra });
}

describe('fixedPacer', () => {
  test('永远是同一个间隔', async () => {
    assert.deepEqual(await fixedPacer(300_000).next(INPUT), { source: 'fixed', ms: 300_000 });
  });
});

describe('decisionPacer', () => {
  test('问一个按档位从短到长的 score 问题，挑概率最大的那档', async () => {
    const model = scriptedModel(scored(2));
    const decision = await pacer(model).next(INPUT);
    assert.deepEqual(decision, { source: 'decided', ms: 1_800_000, option: '30m', confidence: 0.8 });

    const [request] = model.requests;
    assert.deepEqual(Object.keys(request!.questions), [PACE_QUESTION]);
    const question = request!.questions[PACE_QUESTION]!;
    assert.equal(question.type, 'score');
    assert.deepEqual(question, paceQuestion(options));
    assert.equal(question.type === 'score' ? question.criteria.length : 0, 4);
    assert.match(question.type === 'score' ? question.criteria[0]! : '', /^5 分钟后再说一句：/);
    assert.match(question.type === 'score' ? question.criteria[3]! : '', /^1 小时后再说一句：/);
  });

  test('各档都能挑到', async () => {
    const got = [];
    for (const level of [0, 1, 2, 3]) got.push(await pacer(scriptedModel(scored(level))).next(INPUT));
    assert.deepEqual(
      got.map((decision) => decision.ms),
      options.map((option) => option.ms),
    );
  });

  test('state 里是结构化的信号；recent 是 0 不发对话原文', async () => {
    const model = scriptedModel(scored(1));
    await pacer(model, { work: async () => ({ state: 'working', task: '写测试' }) }).next(INPUT);
    assert.deepEqual(model.requests[0]!.state, {
      time: '15:15',
      weekday: '周六',
      tone: 'warm',
      line: { text: '喝口水吧', kind: 'whisper' },
      talked: false,
      unanswered: 2,
      minutesSinceTalk: 20,
      work: { state: 'working', task: '写测试' },
    });
  });

  test('没说过话 minutesSinceTalk 是 null；读不到工作状态当没有', async () => {
    const model = scriptedModel(scored(1));
    await pacer(model, {
      work: async () => {
        throw new Error('桌宠没连上');
      },
    }).next({ ...INPUT, sinceTalkMs: null });
    const state = model.requests[0]!.state as Record<string, unknown>;
    assert.equal(state['minutesSinceTalk'], null);
    assert.equal(state['work'], null);
  });

  test('recent 条数的最近对话原文一并发过去，只要主人和 yoyo 说的话，每条截短', async () => {
    const context = createContext({ store: createMemoryStore(), session: 's' });
    await context.append(
      userEntry('第一句'),
      assistantEntry('第二句'),
      eventEntry('whisper', { text: '碎碎念不算对话' }),
      userEntry('第三句'),
      assistantEntry('长'.repeat(300)),
    );
    const model = scriptedModel(scored(1));
    await pacer(model, { context, recent: 3 }).next(INPUT);
    const recent = (model.requests[0]!.state as { recent: { role: string; text: string }[] }).recent;
    assert.deepEqual(
      recent.map((turn) => [turn.role, turn.text.length]),
      [
        ['assistant', 3],
        ['user', 3],
        ['assistant', 200],
      ],
    );
    assert.equal(recent[0]!.text, '第二句');
  });

  test('没把握：最大的那档低于 minConfidence，退回固定间隔', async () => {
    const { logger, lines } = linesOf();
    const decision = await pacer(scriptedModel(scored(1, 0.3)), { logger }).next(INPUT);
    assert.deepEqual(decision, { source: 'fallback', ms: 300_000, reason: 'unsure' });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /没把握/);
  });

  test('回的不是 score、概率个数对不上、抛错，都是 error，不抛出来', async () => {
    const wrongType = await pacer(scriptedModel({ type: 'noul', noul: 0.9 })).next(INPUT);
    assert.deepEqual(wrongType, { source: 'fallback', ms: 300_000, reason: 'error' });

    const short = await pacer(scriptedModel({ type: 'score', score: 0.5, probabilities: [0.5, 0.5] })).next(INPUT);
    assert.deepEqual(short, { source: 'fallback', ms: 300_000, reason: 'error' });

    const failing: DecisionModel = {
      name: 'failing',
      decide: async () => {
        throw new Error('503');
      },
    };
    assert.deepEqual(await pacer(failing).next(INPUT), { source: 'fallback', ms: 300_000, reason: 'error' });
  });

  test('超时：模型不回，到点就退回，拍子最多被卡这么久', async () => {
    const hanging: DecisionModel = {
      name: 'hanging',
      decide: (request: DecisionRequest) =>
        new Promise((_, reject) => {
          request.signal?.addEventListener('abort', () => reject(new Error('被中止了')));
        }),
    };
    const started = Date.now();
    const decision = await pacer(hanging, { timeoutMs: 30 }).next(INPUT);
    assert.deepEqual(decision, { source: 'fallback', ms: 300_000, reason: 'timeout' });
    assert.ok(Date.now() - started < 2_000);
  });

  test('模型根本不理 signal 也不会卡住', async () => {
    const deaf: DecisionModel = { name: 'deaf', decide: () => new Promise(() => {}) };
    assert.deepEqual(await pacer(deaf, { timeoutMs: 30 }).next(INPUT), {
      source: 'fallback',
      ms: 300_000,
      reason: 'timeout',
    });
  });

  test('调用方中止（yoyo 停下）也退回，不抛出来', async () => {
    const controller = new AbortController();
    controller.abort(new Error('yoyo 停下了'));
    const decision = await pacer(scriptedModel(scored(1))).next(INPUT, controller.signal);
    assert.deepEqual(decision, { source: 'fallback', ms: 300_000, reason: 'error' });
  });

  test('报错里没有密钥：日志只有一行，密钥抹掉了', async () => {
    const { logger, lines } = linesOf();
    const failing: DecisionModel = {
      name: 'failing',
      decide: async () => {
        throw new Error(`401 Authorization: Bearer ${SECRET}`);
      },
    };
    await pacer(failing, { logger, secrets: [SECRET] }).next(INPUT);
    assert.equal(lines.length, 1);
    assert.ok(!lines.join('\n').includes(SECRET));
    assert.match(lines[0]!, /401/);
  });

  test('间隔夹到一分钟以上：fallbackMs 太小也不低于一分钟', async () => {
    const decision = await pacer(scriptedModel({ type: 'noul', noul: 0.5 }), { fallbackMs: 1_000 }).next(INPUT);
    assert.equal(decision.ms, 60_000);
  });
});

describe('createWhisperPacer', () => {
  const context = createContext({ store: createMemoryStore(), session: 's' });

  test('没配 pace.decision 是固定间隔：就算配了 memory.decision 也不借', async () => {
    const { logger, lines } = linesOf();
    const config = parseConfig({
      memory: { decision: { provider: 'typesafe', model: 'jev-latest', apiKey: SECRET } },
    });
    const made = createWhisperPacer({ config: config.pace, fallbackMs: 300_000, logger, context });
    assert.equal(made.name, 'fixed');
    assert.deepEqual(await made.next(INPUT), { source: 'fixed', ms: 300_000 });
    assert.deepEqual(lines, []);
  });

  test('配了就是决策的；名字是模型名；密钥单独列出来', () => {
    const { logger } = linesOf();
    const config = parseConfig({ pace: { decision: { provider: 'typesafe', model: 'jev-latest', apiKey: SECRET } } });
    const made = createWhisperPacer({ config: config.pace, fallbackMs: 300_000, logger, context });
    assert.notEqual(made.name, 'fixed');
    assert.deepEqual(paceSecrets(config.pace), [SECRET]);
    assert.deepEqual(paceSecrets(parseConfig({}).pace), []);
  });

  test('配得不对（没写 model）记一行，按固定间隔，行里没有密钥', async () => {
    const { logger, lines } = linesOf();
    const config = parseConfig({ pace: { decision: { provider: 'typesafe', apiKey: SECRET } } });
    const made = createWhisperPacer({ config: config.pace, fallbackMs: 300_000, logger, context });
    assert.equal(made.name, 'fixed');
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /pace\.decision 不对/);
    assert.ok(!lines[0]!.includes(SECRET));
  });
});
