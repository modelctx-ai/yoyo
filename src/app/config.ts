import { existsSync, readFileSync } from 'node:fs';

import { z } from 'zod';

/**
 * config.json 的结构。旧配置原样可用：所有新字段都有缺省值，认不出的字段保留不报错。
 */
const text = z.string().trim();

const pet = z.looseObject({
  baseUrl: text.default('http://127.0.0.1:3080/dsh-pet-7340'),
  id: text.default('main'),
  surface: z.enum(['web', 'desktop', 'both', 'any']).default('desktop'),
});

const speech = z.looseObject({
  baseUrl: text.default('https://api.fish.audio/v1/tts'),
  apiKey: text.default(''),
  model: text.default('s2.1-pro-free'),
  referenceId: text.default(''),
  /** 缺省开启。只有明确写成 false 才不把对话回复念出来。 */
  autoplay: z.boolean().default(true),
  /** 朗读桌宠自己对话回复时用的语气。 */
  tone: z.enum(['lively', 'warm', 'calm', 'brisk']).optional(),
});

const llm = z.looseObject({
  /** 和 dsh-pet 独立模式同一套协议名。 */
  provider: z.enum(['openai-compatible', 'anthropic']).default('openai-compatible'),
  baseUrl: text.default(''),
  apiKey: text.default(''),
  model: text.default(''),
  /** 回复时允许模型调用工具（搜索、天气、日程，以及 mcpServers 里的工具）。缺省关闭。 */
  tools: z.boolean().default(false),
});

const listen = z.looseObject({
  enabled: z.boolean().default(true),
  seconds: z.number().default(5),
  device: text.default(':0'),
  action: text.default('碎碎念-对屏碎碎念'),
});

const asr = z.looseObject({
  model: text.default('tiny'),
  bin: text.optional(),
});

const anysearch = z.looseObject({
  script: text.default(''),
  apiKey: text.default(''),
  maxResults: z.number().int().positive().default(3),
  /** 自定义启动命令（argv 数组，第一项是可执行文件）；给了就不用 script。 */
  command: z.array(z.string()).optional(),
});

const toggle = z.looseObject({ enabled: z.boolean().default(true) });

const context = z.looseObject({
  /** 交给模型的历史上限（估算 token）。不写就整段带上，和以前一样。 */
  maxTokens: z.number().int().positive().optional(),
  /** 历史超过这么多估算 token 时，把较早的部分压成摘要。不写就不压缩。 */
  compactAt: z.number().int().positive().optional(),
  /** 压缩时原样保留最近多少条消息。 */
  keep: z.number().int().positive().default(40),
});

const mcpServer = z.union([
  z.looseObject({
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    enabled: z.boolean().optional(),
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
  }),
  z.looseObject({
    url: z.string(),
    type: z.enum(['http', 'sse']).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().optional(),
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
  }),
]);

export const configSchema = z.looseObject({
  /** `dsh-pet` 驱动桌宠；`console` 只在终端打印，用来在没有桌宠的机器上调试。 */
  stage: z.enum(['dsh-pet', 'console']).default('dsh-pet'),
  pet: pet.prefault({}),
  intervalSec: z.number().default(300),
  speech: speech.prefault({}),
  llm: llm.prefault({}),
  listen: listen.prefault({}),
  asr: asr.prefault({}),
  anysearch: anysearch.prefault({}),
  clipboard: toggle.prefault({}),
  hotkey: toggle.prefault({}),
  context: context.prefault({}),
  /** 和常见的 mcpServers 写法相同。只在 `llm.tools` 打开时连接。 */
  mcpServers: z.record(z.string(), mcpServer).default({}),
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
    throw new Error(`config.json 不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  return parseConfig(raw);
}

/** 导演常驻、预合成之前的检查：语音必须配好，驱动桌宠时宠物地址也要完整。 */
export function assertDirectorReady(config: Config): void {
  for (const key of ['baseUrl', 'apiKey', 'model', 'referenceId'] as const) {
    if (!config.speech[key]) throw new Error(`config.json 的 speech.${key} 还空着`);
  }
  if (config.stage === 'dsh-pet' && (!config.pet.baseUrl || !config.pet.id || !config.pet.surface)) {
    throw new Error('config.json 的 pet 不完整');
  }
}

/** 模型配齐了才写碎碎念和回复。 */
export function llmReady(llm: LlmConfig): boolean {
  return Boolean(llm.apiKey && llm.model && (llm.baseUrl || llm.provider === 'anthropic'));
}
