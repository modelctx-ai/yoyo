import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'vite-plus/test';

import { assistantEntry, eventEntry, userEntry } from '@modelctx-ai/ctx';

import type { AppOverrides } from '../app/container.ts';
import { resolvePaths, type Paths } from '../app/paths.ts';
import { createYoyoContext } from '../brain/context.ts';
import { localDateKey } from '../kernel/time.ts';
import { directorAlive, drain, writePid } from '../runtime/inbox.ts';
import {
  fakeHost,
  fakePlayer,
  fakeSearch,
  fakeSfx,
  fakeSynthesizer,
  memoryLogger,
  type MemoryLogger,
} from '../runtime/testing.ts';
import { buildDomains, createCommandEnv, type CommandEnv } from './commands.ts';
import { dispatch } from './registry.ts';

const NOW = new Date(2026, 9, 24, 15, 0, 0);

interface Cli {
  readonly env: CommandEnv;
  readonly paths: Paths;
  readonly lines: string[];
  readonly logger: MemoryLogger;
  /** 跑一条命令，返回这条命令打印的行。 */
  readonly run: (...argv: string[]) => Promise<string[]>;
}

function cli(options: { readonly config?: unknown; readonly overrides?: AppOverrides } = {}): Cli {
  const home = mkdtempSync(join(tmpdir(), 'yoyo-'));
  const paths = resolvePaths({ YOYO_HOME: home, YOYO_CONFIG: join(home, 'config.json') });
  if (options.config !== undefined) writeFileSync(paths.configFile, JSON.stringify(options.config));
  const lines: string[] = [];
  const logger = memoryLogger();
  const env = createCommandEnv(paths, {
    out: (text) => void lines.push(text),
    logger,
    now: () => NOW,
    ...(options.overrides ? { overrides: options.overrides } : {}),
  });
  const domains = buildDomains(env);
  return {
    env,
    paths,
    lines,
    logger,
    run: async (...argv) => {
      const start = lines.length;
      const result = dispatch(domains, argv);
      if (result.kind === 'text') lines.push(result.text);
      else await result.verb.run(result.flags);
      return lines.slice(start);
    },
  };
}

/** 能直接当导演跑的配置：控制台舞台，语音配齐，没有模型。 */
const CONSOLE_CONFIG = { stage: 'console', speech: { apiKey: 'fish-key', referenceId: 'ref' } };

function quietServices(calls: string[]): AppOverrides {
  return { synthesizer: fakeSynthesizer(calls), player: fakePlayer(calls), sfx: fakeSfx(calls) };
}

describe('commands', () => {
  test('日程：加一条再列出来，格式和以前一样；没有 config.json 也能用', async () => {
    const { run } = cli();
    assert.deepEqual(await run('alarm', 'list'), ['还没有日程']);
    assert.deepEqual(await run('alarm', 'add', '--title', '喝水', '--time', '15:30', '--repeat', 'daily'), [
      'alarm\t15:30\t喝水',
    ]);
    assert.deepEqual(
      await run('alarm', 'add', '--title', '开会', '--time', '09:30', '--date', '2026-10-26', '--kind', 'task'),
      ['task\t09:30\t开会'],
    );
    assert.deepEqual(await run('alarm', 'list'), ['task\t09:30\t2026-10-26\t开会', 'alarm\t15:30\tdaily\t喝水']);
    await assert.rejects(run('alarm', 'add', '--time', '15:30', '--repeat', 'daily'), /日程要有标题/);
    await assert.rejects(run('alarm', 'add', '--title', '周会', '--time', '10:00', '--repeat', 'weekly'), /weekday/);
  });

  test('联系人：contract 也能用；log tail 记着做过的事', async () => {
    const { run } = cli();
    assert.deepEqual(await run('contact', 'list'), ['还没有联系人']);
    assert.deepEqual(await run('log', 'tail'), ['还没有记录']);
    assert.deepEqual(
      await run('contract', 'add', '--name', '小王', '--yoyo', 'yoyo://xiaowang@example', '--note', '同事'),
      ['小王\tyoyo://xiaowang@example'],
    );
    assert.deepEqual(await run('contact', 'list'), ['小王\tyoyo://xiaowang@example\t同事']);
    const log = await run('log', 'tail');
    assert.equal(log.length, 1);
    assert.match(log[0] ?? '', /^\d{4}-\d{2}-\d{2}T[^\t]+\tcontact-add$/);
  });

  test('粘贴板：get 读当前内容，history 是 yoyo 记下的变化', async () => {
    let text = '  复制的一段话  ';
    const { run, env } = cli({ overrides: { clipboard: { read: () => text } } });
    assert.deepEqual(await run('clip', 'get'), ['复制的一段话']);
    text = '';
    assert.deepEqual(await run('clip', 'get'), ['粘贴板是空的']);
    assert.deepEqual(await run('clip', 'history'), ['还没有复制记录']);
    env.repos().clipboard.insert({ text: '第一行\n第二行', at: '2026-10-24T07:00:00.000Z' });
    assert.deepEqual(await run('clip', 'history'), ['2026-10-24T07:00:00.000Z\t第一行 第二行']);
  });

  test('表情包：list 看现在这套；refresh 现在就搜一套', async () => {
    const calls: string[] = [];
    const found = '看 https://example.com/a.png 和 https://example.com/b.gif';
    const { run, env } = cli({
      config: CONSOLE_CONFIG,
      overrides: { ...quietServices(calls), search: fakeSearch(calls, found) },
    });
    assert.deepEqual(await run('meme', 'list'), ['还没有表情包']);
    assert.deepEqual(await run('meme', 'refresh'), ['2张']);
    assert.deepEqual(calls, ['search:可爱表情包 png']);
    assert.deepEqual(await run('meme', 'list'), [
      `${NOW.toISOString()}\t2张`,
      'https://example.com/a.png',
      'https://example.com/b.gif',
    ]);
    assert.equal(env.repos().activity.list(5).at(-1)?.type, 'meme-pack');
  });

  test('context tail 只列消息和碎碎念的最后 12 条', async () => {
    const { run, env } = cli();
    assert.deepEqual(await run('context', 'tail'), ['还没有上下文']);
    const context = await createYoyoContext({ db: env.db(), petId: 'main' });
    await context.append(eventEntry('whisper', { text: '最早的碎碎念', at: 1 }));
    for (let i = 0; i < 6; i += 1) {
      await context.append(
        userEntry(`第 ${i} 句\n换行`, { at: 10 + i * 2 }),
        assistantEntry(`回 ${i}`, { at: 11 + i * 2 }),
      );
    }
    await context.append(
      eventEntry('meme-pack', { text: '不列', at: 100 }),
      // 框架事件也不列
      eventEntry('ctx.compacted', { text: '不列', at: 100 }),
      eventEntry('whisper', { text: '最后一句', at: 101 }),
    );
    const rows = await run('context', 'tail');
    assert.equal(rows.length, 12);
    assert.equal(rows[0], 'assistant\t回 0');
    assert.equal(rows[1], 'user\t第 1 句 换行');
    assert.equal(rows.at(-1), 'whisper\t最后一句');
    assert.equal(rows.includes('meme-pack\t不列'), false);
    assert.equal(rows.includes('ctx.compacted\t不列'), false);
  });

  test('context compact：没配模型就说一句', async () => {
    const { run } = cli({ config: {} });
    assert.deepEqual(await run('context', 'compact'), ['还没配好 llm，压缩要用模型']);
  });

  test('chat sync：导演没在跑就提示；在跑就用记下的渠道接上', async () => {
    const calls: string[] = [];
    const { run, env, paths } = cli({
      config: { llm: { baseUrl: 'https://llm.example/v1', apiKey: 'llm-key', model: 'mock-model' } },
      overrides: { host: fakeHost(calls) },
    });
    assert.deepEqual(await run('chat', 'sync'), ['导演没在跑，上下文代理还没起来']);
    env.repos().kv.set('channel-base', 'http://127.0.0.1:4567/v1');
    env.repos().kv.set('channel-token', 'local-token');
    assert.deepEqual(await run('chat', 'sync'), ['导演没在跑，上下文代理还没起来'], '记下的渠道是上次的');
    writePid(paths.pidFile);
    assert.deepEqual(await run('chat'), ['yoyo chat <动作>\n\nsync       把渠道接到桌宠对话']);
    assert.deepEqual(await run('chat', 'sync'), ['已接上 mock-model']);
    assert.deepEqual(calls, ['bind:http://127.0.0.1:4567/v1']);
  });

  test('listen、whisper：导演在跑就交给它', async () => {
    const { run, paths } = cli();
    writePid(paths.pidFile);
    assert.equal(directorAlive(paths.pidFile), true);
    assert.deepEqual(await run('whisper'), ['已交给正在运行的 yoyo：whisper']);
    assert.deepEqual(await run('listen', 'now'), ['已交给正在运行的 yoyo：listen']);
    assert.deepEqual(
      drain(paths.inboxFile).map((message) => message.type),
      ['whisper', 'listen'],
    );
  });

  test('whisper：导演没在跑就当场说一句；驱动桌宠时语音没配好先报出来', async () => {
    const calls: string[] = [];
    const { run, env, logger } = cli({ config: CONSOLE_CONFIG, overrides: quietServices(calls) });
    // 导演用真时钟：先记下今天报过天气，免得赶上下班时间去联网查
    env.repos().kv.set('weather-date', localDateKey(new Date()));
    assert.deepEqual(await run('whisper'), []);
    assert.equal(calls[0]?.startsWith('synth:'), true);
    assert.ok(calls.some((call) => call.startsWith('play:')));
    assert.ok(
      logger.lines.some((line) => line.startsWith('[')),
      '控制台舞台把台词打印出来',
    );
    assert.deepEqual(
      env
        .repos()
        .activity.list(10)
        .map((event) => event.type)
        .slice(-1),
      ['sfx'],
    );

    // 驱动桌宠时语音必须配好；控制台舞台不用，没配就只打印台词
    const bare = cli({ config: {} });
    await assert.rejects(bare.run('whisper'), /speech\.apiKey 还空着/);
    const quiet = cli({ config: { stage: 'console' }, overrides: { platform: 'linux' } });
    quiet.env.repos().kv.set('weather-date', localDateKey(new Date()));
    assert.deepEqual(await quiet.run('whisper'), []);
    assert.ok(quiet.logger.lines.some((line) => line.startsWith('[')));
    assert.deepEqual(
      quiet.env
        .repos()
        .activity.list(10)
        .map((event) => event.type)
        .slice(-1),
      ['sfx'],
    );
  });
});
