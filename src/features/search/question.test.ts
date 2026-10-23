import assert from 'node:assert/strict';
import { describe, test } from 'vite-plus/test';

import { shouldSearch } from './question.ts';

describe('question', () => {
  test('提问才去搜', () => {
    assert.equal(shouldSearch('今天海淀天气怎么样'), true);
    assert.equal(shouldSearch('嗯我听到了'), false);
  });

  test('问号、疑问词和要查事实的说法都算提问', () => {
    for (const text of ['在吗？', 'ok?', '谁赢了', '最新的消息', '帮我看一下这个', '查一下明天的会', '有多少人']) {
      assert.equal(shouldSearch(text), true, text);
    }
    for (const text of ['好的', '谢谢你', '']) {
      assert.equal(shouldSearch(text), false, text);
    }
  });
});
