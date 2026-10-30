import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'vite-plus/test';

import { parseConfig } from '../app/config.ts';
import {
  bashSandboxSettings,
  findProgram,
  prepareSandbox,
  sandboxArgv,
  sandboxed,
  sandboxSettings,
  settingsFile,
  wantsSandbox,
  writeSandboxSettings,
} from './sandbox.ts';

const fixtures = fileURLToPath(new URL('fixtures', import.meta.url));
const launcher = { command: '/usr/bin/srt', options: ['--debug'], settingsFile: '/h/sandbox/settings-x.json' };

function sandbox(raw: object) {
  return parseConfig({ sandbox: { enabled: true, ...raw } }).sandbox;
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'yoyo-sandbox-'));
}

describe('brain/sandbox', () => {
  test('设置：用户的 policy 原样保留，denyWrite 追加 yoyo 的位置，缺的数组补成空的', () => {
    const policy = {
      network: { allowedDomains: ['api.example.com'], allowUnixSockets: ['/run/x.sock'] },
      filesystem: { denyWrite: ['/etc'] },
      enableWeakerNestedSandbox: true,
    };
    const settings = sandboxSettings(policy, { dataDir: '/h/.yoyo', configFile: '/repo/config.json' });
    assert.deepEqual(settings, {
      network: { allowedDomains: ['api.example.com'], allowUnixSockets: ['/run/x.sock'], deniedDomains: [] },
      filesystem: { denyWrite: ['/etc', '/h/.yoyo', '/repo/config.json'], denyRead: [], allowWrite: [] },
      enableWeakerNestedSandbox: true,
    });
    assert.deepEqual(policy.filesystem.denyWrite, ['/etc'], '不改用户的配置');
    assert.deepEqual(
      sandboxSettings(
        { network: 'x', filesystem: { denyWrite: 'y' } },
        { dataDir: '/h/.yoyo', configFile: '/repo/config.json', policyFile: '/repo/policy.json' },
      ),
      {
        network: { allowedDomains: [], deniedDomains: [] },
        filesystem: { denyWrite: ['/h/.yoyo', '/repo/config.json', '/repo/policy.json'], denyRead: [], allowWrite: [] },
      },
      '写错的段当没写',
    );
  });

  test('bash 的设置：policy 里范围以外的字段留着，域名和可写目录换成 bash 自己的，denyWrite 只加落在工作区里的位置', () => {
    const scope = {
      workspace: '/w',
      tmpDir: '/tmp/yoyo-bash-1',
      denyRead: ['/h/.yoyo', '/h/.ssh'],
      allowRead: ['/h/.yoyo/workspace'],
      allowedDomains: ['pypi.org'],
      dataDir: '/h/.yoyo',
      configFile: '/w/config.json',
      policyFile: '/w/sub/policy.json',
    };
    const policy = {
      enableWeakerNestedSandbox: true,
      network: { allowedDomains: ['api.example.com'], deniedDomains: ['evil.example'], allowLocalBinding: true },
      filesystem: { allowWrite: ['/opt'], denyRead: ['/etc/shadow'], denyWrite: ['/etc'], allowRead: ['/x'] },
    };
    assert.deepEqual(bashSandboxSettings(policy, scope), {
      enableWeakerNestedSandbox: true,
      network: { allowedDomains: ['pypi.org'], deniedDomains: ['evil.example'] },
      filesystem: {
        denyRead: ['/etc/shadow', '/h/.yoyo', '/h/.ssh'],
        allowRead: ['/h/.yoyo/workspace'],
        allowWrite: ['/w', '/tmp/yoyo-bash-1'],
        denyWrite: ['/etc', '/w/config.json', '/w/sub/policy.json'],
      },
    });
    assert.deepEqual(policy.filesystem.allowWrite, ['/opt'], '不改用户的配置');
    // 写错的段当没写；数据目录包着工作区时不进 denyWrite，不然工作区也写不了
    assert.deepEqual(
      bashSandboxSettings(
        { network: 'x', filesystem: [] },
        { ...scope, workspace: '/h/.yoyo/workspace', configFile: '/c.json', policyFile: '' },
      ),
      {
        network: { allowedDomains: ['pypi.org'], deniedDomains: [] },
        filesystem: {
          denyRead: ['/h/.yoyo', '/h/.ssh'],
          allowRead: ['/h/.yoyo/workspace'],
          allowWrite: ['/h/.yoyo/workspace', '/tmp/yoyo-bash-1'],
          denyWrite: [],
        },
      },
    );
  });

  test('命令行：沙箱程序、它的选项、--settings 文件、--、再接要跑的', () => {
    assert.deepEqual(sandboxArgv(launcher, ['/bin/bash', '-c', 'ls']), [
      '/usr/bin/srt',
      '--debug',
      '--settings',
      '/h/sandbox/settings-x.json',
      '--',
      '/bin/bash',
      '-c',
      'ls',
    ]);
  });

  test('设置文件按内容哈希命名，目录 0700、文件 0600，内容相同的复用', () => {
    const a = settingsFile({ network: {} });
    assert.match(a.name, /^settings-[0-9a-f]{16}\.json$/);
    assert.equal(settingsFile({ network: {} }).name, a.name);
    assert.notEqual(settingsFile({ network: { allowedDomains: [] } }).name, a.name);
    const home = scratch();
    const file = writeSandboxSettings(home, { network: {} });
    assert.equal(file, join(home, 'sandbox', a.name));
    assert.equal(readFileSync(file, 'utf8'), a.text);
    assert.equal(statSync(join(home, 'sandbox')).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(writeSandboxSettings(home, { network: {} }), file);
  });

  test('改写启动命令：沙箱程序在前，原来的命令放在 -- 后面；env、cwd 原样保留，url 的不动', () => {
    assert.deepEqual(
      sandboxed({ command: 'npx', args: ['-y', 'some-server'], env: { K: 'v' }, cwd: '/w', include: ['a'] }, launcher),
      {
        command: '/usr/bin/srt',
        args: ['--debug', '--settings', '/h/sandbox/settings-x.json', '--', 'npx', '-y', 'some-server'],
        env: { K: 'v' },
        cwd: '/w',
        include: ['a'],
      },
    );
    assert.deepEqual(sandboxed({ command: 'node' }, { ...launcher, options: [] }), {
      command: '/usr/bin/srt',
      args: ['--settings', '/h/sandbox/settings-x.json', '--', 'node'],
    });
    const remote = { url: 'https://mcp.example/api' };
    assert.equal(sandboxed(remote, launcher), remote);
  });

  test('豁免：写了 "sandbox": false 的、url 的不放进沙箱', () => {
    assert.equal(wantsSandbox({ command: 'node' }, { command: 'node' }), true);
    assert.equal(wantsSandbox({ command: 'node', sandbox: true }, { command: 'node' }), true);
    assert.equal(wantsSandbox({ command: 'node', sandbox: 'yes' }, { command: 'node' }), true, '写错按缺省');
    assert.equal(wantsSandbox({ command: 'via', sandbox: false }, { command: 'via' }), false);
    assert.equal(wantsSandbox({ command: 'via', sandbox: 'false' }, { command: 'via' }), false);
    assert.equal(wantsSandbox({ url: 'http://a' }, { url: 'http://a' }), false);
  });

  test('在 PATH 上找沙箱程序；带 / 的按路径找', () => {
    const fake = join(fixtures, 'fake-srt.mjs');
    assert.equal(findProgram('fake-srt.mjs', { PATH: `/nowhere:${fixtures}` }), fake);
    assert.equal(findProgram(fake, { PATH: '' }), fake);
    assert.equal(findProgram('fake-srt.mjs', { PATH: '/nowhere' }), undefined);
    assert.equal(findProgram('where-server.mjs', { PATH: fixtures }), undefined, '不能执行的不算');
    assert.equal(findProgram('fake-srt.mjs', {}), undefined);
  });

  test('准备：policy 的路径相对 config.json 所在目录；读不出、不是 JSON 对象、找不到程序都抛错', () => {
    const home = scratch();
    const repo = join(home, 'repo');
    mkdirSync(repo);
    const configFile = join(repo, 'config.json');
    writeFileSync(join(repo, 'policy.json'), JSON.stringify({ network: { allowedDomains: ['a.example'] } }));
    writeFileSync(join(repo, 'list.json'), '[]');
    writeFileSync(join(repo, 'broken.json'), '{');
    const env = { PATH: fixtures };
    const options = { dataDir: join(home, 'data'), configFile, env };

    const ready = prepareSandbox(sandbox({ command: ['fake-srt.mjs', '--debug'], policy: 'policy.json' }), options);
    assert.equal(ready.command, join(fixtures, 'fake-srt.mjs'));
    assert.deepEqual(ready.options, ['--debug']);
    assert.ok(ready.settingsFile.startsWith(join(home, 'data', 'sandbox', 'settings-')));
    const settings = JSON.parse(readFileSync(ready.settingsFile, 'utf8'));
    assert.deepEqual(settings.network.allowedDomains, ['a.example']);
    assert.deepEqual(settings.filesystem.denyWrite, [join(home, 'data'), configFile, join(repo, 'policy.json')]);

    const inline = prepareSandbox(sandbox({ command: 'fake-srt.mjs' }), options);
    assert.deepEqual(inline.options, []);
    assert.deepEqual(JSON.parse(readFileSync(inline.settingsFile, 'utf8')).network.allowedDomains, []);

    assert.throws(
      () => prepareSandbox(sandbox({ command: 'fake-srt.mjs', policy: 'missing.json' }), options),
      new RegExp(`sandbox.policy 的文件 ${join(repo, 'missing.json')} 读不出（ENOENT）`),
    );
    assert.throws(
      () => prepareSandbox(sandbox({ command: 'fake-srt.mjs', policy: 'list.json' }), options),
      /list\.json 不是 JSON 对象/,
    );
    assert.throws(
      () => prepareSandbox(sandbox({ command: 'fake-srt.mjs', policy: 'broken.json' }), options),
      /broken\.json 不是 JSON$/,
    );
    assert.throws(() => prepareSandbox(sandbox({}), options), /^Error: 沙箱程序 srt 找不到$/);
  });
});
