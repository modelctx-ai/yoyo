/**
 * yoyo 自己改配置的三个工具：`get_settings` 看、`change_setting` 改、`undo_setting` 撤销最近一次。
 * 只认配置项表里标了 `agent` 的几项（`app/settings.ts` 的 `AGENT_PATHS`），都是就地生效的低风险项；密钥、模型、MCP、沙箱这些只有主人能改。
 * 开关 `settings.agent`：`allow` 直接改，`ask` 每次改要主人在工作台里批准，`deny` 没有这三个工具。转告子任务结果的那一轮不给改。
 */
import { tool, type LocalToolRegistry } from '@modelctx-ai/ctx';
import { z } from 'zod';

import type { SettingsConfig } from '../app/config.ts';
import {
  AGENT_PATHS,
  SETTINGS,
  SettingsError,
  changeText,
  type AgentPath,
  type EditResult,
  type Json,
} from '../app/settings.ts';
import { FileError, addGated, answered, defineAction, type AskDeps } from './action.ts';

/** 改配置的两个工具：只在主人发起的那一轮给。 */
export const SETTINGS_TOOL_NAMES: readonly string[] = ['change_setting', 'undo_setting'];

export interface SettingsToolDeps extends AskDeps {
  readonly permission: SettingsConfig['agent'];
  /** 这几项现在是多少（密钥打码）。 */
  readonly values: (paths: readonly AgentPath[]) => Record<string, Json>;
  /** 以模型的名义改一项，改成了记一笔；不让改、写错了抛 `SettingsError`。 */
  readonly edit: (path: AgentPath, value: unknown) => EditResult;
  /** 撤销模型最近改的那一笔。 */
  readonly undo: () => EditResult;
}

/** 每一项一个分支：路径定了，值就按那一项的 schema 收，模型看得到每一项能写什么。 */
function changeSchema(): z.ZodType<{ path: AgentPath; value: unknown }> {
  const branches = AGENT_PATHS.map((path) =>
    z.object({
      path: z.literal(path).describe(SETTINGS[path].summary),
      value: SETTINGS[path].schema.describe(SETTINGS[path].hint.replace(/^要是/, '')),
    }),
  );
  const [first, ...rest] = branches;
  return z.discriminatedUnion('path', [first!, ...rest]);
}

/** 改完回给模型的话：改了什么、什么时候生效、怎么改回去。 */
function editedText(result: EditResult, what: string): string {
  if (result.changes.length === 0) return `${what}：值和原来一样，没改。`;
  const when = result.apply === 'live' ? '马上生效' : '这一轮说完以后换上';
  return `${what}：${result.changes.map(changeText).join('；')}，${when}。`;
}

/** 写错、不让改、没有能撤销的：换成 `FileError`，由 `answered` 原样交回模型，不当工具出错。 */
function told<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof SettingsError) throw new FileError(error.message, { cause: error });
    throw error;
  }
}

export function addSettingsTools(registry: LocalToolRegistry, deps: SettingsToolDeps): void {
  if (deps.permission === 'deny') return;

  registry.addTool(
    'get_settings',
    tool({
      description:
        'yoyo 自己能改的几项配置现在是多少：碎碎念的间隔、语音、音效、傍晚的天气、表情包、念完听回应、子任务通知。',
      inputSchema: z.object({}),
      execute: async () => {
        const values = deps.values(AGENT_PATHS);
        return AGENT_PATHS.map(
          (path) => `${path} = ${JSON.stringify(values[path])}：${SETTINGS[path].summary}（${SETTINGS[path].hint}）`,
        ).join('\n');
      },
    }),
  );

  const schema = changeSchema();
  addGated(registry, deps, {
    name: 'change_setting',
    permission: deps.permission,
    description:
      '改 yoyo 自己的一项配置。主人明确说了才改（「以后少念叨点」「别放语音了」「傍晚别报天气」），不要自作主张；' +
      '先用 get_settings 看现在是多少。改完用自己的话告诉主人改了什么，说一声能改回去。只能改 get_settings 列出来的几项，' +
      '模型、密钥、MCP 服务器、沙箱这些只有主人能在工作台里改。',
    schema,
    action: defineAction(
      schema,
      (input) => {
        const before = deps.values([input.path])[input.path];
        return `把 ${input.path} 从 ${JSON.stringify(before)} 改成 ${JSON.stringify(input.value)}`;
      },
      (input) => answered(() => told(() => editedText(deps.edit(input.path, input.value), '改好了'))),
    ),
  });

  const none = z.object({});
  addGated(registry, deps, {
    name: 'undo_setting',
    permission: deps.permission,
    description: '撤销 yoyo 自己最近一次改的配置，改回原来的值。主人说「刚才那个改回去」时用。',
    schema: none,
    action: defineAction(
      none,
      () => '撤销 yoyo 最近一次改的配置',
      () => answered(() => told(() => editedText(deps.undo(), '撤销了'))),
    ),
  });
}
