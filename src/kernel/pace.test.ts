import assert from 'node:assert/strict';
import { describe, test } from 'vite-plus/test';

import { TALK_GAP_MS, nextWhisperAt } from './pace.ts';

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
