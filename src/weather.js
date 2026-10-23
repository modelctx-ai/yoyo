import { getKv, setKv } from './db.js';

export const WEATHER_ACTION = '东张西望';
export const WEATHER_CUE = '[relaxed]';

const ZONE_PLACES = {
  'Asia/Taipei': { name: '台北', latitude: 25.0375, longitude: 121.5637 },
  'Asia/Shanghai': { name: '上海', latitude: 31.2304, longitude: 121.4737 },
  'Asia/Hong_Kong': { name: '香港', latitude: 22.3193, longitude: 114.1694 },
  'Asia/Tokyo': { name: '东京', latitude: 35.6762, longitude: 139.6503 },
  'Asia/Singapore': { name: '新加坡', latitude: 1.3521, longitude: 103.8198 },
};

export function placeForTimeZone(timeZone) {
  return ZONE_PLACES[timeZone] ?? null;
}

/** IP 库查不到时常回这个美国中部点，不能拿来报天气。 */
export function isUnusablePlace(place) {
  return Math.abs(place.latitude - 37.751) < 0.2 && Math.abs(place.longitude + 97.822) < 0.2;
}

export function localDateKey(now) {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** 工作日 17:00–18:59，并且今天还没报过。 */
export function offWorkWeatherDue(now, lastDate) {
  const weekday = now.getDay();
  if (weekday === 0 || weekday === 6) return false;
  const hour = now.getHours();
  if (hour < 17 || hour > 18) return false;
  return lastDate !== localDateKey(now);
}

export function weatherPhrase(code) {
  if (code === 0) return '晴';
  if (code <= 3) return '多云';
  if (code <= 48) return '有雾';
  if (code <= 57) return '毛毛雨';
  if (code <= 67) return '下雨';
  if (code <= 77) return '下雪';
  if (code <= 82) return '阵雨';
  if (code <= 86) return '阵雪';
  if (code >= 95) return '雷雨';
  return '天气多变';
}

export function needsUmbrella(hours) {
  return hours.some((hour) => hour.rainPct >= 40 || (hour.code >= 51 && hour.code <= 99));
}

export function weatherReport(hours, place) {
  const where = place.trim() || '你这边';
  const bits = hours.slice(0, 3).map((hour) => {
    const rain = hour.rainPct >= 40 ? `，降雨大概 ${Math.round(hour.rainPct)}%` : '';
    return `${hour.hour}点左右 ${Math.round(hour.tempC)} 度，${weatherPhrase(hour.code)}${rain}`;
  });
  const tip = needsUmbrella(hours) ? '出门记得带伞。' : '这几小时不用带伞。';
  return `快下班啦。${where}接下来几个小时，${bits.join('；')}。${tip}`;
}

export function pickUpcoming(times, temps, rains, codes, now) {
  const rows = [];
  for (let i = 0; i < times.length; i += 1) {
    const at = new Date(times[i] ?? '');
    const tempC = temps[i];
    if (Number.isNaN(at.getTime()) || typeof tempC !== 'number' || !Number.isFinite(tempC)) continue;
    if (at.getTime() < now.getTime() - 30 * 60 * 1000) continue;
    rows.push({
      hour: at.getHours(),
      tempC,
      rainPct: typeof rains[i] === 'number' && Number.isFinite(rains[i]) ? rains[i] : 0,
      code: typeof codes[i] === 'number' && Number.isFinite(codes[i]) ? codes[i] : -1,
    });
  }
  return [rows[0], rows[2], rows[4]].filter((row) => row !== undefined);
}

export function readPlace(dataDir) {
  const stored = getKv(dataDir, 'place');
  if (!stored) return null;
  try {
    return placeFrom(JSON.parse(stored));
  } catch {
    return null;
  }
}

function placeFrom(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const latitude = Number(raw.latitude);
  const longitude = Number(raw.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const place = { name: typeof raw.name === 'string' ? raw.name.trim() : '', latitude, longitude };
  return isUnusablePlace(place) ? null : place;
}

export function readWeatherStamp(dataDir) {
  const date = getKv(dataDir, 'weather-date');
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

export function writeWeatherStamp(dataDir, date) {
  setKv(dataDir, 'weather-date', date);
}

export async function ensurePlace(dataDir, fetcher = fetch) {
  const saved = readPlace(dataDir);
  if (saved) return saved;
  const zoned = placeForTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  if (zoned) {
    setKv(dataDir, 'place', JSON.stringify(zoned));
    return zoned;
  }
  const response = await fetcher('https://ipinfo.io/json', { signal: AbortSignal.timeout(8000) });
  if (!response.ok) return null;
  const data = await response.json();
  const [lat, lon] = String(data.loc ?? '').split(',');
  const place = {
    name: typeof data.city === 'string' ? data.city.trim() : '',
    latitude: Number(lat),
    longitude: Number(lon),
  };
  if (!Number.isFinite(place.latitude) || !Number.isFinite(place.longitude) || isUnusablePlace(place)) return null;
  setKv(dataDir, 'place', JSON.stringify(place));
  return place;
}

export async function fetchUpcoming(place, now, fetcher = fetch) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(place.latitude));
  url.searchParams.set('longitude', String(place.longitude));
  url.searchParams.set('hourly', 'temperature_2m,precipitation_probability,weather_code');
  url.searchParams.set('forecast_hours', '8');
  url.searchParams.set('timezone', 'auto');
  const response = await fetcher(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`天气接口 ${response.status}`);
  const data = await response.json();
  const hourly = data.hourly;
  if (!hourly?.time || !hourly.temperature_2m || !hourly.weather_code) return [];
  return pickUpcoming(hourly.time, hourly.temperature_2m, hourly.precipitation_probability ?? [], hourly.weather_code, now);
}

export async function buildOffWorkWeather(dataDir, now, fetcher = fetch) {
  const place = await ensurePlace(dataDir, fetcher);
  if (!place) return null;
  const hours = await fetchUpcoming(place, now, fetcher);
  if (hours.length === 0) return null;
  return {
    text: weatherReport(hours, place.name),
    cue: WEATHER_CUE,
    action: WEATHER_ACTION,
    kind: 'weather',
  };
}
