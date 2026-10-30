import assert from 'node:assert/strict';
import { describe, test } from 'vite-plus/test';

import { createContext, createMemoryStore, type ContextSource } from '@modelctx-ai/ctx';

import type { ClipEntry, WorkStatus } from '../kernel/types.ts';
import type { ClipboardRepo, TaskRepo } from '../ports/index.ts';
import { memoryRepos } from '../runtime/testing.ts';
import { agentTasksSource, clipboardSource, taskSource } from './sources.ts';

function host(status: WorkStatus | null | Error) {
  return {
    workStatus: async () => {
      if (status instanceof Error) throw status;
      return status;
    },
  };
}

function tasks(list: readonly string[] | Error): { tasks: TaskRepo } {
  return {
    tasks: {
      list: () => {
        if (list instanceof Error) throw list;
        return [...list];
      },
    },
  };
}

function clips(texts: readonly string[]): { clipboard: ClipboardRepo } {
  const items: ClipEntry[] = texts.map((text, i) => ({ text, at: new Date(1_000 * i).toISOString() }));
  return {
    clipboard: {
      list: (limit = 50) => items.slice(0, limit),
      insert: (entry) => {
        items.unshift(entry);
      },
    },
  };
}

function collect(source: ContextSource) {
  return source.collect({ session: 'pet:main' });
}

describe('brain/sources', () => {
  test('当前任务优先用桌宠的任务，去掉首尾空白', async () => {
    const source = taskSource({ host: host({ task: '  修天气地点 ', state: 'coding' }), repos: tasks([]) });
    assert.equal(source.name, 'task');
    assert.equal(await collect(source), '当前任务：修天气地点');
  });

  test('没有任务就用工作状态', async () => {
    assert.equal(
      await collect(taskSource({ host: host({ task: '  ', state: 'coding' }), repos: tasks([]) })),
      '当前任务：coding',
    );
  });

  test('本地任务取前 5 条，用「；」接在后面', async () => {
    const source = taskSource({
      host: host({ task: '写周报', state: null }),
      repos: tasks(['一', '二', '三', '四', '五', '六']),
    });
    assert.equal(await collect(source), '当前任务：写周报；一；二；三；四；五');
  });

  test('桌宠读不到也照样带本地任务；两边都没有就不出声', async () => {
    assert.equal(
      await collect(taskSource({ host: host(new Error('桌宠没开')), repos: tasks(['买菜']) })),
      '当前任务：买菜',
    );
    assert.equal(await collect(taskSource({ host: host(new Error('桌宠没开')), repos: tasks([]) })), null);
    assert.equal(await collect(taskSource({ host: host(null), repos: tasks(new Error('坏了')) })), null);
  });

  test('粘贴板取最新一条，去掉首尾空白，最多 160 字', async () => {
    assert.equal(await collect(clipboardSource(clips(['  最新的 \n', '旧的']))), '粘贴板：最新的');
    const long = await collect(clipboardSource(clips(['长'.repeat(200)])));
    assert.equal(long, `粘贴板：${'长'.repeat(160)}`);
    assert.equal(await collect(clipboardSource(clips([]))), null);
    assert.equal(await collect(clipboardSource(clips(['   ']))), null);
  });

  test('子任务：排队、在做、等回答的每一轮都列出来，等回答的带着问题；做完的不列', async () => {
    const repos = memoryRepos({ now: () => new Date(1_000) });
    const make = (title: string, state: 'queued' | 'running' | 'waiting' | 'done', question?: string) => {
      const task = repos.agentTasks.create({ title, goal: '目标', criteria: [], agent: 'general', origin: 'main' }, 1);
      repos.agentTasks.update(task.id, { state, ...(question ? { question, askedAt: 2 } : {}) }, 2);
    };
    const source = agentTasksSource(repos);
    assert.equal(source.name, 'tasks');
    assert.equal(await collect(source), null);
    make('做封面', 'waiting', '蓝色还是绿色？');
    make('周报', 'running');
    make('旧的', 'done');
    const fact = await collect(source);
    assert.match(String(fact), /^子任务：\n#2\t在做\t-\t周报\n#1\t等回答\t-\t做封面\n\n在等主人回答的问题/);
    assert.match(String(fact), /#1「做封面」问：蓝色还是绿色？$/);
    assert.doesNotMatch(String(fact), /旧的/);
  });

  test('接进上下文后按顺序成为这一次的事实', async () => {
    const context = createContext({
      store: createMemoryStore(),
      session: 'pet:main',
      sources: [
        taskSource({ host: host({ task: '修天气地点', state: null }), repos: tasks([]) }),
        clipboardSource(clips(['https://example.com/issue/1'])),
      ],
    });
    assert.deepEqual(await context.facts(), [
      { source: 'task', text: '当前任务：修天气地点' },
      { source: 'clipboard', text: '粘贴板：https://example.com/issue/1' },
    ]);
  });
});
