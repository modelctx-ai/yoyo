import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

import { createToolRegistry, tool, type LocalToolRegistry } from '@modelctx-ai/ctx';
import { z } from 'zod';

import { errorText } from '../app/log.ts';
import { addSchedule, updateSchedule } from '../features/alarms/schedule.ts';
import { ARTIFACT_MAX, ARTIFACTS_PER_TASK, deliverArtifact, deliveredNote } from '../features/tasks/artifacts.ts';
import { DEFAULT_AGENT, agentMenu, mergeAgents, type AgentProfile } from '../features/tasks/agents.ts';
import {
  CRITERIA_MAX,
  TaskError,
  TODOS_MAX,
  answerTask,
  askTask,
  cancelAgentTask,
  createAgentTask,
  failTask,
  finishTask,
  planTodos,
  updateTodo,
} from '../features/tasks/tasks.ts';
import { ensurePlace, fetchUpcoming, weatherReport } from '../features/weather/weather.ts';
import { localDateKey, minutesOf } from '../kernel/time.ts';
import type { ArtifactFiles, Repos, WebSearch } from '../ports/index.ts';
import { FileError, type FileAccess } from './files.ts';

/** 跑一条 yoyo 命令行（只开 agent 那部分），交回它打出的文字。 */
export type CliRun = (argv: readonly string[]) => Promise<string>;

/** agent 调 yoyo 命令行的那个工具名，子 agent 类型的工具清单里也写这个。 */
export const CLI_TOOL = 'yoyo';

export interface YoyoToolDeps {
  readonly repos: Repos;
  readonly search: WebSearch | null;
  /** 给了就加 `yoyo` 工具：用命令行查 yoyo 自己的数据。 */
  readonly cli?: CliRun;
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
    if (error instanceof TaskError || error instanceof FileError) return error.message;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return '没有这个文件';
    if (code === 'EISDIR') return '这是目录，要交文件';
    throw error;
  }
}

/**
 * 回复时可以交给模型的本地工具。只有 `llm.tools` 打开时才用。
 * `tasks` 打开时加上主线程管子任务的几个（开、列、看、取消）；子 agent 用的是另一份注册表，没有这几个。
 */
export function createYoyoTools(
  deps: YoyoToolDeps & {
    readonly tasks?: boolean;
    /** 能派的子 agent 类型；不给就只有内置的。 */
    readonly agents?: readonly AgentProfile[];
  },
): LocalToolRegistry {
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

  registry.addTool(
    'update_alarm',
    tool({
      description:
        '改一个已经设好的闹钟或定时任务，或者暂停、恢复它。先用 list_alarms 看编号，只写要改的项。暂停是到点不响、日程留着。返回改好的日程，或者说明哪里不对。',
      inputSchema: z.object({
        id: z.string().describe('日程编号，list_alarms 里的 id'),
        title: z.string().optional().describe('新的提醒内容'),
        time: z.string().optional().describe('新的时间，HH:MM，24 小时制'),
        date: z.string().optional().describe('一次性提醒的新日期：YYYY-MM-DD，或「今天」「明天」「后天」'),
        repeat: z
          .enum(['daily', 'weekdays', 'weekly', 'none'])
          .optional()
          .describe('新的重复：每天 daily，工作日 weekdays，每周 weekly；none 是改成一次性（要同时给 date）'),
        weekday: z.number().int().optional().describe('每周提醒在星期几，0 是周日'),
        kind: z.enum(['alarm', 'task']).optional().describe('alarm 是闹钟；task 是任务'),
        enabled: z.boolean().optional().describe('false 暂停，true 恢复'),
      }),
      execute: async (input) => {
        const at = now();
        try {
          const found = repos.schedule.list().find((entry) => entry.id === input.id);
          if (!found) return `没有这条日程：${input.id}，先用 list_alarms 看编号`;
          const time = input.time ?? found.time;
          return updateSchedule(repos, input.id, {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.time !== undefined ? { time: input.time } : {}),
            ...(input.date !== undefined ? { date: resolveDate(input.date, time, at) } : {}),
            ...(input.repeat !== undefined ? { repeat: input.repeat === 'none' ? null : input.repeat } : {}),
            ...(input.weekday !== undefined ? { weekday: input.weekday } : {}),
            ...(input.kind !== undefined ? { kind: input.kind } : {}),
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          });
        } catch (error) {
          return errorText(error);
        }
      },
    }),
  );

  if (deps.cli) addCliTool(registry, deps.cli);
  if (deps.tasks) addTaskTools(registry, repos, now, deps.agents ?? mergeAgents([]));
  return registry;
}

/** 把一行命令拆成参数：空白分开，单双引号里的算一个；开头的 `yoyo` 去掉。 */
export function splitCommand(command: string): string[] {
  const parts: string[] = [];
  for (const match of command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g))
    parts.push(match[1] ?? match[2] ?? match[3] ?? '');
  return parts[0] === 'yoyo' ? parts.slice(1) : parts;
}

/**
 * `yoyo` 工具：agent 用 yoyo 自己的命令行查东西，和主人在终端里敲的是同一套命令，只开标了 agent 的那部分（只读）。
 * 命令行分层给出：先看领域，再看动作，`inspect` 才给参数，所以说明里不列全部命令。
 */
function addCliTool(registry: LocalToolRegistry, cli: CliRun): void {
  registry.addTool(
    CLI_TOOL,
    tool({
      description:
        '用 yoyo 自己的命令行查 yoyo 的数据：子任务、日程、联系人、记住的事、对话历史。只读。\n' +
        'command 写 yoyo 后面的部分，例如 "task list"、"task list --state running"、"task show 3"、"search 周报"。' +
        '不知道有什么就先跑空的 ""，再 "task" 看动作，"inspect task" 看参数。',
      inputSchema: z.object({ command: z.string().describe('yoyo 后面的部分，例如 "task show 3"') }),
      execute: async ({ command }) => {
        try {
          return (await cli(splitCommand(command))) || '（没有输出）';
        } catch (error) {
          return `命令没跑成：${errorText(error)}`;
        }
      },
    }),
  );
}

/**
 * 主线程管子任务：派出去、取消、把主人的回答交给等回答的子任务。看进度和结果用 `yoyo` 工具（`yoyo task list`、`yoyo task show <编号>`）。
 * 子任务由常驻进程在后台做，做完结果会回到主线程。
 */
function addTaskTools(
  registry: LocalToolRegistry,
  repos: Repos,
  now: () => Date,
  agents: readonly AgentProfile[],
): void {
  const names = agents.map((profile) => profile.name);
  registry.addTool(
    'task_create',
    tool({
      description:
        '派一个子任务给后台的子 agent 去做：要花时间、要好几步、要查资料或整理东西的事。马上返回编号，不等做完；' +
        '做完了结果会回到这里。主人只是聊天、一两句能答的不要派。\n按事情挑一种子 agent：\n' +
        agentMenu(agents),
      inputSchema: z.object({
        title: z.string().describe('一句话标题，像待办事项，例如「整理本周周报」'),
        goal: z.string().describe('要做成什么样：背景、范围、要交回什么。写清楚，子 agent 只看得到这段'),
        criteria: z
          .array(z.string())
          .max(CRITERIA_MAX)
          .describe('验收标准，一条一句、能检查的，例如「列出每个项目本周的进展」'),
        agent: z
          .string()
          .optional()
          .describe(`哪种子 agent 来做：${names.join('、')}；不写是 ${DEFAULT_AGENT}`),
      }),
      execute: async (input) =>
        guarded(() => {
          const task = createAgentTask(repos, { ...input, origin: 'main' }, now(), names);
          return `开了子任务 #${task.id}「${task.title}」，交给 ${task.agent}，排队等着做`;
        }),
    }),
  );

  registry.addTool(
    'task_cancel',
    tool({
      description: '取消一个还开着（排队、在做、等回答）的子任务。主人说不用做了时用。',
      inputSchema: z.object({ id: z.number().int().describe('子任务编号') }),
      execute: async ({ id }) => guarded(() => `取消了子任务 #${cancelAgentTask(repos, id, now()).id}`),
    }),
  );

  registry.addTool(
    'task_answer',
    tool({
      description:
        '主人回答了某个子任务的提问：把回答交给它，它排队接着做。只对「等回答」的子任务有效；' +
        '要等主人真的说了才用，别替主人答。哪些子任务在等、问了什么，看每一轮事实里的「在等主人回答的问题」；' +
        '主人的话对不上是哪一个、或者一句话答了几个，先问清楚再交，不要把回答交错编号。',
      inputSchema: z.object({
        id: z.number().int().describe('在等回答的子任务编号'),
        answer: z.string().describe('主人的回答：原意不变，带上必要的背景，子 agent 只看得到这段'),
      }),
      execute: async ({ id, answer }) =>
        guarded(() => {
          const task = answerTask(repos, id, answer, now());
          return `回答交给子任务 #${task.id}「${task.title}」了，它排队接着做`;
        }),
    }),
  );
}

/**
 * 子 agent 自己用的：拆 todo、改 todo、交文件、问主人、交结果、交不了。都要带上子任务编号，只对在做的那个有效。
 * 加在子 agent 的注册表里，主线程看不到。
 */
export function addTaskWorkerTools(
  registry: LocalToolRegistry,
  deps: Pick<YoyoToolDeps, 'repos' | 'now'> & {
    /** 交付物的文件放哪；不给就没有 `task_deliver`。 */
    readonly files?: ArtifactFiles;
    /** 给了就能用 `path` 交工作区里已有的文件，按读文件的规则查。 */
    readonly access?: FileAccess;
  },
): void {
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
    'task_ask',
    tool({
      description:
        '做到一半真要主人拿主意（偏好、取舍、缺的信息）时问一句：子任务进入「等回答」，这一轮停下，主人回答后接着做，回答写在下一条消息里。' +
        '一次只问一个问题，写清楚背景和选项；问之前先把不用问也能做的做完，能自己查到的别问。',
      inputSchema: z.object({ id, question: z.string().describe('要问主人的话：背景、选项，一个问题') }),
      execute: async (input) =>
        guarded(() => {
          const task = askTask(repos, input.id, input.question, now());
          return `问题记下了，子任务 #${task.id} 等主人回答。这一轮到此为止：别再调别的工具，直接结束；回答来了会接着做`;
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

  const { files, access } = deps;
  if (!files) return;
  registry.addTool(
    'task_deliver',
    tool({
      description:
        '交一个文件给主人：整理好的 Markdown、CSV 表格、JSON、图片。存进这个子任务自己的交付物里，工作台能看能下载。' +
        '写出内容交用 content；已经在工作区里的文件（例如用 write 写好的，或者用 bash 跑脚本生成的）用 path 交，不用再抄一遍。' +
        `文件名只写名字（例如「周报.md」「对比.csv」），同名的会换成新的；单个最多 5 MB，一个子任务最多 ${ARTIFACTS_PER_TASK} 个。` +
        '结果里照样写结论，并说交了哪些文件。',
      inputSchema: z.object({
        id,
        name: z.string().optional().describe('文件名，带扩展名，例如「周报.md」；用 path 交时不写就用原来的名字'),
        content: z.string().optional().describe('文件内容；图片之类的二进制给 base64'),
        encoding: z.enum(['utf8', 'base64']).optional().describe('content 的写法：文字 utf8（缺省），二进制 base64'),
        path: z.string().optional().describe('交工作区里已有的文件：它的路径'),
      }),
      execute: async (input) =>
        guarded(() => {
          const { path } = input;
          if (path !== undefined && input.content !== undefined) return 'content 和 path 只给一个';
          let content: string | Uint8Array | undefined = input.content;
          let name: string | undefined = input.name;
          if (path !== undefined) {
            if (!access) return '这里不能用 path 交，把内容写进 content';
            const real = access.resolve(path, 'read');
            if (statSync(real).size > ARTIFACT_MAX) return `太大了，单个最多 5 MB：${path}`;
            content = readFileSync(real);
            name ??= basename(real);
          }
          if (content === undefined) return '要给 content，或者用 path 交工作区里的文件';
          const artifact = deliverArtifact(
            repos,
            files,
            { id: input.id, name, content, ...(input.encoding ? { encoding: input.encoding } : {}) },
            now(),
          );
          return deliveredNote({ id: input.id }, artifact, repos.artifacts.list({ task: input.id }).length);
        }),
    }),
  );
}
