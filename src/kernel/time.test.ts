import assert from 'node:assert/strict';
import { describe, test } from 'vite-plus/test';

import { localDateKey, minutesOf } from './time.ts';

describe('time', () => {
  test('本地日期补零', () => {
    assert.equal(localDateKey(new Date(2026, 9, 23, 17, 40, 0)), '2026-10-23');
    assert.equal(localDateKey(new Date(2026, 0, 5, 0, 0, 0)), '2026-01-05');
    assert.equal(localDateKey(new Date(2026, 11, 31, 23, 59, 59)), '2026-12-31');
  });

  test('HH:MM 换成当天的第几分钟，写错返回 null', () => {
    assert.equal(minutesOf('15:30'), 930);
    assert.equal(minutesOf('7:05'), 425);
    assert.equal(minutesOf('00:00'), 0);
    assert.equal(minutesOf('23:59'), 1439);
    assert.equal(minutesOf('24:00'), null);
    assert.equal(minutesOf('12:60'), null);
    assert.equal(minutesOf('1230'), null);
    assert.equal(minutesOf(' 12:30'), null);
    assert.equal(minutesOf(''), null);
    assert.equal(minutesOf(null), null);
    assert.equal(minutesOf(undefined), null);
  });
});
