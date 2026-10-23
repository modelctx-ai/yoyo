import assert from 'node:assert/strict';
import { describe, test } from 'vite-plus/test';

import { TONES } from '../../kernel/tone.ts';
import type { Line } from '../../kernel/types.ts';
import { LINES, REPEAT_WINDOW_MS, pickLine } from './catalog.ts';

/** 依次给出这些随机数，用完以后一直给 0。 */
function sequence(...values: number[]): () => number {
  return () => values.shift() ?? 0;
}

describe('catalog', () => {
  test('每档至少三句，并且都有动作', () => {
    for (const tone of TONES) {
      const lines = LINES.filter((line) => line.tone === tone);
      assert.equal(lines.length >= 3, true, tone);
      assert.equal(
        lines.some((line) => line.text.length >= 24),
        true,
        `${tone} 缺长句`,
      );
      for (const line of lines) assert.equal(line.action.length > 0, true);
    }
  });

  test('预制台词都是 whisper，句首标签带方括号，没有重复的句子', () => {
    assert.equal(LINES.length, 22);
    for (const line of LINES) {
      assert.equal(line.kind, 'whisper', line.text);
      assert.match(line.cue, /^\[[^\]]+\]$/, line.text);
    }
    assert.equal(new Set(LINES.map((line) => line.text)).size, LINES.length);
  });

  test('有长句时一半概率只抽长句', () => {
    const mixed: Line[] = [
      { text: '短句', tone: 'warm', cue: '[relaxed]', action: '照镜子', kind: 'whisper' },
      {
        text: '这是一段超过二十四个字的小笑话，用来确认长句会被优先抽到。',
        tone: 'warm',
        cue: '[relaxed]',
        action: '碎碎念-对屏碎碎念',
        kind: 'whisper',
      },
    ];
    assert.equal(pickLine(mixed, 'warm', [], 0, () => 0)?.text, mixed[1]?.text);
    assert.equal(pickLine(mixed, 'warm', [], 0, sequence(0.7, 0.2))?.text, '短句');
  });

  test('3 小时内不重复；当前语气用完就换语气；全部用完就停', () => {
    const now = 10_000_000;
    const hour = 60 * 60 * 1000;
    const lines: Line[] = [
      { text: '甲', tone: 'warm', cue: '[relaxed]', action: '照镜子', kind: 'whisper' },
      { text: '乙', tone: 'warm', cue: '[relaxed]', action: '照镜子', kind: 'whisper' },
      { text: '丙', tone: 'calm', cue: '[calm]', action: '碎碎念-发呆碎碎念', kind: 'whisper' },
    ];
    assert.equal(pickLine(lines, 'warm', [{ text: '甲', at: now - hour }], now, () => 0.9)?.text, '乙');
    assert.equal(
      pickLine(
        lines,
        'warm',
        [
          { text: '甲', at: now - hour },
          { text: '乙', at: now - hour },
        ],
        now,
        () => 0.9,
      )?.text,
      '丙',
    );
    assert.equal(
      pickLine(
        lines,
        'warm',
        lines.map((line) => ({ text: line.text, at: now - hour })),
        now,
        () => 0.9,
      ),
      undefined,
    );
    assert.equal(pickLine(lines, 'warm', [{ text: '甲', at: now - 4 * hour }], now, () => 0)?.text, '甲');
  });

  test('正好 3 小时前说过的可以再说；空白句子不抽', () => {
    const now = 50_000_000;
    const lines: Line[] = [
      { text: '  ', tone: 'brisk', cue: '[confident]', action: '写代码', kind: 'whisper' },
      { text: '甲', tone: 'brisk', cue: '[confident]', action: '写代码', kind: 'whisper' },
    ];
    assert.equal(REPEAT_WINDOW_MS, 3 * 60 * 60 * 1000);
    assert.equal(pickLine(lines, 'brisk', [{ text: '甲', at: now - REPEAT_WINDOW_MS }], now, () => 0)?.text, '甲');
    assert.equal(
      pickLine(lines, 'brisk', [{ text: '甲', at: now - REPEAT_WINDOW_MS + 1 }], now, () => 0),
      undefined,
    );
  });
});
