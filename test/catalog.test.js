import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { LINES, bubbleMs, pickLine, toneForHour } from '../src/catalog.js';

describe('catalog', () => {
  test('时段对应四档语气', () => {
    assert.equal(toneForHour(1), 'calm');
    assert.equal(toneForHour(6), 'calm');
    assert.equal(toneForHour(8), 'warm');
    assert.equal(toneForHour(10), 'brisk');
    assert.equal(toneForHour(15), 'lively');
    assert.equal(toneForHour(17), 'warm');
    assert.equal(toneForHour(21), 'warm');
  });

  test('每档至少三句，并且都有动作', () => {
    for (const tone of ['lively', 'warm', 'calm', 'brisk']) {
      const lines = LINES.filter((line) => line.tone === tone);
      assert.equal(lines.length >= 3, true, tone);
      assert.equal(lines.some((line) => line.text.length >= 24), true, `${tone} 缺长句`);
      for (const line of lines) assert.equal(line.action.length > 0, true);
    }
  });

  test('有长句时一半概率只抽长句，短句气泡保持 10 秒', () => {
    const mixed = [
      { text: '短句', tone: 'warm', cue: '[relaxed]', action: '照镜子' },
      { text: '这是一段超过二十四个字的小笑话，用来确认长句会被优先抽到。', tone: 'warm', cue: '[relaxed]', action: '碎碎念-对屏碎碎念' },
    ];
    assert.equal(pickLine(mixed, 'warm', [], 0, () => 0)?.text, mixed[1].text);
    assert.equal(bubbleMs('短句'), 10_000);
    assert.equal(bubbleMs(mixed[1].text) > 10_000, true);
  });

  test('3 小时内不重复；当前语气用完就换语气；全部用完就停', () => {
    const now = 10_000_000;
    const hour = 60 * 60 * 1000;
    const lines = [
      { text: '甲', tone: 'warm', cue: '[relaxed]', action: '照镜子' },
      { text: '乙', tone: 'warm', cue: '[relaxed]', action: '照镜子' },
      { text: '丙', tone: 'calm', cue: '[calm]', action: '碎碎念-发呆碎碎念' },
    ];
    assert.equal(pickLine(lines, 'warm', [{ text: '甲', at: now - hour }], now, () => 0.9)?.text, '乙');
    assert.equal(pickLine(lines, 'warm', [{ text: '甲', at: now - hour }, { text: '乙', at: now - hour }], now, () => 0.9)?.text, '丙');
    assert.equal(
      pickLine(lines, 'warm', lines.map((line) => ({ text: line.text, at: now - hour })), now, () => 0.9),
      undefined,
    );
    assert.equal(pickLine(lines, 'warm', [{ text: '甲', at: now - 4 * hour }], now, () => 0)?.text, '甲');
  });
});
