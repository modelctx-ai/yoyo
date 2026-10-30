import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'vite-plus/test';

import {
  createContext,
  createMemoryStore,
  createOrchestrator,
  type LocalToolRegistry,
  type ToolOutput,
} from '@modelctx-ai/ctx';
import { MockLanguageModelV4 } from 'ai/test';

import type { ActivityRecord, ScheduleItem } from '../kernel/types.ts';
import type { Repos, WebSearch } from '../ports/index.ts';
import { generateReply } from './compose.ts';
import { recordUser, yoyoProjection } from './context.ts';
import { createYoyoHarness } from './harness.ts';
import { createRepos } from '../storage/repos.ts';
import { addTaskWorkerTools, createYoyoTools } from './tools.ts';

type DoGenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** 只在内存里的 Repos，够工具用。 */
function memoryRepos(): Repos & { readonly events: ActivityRecord[] } {
  const schedule: ScheduleItem[] = [];
  const events: ActivityRecord[] = [];
  const kv = new Map<string, string>();
  return {
    events,
    contacts: { list: () => [], insert: () => {}, remove: () => false },
    schedule: {
      list: () => schedule.toSorted((a, b) => a.time.localeCompare(b.time)),
      insert: (item) => {
        schedule.push(item);
      },
      markFired: (id, occurrence) => {
        const index = schedule.findIndex((item) => item.id === id);
        const found = schedule[index];
        if (found) schedule[index] = { ...found, lastFired: occurrence };
      },
      remove: () => false,
    },
    clipboard: { list: () => [], insert: () => {} },
    memes: { read: () => null, write: () => {} },
    activity: {
      record: (event) => {
        events.push({ ...event, at: new Date(0).toISOString() });
      },
      list: (limit = 20) => events.slice(-limit),
    },
    spoken: { recent: () => [], remember: () => {} },
    kv: {
      get: (key) => kv.get(key) ?? null,
      set: (key, value) => {
        kv.set(key, value);
      },
    },
    tasks: { list: () => [] },
    agentTasks: createRepos(new DatabaseSync(':memory:')).agentTasks,
  };
}

function searcher(result: string | Error, queries: string[] = []): WebSearch {
  return {
    search: async (query) => {
      queries.push(query);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

/** 经注册表包好的工具执行一次，拆出结果：文字是字符串，JSON 是原值。 */
async function run(registry: LocalToolRegistry, name: string, input: unknown = {}): Promise<unknown> {
  const picked = registry.toolSet([name])[name];
  assert.ok(picked?.execute, `没有工具 ${name}`);
  const output = (await picked.execute(input, { toolCallId: 'c1', messages: [], context: {} })) as ToolOutput;
  if (output.type === 'text') return output.text;
  if (output.type === 'json') return output.value;
  throw new Error(`工具 ${name} 的结果是 ${output.type}`);
}

/** 2026-10-23（周五）14:10，本地时间。 */
const NOW = new Date(2026, 9, 23, 14, 10);

/** 在 `now` 这一刻加一条提醒，返回它落到的日期。 */
async function dateOf(now: Date, input: Record<string, unknown>): Promise<string | null> {
  const tools = createYoyoTools({ repos: memoryRepos(), search: null, now: () => now });
  return ((await run(tools, 'add_alarm', { title: '提醒', ...input })) as ScheduleItem).date;
}

const TAIPEI = JSON.stringify({ name: '台北', latitude: 25.0375, longitude: 121.5637 });

function forecast(status = 200): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fake = async (input: string | URL | Request) => {
    urls.push(input instanceof Request ? input.url : String(input));
    if (status !== 200) return new Response('{}', { status });
    const time = Array.from({ length: 8 }, (_, i) => `2026-10-23T${String(14 + i).padStart(2, '0')}:00`);
    return Response.json({
      hourly: {
        time,
        temperature_2m: [20, 20.4, 21, 21, 19, 18, 18, 17],
        precipitation_probability: [0, 0, 10, 10, 60, 70, 20, 0],
        weather_code: [0, 0, 2, 2, 61, 61, 3, 3],
      },
    });
  };
  return { fetch: fake, urls };
}

describe('brain/tools', () => {
  test('注册表里有搜索、天气、闹钟；没有搜索就不给 web_search', () => {
    const repos = memoryRepos();
    const full = createYoyoTools({ repos, search: searcher('x') });
    assert.deepEqual(
      full.list().map((info) => `${info.name}@${info.source}`),
      ['web_search@local', 'weather_forecast@local', 'list_alarms@local', 'add_alarm@local'],
    );
    const offline = createYoyoTools({ repos, search: null });
    assert.deepEqual(
      offline.list().map((info) => info.name),
      ['weather_forecast', 'list_alarms', 'add_alarm'],
    );
  });

  test('web_search 调搜索并记一条 search；搜不到或出错也回一句话', async () => {
    const repos = memoryRepos();
    const queries: string[] = [];
    const found = createYoyoTools({ repos, search: searcher('台北今天晴，28 度', queries) });
    assert.equal(await run(found, 'web_search', { query: '台北天气' }), '台北今天晴，28 度');
    assert.deepEqual(queries, ['台北天气']);
    assert.deepEqual(
      repos.events.map((event) => `${event.type}:${String(event['query'])}`),
      ['search:台北天气'],
    );
    assert.equal(await run(createYoyoTools({ repos, search: searcher('  ') }), 'web_search', { query: 'x' }), '没搜到');
    assert.equal(
      await run(createYoyoTools({ repos, search: searcher(new Error('anysearch 退出 1')) }), 'web_search', {
        query: 'x',
      }),
      '搜索没做成：anysearch 退出 1',
    );
    assert.equal(repos.events.length, 1, '没搜到不记');
  });

  test('weather_forecast 用存过的地点查接下来几个小时，不带「快下班啦」', async () => {
    const repos = memoryRepos();
    repos.kv.set('place', TAIPEI);
    const { fetch, urls } = forecast();
    const tools = createYoyoTools({ repos, search: null, fetch, now: () => NOW });
    assert.equal(
      await run(tools, 'weather_forecast'),
      '台北接下来几个小时，14点左右 20 度，晴；16点左右 21 度，多云；18点左右 19 度，下雨，降雨大概 60%。出门记得带伞。',
    );
    assert.equal(urls.length, 1);
    assert.match(urls[0]!, /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?latitude=25\.0375/);
  });

  test('weather_forecast 查不到就照实说', async () => {
    const repos = memoryRepos();
    repos.kv.set('place', TAIPEI);
    const tools = createYoyoTools({ repos, search: null, fetch: forecast(500).fetch, now: () => NOW });
    assert.equal(await run(tools, 'weather_forecast'), '天气没查到：天气接口 500');
  });

  test('子任务：主线程能派、列、看、取消；子 agent 那份没有派的，只有拆 todo、标状态、交结果、交不了', async () => {
    const repos = memoryRepos();
    const main = createYoyoTools({ repos, search: null, tasks: true, now: () => NOW });
    assert.deepEqual(
      main
        .list()
        .map((info) => info.name)
        .filter((name) => name.startsWith('task_')),
      ['task_create', 'task_list', 'task_show', 'task_cancel'],
    );
    const worker = createYoyoTools({ repos, search: null });
    addTaskWorkerTools(worker, { repos, now: () => NOW });
    assert.deepEqual(
      worker
        .list()
        .map((info) => info.name)
        .filter((name) => name.startsWith('task_')),
      ['task_plan', 'task_todo', 'task_finish', 'task_fail'],
    );

    assert.equal(
      await run(main, 'task_create', { title: '整理周报', goal: '本周进展', criteria: ['三个项目都有'] }),
      '开了子任务 #1「整理周报」，排队等着做',
    );
    assert.equal(await run(main, 'task_create', { title: ' ', goal: 'x', criteria: [] }), '标题不能空着');
    assert.equal(await run(main, 'task_list'), '#1\t排队\t-\t整理周报');
    assert.match(String(await run(main, 'task_show', { id: 1 })), /^#1 整理周报（排队）/);
    assert.equal(await run(main, 'task_show', { id: 9 }), '没有子任务 #9');
    assert.equal(repos.agentTasks.get(1)?.origin, 'main');

    // 子 agent 的工具只对在做的任务有效，规则不让做的原样交回去
    assert.equal(await run(worker, 'task_plan', { id: 1, todos: ['收集'] }), '子任务 #1 现在是「排队」，不能再改');
    repos.agentTasks.update(1, { state: 'running' }, NOW.getTime());
    assert.equal(await run(worker, 'task_plan', { id: 1, todos: ['收集', '写'] }), 'todo 定好了，一共 2 项');
    assert.equal(await run(worker, 'task_todo', { id: 1, index: 1, state: 'done' }), '改好了，还剩 1 项');
    assert.equal(
      await run(worker, 'task_finish', { id: 1, result: '周报', checks: [] }),
      '还有 todo 没做完：2. 写。做完或跳过再交',
    );
    assert.equal(
      await run(worker, 'task_todo', { id: 1, index: 2, state: 'done' }),
      '改好了，todo 都做完了；对一遍验收标准再交结果',
    );
    const checks = [{ criterion: '三个项目都有', met: true, evidence: '有' }];
    assert.equal(await run(worker, 'task_finish', { id: 1, result: '周报', checks }), '交好了，子任务 #1 做完');
    assert.equal(await run(main, 'task_cancel', { id: 1 }), '子任务 #1 已经「做完」');
  });

  test('add_alarm 存进日程并记 schedule-add；写错了回校验文案；list_alarms 列出来', async () => {
    const repos = memoryRepos();
    const tools = createYoyoTools({ repos, search: null, now: () => NOW });
    const saved = (await run(tools, 'add_alarm', { title: '喝水', time: '15:30', repeat: 'daily' })) as ScheduleItem;
    assert.equal(saved.title, '喝水');
    assert.equal(saved.kind, 'alarm');
    assert.equal(saved.repeat, 'daily');
    assert.equal(saved.date, null);
    assert.match(saved.id, /^s_/);
    assert.deepEqual(
      repos.events.map((event) => event.type),
      ['schedule-add'],
    );
    assert.equal(await run(tools, 'add_alarm', { title: '开会', time: '25:00' }), '时间要写成 HH:MM');
    assert.equal(
      await run(tools, 'add_alarm', { title: '周会', time: '09:00', repeat: 'weekly' }),
      'weekly 要指定 weekday，0 是周日',
    );
    const weekly = (await run(tools, 'add_alarm', {
      title: '周会',
      time: '09:00',
      repeat: 'weekly',
      weekday: 1,
      kind: 'task',
    })) as ScheduleItem;
    assert.equal(weekly.weekday, 1);
    assert.equal(weekly.kind, 'task');
    assert.deepEqual(
      ((await run(tools, 'list_alarms')) as ScheduleItem[]).map((item) => `${item.time} ${item.title}`),
      ['09:00 周会', '15:30 喝水'],
    );
  });

  test('一次性提醒不写日期就取最近的那个时间点，也认今天、明天、后天', async () => {
    assert.equal(await dateOf(NOW, { time: '15:00' }), '2026-10-23');
    assert.equal(await dateOf(NOW, { time: '14:10' }), '2026-10-23');
    assert.equal(await dateOf(NOW, { time: '09:00' }), '2026-10-24');
    assert.equal(await dateOf(NOW, { time: '09:00', date: '今天' }), '2026-10-23');
    assert.equal(await dateOf(NOW, { time: '09:00', date: '明天' }), '2026-10-24');
    assert.equal(await dateOf(NOW, { time: '09:00', date: '后天' }), '2026-10-25');
    assert.equal(await dateOf(NOW, { time: '09:00', date: '2026-12-01' }), '2026-12-01');
    assert.equal(await dateOf(new Date(2026, 9, 31, 23, 0), { time: '08:00' }), '2026-11-01');
  });

  test('回复时模型真的能调到 add_alarm，参数按 schema 校验后交给日程', async () => {
    const repos = memoryRepos();
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'c1',
              toolName: 'add_alarm',
              input: JSON.stringify({ title: '开周会', time: '08:00', date: '明天' }),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          usage,
          warnings: [],
        } satisfies DoGenerateResult,
        {
          content: [{ type: 'text', text: '好，明早八点叫你开周会。' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage,
          warnings: [],
        } satisfies DoGenerateResult,
      ],
    });
    const context = createContext({
      store: createMemoryStore(),
      session: 'pet:main',
      projection: yoyoProjection,
      tools: createYoyoTools({ repos, search: null, now: () => NOW }),
    });
    await recordUser(context, '明天早上八点提醒我开周会', 1);
    const runs = createOrchestrator({ harness: createYoyoHarness(context) });
    const line = await generateReply(context, runs, { tone: 'warm', model, tools: true });
    assert.equal(line.text, '好，明早八点叫你开周会。');
    assert.deepEqual(
      repos.schedule.list().map((item) => `${item.date} ${item.time} ${item.title}`),
      ['2026-10-24 08:00 开周会'],
    );
    assert.deepEqual(
      model.doGenerateCalls[0]!.tools?.map((item) => item.name),
      ['weather_forecast', 'list_alarms', 'add_alarm'],
    );
  });
});
