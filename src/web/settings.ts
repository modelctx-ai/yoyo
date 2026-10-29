/**
 * 管理页改 config.json：读出来给页面时把密钥打码，存回去时把没动过的码换回原来的值。
 * 写之前和常驻进程启动时一样检查一遍，写的时候先写临时文件再改名，常驻进程盯着文件，自己换上新的。
 */
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';

import { assertDirectorReady, parseConfig, type Config } from '../app/config.ts';
import { errorText } from '../app/log.ts';

/** 页面上直接点的开关，和配置文档「开关」一节一致。`web.enabled` 不在这里：关掉它管理页就没了，要改去整份配置里改。 */
export const SWITCHES = [
  'listen.enabled',
  'speech.autoplay',
  'sfx.enabled',
  'weather.enabled',
  'memes.enabled',
  'clipboard.enabled',
  'hotkey.enabled',
  'llm.tools',
  'memory.enabled',
  'sandbox.enabled',
] as const;

export type SwitchPath = (typeof SWITCHES)[number];

/** 打码的样子。存回来时还是它，就当没改。 */
export const MASK = '••••••';

/** 名字像密钥的键：apiKey、token、secret、password、Authorization 之类，MCP 服务器的 env 和 headers 里的也算。 */
const SECRET_KEY = /api[-_]?key|token|secret|password|passwd|authorization|cookie|credential/i;

/** 认不出、不好改的：回一句话给页面。409 是文件在别处改过了。 */
export class SettingsError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** 文件内容的指纹：页面存整份时带回来，对不上就是在别处改过了。 */
function versionOf(file: string): string {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isObject(value: unknown): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 把名字像密钥、值是非空字符串的都换成码。 */
export function maskSecrets(value: Json): Json {
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) && typeof item === 'string' && item !== '' ? MASK : maskSecrets(item),
    ]),
  );
}

/** 页面交回来的里还是码的，换回原来同一位置的值；原来那里没有就报错，免得把码当成密钥存进去。 */
export function unmaskSecrets(value: Json, original: Json, path = ''): Json {
  if (value === MASK) {
    if (typeof original !== 'string' || original === '') {
      throw new SettingsError(`${path || '（根）'} 还是打码的样子，但原来没有这一项：填上真的值`);
    }
    return original;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      unmaskSecrets(item, Array.isArray(original) ? (original[index] ?? null) : null, `${path}[${index}]`),
    );
  }
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      unmaskSecrets(item, isObject(original) ? (original[key] ?? null) : null, path ? `${path}.${key}` : key),
    ]),
  );
}

/** 读 config.json 原文。不是对象也算读不了：常驻进程不会用这样的配置。 */
export function readRaw(file: string): Record<string, Json> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new SettingsError(`config.json 现在读不了，先在编辑器里修好：${errorText(error)}`);
  }
  if (!isObject(raw)) throw new SettingsError('config.json 现在不是一个对象，先在编辑器里修好');
  return raw;
}

/** 检查一遍再写：和常驻进程启动时同样的检查。先写临时文件再改名，权限照旧（缺省只给自己读写）。 */
export function writeRaw(file: string, raw: Record<string, Json>): Config {
  let config: Config;
  try {
    config = parseConfig(raw);
    assertDirectorReady(config);
  } catch (error) {
    throw new SettingsError(errorText(error));
  }
  let mode = 0o600;
  try {
    mode = statSync(file).mode & 0o777;
  } catch {
    /* 文件没了就按缺省 */
  }
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(raw, null, 2)}\n`, { mode });
  renameSync(temp, file);
  return config;
}

/** 页面上看到的：打过码的整份原文，和各个开关现在的值（按缺省值补齐以后）。 */
export function readSettings(file: string): {
  text: string;
  version: string;
  switches: Record<SwitchPath, boolean>;
} {
  const version = versionOf(file);
  const raw = readRaw(file);
  const config = parseConfig(raw) as unknown as Record<string, Record<string, unknown>>;
  const switches = Object.fromEntries(
    SWITCHES.map((path) => {
      const [section = '', key = ''] = path.split('.');
      return [path, config[section]?.[key] === true];
    }),
  ) as Record<SwitchPath, boolean>;
  return { text: `${JSON.stringify(maskSecrets(raw), null, 2)}\n`, version, switches };
}

/** 存整份：页面交回来的文字。给了 `version` 就先对一下，免得盖掉别处（开关、编辑器）刚改的。 */
export function saveText(file: string, text: string, version?: string): Config {
  if (version !== undefined && version !== versionOf(file)) {
    throw new SettingsError('config.json 在别处改过了：刷新一下再改', 409);
  }
  let next: unknown;
  try {
    next = JSON.parse(text);
  } catch (error) {
    throw new SettingsError(`不是合法的 JSON：${errorText(error)}`);
  }
  if (!isObject(next)) throw new SettingsError('整份配置要是一个对象');
  return writeRaw(file, unmaskSecrets(next, readRaw(file)) as Record<string, Json>);
}

/** 只改开关：别的原样留着。 */
export function saveSwitches(file: string, values: Record<string, unknown>): Config {
  const raw = readRaw(file);
  for (const [path, value] of Object.entries(values)) {
    if (!(SWITCHES as readonly string[]).includes(path)) throw new SettingsError(`${path} 不是能直接点的开关`);
    if (typeof value !== 'boolean') throw new SettingsError(`${path} 只能是 true 或 false`);
    const [section = '', key = ''] = path.split('.');
    const current = raw[section];
    raw[section] = { ...(isObject(current) ? current : {}), [key]: value };
  }
  return writeRaw(file, raw);
}
