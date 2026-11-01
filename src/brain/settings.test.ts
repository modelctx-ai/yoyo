import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'vite-plus/test';

import { createToolRegistry, type LocalToolRegistry, type ToolOutput } from '@modelctx-ai/ctx';

import { settingsAccess } from '../app/settings.ts';
import { memoryRepos } from '../runtime/testing.ts';
import { ASK_NOTE, type ActionTable } from './action.ts';
import { createApprovalGate } from './approvals.ts';
import { SETTINGS_TOOL_NAMES, addSettingsTools } from './settings.ts';

const NOW = new Date(2026, 10, 1, 15, 0, 0);

function rig(permission: 'allow' | 'ask' | 'deny' = 'allow') {
  const file = join(mkdtempSync(join(tmpdir(), 'yoyo-set-')), 'config.json');
  writeFileSync(file, JSON.stringify({ stage: 'console', intervalSec: 300, llm: { apiKey: 'secret-key' } }));
  const repos = memoryRepos({ now: () => NOW });
  const settings = settingsAccess(file, repos.activity);
  const registry = createToolRegistry();
  const actions: ActionTable = new Map();
  addSettingsTools(registry, {
    permission,
    values: (paths) => settings.values(paths),
    edit: (path, value) => settings.edit([{ path, value }], 'agent'),
    undo: () => settings.undo('agent', 'agent'),
    actions,
    gate: createApprovalGate({ repos, now: () => NOW }),
  });
  return { file, repos, registry, actions };
}

async function call(registry: LocalToolRegistry, name: string, input: unknown = {}): Promise<string> {
  const picked = registry.toolSet([name], { session: 'pet:main', runId: 'run_1' })[name];
  assert.ok(picked?.execute, `没有工具 ${name}`);
  const output = (await picked.execute(input, { toolCallId: 'c1', messages: [], context: {} })) as ToolOutput;
  assert.equal(output.type, 'text', JSON.stringify(output));
  return output.type === 'text' ? output.text : '';
}

function onDisk(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

describe('yoyo 自己改配置', () => {
  test('deny 没有工具；allow 有看、改、撤销三个；改和撤销只在主人发起的那一轮给', () => {
    assert.deepEqual(rig('deny').registry.list(), []);
    assert.deepEqual(
      rig()
        .registry.list()
        .map((definition) => definition.name),
      ['get_settings', 'change_setting', 'undo_setting'],
    );
    assert.deepEqual(SETTINGS_TOOL_NAMES, ['change_setting', 'undo_setting']);
  });

  test('输入只认模型能改的项：路径不在里面、值的类型不对，都过不了参数检查', () => {
    const { registry } = rig();
    const schema = JSON.stringify(
      registry.list().find((definition) => definition.name === 'change_setting')?.inputSchema,
    );
    for (const path of ['intervalSec', 'weather.enabled', 'pace.options'])
      assert.ok(schema.includes(`"${path}"`), path);
    for (const path of ['llm.apiKey', 'llm.tools', 'mcpServers', 'sandbox.enabled']) {
      assert.ok(!schema.includes(`"${path}"`), path);
    }
  });

  test('看：列出能改的项、现在的值和取值说明', async () => {
    const text = await call(rig().registry, 'get_settings');
    assert.match(text, /^intervalSec = 300：日常碎碎念的间隔（秒）.*（要是 60 到 86400 之间的秒数）$/m);
    assert.match(text, /^weather\.enabled = true：/m);
    assert.ok(!text.includes('secret-key') && !text.includes('apiKey'));
  });

  test('改：写进文件、记一笔，回给模型改了什么、马上生效；撤销改回去', async () => {
    const { registry, file, repos } = rig();
    assert.equal(
      await call(registry, 'change_setting', { path: 'intervalSec', value: 900 }),
      '改好了：intervalSec 300 → 900，马上生效。',
    );
    assert.equal(onDisk(file)['intervalSec'], 900);
    assert.equal(repos.activity.list(1)[0]?.['source'], 'agent');
    assert.equal(
      await call(registry, 'change_setting', { path: 'intervalSec', value: 900 }),
      '改好了：值和原来一样，没改。',
    );
    assert.equal(await call(registry, 'undo_setting'), '撤销了：intervalSec 900 → 300，马上生效。');
    assert.equal(onDisk(file)['intervalSec'], 300);
    assert.equal(await call(registry, 'undo_setting'), 'yoyo 最近没改过配置，没有能撤销的');
  });

  test('ask：说明里多一句要批准；调了只记批准请求，不改文件；批准以后照原参数改', async () => {
    const { registry, file, repos, actions } = rig('ask');
    const change = registry.list().find((definition) => definition.name === 'change_setting');
    assert.ok(change?.description?.endsWith(ASK_NOTE));
    const reply = await call(registry, 'change_setting', { path: 'sfx.enabled', value: false });
    assert.match(reply, /要主人在工作台里批准才会做：「把 sfx\.enabled 从 true 改成 false」（批准请求 #1）/);
    assert.equal(onDisk(file)['sfx'], undefined, '没批准不改');
    assert.equal(repos.approvals.get(1)?.tool, 'change_setting');
    const done = await actions.get('change_setting')?.perform(JSON.parse(repos.approvals.get(1)!.input));
    assert.equal(done, '改好了：sfx.enabled （没写） → false，马上生效。');
    assert.deepEqual(onDisk(file)['sfx'], { enabled: false });
  });
});
