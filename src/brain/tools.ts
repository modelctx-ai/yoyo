import { createToolRegistry, tool, type ToolRegistry } from '@modelctx-ai/ctx';
import { z } from 'zod';

import { errorText } from '../app/log.ts';
import { addSchedule } from '../features/alarms/schedule.ts';
import { ensurePlace, fetchUpcoming, weatherReport } from '../features/weather/weather.ts';
import { localDateKey, minutesOf } from '../kernel/time.ts';
import type { Repos, WebSearch } from '../ports/index.ts';

export interface YoyoToolDeps {
  readonly repos: Repos;
  readonly search: WebSearch | null;
  /** 天气用。 */
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

const RELATIVE_DAYS: ReadonlyMap<string, number> = new Map([
  ['今天', 0],
  ['明天', 1],
  ['后天', 2],
]);

/** 一次性提醒的日期：认「今天」「明天」「后天」；不写就取最近的那个时间点（今天过了就明天）。 */
function resolveDate(date: string | undefined, time: string, now: Date): string {
  const given = date?.trim();
  const offset = given ? RELATIVE_DAYS.get(given) : undefined;
  if (given && offset === undefined) return given;
  const day = new Date(now);
  if (offset !== undefined) {
    day.setDate(day.getDate() + offset);
  } else {
    const minutes = minutesOf(time.trim());
    if (minutes !== null && minutes < now.getHours() * 60 + now.getMinutes()) day.setDate(day.getDate() + 1);
  }
  return localDateKey(day);
}

/** 回复时可以交给模型的本地工具。只有 `llm.tools` 打开时才用。 */
export function createYoyoTools(deps: YoyoToolDeps): ToolRegistry {
  const { repos, search } = deps;
  const now = deps.now ?? (() => new Date());
  const registry = createToolRegistry();

  if (search) {
    registry.add(
      'web_search',
      tool({
        description: '上网搜索。主人问到新闻、最新的事、数字或人物时用，不要凭记忆编。',
        inputSchema: z.object({ query: z.string().describe('要搜的内容，越具体越好') }),
        execute: async ({ query }) => {
          try {
            const text = await search.search(query);
            if (!text.trim()) return '没搜到';
            repos.activity.record({ type: 'search', query });
            return text;
          } catch (error) {
            return `搜索没做成：${errorText(error)}`;
          }
        },
      }),
    );
  }

  registry.add(
    'weather_forecast',
    tool({
      description: '查主人所在地接下来几个小时的天气：气温、天气、要不要带伞。',
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const place = await ensurePlace(repos.kv, deps.fetch);
          const hours = place ? await fetchUpcoming(place, now(), deps.fetch) : [];
          if (!place || hours.length === 0) return '天气没查到';
          return weatherReport(hours, place.name).replace(/^快下班啦。/, '');
        } catch (error) {
          return `天气没查到：${errorText(error)}`;
        }
      },
    }),
  );

  registry.add(
    'list_alarms',
    tool({
      description: '列出已经设好的闹钟和定时任务。',
      inputSchema: z.object({}),
      execute: async () => repos.schedule.list(),
    }),
  );

  registry.add(
    'add_alarm',
    tool({
      description: '新增一个闹钟或定时任务，到点由小女仆说出来。返回存好的日程，或者说明哪里不对。',
      inputSchema: z.object({
        title: z.string().describe('到点要说的话，例如「喝水」「开周会」'),
        time: z.string().describe('几点，HH:MM，24 小时制'),
        date: z
          .string()
          .optional()
          .describe('一次性提醒的日期：YYYY-MM-DD，或「今天」「明天」「后天」；不写就是最近的那个时间点'),
        repeat: z
          .enum(['daily', 'weekdays', 'weekly'])
          .optional()
          .describe('重复：每天 daily，工作日 weekdays，每周 weekly；一次性的不写'),
        weekday: z.number().int().optional().describe('每周提醒在星期几，0 是周日'),
        kind: z.enum(['alarm', 'task']).optional().describe('alarm 是闹钟（缺省）；task 是任务，到点先说「到点了。」'),
      }),
      execute: async (input) => {
        const at = now();
        try {
          return addSchedule(
            repos,
            {
              title: input.title,
              time: input.time,
              date: input.repeat ? null : resolveDate(input.date, input.time, at),
              repeat: input.repeat ?? null,
              weekday: input.weekday,
              kind: input.kind ?? 'alarm',
            },
            at,
          );
        } catch (error) {
          return errorText(error);
        }
      },
    }),
  );

  return registry;
}
