import assert from 'node:assert/strict';
import { describe, test } from 'vite-plus/test';

import {
  DEFAULT_PACE_SEC,
  TALK_GAP_MS,
  nextWhisperAt,
  paceId,
  paceLabel,
  paceOptions,
  pickPace,
  whisperIntervalMs,
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

  test('碎碎念间隔：至少一分钟，没写或写错按 5 分钟', () => {
    assert.equal(whisperIntervalMs(300), 300_000);
    assert.equal(whisperIntervalMs(10), 60_000);
    assert.equal(whisperIntervalMs(0), 300_000);
    assert.equal(whisperIntervalMs(Number.NaN), 300_000);
  });

  test('档名和说法：整小时、整分钟、秒', () => {
    assert.deepEqual([3600, 7200, 900, 90].map(paceId), ['1h', '2h', '15m', '90s']);
    assert.deepEqual(
      [3600, 900, 90].map((sec) => paceLabel({ id: paceId(sec), ms: sec * 1000 })),
      ['1 小时', '15 分钟', '90 秒'],
    );
  });

  test('档位：丢掉少于一分钟、不是有限数的，取整去重，从短到长；不到两档用缺省四档', () => {
    assert.deepEqual(paceOptions([1800, 60, 59, Number.NaN, Infinity, 1800, 90.4]), [
      { id: '1m', ms: 60_000 },
      { id: '90s', ms: 90_000 },
      { id: '30m', ms: 1_800_000 },
    ]);
    const defaults = paceOptions([]);
    assert.deepEqual(
      defaults.map((option) => option.ms / 1000),
      DEFAULT_PACE_SEC,
    );
    assert.deepEqual(paceOptions([300]), defaults);
  });

  test('挑档：概率最大的一档，一样大取短的；把握不够、档数对不上返回 null', () => {
    const options = paceOptions([]);
    assert.deepEqual(pickPace(options, [0.1, 0.2, 0.6, 0.1], 0.4), { option: options[2], confidence: 0.6 });
    assert.deepEqual(pickPace(options, [0.4, 0.4, 0.1, 0.1], 0.4), { option: options[0], confidence: 0.4 });
    assert.equal(pickPace(options, [0.3, 0.3, 0.2, 0.2], 0.4), null);
    assert.equal(pickPace(options, [1, 0], 0.4), null);
    assert.equal(pickPace(options, [Number.NaN, 0, 0, 0], 0), null);
  });
});
