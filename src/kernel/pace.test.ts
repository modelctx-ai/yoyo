import assert from 'node:assert/strict';
import { describe, test } from 'vite-plus/test';

import {
  DEFAULT_PACE_SECONDS,
  PACE_MIN_MS,
  TALK_GAP_MS,
  clampPaceMs,
  nextWhisperAt,
  paceId,
  paceLabel,
  paceNote,
  paceOptionsFrom,
  pickPace,
} from './pace.ts';

describe('pace', () => {
  test('对话一出现，碎碎念就顺延到结束后 30 秒，再说话就再顺延', () => {
    const scheduled = 1_000;
    assert.equal(nextWhisperAt(scheduled, 900, 1_000), 900 + 30_000);
    assert.equal(nextWhisperAt(900 + 30_000, 20_000, 20_000), 20_000 + 30_000);
    assert.equal(nextWhisperAt(80_000, 1_000, 80_000), 80_000);
  });

  test('原定时间更晚就照原定；从没说过话不顺延；间隔可以另给', () => {
    assert.equal(TALK_GAP_MS, 30_000);
    assert.equal(nextWhisperAt(100_000, 50_000, 60_000), 100_000);
    const now = Date.UTC(2026, 9, 23, 9, 0, 0);
    assert.equal(nextWhisperAt(now, 0, now), now);
    assert.equal(nextWhisperAt(1_000, 900, 1_000, 10_000), 10_900);
  });
});

describe('pace 档位', () => {
  test('档位的名字和中文写法：5m、1h、1h30m、90s', () => {
    assert.deepEqual([300_000, 3_600_000, 5_400_000, 90_000].map(paceId), ['5m', '1h', '1h30m', '1m30s']);
    assert.deepEqual([300_000, 3_600_000, 5_400_000, 90_000].map(paceLabel), [
      '5 分钟',
      '1 小时',
      '1 小时 30 分钟',
      '1 分钟 30 秒',
    ]);
  });

  test('没写或写错用缺省四档：5 分钟、15 分钟、30 分钟、1 小时', () => {
    const fallback = paceOptionsFrom(undefined);
    assert.deepEqual(
      fallback.map((option) => option.id),
      ['5m', '15m', '30m', '1h'],
    );
    assert.deepEqual(
      fallback.map((option) => option.ms / 1000),
      DEFAULT_PACE_SECONDS,
    );
    assert.deepEqual(paceOptionsFrom('15m'), fallback);
    assert.deepEqual(paceOptionsFrom({}), fallback);
  });

  test('写的档位：数字字符串可以，丢掉不合法和少于 60 的，去重排序', () => {
    const options = paceOptionsFrom([
      '1800',
      600,
      '600',
      59,
      60,
      'abc',
      null,
      true,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      120.4,
    ]);
    assert.deepEqual(
      options.map((option) => [option.id, option.ms]),
      [
        ['1m', 60_000],
        ['2m', 120_000],
        ['10m', 600_000],
        ['30m', 1_800_000],
      ],
    );
  });

  test('剩下不到两档用缺省四档', () => {
    const fallback = paceOptionsFrom(undefined);
    assert.deepEqual(paceOptionsFrom([900]), fallback);
    assert.deepEqual(paceOptionsFrom([900, 900, 30]), fallback);
    assert.deepEqual(paceOptionsFrom([]), fallback);
    assert.equal(paceOptionsFrom([900, 901]).length, 2);
  });
});

describe('pace 挑档', () => {
  const options = paceOptionsFrom(undefined);

  test('取概率最大的一档；并列取短的', () => {
    assert.deepEqual(pickPace(options, [0.1, 0.2, 0.6, 0.1], 0.4), { option: options[2], confidence: 0.6 });
    assert.deepEqual(pickPace(options, [0.5, 0.5, 0, 0], 0.4), { option: options[0], confidence: 0.5 });
  });

  test('最大的那档低于 minConfidence 是没把握；等于算够', () => {
    assert.equal(pickPace(options, [0.3, 0.3, 0.2, 0.2], 0.4), 'unsure');
    assert.deepEqual(pickPace(options, [0.4, 0.3, 0.2, 0.1], 0.4), { option: options[0], confidence: 0.4 });
    assert.deepEqual(pickPace(options, [0.3, 0.3, 0.2, 0.2], 0), { option: options[0], confidence: 0.3 });
  });

  test('概率个数和档位对不上、不是有限数是 invalid', () => {
    assert.equal(pickPace(options, [0.5, 0.5], 0.4), 'invalid');
    assert.equal(pickPace(options, [0.5, Number.NaN, 0, 0], 0.4), 'invalid');
    assert.equal(pickPace(options, [], 0.4), 'invalid');
  });

  test('间隔夹到一分钟到最长一档；不给上限只管下限', () => {
    assert.equal(clampPaceMs(1_000), PACE_MIN_MS);
    assert.equal(clampPaceMs(7_200_000), 7_200_000);
    assert.equal(clampPaceMs(7_200_000, 3_600_000), 3_600_000);
    assert.equal(clampPaceMs(300_000, 3_600_000), 300_000);
    assert.equal(clampPaceMs(1_000, 10_000), PACE_MIN_MS);
  });
});

describe('pace 说明', () => {
  const options = paceOptionsFrom(undefined);

  test('一句短的原因：固定、挑的档（最短和最长各带一句主人的情形）、退回', () => {
    assert.equal(paceNote({ source: 'fixed', ms: 300_000 }, options), '按固定间隔');
    assert.equal(
      paceNote({ source: 'decided', ms: 3_600_000, option: '1h', confidence: 0.7 }, options),
      '主人在忙，隔 1 小时',
    );
    assert.equal(
      paceNote({ source: 'decided', ms: 300_000, option: '5m', confidence: 0.7 }, options),
      '主人有空，隔 5 分钟',
    );
    assert.equal(paceNote({ source: 'decided', ms: 1_800_000, option: '30m', confidence: 0.7 }, options), '隔 30 分钟');
    assert.equal(paceNote({ source: 'fallback', ms: 300_000, reason: 'timeout' }, options), '决策模型超时，按固定间隔');
    assert.equal(
      paceNote({ source: 'fallback', ms: 300_000, reason: 'unsure' }, options),
      '决策模型没把握，按固定间隔',
    );
    assert.equal(paceNote({ source: 'fallback', ms: 300_000, reason: 'error' }, options), '决策模型没判成，按固定间隔');
  });
});
