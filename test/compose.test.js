import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseWhisper, whisperMessages } from '../src/compose.js';

describe('compose', () => {
  test('去掉引号和句首标签，并配上当前语气的动作', () => {
    const line = parseWhisper('「[happy] 今天的编译过了，可以歇一下。」', 'warm');
    assert.equal(line.text, '今天的编译过了，可以歇一下。');
    assert.equal(line.cue, '[relaxed]');
    assert.equal(line.action, '碎碎念-对屏碎碎念');
    assert.equal(line.kind, 'generated');
  });

  test('太短或太长的结果丢掉', () => {
    assert.equal(parseWhisper('嗯', 'calm'), null);
    assert.equal(parseWhisper('啊'.repeat(81), 'calm'), null);
  });

  test('语气说明仍在系统提示里', () => {
    const messages = whisperMessages({ tone: 'brisk', messages: [], task: '' });
    assert.match(messages[0].content, /confident/);
  });
});
