/**
 * 子 agent 的类型，照 Claude Code 的 subagent_type：每种有名字、什么时候用、自己的指令和工具清单，
 * 主线程派子任务时挑一种。内置三种，主人可以在 `~/.yoyo/agents/<名字>.md` 里加或覆盖，
 * 格式和 Claude Code 的 `.claude/agents/*.md` 一样：frontmatter 写 name、description、tools、model，正文是指令。
 * 这里只管定义、解析和挑工具；读目录在组装根，跑在 `runtime/tasks.ts`。
 */

/** 子 agent 自己的任务工具，哪种类型都有。 */
export const TASK_TOOL_NAMES: readonly string[] = [
  'task_plan',
  'task_todo',
  'task_deliver',
  'task_ask',
  'task_finish',
  'task_fail',
];

export const DEFAULT_AGENT = 'general';

export interface AgentProfile {
  /** `[a-z0-9-]`，1 到 32 个字。 */
  readonly name: string;
  /** 什么时候用它，主线程按这句挑。 */
  readonly description: string;
  /** 接在做事协议后面的指令。 */
  readonly instructions: string;
  /** 能用哪些工具（不算任务工具）；`*` 结尾按前缀匹配，例如 `github__*`。null 是全部。 */
  readonly tools: readonly string[] | null;
  /** 换一个模型（服务商和密钥照 `llm`）；不写用 `llm.model`。 */
  readonly model: string | null;
  /** `builtin` 或者文件路径。 */
  readonly source: string;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const BUILTIN_AGENTS: readonly AgentProfile[] = [
  {
    name: 'general',
    description: '什么都能做：查资料、整理、写东西、设提醒。拿不准就用它。',
    instructions: '你手上的工具都可以用。',
    tools: null,
    model: null,
    source: 'builtin',
  },
  {
    name: 'research',
    description: '上网查、对比、下结论，交回来要带出处。只读，不改日程，不发东西。',
    instructions: [
      '你是查资料的子 agent。',
      '先想清楚要回答什么、怎样算查清楚，再动手查；同一件事换两三个说法查，不只看第一条。',
      '每个结论后面写出处（网址或来源名）；来源说法不一致时写出分歧。',
      '查不到就照实说查不到，不要凭记忆补数字和新闻。',
    ].join('\n'),
    tools: ['web_search', 'weather_forecast', 'list_alarms', 'recall', 'yoyo', 'read'],
    model: null,
    source: 'builtin',
  },
  {
    name: 'writer',
    description: '把给的材料整理成周报、清单、摘要、回复草稿。不上网，材料要在目标里给全，或者在工作区的文件里。',
    instructions: [
      '你是整理和写东西的子 agent，不上网。',
      '只用目标里给的材料、工作区里的文件、你记得的主人的事和 yoyo 命令行查得到的（以前的对话、子任务、日程）；缺材料就在结果里列出缺什么，不要编。',
      '写成主人能直接用的样子：先结论后细节，分点，短句。',
    ].join('\n'),
    tools: ['recall', 'yoyo', 'read', 'write', 'edit'],
    model: null,
    source: 'builtin',
  },
];

/** 写错的 agent 文件：说清楚哪个文件哪里不对。 */
export class AgentFileError extends Error {}

function frontmatter(text: string): { readonly fields: Map<string, string>; readonly body: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^﻿/, ''));
  if (!match) return null;
  const fields = new Map<string, string>();
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const pair = /^\s*([A-Za-z_]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (pair) fields.set(pair[1]!.toLowerCase(), pair[2]!.replace(/^(["'])(.*)\1$/, '$2'));
  }
  return { fields, body: match[2] ?? '' };
}

/** 解析一个 agent 文件；`fallback` 是文件名（不带 .md），frontmatter 没写 name 时用它。 */
export function parseAgentFile(text: string, fallback: string, source: string): AgentProfile {
  const parsed = frontmatter(text);
  if (!parsed) throw new AgentFileError(`${source}：开头要有 --- 包着的 frontmatter`);
  const name = (parsed.fields.get('name') || fallback).trim();
  if (!NAME.test(name)) throw new AgentFileError(`${source}：名字「${name}」只能用小写字母、数字和 -，最多 32 个字`);
  const description = parsed.fields.get('description')?.trim();
  if (!description) throw new AgentFileError(`${source}：要写 description，主线程按它挑`);
  const instructions = parsed.body.trim();
  if (!instructions) throw new AgentFileError(`${source}：正文是这个 agent 的指令，不能空着`);
  const toolList = parsed.fields.get('tools')?.trim();
  const tools = toolList
    ? toolList
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((item) => item.trim().replace(/^(["'])(.*)\1$/, '$2'))
        .filter(Boolean)
    : null;
  const model = parsed.fields.get('model')?.trim() || null;
  return { name, description, instructions, tools, model, source };
}

/** 内置的加上主人的，同名的主人的盖掉内置的；按名字排，`general` 在最前。 */
export function mergeAgents(custom: readonly AgentProfile[]): AgentProfile[] {
  const byName = new Map<string, AgentProfile>();
  for (const profile of [...BUILTIN_AGENTS, ...custom]) byName.set(profile.name, profile);
  return [...byName.values()].toSorted((a, b) =>
    a.name === DEFAULT_AGENT ? -1 : b.name === DEFAULT_AGENT ? 1 : a.name.localeCompare(b.name),
  );
}

/**
 * 这种类型实际拿到的工具名：清单里有的（`*` 结尾按前缀）加上任务工具，清单写了但没有的跳过。
 * 清单是 null（全部）时返回 true。
 */
export function agentTools(profile: AgentProfile, available: readonly string[]): string[] | true {
  if (profile.tools === null) return true;
  const picked = available.filter((name) =>
    profile.tools!.some((pattern) =>
      pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern,
    ),
  );
  return [...new Set([...picked, ...TASK_TOOL_NAMES])];
}

/** 给主线程看的类型清单，放在 `task_create` 的说明里。 */
export function agentMenu(profiles: readonly AgentProfile[]): string {
  return profiles.map((profile) => `${profile.name}：${profile.description}`).join('\n');
}
