import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { cleanTranscript } from '../src/asr.js';
import { listenSeconds, wantsReply } from '../src/listen.js';
import { shouldSearch } from '../src/search.js';
import { foreignLine, speechAutoplay } from '../src/speech.js';

describe('listen and search', () => {
  test('开关关掉或天气播报时不听', () => {
    assert.equal(wantsReply({ kind: 'weather', text: '快下班啦' }, { enabled: true }), false);
    assert.equal(wantsReply({ text: '主人，我在这儿呢' }, { enabled: false }), false);
    assert.equal(wantsReply({ text: '主人，我在这儿呢', kind: 'generated' }, { enabled: true }), true);
    assert.equal(wantsReply({ text: '喝水', kind: 'reminder' }, { enabled: true }), false);
    assert.equal(listenSeconds({ seconds: 5 }), 5);
    assert.equal(listenSeconds({ seconds: 99 }), 10);
  });

  test('静音幻觉不当成主人说的话', () => {
    assert.equal(cleanTranscript('你'), '');
    assert.equal(cleanTranscript('谢谢观看'), '');
    assert.equal(cleanTranscript('今天海淀下雨吗'), '今天海淀下雨吗');
  });

  test('右键对话的新回复才朗读，自己刚投喂的不重复念', () => {
    assert.equal(speechAutoplay({}), true);
    assert.equal(speechAutoplay({ autoplay: false }), false);
    const state = { pets: { main: { say: { counter: 4, data: { text: '在的' } } } } };
    assert.equal(foreignLine(state, 'main', new Set()).text, '在的');
    assert.equal(foreignLine(state, 'main', new Set(['在的'])), null);
  });

  test('提问才去搜', () => {
    assert.equal(shouldSearch('今天海淀天气怎么样'), true);
    assert.equal(shouldSearch('嗯我听到了'), false);
  });
});
