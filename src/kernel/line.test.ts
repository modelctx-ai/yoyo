import assert from 'node:assert/strict';
import { describe, test } from 'vite-plus/test';

import { activityLabel, bubbleMs, contextRoleOf } from './line.ts';
import type { Line, LineKind } from './types.ts';

function line(kind: LineKind): Line {
  return { text: '在呢', tone: 'calm', cue: '[calm]', action: '待机呼吸休闲', kind };
}

describe('line', () => {
  test('短句气泡保持 10 秒，长句按字数加长，最多 40 秒', () => {
    assert.equal(bubbleMs('短句'), 10_000);
    assert.equal(bubbleMs('一'.repeat(20)), 10_000);
    assert.equal(bubbleMs('一'.repeat(21)), 8_000 + 21 * 180);
    assert.equal(bubbleMs('一'.repeat(500)), 40_000);
  });

  test('行为记录的类型和旧代码一致', () => {
    assert.equal(activityLabel(line('whisper')), 'calm');
    assert.equal(activityLabel({ ...line('whisper'), tone: 'lively' }), 'lively');
    assert.equal(activityLabel(line('generated')), 'reply');
    assert.equal(activityLabel(line('reply')), 'reply');
    assert.equal(activityLabel(line('weather')), 'weather');
    assert.equal(activityLabel(line('reminder')), 'reminder');
  });

  test('回复、提醒、天气记成助手消息，碎碎念记成碎碎念事件', () => {
    assert.equal(contextRoleOf(line('reply')), 'assistant');
    assert.equal(contextRoleOf(line('reminder')), 'assistant');
    assert.equal(contextRoleOf(line('weather')), 'assistant');
    assert.equal(contextRoleOf(line('whisper')), 'whisper');
    assert.equal(contextRoleOf(line('generated')), 'whisper');
  });
});
