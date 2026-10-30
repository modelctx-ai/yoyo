import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'vite-plus/test';

import { createCliRunner } from './cli.ts';
import { resolvePaths } from './paths.ts';

function home(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'yoyo-cli-'));
  return { ...process.env, YOYO_HOME: dir, YOYO_CONFIG: join(dir, 'config.json') };
}

describe('agent 跑命令行', () => {
  // 起五次真的命令行（每次一个 Node 进程）：慢的机器上（例如发版流水线的 Intel runner）5 秒不够
  test('另起进程跑真的命令行，只看得到、只调得了 agent 那部分；报错的话也交回来', async () => {
    const env = home();
    const run = createCliRunner(resolvePaths(env), { env });
    const index = await run([]);
    assert.match(index, /^yoyo <领域> \[动作\]/);
    assert.match(index, /\ntask +子任务/);
    assert.match(index, /\nsearch +在对话/);
    for (const hidden of ['listen', 'whisper', 'update', 'web', 'clip', 'meme']) {
      assert.equal(new RegExp(`\\n${hidden} `).test(index), false, hidden);
    }
    assert.equal(await run(['task', 'list']), '还没有子任务');
    assert.match(await run(['task', 'add', '--title', 'x', '--goal', 'y']), /^yoyo task <动作>/, '改东西的动作没有');
    assert.match(await run(['update', 'install']), /^没有 update/);
    assert.equal(await run(['task', 'show', 'x']), '要给子任务编号，例如 yoyo task show 3');
  }, 30_000);

  test('跑太久就停下', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yoyo-cli-'));
    const entry = join(dir, 'slow.mjs');
    writeFileSync(entry, 'setTimeout(() => {}, 10_000);\n');
    const run = createCliRunner({ cliEntry: entry }, { timeoutMs: 100 });
    await assert.rejects(run(['task', 'list']), /命令跑太久，停下了/);
  });
});
