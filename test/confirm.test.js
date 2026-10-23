import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { reduceConfirm } from '../src/confirm.js';
import { chatSettingsBody } from '../src/pet.js';

const start = { text: '今天海淀下雨吗', held: false, done: false, deadline: 3_000 };

describe('confirm', () => {
  test('没人动，到点就用原文发送', () => {
    const sent = reduceConfirm(start, { type: 'tick', now: 3_000 });
    assert.equal(sent.action, 'send');
    assert.equal(sent.text, '今天海淀下雨吗');
  });

  test('任何介入只停下自动发送', () => {
    const held = reduceConfirm(start, { type: 'intervene' });
    assert.equal(held.held, true);
    assert.equal(held.done, false);
    const still = reduceConfirm(held, { type: 'tick', now: 9_000 });
    assert.equal(still.done, false);
  });

  test('介入之后要用户自己发送，可以改字', () => {
    const held = reduceConfirm(start, { type: 'intervene' });
    const sent = reduceConfirm(held, { type: 'send', text: '海淀现在下雨吗' });
    assert.equal(sent.text, '海淀现在下雨吗');
  });

  test('对话渠道只打开桌宠对话，不打开它自己的周期碎碎念', () => {
    const body = chatSettingsBody({ baseUrl: 'https://example.test/v1/', model: 'demo', apiKey: 'secret' });
    assert.equal(body.baseUrl, 'https://example.test/v1');
    assert.equal(body.enabled, true);
    assert.equal(body.automaticWhispers, false);
  });

  test('取消就不再发送', () => {
    assert.equal(reduceConfirm(start, { type: 'cancel' }).action, 'cancel');
  });
});
