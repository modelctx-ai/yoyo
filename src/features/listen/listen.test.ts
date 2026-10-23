import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { Line, LineKind } from '../../kernel/types.ts';
import { listenSeconds, wantsReply } from './listen.ts';

function line(text: string, kind: LineKind): Line {
  return { text, tone: 'lively', cue: '[happy]', action: '碎碎念-对屏碎碎念', kind };
}

describe('listen', () => {
  test('开关关掉或天气播报时不听', () => {
    assert.equal(wantsReply(line('快下班啦', 'weather'), { enabled: true }), false);
    assert.equal(wantsReply(line('主人，我在这儿呢', 'whisper'), { enabled: false }), false);
    assert.equal(wantsReply(line('主人，我在这儿呢', 'generated'), { enabled: true }), true);
    assert.equal(wantsReply(line('主人，我在这儿呢', 'whisper'), { enabled: true }), true);
    assert.equal(wantsReply(line('喝水', 'reminder'), { enabled: true }), false);
    assert.equal(wantsReply(null, { enabled: true }), false);
    assert.equal(wantsReply(undefined, { enabled: true }), false);
    assert.equal(listenSeconds({ seconds: 5 }), 5);
    assert.equal(listenSeconds({ seconds: 99 }), 10);
  });

  test('听的秒数取整，限在 1 到 10 秒，读不懂就 5 秒', () => {
    assert.equal(listenSeconds({ seconds: 0 }), 1);
    assert.equal(listenSeconds({ seconds: -3 }), 1);
    assert.equal(listenSeconds({ seconds: 3.6 }), 4);
    assert.equal(listenSeconds({ seconds: Number.NaN }), 5);
    assert.equal(listenSeconds({ seconds: Number.POSITIVE_INFINITY }), 5);
  });
});
