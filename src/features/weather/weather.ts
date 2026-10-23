import { localDateKey } from '../../kernel/time.ts';
import { toneForHour } from '../../kernel/tone.ts';
import type { Line, Place, WeatherHour } from '../../kernel/types.ts';
import type { KvRepo } from '../../ports/index.ts';

export const WEATHER_ACTION = '东张西望';
export const WEATHER_CUE = '[relaxed]';

const PLACE_KEY = 'place';
const STAMP_KEY = 'weather-date';

const ZONE_PLACES = new Map<string, Place>([
  ['Asia/Taipei', { name: '台北', latitude: 25.0375, longitude: 121.5637 }],
  ['Asia/Shanghai', { name: '上海', latitude: 31.2304, longitude: 121.4737 }],
  ['Asia/Hong_Kong', { name: '香港', latitude: 22.3193, longitude: 114.1694 }],
  ['Asia/Tokyo', { name: '东京', latitude: 35.6762, longitude: 139.6503 }],
  ['Asia/Singapore', { name: '新加坡', latitude: 1.3521, longitude: 103.8198 }],
]);

export function placeForTimeZone(timeZone: string): Place | null {
  return ZONE_PLACES.get(timeZone) ?? null;
}

/** IP 库查不到时常回这个美国中部点，不能拿来报天气。 */
export function isUnusablePlace(place: Place): boolean {
  return Math.abs(place.latitude - 37.751) < 0.2 && Math.abs(place.longitude + 97.822) < 0.2;
}

/** 工作日 17:00–18:59，并且今天还没报过。 */
export function offWorkWeatherDue(now: Date, lastDate: string | null): boolean {
  const weekday = now.getDay();
  if (weekday === 0 || weekday === 6) return false;
  const hour = now.getHours();
  if (hour < 17 || hour > 18) return false;
  return lastDate !== localDateKey(now);
}

export function weatherPhrase(code: number): string {
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

export function needsUmbrella(hours: readonly WeatherHour[]): boolean {
  return hours.some((hour) => hour.rainPct >= 40 || (hour.code >= 51 && hour.code <= 99));
}

export function weatherReport(hours: readonly WeatherHour[], place: string): string {
  const where = place.trim() || '你这边';
  const bits = hours.slice(0, 3).map((hour) => {
    const rain = hour.rainPct >= 40 ? `，降雨大概 ${Math.round(hour.rainPct)}%` : '';
    return `${hour.hour}点左右 ${Math.round(hour.tempC)} 度，${weatherPhrase(hour.code)}${rain}`;
  });
  const tip = needsUmbrella(hours) ? '出门记得带伞。' : '这几小时不用带伞。';
  return `快下班啦。${where}接下来几个小时，${bits.join('；')}。${tip}`;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 从半小时前起，隔两小时取一档，最多三档。 */
export function pickUpcoming(
  times: readonly string[],
  temps: readonly unknown[],
  rains: readonly unknown[],
  codes: readonly unknown[],
  now: Date,
): WeatherHour[] {
  const rows: WeatherHour[] = [];
  for (let i = 0; i < times.length; i += 1) {
    const at = new Date(times[i] ?? '');
    const tempC = temps[i];
    if (Number.isNaN(at.getTime()) || !finiteNumber(tempC)) continue;
    if (at.getTime() < now.getTime() - 30 * 60 * 1000) continue;
    const rainPct = rains[i];
    const code = codes[i];
    rows.push({
      hour: at.getHours(),
      tempC,
      rainPct: finiteNumber(rainPct) ? rainPct : 0,
      code: finiteNumber(code) ? code : -1,
    });
  }
  return [rows[0], rows[2], rows[4]].filter((row): row is WeatherHour => row !== undefined);
}

/** 接口返回的 JSON 当成普通对象读；不是对象就当空的。 */
function fieldsOf(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function placeFrom(raw: unknown): Place | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = fieldsOf(raw);
  const latitude = Number(data['latitude']);
  const longitude = Number(data['longitude']);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const name = data['name'];
  const place = { name: typeof name === 'string' ? name.trim() : '', latitude, longitude };
  return isUnusablePlace(place) ? null : place;
}

export function readPlace(kv: KvRepo): Place | null {
  const stored = kv.get(PLACE_KEY);
  if (!stored) return null;
  try {
    return placeFrom(JSON.parse(stored));
  } catch {
    return null;
  }
}

export function readWeatherStamp(kv: KvRepo): string | null {
  const date = kv.get(STAMP_KEY);
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

export function writeWeatherStamp(kv: KvRepo, date: string): void {
  kv.set(STAMP_KEY, date);
}

/** 先用存过的地点，再按时区猜，最后问 ipinfo。找到就记下来，下次不再查。 */
export async function ensurePlace(
  kv: KvRepo,
  fetcher: typeof fetch = fetch,
  timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): Promise<Place | null> {
  const saved = readPlace(kv);
  if (saved) return saved;
  const zoned = placeForTimeZone(timeZone);
  if (zoned) {
    kv.set(PLACE_KEY, JSON.stringify(zoned));
    return zoned;
  }
  const response = await fetcher('https://ipinfo.io/json', { signal: AbortSignal.timeout(8000) });
  if (!response.ok) return null;
  const data = fieldsOf(await response.json());
  const [latitude, longitude] = String(data['loc'] ?? '').split(',');
  const place = placeFrom({ name: data['city'], latitude, longitude });
  if (!place) return null;
  kv.set(PLACE_KEY, JSON.stringify(place));
  return place;
}

export async function fetchUpcoming(place: Place, now: Date, fetcher: typeof fetch = fetch): Promise<WeatherHour[]> {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(place.latitude));
  url.searchParams.set('longitude', String(place.longitude));
  url.searchParams.set('hourly', 'temperature_2m,precipitation_probability,weather_code');
  url.searchParams.set('forecast_hours', '8');
  url.searchParams.set('timezone', 'auto');
  const response = await fetcher(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`天气接口 ${response.status}`);
  const hourly = fieldsOf(fieldsOf(await response.json())['hourly']);
  const times = hourly['time'];
  const temps = hourly['temperature_2m'];
  const rains = hourly['precipitation_probability'];
  const codes = hourly['weather_code'];
  if (!Array.isArray(times) || !Array.isArray(temps) || !Array.isArray(codes)) return [];
  return pickUpcoming(times, temps, Array.isArray(rains) ? rains : [], codes, now);
}

/** kind 'weather'，tone 取 toneForHour(now)，cue/action 用天气专用值。 */
export async function buildOffWorkWeather(kv: KvRepo, now: Date, fetcher: typeof fetch = fetch): Promise<Line | null> {
  const place = await ensurePlace(kv, fetcher);
  if (!place) return null;
  const hours = await fetchUpcoming(place, now, fetcher);
  if (hours.length === 0) return null;
  return {
    text: weatherReport(hours, place.name),
    tone: toneForHour(now.getHours()),
    cue: WEATHER_CUE,
    action: WEATHER_ACTION,
    kind: 'weather',
  };
}
