/**
 * 管理页改 config.json：读出来给页面时把密钥打码，存回去时把没动过的码换回原来的值。
 * 写之前和常驻进程启动时一样检查一遍，写的时候先写临时文件再改名，常驻进程盯着文件，自己换上新的。
 */
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';

import { z } from 'zod';

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
  'app.launchAtLogin',
] as const;

export type SwitchPath = (typeof SWITCHES)[number];

/** 打码的样子。存回来时还是它，就当没改。 */
export const MASK = '••••••';

/** 表单里的一项：怎么校验、写错了说什么。`secret` 的读出来打码，存回来还是码就不改。 */
interface FieldSpec {
  readonly schema: z.ZodType;
  readonly hint: string;
  readonly secret?: true;
}

const trimmed = z.string().trim();

/**
 * 设置页「常用设置」表单里能改的项，和配置文档对得上。只认这里的路径，值的类型按这里的校验，写错回 400 说是哪一项；
 * 别的项（包括密钥以外的整段 JSON）还是在整份配置里改。`llm.tools`、`speech.autoplay` 页面上已经是开关，表单里不重复放。
 */
export const FIELDS = {
  'llm.provider': {
    schema: z.enum(['openai-compatible', 'anthropic']),
    hint: '只能是 openai-compatible 或 anthropic',
  },
  'llm.baseUrl': {
    schema: trimmed.refine((value) => value === '' || /^https?:\/\/\S+$/.test(value)),
    hint: '要以 http:// 或 https:// 开头，或者留空',
  },
  'llm.model': { schema: trimmed, hint: '要是一段文字' },
  'llm.apiKey': { schema: trimmed, hint: '要是一段文字', secret: true },
  'llm.tools': { schema: z.boolean(), hint: '只能是 true 或 false' },
  'speech.apiKey': { schema: trimmed, hint: '要是一段文字', secret: true },
  'speech.model': { schema: trimmed, hint: '要是一段文字' },
  'speech.referenceId': { schema: trimmed, hint: '要是一段文字' },
  'speech.autoplay': { schema: z.boolean(), hint: '只能是 true 或 false' },
  'speech.tone': {
    schema: z.enum(['', 'lively', 'warm', 'calm', 'brisk']),
    hint: '只能是 lively、warm、calm、brisk，或者留空',
  },
  intervalSec: {
    schema: z.number().min(60).max(86_400),
    hint: '要是 60 到 86400 之间的秒数',
  },
  'pace.options': {
    schema: z.array(z.number().int().min(60).max(86_400)).min(2).max(8),
    hint: '要有 2 到 8 档，每档是 60 到 86400 之间的整数秒',
  },
  'pace.recent': { schema: z.number().int().min(0).max(20), hint: '要是 0 到 20 之间的整数' },
} as const satisfies Record<string, FieldSpec>;

export type FieldPath = keyof typeof FIELDS;

/** 表单里的值：文字、开关、数、几档间隔。 */
export type FieldValue = string | boolean | number | number[];

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
  fields: Record<FieldPath, FieldValue>;
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
  const fields = Object.fromEntries(
    (Object.keys(FIELDS) as FieldPath[]).map((path) => {
      const found = valueAt(config, path) ?? '';
      // 解析以后几档间隔是 { id, ms }，表单里要的是秒
      const value = path === 'pace.options' ? (found as { ms: number }[]).map((option) => option.ms / 1000) : found;
      const secret = 'secret' in FIELDS[path];
      return [path, secret && value !== '' ? MASK : value];
    }),
  ) as Record<FieldPath, FieldValue>;
  return { text: `${JSON.stringify(maskSecrets(raw), null, 2)}\n`, version, switches, fields };
}

/** 按「段.键」或单层的键取值。 */
function valueAt(config: object, path: string): unknown {
  const [section = '', key] = path.split('.');
  const top = (config as Record<string, unknown>)[section];
  return key === undefined ? top : (top as Record<string, unknown> | undefined)?.[key];
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

/**
 * 只改表单里的几项：值按 `FIELDS` 校验，别的原样留着。给了 `version` 就先对指纹，免得盖掉别处刚改的。
 * 密钥项交回来还是码的就不改（原来有值）；交回空的是清掉。哪一项错了，错误里说的是路径，不带值。
 */
export function saveFields(file: string, values: Record<string, unknown>, version?: string): Config {
  if (version !== undefined && version !== versionOf(file)) {
    throw new SettingsError('config.json 在别处改过了：刷新一下再改', 409);
  }
  const entries = Object.entries(values);
  if (entries.length === 0) throw new SettingsError('没有要改的项');
  const raw = readRaw(file);
  const problems: string[] = [];
  for (const [path, value] of entries) {
    if (!Object.hasOwn(FIELDS, path)) {
      problems.push(`${path} 不是能在表单里改的项`);
      continue;
    }
    const spec: FieldSpec = FIELDS[path as FieldPath];
    const [section = '', key] = path.split('.');
    const group = key === undefined ? raw : raw[section];
    const current = key === undefined ? raw[section] : isObject(group) ? group[key] : undefined;
    if (spec.secret && value === MASK) {
      if (typeof current !== 'string' || current === '') {
        problems.push(`${path} 还是打码的样子，但原来没有这一项：填上真的值`);
      }
      continue;
    }
    const parsed = spec.schema.safeParse(value);
    if (!parsed.success) {
      problems.push(`${path} ${spec.hint}`);
      continue;
    }
    // 几档间隔去重排序再写；语气留空就是不指定，把这一项拿掉
    let next = parsed.data as Json;
    if (path === 'pace.options') next = [...new Set(next as number[])].toSorted((a, b) => a - b);
    if (key === undefined) raw[section] = next;
    else {
      const rest = { ...(isObject(group) ? group : {}) };
      if (path === 'speech.tone' && next === '') delete rest[key];
      else rest[key] = next;
      raw[section] = rest;
    }
  }
  if (problems.length > 0) throw new SettingsError(problems.join('；'));
  return writeRaw(file, raw);
}
