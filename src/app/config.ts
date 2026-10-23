import { existsSync, readFileSync } from 'node:fs';

import { z } from 'zod';

/**
 * config.json 的结构。和旧代码一样宽松，旧配置原样可用：
 * - 所有键都有缺省值，认不出的键保留不报错；整段写成 null（或不是对象）当没写。
 * - 数字可以写成字符串；不是有限数、或者超出范围就按缺省值。
 * - 开关只认 true/false 和字符串 "true"/"false"，别的按缺省值；选项写错或空着也按缺省值。
 * - `mcpServers` 只要是对象就收下，每台服务器到连接时再看（见 `brain/mcp.ts`），写错的跳过，不挡启动。
 * 只有整份配置不是对象时才报错。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 整段不是对象（null、字符串、数组）就当没写。 */
function objectOrNothing(value: unknown): unknown {
  return isRecord(value) ? value : undefined;
}

/** 数字、布尔转成字符串，别的类型当没写。 */
function textOf(value: unknown): string | undefined {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return typeof value === 'string' ? value : undefined;
}

/** 文字，去掉首尾空白。 */
function text(fallback = '') {
  return z.preprocess((value) => textOf(value)?.trim(), z.string().default(fallback));
}

/** 文字原样保留。语音缓存的文件名按原文算哈希，`speech.model`、`speech.referenceId` 和旧代码一样不去空白。 */
function rawText(fallback = '') {
  return z.preprocess(textOf, z.string().default(fallback));
}

/** 开关：true/false 或字符串 "true"/"false"，别的按缺省值。 */
function flag(fallback: boolean) {
  return z
    .preprocess((value) => (value === 'true' ? true : value === 'false' ? false : value), z.boolean())
    .catch(fallback)
    .default(fallback);
}

/** 有限数，可以写成字符串。范围由用的地方再收（例如间隔至少 60 秒、听 1 到 10 秒）。 */
function finite(fallback: number) {
  return z.coerce.number().catch(fallback).default(fallback);
}

/** 正整数，可以写成字符串。 */
function count(fallback: number) {
  return z.coerce.number().int().positive().catch(fallback).default(fallback);
}

function optionalCount() {
  return z.coerce.number().int().positive().optional().catch(undefined);
}

/** 字符串数组；数字转成字符串，别的项丢掉。不是数组就当没写。 */
function stringList() {
  return z.preprocess(
    (value) =>
      Array.isArray(value) ? value.map(textOf).filter((item): item is string => item !== undefined) : undefined,
    z.array(z.string()).optional(),
  );
}

const pet = z.looseObject({
  baseUrl: text('http://127.0.0.1:3080/dsh-pet-7340'),
  id: text('main'),
  surface: z.enum(['web', 'desktop', 'both', 'any']).catch('desktop').default('desktop'),
});

const speech = z.looseObject({
  baseUrl: text('https://api.fish.audio/v1/tts'),
  apiKey: text(),
  model: rawText('s2.1-pro-free'),
  referenceId: rawText(),
  /** 缺省开启。只有明确写成 false 才不把对话回复念出来。 */
  autoplay: flag(true),
  /** 朗读桌宠自己对话回复时用的语气。 */
  tone: z.enum(['lively', 'warm', 'calm', 'brisk']).optional().catch(undefined),
});

const llm = z.looseObject({
  /** 和 dsh-pet 独立模式同一套协议名。 */
  provider: z.enum(['openai-compatible', 'anthropic']).catch('openai-compatible').default('openai-compatible'),
  baseUrl: text(),
  apiKey: text(),
  model: text(),
  /** 回复时允许模型调用工具（搜索、天气、日程，以及 mcpServers 里的工具）。缺省关闭。 */
  tools: flag(false),
});

const listen = z.looseObject({
  /** 缺省关闭：和旧代码一样，没写 listen 就不听。 */
  enabled: flag(false),
  seconds: finite(5),
  device: text(':0'),
  action: text('碎碎念-对屏碎碎念'),
});

const asr = z.looseObject({
  model: text('tiny'),
  bin: z.preprocess((value) => textOf(value)?.trim(), z.string().optional()),
});

const anysearch = z.looseObject({
  script: text(),
  apiKey: text(),
  maxResults: count(3),
  /** 自定义启动命令（argv 数组，第一项是可执行文件）；给了就不用 script。 */
  command: stringList(),
});

const toggle = z.looseObject({ enabled: flag(true) });

const context = z.looseObject({
  /** 交给模型的历史上限（估算 token）。不写就整段带上，和以前一样。 */
  maxTokens: optionalCount(),
  /** 历史超过这么多估算 token 时，把较早的部分压成摘要。不写就不压缩。 */
  compactAt: optionalCount(),
  /** 压缩时原样保留最近多少条消息。 */
  keep: count(40),
});

export const configSchema = z.looseObject({
  /** `dsh-pet` 驱动桌宠；`console` 只在终端打印，用来在没有桌宠的机器上调试。 */
  stage: z.enum(['dsh-pet', 'console']).catch('dsh-pet').default('dsh-pet'),
  pet: z.preprocess(objectOrNothing, pet.prefault({})),
  intervalSec: finite(300),
  speech: z.preprocess(objectOrNothing, speech.prefault({})),
  llm: z.preprocess(objectOrNothing, llm.prefault({})),
  listen: z.preprocess(objectOrNothing, listen.prefault({})),
  asr: z.preprocess(objectOrNothing, asr.prefault({})),
  anysearch: z.preprocess(objectOrNothing, anysearch.prefault({})),
  clipboard: z.preprocess(objectOrNothing, toggle.prefault({})),
  hotkey: z.preprocess(objectOrNothing, toggle.prefault({})),
  context: z.preprocess(objectOrNothing, context.prefault({})),
  /** 和常见的 mcpServers 写法相同。只在 `llm.tools` 打开时连接，每台服务器到那时再检查。 */
  mcpServers: z.preprocess(objectOrNothing, z.record(z.string(), z.unknown()).default({})),
});

export type Config = z.infer<typeof configSchema>;
export type PetConfig = Config['pet'];
export type SpeechConfig = Config['speech'];
export type LlmConfig = Config['llm'];
export type ListenConfig = Config['listen'];
export type AsrConfig = Config['asr'];
export type AnysearchConfig = Config['anysearch'];
export type ContextConfig = Config['context'];
export type McpServersConfig = Config['mcpServers'];

function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(根)'}：${issue.message}`).join('；');
}

export function parseConfig(raw: unknown): Config {
  const result = configSchema.safeParse(raw ?? {});
  if (!result.success) throw new Error(`config.json 不对：${describeIssues(result.error)}`);
  return result.data;
}

export function loadConfig(path: string): Config {
  if (!existsSync(path)) throw new Error(`找不到 ${path}，先把 config.example.json 复制成 config.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`config.json 不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  return parseConfig(raw);
}

const SPEECH_KEYS = ['baseUrl', 'apiKey', 'model', 'referenceId'] as const;

/** Fish Audio 的四项都填了才合成语音；没填齐就只出字。 */
export function speechReady(settings: SpeechConfig): boolean {
  return SPEECH_KEYS.every((key) => settings[key].trim() !== '');
}

/**
 * 导演常驻、预合成之前的检查：驱动桌宠时语音必须配好，宠物地址也要完整。
 * `console` 舞台不要求语音，没配就只打印台词。
 */
export function assertDirectorReady(config: Config): void {
  if (config.stage !== 'dsh-pet') return;
  for (const key of SPEECH_KEYS) {
    if (!config.speech[key].trim()) throw new Error(`config.json 的 speech.${key} 还空着`);
  }
  if (!config.pet.baseUrl || !config.pet.id || !config.pet.surface) throw new Error('config.json 的 pet 不完整');
}

/** 模型配齐了才写碎碎念和回复。 */
export function llmReady(settings: LlmConfig): boolean {
  return Boolean(settings.apiKey && settings.model && (settings.baseUrl || settings.provider === 'anthropic'));
}
