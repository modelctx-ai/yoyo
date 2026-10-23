import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { localDateKey, needsUmbrella, offWorkWeatherDue, pickUpcoming, placeForTimeZone, weatherReport } from '../src/weather.js';

const fridayEvening = new Date(2026, 9, 23, 17, 40, 0);

describe('weather', () => {
  test('只有工作日傍晚、而且今天还没报过，才查天气', () => {
    assert.equal(offWorkWeatherDue(fridayEvening, null), true);
    assert.equal(offWorkWeatherDue(fridayEvening, '2026-10-23'), false);
    assert.equal(offWorkWeatherDue(new Date(2026, 9, 23, 16, 50), null), false);
    assert.equal(offWorkWeatherDue(new Date(2026, 9, 24, 17, 10), null), false);
    assert.equal(localDateKey(fridayEvening), '2026-10-23');
    assert.equal(placeForTimeZone('Asia/Taipei')?.name, '台北');
    assert.equal(placeForTimeZone('UTC'), null);
  });

  test('预报会念出时间，有雨才提醒带伞', () => {
    const dry = [{ hour: 18, tempC: 21.4, rainPct: 10, code: 2 }];
    assert.match(weatherReport(dry, '上海'), /^快下班啦。上海接下来几个小时，18点左右 21 度，多云。这几小时不用带伞。$/);
    const wet = [
      dry[0],
      { hour: 20, tempC: 19.2, rainPct: 60, code: 61 },
    ];
    assert.match(weatherReport(wet, ''), /出门记得带伞。$/);
    assert.equal(needsUmbrella(dry), false);
    assert.equal(needsUmbrella(wet), true);
  });

  test('从现在起每隔两小时取一档', () => {
    const picked = pickUpcoming(
      ['2026-10-23T16:00', '2026-10-23T17:00', '2026-10-23T18:00', '2026-10-23T19:00', '2026-10-23T20:00', '2026-10-23T21:00'],
      [20, 21, 20, 19, 18, 17],
      [0, 5, 10, 20, 70, 10],
      [1, 2, 3, 3, 61, 2],
      new Date(2026, 9, 23, 17, 10),
    );
    assert.deepEqual(picked.map((item) => item.hour), [17, 19, 21]);
  });
});
