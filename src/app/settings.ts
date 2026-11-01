/**
 * 能改的配置项：一张表，工作台、命令行、模型三处改配置都只认它。每一项写明怎么校验、改了以后就地生效还是要重建、
 * 谁能改（`agent` 的模型也能改，`owner` 的只有主人）。改的时候读 config.json 原文、只动给的那几项、
 * 写之前和常驻进程启动时一样检查、先写临时文件再改名；常驻进程盯着文件，按 `classify` 就地换上或重建。
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';

import { z } from 'zod';

import type { ActivityEvent } from '../kernel/types.ts';
import type { ActivityRepo } from '../ports/index.ts';
import { assertDirectorReady, parseConfig, type Config } from './config.ts';
import { errorText } from './log.ts';

/** 改了以后怎么换上：`live` 就地生效，`rebuild` 等这一轮说完再按新配置重建。 */
export type Apply = 'live' | 'rebuild';

/** 谁能改：`owner` 只有主人（工作台、命令行），`agent` 主人和模型都能改。 */
export type Editor = 'owner' | 'agent';

/** 这次改动从哪来。 */
export type EditSource = 'web' | 'cli' | 'agent';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface SettingSpec<S extends z.ZodType = z.ZodType> {
  readonly schema: S;
  /** 值不对时接在路径后面的一句。 */
  readonly hint: string;
  /** 给模型、命令行和工作台看的一句说明。 */
  readonly summary: string;
  readonly apply: Apply;
  readonly editor: Editor;
  /** 密钥：读出来打码，交回来还是码就不改，行为记录里也打码，不能撤销。 */
  readonly secret?: true;
  /** 写进文件前整理一下；返回 `undefined` 是把这一项从文件里拿掉。 */
  write?(value: z.infer<S>): Json | undefined;
}

/** 表里的一项：`write` 收到的是它自己 schema 的类型，`apply`、`editor` 留着字面量，`AgentPath` 才推得出来。 */
type Entry<S extends z.ZodType, A extends Apply, E extends Editor> = SettingSpec<S> & {
  readonly apply: A;
  readonly editor: E;
};

function setting<S extends z.ZodType, A extends Apply, E extends Editor>(
  spec: SettingSpec<S> & { readonly apply: A; readonly editor: E },
): Entry<S, A, E> {
  return spec;
}

const flag = z.boolean();
const trimmed = z.string().trim();

/** 开关。 */
function toggle<A extends Apply, E extends Editor>(summary: string, apply: A, editor: E): Entry<typeof flag, A, E> {
  return { schema: flag, hint: '只能是 true 或 false', summary, apply, editor };
}

/**
 * 能改的项。`agent` 只放低风险、就地生效的：密钥、`llm`、`mcpServers`、`sandbox`、`stage`、`pet`、`web` 这类，
 * 被提示注入时改了就等于能在本机跑命令或把数据发出去，只给主人。不在表里的项照样能在整份配置里改，改了按重建算。
 */
export const SETTINGS = {
  intervalSec: setting({
    schema: z.number().min(60).max(86_400),
    hint: '要是 60 到 86400 之间的秒数',
    summary: '日常碎碎念的间隔（秒）；配了决策模型时是没判成时的间隔',
    apply: 'live',
    editor: 'agent',
  }),
  'pace.options': setting({
    schema: z.array(z.number().int().min(60).max(86_400)).min(2).max(8),
    hint: '要有 2 到 8 档，每档是 60 到 86400 之间的整数秒',
    summary: '决策模型能挑的几档间隔（秒）',
    apply: 'live',
    editor: 'agent',
    write: (value) => [...new Set(value)].toSorted((a, b) => a - b),
  }),
  'pace.minConfidence': setting({
    schema: z.number().min(0).max(1),
    hint: '要是 0 到 1 之间的数',
    summary: '决策模型的把握低于它，这一句按 intervalSec',
    apply: 'live',
    editor: 'owner',
  }),
  'pace.recent': setting({
    schema: z.number().int().min(0).max(20),
    hint: '要是 0 到 20 之间的整数',
    summary: '交给决策模型的最近对话原文条数，0 不交原文',
    apply: 'live',
    editor: 'owner',
  }),
  'speech.autoplay': toggle('说话时放语音', 'live', 'agent'),
  'sfx.enabled': toggle('每个动作配一段很轻的音效', 'live', 'agent'),
  'weather.enabled': toggle('工作日傍晚报天气', 'live', 'agent'),
  'memes.enabled': toggle('碎碎念时配表情包', 'live', 'agent'),
  'listen.enabled': toggle('碎碎念念完听主人回应', 'live', 'agent'),
  'tasks.notify': toggle('子任务做完或没做成时说一声', 'live', 'agent'),
  // 粘贴板的来源组装时才挂上，关掉要重建，不然模型还看得到最近一条
  'clipboard.enabled': toggle('读粘贴板', 'rebuild', 'owner'),
  // app 外壳自己读这一项，常驻进程用不到
  'app.launchAtLogin': toggle('登录时打开 yoyo.app', 'live', 'owner'),
  'hotkey.enabled': toggle('Control+Option+Y 听一句', 'rebuild', 'owner'),
  'llm.tools': toggle('回复时让模型用工具', 'rebuild', 'owner'),
  'memory.enabled': toggle('记住主人', 'rebuild', 'owner'),
  'sandbox.enabled': toggle('MCP 服务器关进沙箱', 'rebuild', 'owner'),
  'speech.tone': setting({
    schema: z.enum(['', 'lively', 'warm', 'calm', 'brisk']),
    hint: '只能是 lively、warm、calm、brisk，或者留空',
    summary: '念桌宠对话回复时的语气，留空按钟点',
    apply: 'live',
    editor: 'owner',
    // 留空就是不指定
    write: (value) => (value === '' ? undefined : value),
  }),
  'speech.model': setting({
    schema: trimmed,
    hint: '要是一段文字',
    summary: 'Fish Audio 的模型',
    apply: 'rebuild',
    editor: 'owner',
  }),
  'speech.referenceId': setting({
    schema: trimmed,
    hint: '要是一段文字',
    summary: 'Fish Audio 的声音',
    apply: 'rebuild',
    editor: 'owner',
  }),
  'speech.apiKey': setting({
    schema: trimmed,
    hint: '要是一段文字',
    summary: 'Fish Audio 的密钥',
    apply: 'rebuild',
    editor: 'owner',
    secret: true,
  }),
  'llm.provider': setting({
    schema: z.enum(['openai-compatible', 'anthropic']),
    hint: '只能是 openai-compatible 或 anthropic',
    summary: '模型服务商的协议',
    apply: 'rebuild',
    editor: 'owner',
  }),
  'llm.baseUrl': setting({
    schema: trimmed.refine((value) => value === '' || /^https?:\/\/\S+$/.test(value)),
    hint: '要以 http:// 或 https:// 开头，或者留空',
    summary: '模型接口地址',
    apply: 'rebuild',
    editor: 'owner',
  }),
  'llm.model': setting({ schema: trimmed, hint: '要是一段文字', summary: '模型名', apply: 'rebuild', editor: 'owner' }),
  'llm.apiKey': setting({
    schema: trimmed,
    hint: '要是一段文字',
    summary: '模型的密钥',
    apply: 'rebuild',
    editor: 'owner',
    secret: true,
  }),
} as const;

export type SettingPath = keyof typeof SETTINGS;
export type SettingValue<P extends SettingPath> = z.infer<(typeof SETTINGS)[P]['schema']>;
/** 模型能改的项。 */
export type AgentPath = {
  [P in SettingPath]: (typeof SETTINGS)[P]['editor'] extends 'agent' ? P : never;
}[SettingPath];

export const SETTING_PATHS = Object.keys(SETTINGS) as SettingPath[];
export const AGENT_PATHS = SETTING_PATHS.filter((path): path is AgentPath => SETTINGS[path].editor === 'agent');

/** 去掉字符串索引签名（配置各段是 `looseObject`，带着它任何键都算有），只留写明的键。 */
type Known<T> = { [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K] };

/** `Config` 里按点分路径取到的类型；路径不在 `Config` 里是 `never`。 */
type At<T, P extends string> = P extends `${infer H}.${infer R}`
  ? H extends keyof Known<NonNullable<T>>
    ? At<Known<NonNullable<T>>[H], R>
    : never
  : P extends keyof Known<NonNullable<T>>
    ? Known<NonNullable<T>>[P]
    : never;

/** 表里不在 `Config` 里的路径；应该一条都没有。 */
type NotInConfig = { [P in SettingPath]: [At<Config, P>] extends [never] ? P : never }[SettingPath];
/** 写错一条路径，这里的类型就是那条路径，`true` 放不进去，编译不过，报错里看得到是哪条。 */
const ALL_IN_CONFIG: [NotInConfig] extends [never] ? true : NotInConfig = true;
void ALL_IN_CONFIG;

export function isSettingPath(path: string): path is SettingPath {
  return Object.hasOwn(SETTINGS, path);
}

/** 认不出、不好改的：回一句话。`status` 按 HTTP 的意思：400 写错了，403 不让改，409 文件在别处改过了。 */
export class SettingsError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// ---- 读写 config.json 原文 ----

/** 打码的样子。存回来时还是它，就当没改。 */
export const MASK = '••••••';

/** 名字像密钥的键：apiKey、token、secret、password、Authorization 之类，MCP 服务器的 env 和 headers 里的也算。 */
const SECRET_KEY = /api[-_]?key|token|secret|password|passwd|authorization|cookie|credential/i;

export function isObject(value: unknown): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 文件内容的指纹：先读后写的一方带回来，对不上就是在别处改过了。 */
export function versionOf(file: string): string {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
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

/** 交回来的里还是码的，换回原来同一位置的值；原来那里没有就报错，免得把码当成密钥存进去。 */
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

/** 原文里按点分路径取值；没有是 `undefined`。 */
export function rawAt(raw: Record<string, Json>, path: string): Json | undefined {
  let node: Json | undefined = raw;
  for (const key of path.split('.')) {
    if (!isObject(node)) return undefined;
    node = node[key];
  }
  return node;
}

/** 原文里按点分路径写值，`undefined` 是拿掉；中间那段不是对象就换成对象。 */
function setRawAt(raw: Record<string, Json>, path: string, value: Json | undefined): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  let node = raw;
  for (const key of keys) {
    const next = node[key];
    if (!isObject(next)) node[key] = {};
    node = node[key] as Record<string, Json>;
  }
  if (value === undefined) delete node[last];
  else node[last] = value;
}

/** 解析以后的配置里按点分路径取值。几档间隔解析以后是 `{ id, ms }`，这里换回秒，和原文、表单一样。 */
export function settingAt(config: Config, path: SettingPath): Json {
  if (path === 'pace.options') return config.pace.options.map((option) => option.ms / 1000);
  let node: unknown = config;
  for (const key of path.split('.')) node = isObject(node) ? (node as Record<string, unknown>)[key] : undefined;
  return (node ?? null) as Json;
}

// ---- 改 ----

export interface ConfigEdit {
  readonly path: string;
  readonly value: unknown;
}

/** 一项改动：前后都是文件里的原文（没有是 null），密钥打码。 */
export interface SettingChange {
  readonly path: SettingPath;
  readonly before: Json;
  readonly after: Json;
}

export interface EditResult {
  /** 真的变了的项；值和原来一样的不算。 */
  readonly changes: readonly SettingChange[];
  /** 怎么换上：有一项要重建就是 `rebuild`；什么都没变是 null。 */
  readonly apply: Apply | null;
  readonly config: Config;
}

export interface EditOptions {
  /** 先读后写的一方读到时的指纹，对不上回 409。 */
  readonly version?: string | undefined;
}

function sameJson(a: Json | undefined, b: Json | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function shown(path: SettingPath, value: Json | undefined): Json {
  if (value === undefined) return null;
  return 'secret' in SETTINGS[path] && value !== '' ? MASK : value;
}

/**
 * 改几项：只认表里的路径，`agent` 只能改 `agent` 的项，值按表里的 schema 校验，有一项不对就一项都不改，错误里说路径不带值。
 * 密钥项交回来还是码就不改。别的键（包括表外的、认不出的）原样留着。写之前检查一遍，原子写。
 */
export function editSettings(
  file: string,
  edits: readonly ConfigEdit[],
  source: EditSource,
  options: EditOptions = {},
): EditResult {
  if (options.version !== undefined && options.version !== versionOf(file)) {
    throw new SettingsError('config.json 在别处改过了：刷新一下再改', 409);
  }
  if (edits.length === 0) throw new SettingsError('没有要改的项');
  const raw = readRaw(file);
  const problems: string[] = [];
  let forbidden = false;
  const changes: SettingChange[] = [];
  for (const edit of edits) {
    if (!isSettingPath(edit.path)) {
      problems.push(`${edit.path} 不是能这样改的项`);
      continue;
    }
    const path = edit.path;
    const spec: SettingSpec = SETTINGS[path];
    if (source === 'agent' && spec.editor !== 'agent') {
      problems.push(`${path} 只有主人能改`);
      forbidden = true;
      continue;
    }
    const before = rawAt(raw, path);
    if (spec.secret && edit.value === MASK) {
      if (typeof before !== 'string' || before === '')
        problems.push(`${path} 还是打码的样子，但原来没有这一项：填上真的值`);
      continue;
    }
    const parsed = spec.schema.safeParse(edit.value);
    if (!parsed.success) {
      problems.push(`${path} ${spec.hint}`);
      continue;
    }
    const after = spec.write ? spec.write(parsed.data) : (parsed.data as Json);
    if (sameJson(before, after)) continue;
    setRawAt(raw, path, after);
    changes.push({ path, before: shown(path, before), after: shown(path, after) });
  }
  if (problems.length > 0) throw new SettingsError(problems.join('；'), forbidden ? 403 : 400);
  if (changes.length === 0) return { changes, apply: null, config: parseConfig(raw) };
  const config = writeRaw(file, raw);
  const apply = changes.every((change) => SETTINGS[change.path].apply === 'live') ? 'live' : 'rebuild';
  return { changes, apply, config };
}

// ---- 行为记录和撤销 ----

/** 行为记录里的一笔：前后值按路径存成 JSON 文字（记录里只放得下文字和数）。 */
export interface EditRecord extends ActivityEvent {
  readonly type: 'config-edit';
  readonly source: EditSource;
  /** 改了哪几项，空格隔开。 */
  readonly text: string;
  readonly before: string;
  readonly after: string;
  /** 这一笔的编号。不用时间认：同一毫秒里改两次，时间是一样的。 */
  readonly id: string;
  /** 撤销的是哪一笔（那一笔的 `id`）。 */
  readonly undoes?: string;
}

export function editRecord(source: EditSource, changes: readonly SettingChange[], undoes?: string): EditRecord {
  return {
    type: 'config-edit',
    id: randomUUID(),
    source,
    text: changes.map((change) => change.path).join(' '),
    before: JSON.stringify(Object.fromEntries(changes.map((change) => [change.path, change.before]))),
    after: JSON.stringify(Object.fromEntries(changes.map((change) => [change.path, change.after]))),
    ...(undoes ? { undoes } : {}),
  };
}

/** 行为记录里读回来的一笔逐项修改。整份配置存的那种没有前后值，不在这里。 */
export interface PastEdit {
  readonly id: string;
  readonly source: string;
  readonly before: Readonly<Record<string, Json>>;
  readonly after: Readonly<Record<string, Json>>;
  readonly undoes: string | null;
}

function parseMap(text: unknown): Record<string, Json> | null {
  if (typeof text !== 'string') return null;
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

export function pastEdit(record: { readonly [field: string]: unknown }): PastEdit | null {
  const before = parseMap(record['before']);
  const after = parseMap(record['after']);
  const id = record['id'];
  if (!before || !after || typeof id !== 'string') return null;
  const undoes = record['undoes'];
  return {
    id,
    source: typeof record['source'] === 'string' ? record['source'] : '',
    before,
    after,
    undoes: typeof undoes === 'string' ? undoes : null,
  };
}

/**
 * 该撤销哪一笔：从新到旧，跳过撤销本身和已经撤销过的；`only` 给了就只看这个来源的。
 * `edits` 按时间从旧到新。
 */
export function lastUndoable(edits: readonly PastEdit[], only?: EditSource): PastEdit | null {
  const undone = new Set(edits.flatMap((edit) => (edit.undoes ? [edit.undoes] : [])));
  for (const edit of edits.toReversed()) {
    if (edit.undoes || undone.has(edit.id)) continue;
    if (only && edit.source !== only) continue;
    return edit;
  }
  return null;
}

/**
 * 撤销一笔：把那几项改回原来的值。之后又改过的、密钥（记录里是码）不撤，说清楚哪一项。
 * 原来没有这一项的，撤销就是把它拿掉。
 */
export function undoEdit(file: string, edit: PastEdit, source: EditSource): EditResult {
  const raw = readRaw(file);
  const problems: string[] = [];
  for (const [path, after] of Object.entries(edit.after)) {
    if (!isSettingPath(path)) problems.push(`${path} 不是能这样改的项`);
    else if ('secret' in SETTINGS[path]) problems.push(`${path} 是密钥，撤销不了`);
    else if (source === 'agent' && SETTINGS[path].editor !== 'agent') problems.push(`${path} 只有主人能改`);
    else if (!sameJson(rawAt(raw, path), after)) problems.push(`${path} 之后又改过了`);
  }
  if (problems.length > 0) throw new SettingsError(`撤销不了：${problems.join('；')}`, 409);
  const changes: SettingChange[] = [];
  for (const [path, before] of Object.entries(edit.before)) {
    const key = path as SettingPath;
    const now = rawAt(raw, key);
    const back = before === null ? undefined : before;
    if (sameJson(now, back)) continue;
    setRawAt(raw, key, back);
    changes.push({ path: key, before: shown(key, now), after: shown(key, back) });
  }
  if (changes.length === 0) return { changes, apply: null, config: parseConfig(raw) };
  const config = writeRaw(file, raw);
  const apply = changes.every((change) => SETTINGS[change.path].apply === 'live') ? 'live' : 'rebuild';
  return { changes, apply, config };
}

// ---- 换配置：就地还是重建 ----

export type ConfigChange =
  | { readonly kind: 'none' }
  | { readonly kind: 'live'; readonly paths: readonly string[] }
  | { readonly kind: 'rebuild'; readonly paths: readonly string[] };

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 补齐缺省值以后，按叶子路径比较；数组算一片叶子。 */
export function changedPaths(prev: unknown, next: unknown, prefix = ''): string[] {
  if (isPlain(prev) && isPlain(next)) {
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
    return [...keys].flatMap((key) => changedPaths(prev[key], next[key], prefix ? `${prefix}.${key}` : key));
  }
  return JSON.stringify(prev ?? null) === JSON.stringify(next ?? null) ? [] : [prefix || '（根）'];
}

/** 这片叶子归表里哪一项（路径相同，或者在它下面）；不在表里是 null。 */
function settingOf(leaf: string): SettingPath | null {
  return SETTING_PATHS.find((path) => leaf === path || leaf.startsWith(`${path}.`)) ?? null;
}

/**
 * 新旧两份配置差在哪、怎么换上：变了的全在表里而且都是就地生效的，才算 `live`；
 * 有一项不在表里（手改了 `mcpServers` 之类）就按重建算：漏登记最多多重建一次，不会该重建的没重建。
 */
export function classify(prev: Config, next: Config): ConfigChange {
  const paths = changedPaths(prev, next);
  if (paths.length === 0) return { kind: 'none' };
  const live = paths.every((leaf) => {
    const path = settingOf(leaf);
    return path !== null && SETTINGS[path].apply === 'live';
  });
  return { kind: live ? 'live' : 'rebuild', paths };
}

// ---- 三个入口共用：改了就记一笔，撤销按记录来 ----

/** 能撤销的最多往回翻这么多笔修改。 */
const UNDO_LOOKBACK = 200;

export interface SettingsAccess {
  /** 这几项现在是多少：按文件里的、补齐缺省值以后，密钥打码。 */
  values(paths: readonly SettingPath[]): Record<string, Json>;
  /** 改，改成了就记一笔 `config-edit`。 */
  edit(edits: readonly ConfigEdit[], source: EditSource, options?: EditOptions): EditResult;
  /** 撤销最近一笔（`only` 给了就只看这个来源改的），撤销本身也记一笔。没有能撤销的回 404。 */
  undo(source: EditSource, only?: EditSource): EditResult;
}

export function settingsAccess(file: string, activity: Pick<ActivityRepo, 'record' | 'list'>): SettingsAccess {
  return {
    values(paths) {
      const config = parseConfig(readRaw(file));
      return Object.fromEntries(paths.map((path) => [path, shown(path, settingAt(config, path))]));
    },
    edit(edits, source, options) {
      const result = editSettings(file, edits, source, options);
      if (result.changes.length > 0) activity.record(editRecord(source, result.changes));
      return result;
    },
    undo(source, only) {
      const records = activity.list(UNDO_LOOKBACK, { types: ['config-edit'] });
      const edits = records.map(pastEdit).filter((edit): edit is PastEdit => edit !== null);
      const target = lastUndoable(edits, only);
      if (!target) {
        throw new SettingsError(only === 'agent' ? 'yoyo 最近没改过配置，没有能撤销的' : '没有能撤销的修改', 404);
      }
      const result = undoEdit(file, target, source);
      if (result.changes.length > 0) activity.record(editRecord(source, result.changes, target.id));
      return result;
    },
  };
}

function showValue(value: Json): string {
  return value === null ? '（没写）' : JSON.stringify(value);
}

/** 一项改动写成一句：`intervalSec 300 → 900`。 */
export function changeText(change: SettingChange): string {
  return `${change.path} ${showValue(change.before)} → ${showValue(change.after)}`;
}
