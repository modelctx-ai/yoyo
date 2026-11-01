/**
 * 管理页改 config.json：读出来给页面时把密钥打码，存回去时把没动过的码换回原来的值。
 * 开关和表单都经 `app/settings.ts` 的 `editSettings`，和命令行、模型改配置是同一套校验和写法；常驻进程盯着文件，自己换上新的。
 */
import { parseConfig, type Config } from '../app/config.ts';
import { errorText } from '../app/log.ts';
import {
  MASK,
  SETTINGS,
  SettingsError,
  editSettings,
  isObject,
  maskSecrets,
  readRaw,
  settingAt,
  unmaskSecrets,
  versionOf,
  writeRaw,
  type EditResult,
  type Json,
  type SettingPath,
} from '../app/settings.ts';

export { MASK, SettingsError, maskSecrets, unmaskSecrets };

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
] as const satisfies readonly SettingPath[];

export type SwitchPath = (typeof SWITCHES)[number];

/**
 * 设置页「常用设置」表单里的项，和配置文档对得上；怎么校验在配置项表里。别的项还是在整份配置里改。
 * `llm.tools`、`speech.autoplay` 页面上已经是开关，表单里不重复放。
 */
export const FIELDS = [
  'llm.provider',
  'llm.baseUrl',
  'llm.model',
  'llm.apiKey',
  'llm.tools',
  'speech.apiKey',
  'speech.model',
  'speech.referenceId',
  'speech.autoplay',
  'speech.tone',
  'intervalSec',
  'pace.options',
  'pace.recent',
] as const satisfies readonly SettingPath[];

export type FieldPath = (typeof FIELDS)[number];

/** 表单里的值：文字、开关、数、几档间隔。 */
export type FieldValue = string | boolean | number | number[];

/** 页面上看到的：打过码的整份原文，和各个开关、表单项现在的值（按缺省值补齐以后）。 */
export function readSettings(file: string): {
  text: string;
  version: string;
  switches: Record<SwitchPath, boolean>;
  fields: Record<FieldPath, FieldValue>;
} {
  const version = versionOf(file);
  const raw = readRaw(file);
  const config = parseConfig(raw);
  const switches = Object.fromEntries(SWITCHES.map((path) => [path, settingAt(config, path) === true])) as Record<
    SwitchPath,
    boolean
  >;
  const fields = Object.fromEntries(
    FIELDS.map((path) => {
      const value = settingAt(config, path) ?? '';
      return [path, 'secret' in SETTINGS[path] && value !== '' ? MASK : value];
    }),
  ) as Record<FieldPath, FieldValue>;
  return { text: `${JSON.stringify(maskSecrets(raw), null, 2)}\n`, version, switches, fields };
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

/** 只改开关：只认开关表里的，别的原样留着。 */
export function saveSwitches(file: string, values: Record<string, unknown>): EditResult {
  for (const path of Object.keys(values)) {
    if (!(SWITCHES as readonly string[]).includes(path)) throw new SettingsError(`${path} 不是能直接点的开关`);
  }
  return editSettings(
    file,
    Object.entries(values).map(([path, value]) => ({ path, value })),
    'web',
  );
}

/**
 * 只改表单里的几项：只认表单里的，值按配置项表校验，别的原样留着。给了 `version` 就先对指纹，免得盖掉别处刚改的。
 * 密钥项交回来还是码的就不改（原来有值）；交回空的是清掉。哪一项错了，错误里说的是路径，不带值。
 */
export function saveFields(file: string, values: Record<string, unknown>, version?: string): EditResult {
  const entries = Object.entries(values);
  const unknown = entries
    .filter(([path]) => !(FIELDS as readonly string[]).includes(path))
    .map(([path]) => `${path} 不是能在表单里改的项`);
  if (unknown.length > 0) throw new SettingsError(unknown.join('；'));
  return editSettings(
    file,
    entries.map(([path, value]) => ({ path, value })),
    'web',
    { version },
  );
}
