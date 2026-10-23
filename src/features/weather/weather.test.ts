import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { KvRepo } from '../../ports/index.ts';
import {
  WEATHER_ACTION,
  WEATHER_CUE,
  buildOffWorkWeather,
  ensurePlace,
  fetchUpcoming,
  isUnusablePlace,
  needsUmbrella,
  offWorkWeatherDue,
  pickUpcoming,
  placeForTimeZone,
  readPlace,
  readWeatherStamp,
  weatherPhrase,
  weatherReport,
  writeWeatherStamp,
} from './weather.ts';

const fridayEvening = new Date(2026, 9, 23, 17, 40, 0);
const shanghai = { name: '上海', latitude: 31.2304, longitude: 121.4737 };

function memoryKv(initial: Record<string, string> = {}): KvRepo & { readonly data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: (key) => data.get(key) ?? null,
    set: (key, value) => {
      data.set(key, value);
    },
  };
}

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** 假的 fetch：按地址回答，记下每次请求。 */
function fakeFetch(answer: (url: string) => Response): { readonly fetcher: typeof fetch; readonly calls: Call[] } {
  const calls: Call[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    return answer(url);
  };
  return { fetcher, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const forecast = {
  hourly: {
    time: [
      '2026-10-23T16:00',
      '2026-10-23T17:00',
      '2026-10-23T18:00',
      '2026-10-23T19:00',
      '2026-10-23T20:00',
      '2026-10-23T21:00',
    ],
    temperature_2m: [20, 21, 20, 19, 18, 17],
    precipitation_probability: [0, 5, 10, 20, 70, 10],
    weather_code: [1, 2, 3, 3, 61, 2],
  },
};

describe('weather', () => {
  test('只有工作日傍晚、而且今天还没报过，才查天气', () => {
    assert.equal(offWorkWeatherDue(fridayEvening, null), true);
    assert.equal(offWorkWeatherDue(fridayEvening, '2026-10-23'), false);
    assert.equal(offWorkWeatherDue(fridayEvening, '2026-10-22'), true);
    assert.equal(offWorkWeatherDue(new Date(2026, 9, 23, 16, 50), null), false);
    assert.equal(offWorkWeatherDue(new Date(2026, 9, 23, 18, 59), null), true);
    assert.equal(offWorkWeatherDue(new Date(2026, 9, 23, 19, 0), null), false);
    assert.equal(offWorkWeatherDue(new Date(2026, 9, 24, 17, 10), null), false);
    assert.equal(placeForTimeZone('Asia/Taipei')?.name, '台北');
    assert.equal(placeForTimeZone('UTC'), null);
    assert.equal(placeForTimeZone('constructor'), null);
  });

  test('预报会念出时间，有雨才提醒带伞', () => {
    const dry = [{ hour: 18, tempC: 21.4, rainPct: 10, code: 2 }];
    assert.match(
      weatherReport(dry, '上海'),
      /^快下班啦。上海接下来几个小时，18点左右 21 度，多云。这几小时不用带伞。$/,
    );
    const wet = [...dry, { hour: 20, tempC: 19.2, rainPct: 60, code: 61 }];
    assert.match(weatherReport(wet, ''), /出门记得带伞。$/);
    assert.match(weatherReport(wet, ' '), /^快下班啦。你这边接下来几个小时，.*20点左右 19 度，下雨，降雨大概 60%。/);
    assert.equal(needsUmbrella(dry), false);
    assert.equal(needsUmbrella(wet), true);
    assert.equal(needsUmbrella([{ hour: 18, tempC: 20, rainPct: 0, code: 95 }]), true);
  });

  test('天气代码换成说法', () => {
    assert.deepEqual([0, 2, 45, 53, 63, 75, 81, 85, 90, 95].map(weatherPhrase), [
      '晴',
      '多云',
      '有雾',
      '毛毛雨',
      '下雨',
      '下雪',
      '阵雨',
      '阵雪',
      '天气多变',
      '雷雨',
    ]);
  });

  test('从现在起每隔两小时取一档', () => {
    const picked = pickUpcoming(
      forecast.hourly.time,
      forecast.hourly.temperature_2m,
      forecast.hourly.precipitation_probability,
      forecast.hourly.weather_code,
      new Date(2026, 9, 23, 17, 10),
    );
    assert.deepEqual(
      picked.map((item) => item.hour),
      [17, 19, 21],
    );
    assert.deepEqual(picked[0], { hour: 17, tempC: 21, rainPct: 5, code: 2 });
  });

  test('读不懂的温度跳过，缺降雨和天气代码时给缺省值', () => {
    const picked = pickUpcoming(
      ['2026-10-23T17:00', 'bad', '2026-10-23T18:00'],
      [null, 20, 19],
      [],
      ['x'],
      new Date(2026, 9, 23, 17, 0),
    );
    assert.deepEqual(picked, [{ hour: 18, tempC: 19, rainPct: 0, code: -1 }]);
  });

  test('地点和播报日期存在 kv 里', () => {
    const kv = memoryKv({ place: JSON.stringify({ name: ' 上海 ', latitude: '31.2304', longitude: 121.4737 }) });
    assert.deepEqual(readPlace(kv), shanghai);
    assert.equal(readPlace(memoryKv()), null);
    assert.equal(readPlace(memoryKv({ place: '{不是 JSON' })), null);
    assert.equal(readPlace(memoryKv({ place: JSON.stringify({ name: '某地', latitude: 'x', longitude: 1 }) })), null);
    const middle = { name: '', latitude: 37.751, longitude: -97.822 };
    assert.equal(isUnusablePlace(middle), true);
    assert.equal(readPlace(memoryKv({ place: JSON.stringify(middle) })), null);

    const stamps = memoryKv();
    assert.equal(readWeatherStamp(stamps), null);
    writeWeatherStamp(stamps, '2026-10-23');
    assert.equal(stamps.data.get('weather-date'), '2026-10-23');
    assert.equal(readWeatherStamp(stamps), '2026-10-23');
    assert.equal(readWeatherStamp(memoryKv({ 'weather-date': '昨天' })), null);
  });

  test('ensurePlace 先用存过的，再按时区猜，最后问 ipinfo', async () => {
    const never = fakeFetch(() => {
      throw new Error('不该联网');
    });
    const saved = memoryKv({ place: JSON.stringify(shanghai) });
    assert.deepEqual(await ensurePlace(saved, never.fetcher, 'UTC'), shanghai);

    const zoned = memoryKv();
    const taipei = await ensurePlace(zoned, never.fetcher, 'Asia/Taipei');
    assert.equal(taipei?.name, '台北');
    assert.deepEqual(JSON.parse(zoned.data.get('place') ?? 'null'), taipei);
    assert.equal(never.calls.length, 0);

    const asked = memoryKv({ place: JSON.stringify({ name: '', latitude: 37.751, longitude: -97.822 }) });
    const ipinfo = fakeFetch(() => json({ city: ' Berlin ', loc: '52.5200,13.4050' }));
    const berlin = await ensurePlace(asked, ipinfo.fetcher, 'Europe/Berlin');
    assert.deepEqual(berlin, { name: 'Berlin', latitude: 52.52, longitude: 13.405 });
    assert.deepEqual(JSON.parse(asked.data.get('place') ?? 'null'), berlin);
    assert.equal(ipinfo.calls.length, 1);
    assert.equal(ipinfo.calls[0]?.url, 'https://ipinfo.io/json');
    assert.ok(ipinfo.calls[0]?.init?.signal instanceof AbortSignal);
  });

  test('ipinfo 查不到或给的是美国中部默认点，就不报天气，也不记地点', async () => {
    for (const response of [
      json({}, 500),
      json({ city: 'Somewhere', loc: '37.751,-97.822' }),
      json({ city: 'Nowhere' }),
      json(null),
    ]) {
      const kv = memoryKv();
      assert.equal(await ensurePlace(kv, fakeFetch(() => response).fetcher, 'UTC'), null);
      assert.equal(kv.data.has('place'), false);
    }
  });

  test('fetchUpcoming 照旧请求 open-meteo', async () => {
    const api = fakeFetch(() => json(forecast));
    const hours = await fetchUpcoming(shanghai, new Date(2026, 9, 23, 17, 10), api.fetcher);
    assert.deepEqual(
      hours.map((item) => item.hour),
      [17, 19, 21],
    );
    const url = new URL(api.calls[0]?.url ?? '');
    assert.equal(`${url.origin}${url.pathname}`, 'https://api.open-meteo.com/v1/forecast');
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      latitude: '31.2304',
      longitude: '121.4737',
      hourly: 'temperature_2m,precipitation_probability,weather_code',
      forecast_hours: '8',
      timezone: 'auto',
    });
    assert.ok(api.calls[0]?.init?.signal instanceof AbortSignal);

    await assert.rejects(fetchUpcoming(shanghai, fridayEvening, fakeFetch(() => json({}, 503)).fetcher), {
      message: '天气接口 503',
    });
    assert.deepEqual(await fetchUpcoming(shanghai, fridayEvening, fakeFetch(() => json({ hourly: {} })).fetcher), []);
  });

  test('buildOffWorkWeather 给出一句天气台词', async () => {
    const kv = memoryKv({ place: JSON.stringify(shanghai) });
    const line = await buildOffWorkWeather(kv, new Date(2026, 9, 23, 17, 10), fakeFetch(() => json(forecast)).fetcher);
    assert.deepEqual(line, {
      text: '快下班啦。上海接下来几个小时，17点左右 21 度，多云；19点左右 19 度，多云；21点左右 17 度，多云。这几小时不用带伞。',
      tone: 'warm',
      cue: WEATHER_CUE,
      action: WEATHER_ACTION,
      kind: 'weather',
    });
    assert.equal(WEATHER_CUE, '[relaxed]');
    assert.equal(WEATHER_ACTION, '东张西望');

    const empty = await buildOffWorkWeather(kv, fridayEvening, fakeFetch(() => json({ hourly: {} })).fetcher);
    assert.equal(empty, null);
  });
});
