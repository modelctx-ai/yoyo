import { createToolRegistry, tool, type LocalToolRegistry } from '@modelctx-ai/ctx';
import { z } from 'zod';

import { errorText } from '../app/log.ts';
import { addSchedule } from '../features/alarms/schedule.ts';
import {
  CRITERIA_MAX,
  TaskError,
  TODOS_MAX,
  cancelAgentTask,
  createAgentTask,
  failTask,
  finishTask,
  planTodos,
  taskDetail,
  taskRow,
  updateTodo,
} from '../features/tasks/tasks.ts';
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

/** 规则不让做的事原样交回模型；别的错照常抛。 */
function guarded<T>(work: () => T): T | string {
  try {
    return work();
  } catch (error) {
    if (error instanceof TaskError) return error.message;
    throw error;
  }
}

/**
 * 回复时可以交给模型的本地工具。只有 `llm.tools` 打开时才用。
 * `tasks` 打开时加上主线程管子任务的几个（开、列、看、取消）；子 agent 用的是另一份注册表，没有这几个。
 */
export function createYoyoTools(deps: YoyoToolDeps & { readonly tasks?: boolean }): LocalToolRegistry {
  const { repos, search } = deps;
  const now = deps.now ?? (() => new Date());
  const registry = createToolRegistry();

  if (search) {
    registry.addTool(
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

  registry.addTool(
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

  registry.addTool(
    'list_alarms',
    tool({
      description: '列出已经设好的闹钟和定时任务。',
      inputSchema: z.object({}),
      execute: async () => repos.schedule.list(),
    }),
  );

  registry.addTool(
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

  if (deps.tasks) addTaskTools(registry, repos, now);
  return registry;
}

/** 主线程管子任务：派出去、看进度、看结果、取消。子任务由常驻进程在后台做，做完结果会回到主线程。 */
function addTaskTools(registry: LocalToolRegistry, repos: Repos, now: () => Date): void {
  registry.addTool(
    'task_create',
    tool({
      description:
        '派一个子任务给后台的子 agent 去做：要花时间、要好几步、要查资料或整理东西的事。马上返回编号，不等做完；' +
        '做完了结果会回到这里。主人只是聊天、一两句能答的不要派。',
      inputSchema: z.object({
        title: z.string().describe('一句话标题，像待办事项，例如「整理本周周报」'),
        goal: z.string().describe('要做成什么样：背景、范围、要交回什么。写清楚，子 agent 只看得到这段'),
        criteria: z
          .array(z.string())
          .max(CRITERIA_MAX)
          .describe('验收标准，一条一句、能检查的，例如「列出每个项目本周的进展」'),
      }),
      execute: async (input) =>
        guarded(() => {
          const task = createAgentTask(repos, { ...input, origin: 'main' }, now());
          return `开了子任务 #${task.id}「${task.title}」，排队等着做`;
        }),
    }),
  );

  registry.addTool(
    'task_list',
    tool({
      description: '列出最近的子任务：编号、状态、todo 进度、标题。',
      inputSchema: z.object({}),
      execute: async () => repos.agentTasks.list({ limit: 20 }).map(taskRow).join('\n') || '还没有子任务',
    }),
  );

  registry.addTool(
    'task_show',
    tool({
      description: '看一个子任务的全部：目标、验收标准、todo 和各自的状态、验收结果、交回的结果或没做成的原因。',
      inputSchema: z.object({ id: z.number().int().describe('子任务编号') }),
      execute: async ({ id }) => {
        const task = repos.agentTasks.get(id);
        return task ? taskDetail(task) : `没有子任务 #${id}`;
      },
    }),
  );

  registry.addTool(
    'task_cancel',
    tool({
      description: '取消一个还在排队或在做的子任务。主人说不用做了时用。',
      inputSchema: z.object({ id: z.number().int().describe('子任务编号') }),
      execute: async ({ id }) => guarded(() => `取消了子任务 #${cancelAgentTask(repos, id, now()).id}`),
    }),
  );
}

/**
 * 子 agent 自己用的：拆 todo、改 todo、交结果、交不了。都要带上子任务编号，只对在做的那个有效。
 * 加在子 agent 的注册表里，主线程看不到。
 */
export function addTaskWorkerTools(registry: LocalToolRegistry, deps: Pick<YoyoToolDeps, 'repos' | 'now'>): void {
  const { repos } = deps;
  const now = deps.now ?? (() => new Date());
  const id = z.number().int().describe('子任务编号');

  registry.addTool(
    'task_plan',
    tool({
      description:
        '把子任务拆成 todo（或者重新拆）：给一整份清单，按顺序。和原来一字不差的项保留原来的状态。' +
        '简单的事拆一两项就行，复杂的拆细一点。',
      inputSchema: z.object({
        id,
        todos: z.array(z.string()).min(1).max(TODOS_MAX).describe('每项一句，做完能看出来'),
      }),
      execute: async (input) =>
        guarded(() => `todo 定好了，一共 ${planTodos(repos, input.id, input.todos, now()).todos.length} 项`),
    }),
  );

  registry.addTool(
    'task_todo',
    tool({
      description: '改一项 todo 的状态：开始做时标 in_progress，做完马上标 done，确实不用做标 skipped 并写原因。',
      inputSchema: z.object({
        id,
        index: z.number().int().describe('第几项，从 1 数'),
        state: z.enum(['in_progress', 'done', 'skipped']),
        note: z.string().optional().describe('一句说明：做出了什么，或者为什么跳过'),
      }),
      execute: async (input) =>
        guarded(() => {
          const task = updateTodo(repos, input.id, input.index, input.state, input.note, now());
          const left = task.todos.filter((todo) => todo.state === 'pending' || todo.state === 'in_progress').length;
          return left > 0 ? `改好了，还剩 ${left} 项` : '改好了，todo 都做完了；对一遍验收标准再交结果';
        }),
    }),
  );

  registry.addTool(
    'task_finish',
    tool({
      description: '交结果：todo 都做完或跳过、验收标准逐条满足以后用。结果写成主人能直接看的样子，会原样交回主线程。',
      inputSchema: z.object({
        id,
        result: z.string().describe('交回的结果：结论在前，要点分行'),
        checks: z
          .array(
            z.object({
              criterion: z.string().describe('验收标准原文'),
              met: z.boolean(),
              evidence: z.string().describe('凭什么说满足了'),
            }),
          )
          .describe('每条验收标准一项'),
      }),
      execute: async (input) =>
        guarded(() => `交好了，子任务 #${finishTask(repos, input.id, input.result, input.checks, now()).id} 做完`),
    }),
  );

  registry.addTool(
    'task_fail',
    tool({
      description: '确实做不了时用：缺权限、缺信息、工具不够。说清楚卡在哪，主线程会告诉主人。',
      inputSchema: z.object({ id, reason: z.string().describe('卡在哪，要什么才能做') }),
      execute: async (input) =>
        guarded(() => `记下了，子任务 #${failTask(repos, input.id, input.reason, now()).id} 没做成`),
    }),
  );
}
