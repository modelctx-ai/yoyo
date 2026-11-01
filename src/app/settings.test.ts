import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'vite-plus/test';

import { memoryRepos } from '../runtime/testing.ts';
import { parseConfig } from './config.ts';
import {
  AGENT_PATHS,
  MASK,
  SETTINGS,
  changedPaths,
  classify,
  editSettings,
  lastUndoable,
  pastEdit,
  settingsAccess,
  versionOf,
  type PastEdit,
} from './settings.ts';

const RAW = {
  stage: 'console',
  intervalSec: 300,
  llm: { model: 'demo', apiKey: 'secret-key' },
  mcpServers: { fs: { command: 'mcp-fs' } },
  extra: { kept: true },
};

function tempConfig(value: unknown = RAW): string {
  const file = join(mkdtempSync(join(tmpdir(), 'yoyo-settings-')), 'config.json');
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function onDisk(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

describe('配置项表', () => {
  test('模型能改的只有就地生效的低风险项；模型、密钥、MCP、沙箱、粘贴板只给主人', () => {
    assert.deepEqual(AGENT_PATHS, [
      'intervalSec',
      'pace.options',
      'speech.autoplay',
      'sfx.enabled',
      'weather.enabled',
      'memes.enabled',
      'listen.enabled',
      'tasks.notify',
    ]);
    for (const path of AGENT_PATHS) assert.equal(SETTINGS[path].apply, 'live', path);
    for (const path of ['llm.apiKey', 'llm.tools', 'sandbox.enabled', 'clipboard.enabled', 'speech.apiKey'] as const) {
      assert.equal(SETTINGS[path].editor, 'owner', path);
    }
  });
});

describe('classify：就地还是重建', () => {
  const base = parseConfig(RAW);

  test('没变是 none；只改了就地生效的项是 live', () => {
    assert.deepEqual(classify(base, parseConfig(RAW)), { kind: 'none' });
    assert.deepEqual(classify(base, parseConfig({ ...RAW, intervalSec: 900, weather: { enabled: false } })), {
      kind: 'live',
      paths: ['intervalSec', 'weather.enabled'],
    });
    assert.deepEqual(classify(base, parseConfig({ ...RAW, pace: { options: [600, 1200] } })), {
      kind: 'live',
      paths: ['pace.options'],
    });
  });

  test('有一项要重建、或者不在表里（MCP 服务器、认不出的键、决策模型），就是 rebuild', () => {
    assert.equal(
      classify(base, parseConfig({ ...RAW, intervalSec: 900, llm: { ...RAW.llm, tools: true } })).kind,
      'rebuild',
    );
    assert.deepEqual(classify(base, parseConfig({ ...RAW, mcpServers: {} })), {
      kind: 'rebuild',
      paths: ['mcpServers.fs'],
    });
    assert.equal(classify(base, parseConfig({ ...RAW, extra: { kept: false } })).kind, 'rebuild');
    const decision = { provider: 'typesafe', model: 'jev-latest' };
    assert.equal(classify(base, parseConfig({ ...RAW, pace: { decision } })).kind, 'rebuild');
  });

  test('按叶子比较，数组算一片叶子，没写的和 null 一样', () => {
    assert.deepEqual(changedPaths({ a: { b: [1, 2] }, c: 1 }, { a: { b: [1, 3] }, c: 1 }), ['a.b']);
    assert.deepEqual(changedPaths({ a: undefined }, { a: null }), []);
  });
});

describe('editSettings', () => {
  test('只动给的项：别的键、表外的、认不出的、密钥都原样留着；几档间隔去重排好', () => {
    const file = tempConfig();
    const result = editSettings(
      file,
      [
        { path: 'intervalSec', value: 900 },
        { path: 'pace.options', value: [1800, 300, 300] },
      ],
      'cli',
    );
    assert.equal(result.apply, 'live');
    assert.deepEqual(result.changes, [
      { path: 'intervalSec', before: 300, after: 900 },
      { path: 'pace.options', before: null, after: [300, 1800] },
    ]);
    assert.deepEqual(onDisk(file), { ...RAW, intervalSec: 900, pace: { options: [300, 1800] } });
  });

  test('值一样不写文件，apply 是 null；要重建的项算 rebuild；语气留空就是把它拿掉', () => {
    const file = tempConfig({ ...RAW, speech: { tone: 'calm' } });
    const version = versionOf(file);
    const same = editSettings(file, [{ path: 'intervalSec', value: 300 }], 'web');
    assert.deepEqual([same.changes, same.apply], [[], null]);
    assert.equal(versionOf(file), version, '没写');
    assert.equal(editSettings(file, [{ path: 'llm.tools', value: true }], 'web').apply, 'rebuild');
    editSettings(file, [{ path: 'speech.tone', value: '' }], 'web');
    assert.deepEqual(onDisk(file)['speech'], {});
  });

  test('模型只能改 agent 的项（403）；写错（400）一项都不改；密钥打码、交回码不改', () => {
    const file = tempConfig();
    const before = readFileSync(file, 'utf8');
    assert.throws(() => editSettings(file, [{ path: 'llm.tools', value: true }], 'agent'), {
      message: 'llm.tools 只有主人能改',
      status: 403,
    });
    assert.throws(
      () =>
        editSettings(
          file,
          [
            { path: 'intervalSec', value: 900 },
            { path: 'weather.enabled', value: 'no' },
            { path: 'mcpServers', value: {} },
          ],
          'agent',
        ),
      { message: 'weather.enabled 只能是 true 或 false；mcpServers 不是能这样改的项', status: 400 },
    );
    assert.equal(readFileSync(file, 'utf8'), before, '有一项不对就一项都不改');

    const key = editSettings(file, [{ path: 'llm.apiKey', value: 'new-key' }], 'web');
    assert.deepEqual(key.changes, [{ path: 'llm.apiKey', before: MASK, after: MASK }]);
    assert.equal(editSettings(file, [{ path: 'llm.apiKey', value: MASK }], 'web').apply, null);
    assert.equal((onDisk(file)['llm'] as { apiKey: string }).apiKey, 'new-key');
  });

  test('先读后写的指纹对不上回 409；写完过不了检查（驱动桌宠缺语音）回 400、文件不动', () => {
    const file = tempConfig();
    const version = versionOf(file);
    editSettings(file, [{ path: 'intervalSec', value: 600 }], 'web');
    assert.throws(() => editSettings(file, [{ path: 'intervalSec', value: 900 }], 'web', { version }), {
      status: 409,
    });
    const pet = tempConfig({ stage: 'dsh-pet', speech: { apiKey: 'k', referenceId: 'r' } });
    assert.throws(
      () => editSettings(pet, [{ path: 'speech.referenceId', value: '' }], 'web'),
      /speech\.referenceId 还空着/,
    );
  });
});

function edit(id: string, source: string, undoes: string | null = null): PastEdit {
  return { id, source, before: {}, after: {}, undoes };
}

describe('撤销', () => {
  test('从新到旧找：跳过撤销本身和撤销过的；可以只看某个来源', () => {
    const edits = [edit('1', 'agent'), edit('2', 'web'), edit('3', 'cli', '2')];
    assert.equal(lastUndoable(edits)?.id, '1');
    assert.equal(lastUndoable(edits, 'agent')?.id, '1');
    assert.equal(lastUndoable([...edits, edit('4', 'agent', '1')]), null);
    assert.equal(lastUndoable([edit('1', 'web')], 'agent'), null);
    assert.equal(pastEdit({ at: '9', type: 'config-edit', source: 'web' }), null, '整份存的那种没有前后值');
    assert.equal(pastEdit({ type: 'config-edit', before: '{}', after: '{}' }), null, '没有编号的不认');
  });

  test('改了记一笔，撤销改回原来的值；模型只撤自己改的；之后又改过、密钥都不撤', () => {
    const file = tempConfig();
    // 时钟不走：几笔修改的时间一样，撤销也要认得是哪一笔
    const repos = memoryRepos({ now: () => new Date(2026, 10, 1, 12, 0, 0) });
    const settings = settingsAccess(file, repos.activity);
    settings.edit([{ path: 'intervalSec', value: 900 }], 'agent');
    settings.edit([{ path: 'weather.enabled', value: false }], 'web');
    assert.deepEqual(
      repos.activity.list(5).map((event) => [event['source'], event['text'], event['before'], event['after']]),
      [
        ['agent', 'intervalSec', '{"intervalSec":300}', '{"intervalSec":900}'],
        ['web', 'weather.enabled', '{"weather.enabled":null}', '{"weather.enabled":false}'],
      ],
    );

    // 模型撤销：跳过主人在工作台改的，撤自己那一笔
    const undone = settings.undo('agent', 'agent');
    assert.deepEqual(undone.changes, [{ path: 'intervalSec', before: 900, after: 300 }]);
    assert.equal(onDisk(file)['intervalSec'], 300);
    assert.deepEqual(onDisk(file)['weather'], { enabled: false });
    assert.throws(() => settings.undo('agent', 'agent'), { status: 404 });

    // 命令行撤销最近一笔：天气那一笔，原来没写就拿掉
    settings.undo('cli');
    assert.deepEqual(onDisk(file)['weather'], {});

    // 之后又改过的不撤
    settings.edit([{ path: 'intervalSec', value: 600 }], 'web');
    writeFileSync(file, JSON.stringify({ ...onDisk(file), intervalSec: 1200 }));
    assert.throws(() => settings.undo('cli'), { message: '撤销不了：intervalSec 之后又改过了', status: 409 });

    settings.edit([{ path: 'llm.apiKey', value: 'other' }], 'web');
    assert.throws(() => settings.undo('cli'), /llm\.apiKey 是密钥，撤销不了/);
    assert.ok(!JSON.stringify(repos.activity.list(50)).includes('other'), '记录里没有密钥');
    assert.ok(!JSON.stringify(repos.activity.list(50)).includes('secret-key'));
  });

  test('看现在的值：没写的按缺省补齐，密钥打码', () => {
    const settings = settingsAccess(tempConfig(), memoryRepos().activity);
    assert.deepEqual(settings.values(['intervalSec', 'pace.options', 'weather.enabled', 'llm.apiKey']), {
      intervalSec: 300,
      'pace.options': [300, 900, 1800, 3600],
      'weather.enabled': true,
      'llm.apiKey': MASK,
    });
  });
});
