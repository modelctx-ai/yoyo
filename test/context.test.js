import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { channelMessages } from '../src/channel.js';
import { mergePetChat, toMessages } from '../src/context.js';
import { replyMessages, whisperMessages } from '../src/compose.js';

describe('context', () => {
  test('连续碎碎念合成一条，对话原句不截断', () => {
    const messages = toMessages([
      { role: 'whisper', text: '在呢' },
      { role: 'whisper', text: '水记得喝一口哦' },
      { role: 'user', text: '今天海淀的天气要说完整，不要砍掉后半句' },
      { role: 'assistant', text: '傍晚会下雨，出门带伞。' },
    ]);
    assert.equal(messages[0].content, '碎碎念：\n在呢\n水记得喝一口哦');
    assert.equal(messages[1].content, '今天海淀的天气要说完整，不要砍掉后半句');
    assert.equal(messages[2].role, 'assistant');
  });

  test('桌宠对话并进来，同一条不重复，旧句还在', () => {
    const first = mergePetChat([], [{ role: 'user', content: '在吗', ts: 1 }]);
    const second = mergePetChat(first, [
      { role: 'user', content: '在吗', ts: 1 },
      { role: 'assistant', content: '在的', ts: 2 },
    ]);
    assert.equal(second.length, 2);
    assert.equal(second[0].text, '在吗');
    assert.equal(second[1].text, '在的');
  });

  test('桌宠发来的截断历史会被换成全文，当前这句还在', () => {
    const context = toMessages([
      { role: 'whisper', text: '先把这一小步做完' },
      { role: 'user', text: '昨天说过要带伞' },
      { role: 'assistant', text: '带了' },
    ]);
    const outgoing = channelMessages(
      [
        { role: 'system', content: '你是女仆' },
        { role: 'user', content: '只剩最近一轮' },
        { role: 'assistant', content: '旧回复' },
        { role: 'user', content: '今天呢' },
      ],
      context,
    );
    assert.equal(outgoing[0].content, '你是女仆');
    assert.match(outgoing[1].content, /先把这一小步做完/);
    assert.equal(outgoing.at(-1).content, '今天呢');
    assert.equal(outgoing.some((message) => message.content === '只剩最近一轮'), false);
  });

  test('生成时把聚合后的上下文整段带上', () => {
    const messages = toMessages([
      { role: 'whisper', text: '先把这一小步做完' },
      { role: 'user', text: '看一下测试' },
      { role: 'assistant', text: '好' },
    ]);
    const whisper = whisperMessages({ tone: 'brisk', messages, task: '修天气地点' });
    assert.match(whisper[1].content, /先把这一小步做完/);
    assert.equal(whisper[2].content, '看一下测试');
    assert.match(whisper.at(-1).content, /修天气地点/);
    const reply = replyMessages({ tone: 'warm', messages, searchText: '' });
    assert.equal(reply.filter((item) => item.role !== 'system').length, messages.length);
  });
});
