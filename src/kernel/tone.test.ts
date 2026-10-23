import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { TONE_ACTION, TONE_CUES, TONES, toneForHour } from './tone.ts';

describe('tone', () => {
  test('时段对应四档语气', () => {
    assert.equal(toneForHour(1), 'calm');
    assert.equal(toneForHour(6), 'calm');
    assert.equal(toneForHour(8), 'warm');
    assert.equal(toneForHour(10), 'brisk');
    assert.equal(toneForHour(15), 'lively');
    assert.equal(toneForHour(17), 'warm');
    assert.equal(toneForHour(21), 'warm');
  });

  test('一天 24 个钟点的分档和旧代码一致', () => {
    const expected = [
      ...Array<string>(7).fill('calm'),
      ...Array<string>(2).fill('warm'),
      ...Array<string>(4).fill('brisk'),
      ...Array<string>(4).fill('lively'),
      ...Array<string>(6).fill('warm'),
      'calm',
    ];
    assert.deepEqual(
      Array.from({ length: 24 }, (_, hour) => toneForHour(hour)),
      expected,
    );
    assert.equal(toneForHour(Number.NaN), 'calm');
  });

  test('每档语气都有情绪标签和动作', () => {
    assert.deepEqual([...TONES].sort(), ['brisk', 'calm', 'lively', 'warm']);
    assert.deepEqual(TONE_CUES, { lively: '[happy]', warm: '[relaxed]', calm: '[calm]', brisk: '[confident]' });
    assert.deepEqual(TONE_ACTION, {
      lively: '碎碎念-对屏碎碎念',
      warm: '碎碎念-对屏碎碎念',
      calm: '碎碎念-发呆碎碎念',
      brisk: '写代码',
    });
  });
});
