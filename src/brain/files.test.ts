import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'vite-plus/test';

import { createToolRegistry, type LocalToolRegistry, type ToolOutput } from '@modelctx-ai/ctx';

import { parseConfig } from '../app/config.ts';
import { resolvePaths } from '../app/paths.ts';
import { memoryRepos } from '../runtime/testing.ts';
import { READ_LINES, addFileTools, createFileAccess, readLines } from './files.ts';

/** 一个假的主目录：数据目录、工作区、交付物、文稿、密钥都在里面。 */
function rig(files: Record<string, unknown> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'yoyo-home-'));
  const paths = resolvePaths({ YOYO_HOME: join(home, '.yoyo'), YOYO_CONFIG: join(home, '.yoyo', 'config.json') });
  mkdirSync(join(home, '.yoyo', 'artifacts', '3'), { recursive: true });
  writeFileSync(join(home, '.yoyo', 'config.json'), '{"llm":{"apiKey":"secret"}}');
  writeFileSync(join(home, '.yoyo', 'yoyo.db'), 'db');
  writeFileSync(join(home, '.yoyo', 'artifacts', '3', '周报.md'), '# 周报');
  mkdirSync(join(home, 'Documents', 'private'), { recursive: true });
  writeFileSync(join(home, 'Documents', 'plan.md'), '计划');
  writeFileSync(join(home, 'Documents', 'private', 'pin.txt'), '1234');
  mkdirSync(join(home, '.ssh'));
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'key');
  const config = parseConfig({ files: { readable: ['~/Documents'], denyRead: ['~/Documents/private'], ...files } });
  const access = createFileAccess({ config: config.files, paths, home });
  const repos = memoryRepos();
  const registry = createToolRegistry();
  addFileTools(registry, { access, repos, allow: config.files });
  return { home, access, repos, registry, workspace: access.workspace };
}

async function run(tools: LocalToolRegistry, name: string, input: unknown): Promise<string> {
  const picked = tools.toolSet([name])[name];
  assert.ok(picked?.execute, `没有工具 ${name}`);
  const output = (await picked.execute(input, { toolCallId: 'c1', messages: [], context: {} })) as ToolOutput;
  assert.equal(output.type, 'text', JSON.stringify(output));
  return output.type === 'text' ? output.text : '';
}

describe('读写文件的工具', () => {
  test('工作区缺省在数据目录下，建好；三个工具都在，开关关掉的就没有', () => {
    const { registry, workspace, home } = rig();
    assert.equal(workspace.endsWith(join('.yoyo', 'workspace')), true);
    assert.deepEqual(
      registry.list().map((definition) => definition.name),
      ['read', 'write', 'edit'],
    );
    const paths = resolvePaths({ YOYO_HOME: join(home, '.yoyo'), YOYO_CONFIG: join(home, 'c.json') });
    const config = parseConfig({ files: { write: 'deny', edit: 'deny', read: 'nope' } });
    const only = createToolRegistry();
    addFileTools(only, {
      access: createFileAccess({ config: config.files, paths, home }),
      repos: memoryRepos(),
      allow: config.files,
    });
    assert.deepEqual(
      only.list().map((definition) => definition.name),
      ['read'],
      '写错的按 allow',
    );
  });

  test('写：相对路径从工作区算，目录不在就建；写不出工作区；记进轨迹', async () => {
    const { registry, workspace, repos, home } = rig();
    assert.equal(
      await run(registry, 'write', { path: 'notes/周报.md', content: '# 周报\nA\n' }),
      '写好了：notes/周报.md（2 行，11 B）',
    );
    assert.equal(readFileSync(join(workspace, 'notes', '周报.md'), 'utf8'), '# 周报\nA\n');
    assert.deepEqual(repos.activity.list(1)[0], {
      at: repos.activity.list(1)[0]?.at,
      type: 'file-write',
      path: 'notes/周报.md',
      size: 11,
    });
    assert.match(await run(registry, 'write', { path: '../x.md', content: 'x' }), /只能写在工作区里|不给读写/);
    assert.match(await run(registry, 'write', { path: '~/Documents/plan.md', content: 'x' }), /只能写在工作区里/);
    assert.equal(readFileSync(join(home, 'Documents', 'plan.md'), 'utf8'), '计划');
  });

  test('读：文件带行号，目录列出来；只读目录和交付物读得到；配置、库、密钥、禁读的读不到', async () => {
    const { registry, home } = rig();
    await run(registry, 'write', { path: 'a.md', content: '一\n二\n三' });
    assert.equal(await run(registry, 'read', { path: 'a.md' }), '1\t一\n2\t二\n3\t三');
    assert.equal(
      await run(registry, 'read', { path: 'a.md', offset: 2, limit: 1 }),
      '2\t二\n……一共 3 行，从第 3 行接着读（offset）',
    );
    assert.equal(await run(registry, 'read', { path: '.' }), 'a.md\t11 B');
    assert.equal(await run(registry, 'read', { path: '~/Documents' }), 'plan.md\t6 B\nprivate/');
    assert.equal(await run(registry, 'read', { path: join(home, '.yoyo', 'artifacts', '3', '周报.md') }), '1\t# 周报');
    for (const path of ['~/.yoyo/config.json', '~/.yoyo/yoyo.db', '~/.ssh/id_ed25519', '~/Documents/private/pin.txt']) {
      assert.match(await run(registry, 'read', { path }), /不给读写/, path);
    }
    assert.match(await run(registry, 'read', { path: '/etc/hosts' }), /读不到工作区和 files\.readable 以外/);
    assert.equal(await run(registry, 'read', { path: 'nope.md' }), '没有这个文件或目录');
  });

  test('符号链接指到外面也出不去', async () => {
    const { registry, workspace, home } = rig();
    symlinkSync(join(home, '.yoyo', 'config.json'), join(workspace, 'config-link.json'));
    symlinkSync(join(home, '.ssh'), join(workspace, 'keys'));
    assert.match(await run(registry, 'read', { path: 'config-link.json' }), /不给读写/);
    assert.match(await run(registry, 'read', { path: 'keys/id_ed25519' }), /不给读写/);
    assert.match(await run(registry, 'write', { path: 'keys/new', content: 'x' }), /不给读写/);
  });

  test('二进制不给内容；长文件分段读', async () => {
    const { registry, workspace } = rig();
    writeFileSync(join(workspace, 'b.bin'), Buffer.from([0, 1, 2, 3]));
    assert.equal(await run(registry, 'read', { path: 'b.bin' }), '二进制文件（4 B），读不了内容');
    const long = Array.from({ length: READ_LINES + 5 }, (_, i) => `第 ${i + 1} 行`).join('\n');
    assert.match(readLines(long), new RegExp(`……一共 ${READ_LINES + 5} 行，从第 ${READ_LINES + 1} 行接着读`));
    assert.equal(readLines(''), '（空文件）');
    assert.equal(readLines('a', 5), '文件只有 1 行');
  });

  test('改：原文一字不差、只出现一次才换；all 全换；改不了的说清楚', async () => {
    const { registry, workspace, repos } = rig();
    await run(registry, 'write', { path: 'a.md', content: 'A 上线\nB 在测\nB 在测' });
    assert.equal(
      await run(registry, 'edit', { path: 'a.md', old: 'A 上线', new: 'A 全量' }),
      '改好了：a.md，换了 1 处',
    );
    assert.match(await run(registry, 'edit', { path: 'a.md', old: 'B 在测', new: 'B 提测' }), /出现了 2 次/);
    assert.equal(
      await run(registry, 'edit', { path: 'a.md', old: 'B 在测', new: 'B 提测', all: true }),
      '改好了：a.md，换了 2 处',
    );
    assert.equal(readFileSync(join(workspace, 'a.md'), 'utf8'), 'A 全量\nB 提测\nB 提测');
    assert.match(await run(registry, 'edit', { path: 'a.md', old: '没有的', new: 'x' }), /没找到要换的原文/);
    assert.match(await run(registry, 'edit', { path: 'a.md', old: '', new: 'x' }), /原文不能空着/);
    assert.match(
      await run(registry, 'edit', { path: '~/Documents/plan.md', old: '计划', new: 'x' }),
      /只能写在工作区里/,
    );
    assert.equal(await run(registry, 'edit', { path: 'b.md', old: 'a', new: 'b' }), '没有这个文件或目录');
    assert.equal(repos.activity.list(1)[0]?.type, 'file-edit');
    // $ 在新文里照原样写进去，不当替换模式
    assert.equal(await run(registry, 'edit', { path: 'a.md', old: 'A 全量', new: '$& $1' }), '改好了：a.md，换了 1 处');
    assert.match(readFileSync(join(workspace, 'a.md'), 'utf8'), /^\$& \$1\n/);
  });

  test('工作区可以换地方；~ 开头算主目录', () => {
    const { home } = rig();
    const paths = resolvePaths({ YOYO_HOME: join(home, '.yoyo'), YOYO_CONFIG: join(home, 'c.json') });
    const access = createFileAccess({
      config: parseConfig({ files: { workspace: '~/yoyo-work' } }).files,
      paths,
      home,
    });
    assert.equal(access.workspace.endsWith('yoyo-work'), true);
    assert.equal(access.show(join(access.workspace, 'a.md')), 'a.md');
    assert.equal(access.show(join(access.workspace, '..', 'Documents')), '~/Documents');
  });
});
