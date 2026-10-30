import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'vite-plus/test';

import { createToolRegistry, type LocalToolRegistry, type ToolOutput } from '@modelctx-ai/ctx';

import { parseConfig } from '../app/config.ts';
import { resolvePaths } from '../app/paths.ts';
import { memoryLogger, memoryRepos } from '../runtime/testing.ts';
import type { ActionTable, AskDeps } from './action.ts';
import { createApprovalGate } from './approvals.ts';
import { BASH_HEAD, BASH_TAIL, addBashTool, bashAnswer, commandHead, prepareBash } from './bash.ts';
import { createFileAccess } from './files.ts';

const fakeSrt = fileURLToPath(new URL('fixtures/fake-srt.mjs', import.meta.url));

interface Call {
  readonly options: string[];
  readonly command: string[];
  readonly cwd: string;
  readonly settings: Record<string, any>;
}

/** 一个假的主目录，PATH 上有一个 srt（包着 fake-srt，把每次收到的东西记到文件里）。 */
function rig(
  files: Record<string, unknown> = {},
  sandbox: Record<string, unknown> = {},
  installed = true,
  ask: AskDeps = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'yoyo-bash-home-'));
  const paths = resolvePaths({ YOYO_HOME: join(home, '.yoyo'), YOYO_CONFIG: join(home, '.yoyo', 'config.json') });
  mkdirSync(join(home, '.yoyo', 'artifacts', '3'), { recursive: true });
  mkdirSync(join(home, '.ssh'));
  mkdirSync(join(home, 'Documents'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  mkdirSync(join(home, 'tmp'));
  const log = join(home, 'srt.log');
  if (installed) {
    writeFileSync(join(bin, 'srt'), `#!/bin/sh\nFAKE_SRT_LOG='${log}' exec '${fakeSrt}' "$@"\n`);
    chmodSync(join(bin, 'srt'), 0o755);
  }
  // 命令只看得到这几个环境变量；SECRET_TOKEN 是 yoyo 自己的，不该进沙箱
  const env = { PATH: `${bin}:${process.env['PATH'] ?? ''}`, HOME: home, SECRET_TOKEN: 'sk-secret', LC_ALL: 'C' };
  const config = parseConfig({
    files: { readable: ['~/Documents'], denyRead: ['~/Documents/private'], ...files },
    sandbox,
  });
  const access = createFileAccess({ config: config.files, paths, home });
  const logger = memoryLogger();
  const repos = memoryRepos();
  const prepared = prepareBash({
    files: config.files,
    sandbox: config.sandbox,
    paths,
    access,
    logger,
    env,
    tmpRoot: join(home, 'tmp'),
  });
  const registry = createToolRegistry();
  if (prepared) {
    addBashTool(registry, { access, repos, sandbox: prepared, config: config.files, env, graceMs: 200, ...ask });
  }
  const calls = (): Call[] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as Call)
      : [];
  return { home, paths, access, logger, repos, registry, prepared, calls, workspace: access.workspace };
}

async function run(tools: LocalToolRegistry, input: unknown): Promise<string> {
  const picked = tools.toolSet(['bash'])['bash'];
  assert.ok(picked?.execute, '没有 bash 工具');
  const output = (await picked.execute(input, { toolCallId: 'c1', messages: [], context: {} })) as ToolOutput;
  assert.equal(output.type, 'text', JSON.stringify(output));
  return output.type === 'text' ? output.text : '';
}

describe('bash 工具', () => {
  test('命令经沙箱程序起：<沙箱> --settings <文件> -- <shell> -c <命令>，在工作区里跑，第一行是退出码', async () => {
    const { registry, calls, workspace, prepared } = rig();
    assert.deepEqual(
      registry.list().map((definition) => definition.name),
      ['bash'],
    );
    assert.equal(await run(registry, { command: 'echo 你好; pwd' }), `退出码 0\n你好\n${workspace}`);
    const [call] = calls();
    assert.deepEqual(call?.options.slice(0, 2), ['--settings', prepared?.launcher.settingsFile]);
    assert.deepEqual(call?.command, [prepared?.shell, '-c', 'echo 你好; pwd']);
    assert.equal(call?.cwd, workspace);
  });

  test('stdout 和 stderr 合在一起，退出码不是 0 照样交回；没有输出也说一声', async () => {
    const { registry } = rig();
    assert.equal(await run(registry, { command: 'echo out; echo err >&2; exit 3' }), '退出码 3\nout\nerr');
    assert.equal(await run(registry, { command: 'true' }), '退出码 0\n（没有输出）');
    assert.match(await run(registry, { command: 'nonexistent-cmd-xyz' }), /^退出码 127\n.*not found/s);
    assert.equal(await run(registry, { command: '  ' }), '要给命令');
  });

  test('进沙箱的环境变量只有几个：yoyo 的密钥不带；临时目录是专用的；没有输入', async () => {
    const { registry, prepared } = rig();
    const env = await run(registry, { command: 'env | sort' });
    assert.doesNotMatch(env, /SECRET_TOKEN|sk-secret/);
    assert.match(env, /^HOME=/m);
    assert.match(env, new RegExp(`^TMPDIR=${prepared!.tmpDir}$`, 'm'));
    assert.equal(await run(registry, { command: 'cat; echo done' }), '退出码 0\ndone', '读输入马上读到结尾');
  });

  test('超时：杀掉整组进程，说清楚，带上超时前的输出；timeout 有上限', async () => {
    const { registry, repos } = rig({ bashTimeout: 1, bashMaxTimeout: 2 });
    const started = Date.now();
    const answer = await run(registry, { command: 'echo 开始; sleep 30; echo 不会到这里', timeout: 0.4 });
    assert.match(answer, /^超时了（0\.4 秒），已经杀掉。超时前的输出：\n开始$/);
    assert.ok(Date.now() - started < 5000, '没有等 30 秒');
    assert.equal(repos.activity.list(1)[0]?.['timedOut'], true);
    // 要得比上限多，按上限算，并说一声
    const capped = await run(registry, { command: 'sleep 30', timeout: 99 });
    assert.match(capped, /^超时了（2 秒），已经杀掉。超时前的输出：\n（没有输出）\n（timeout 超过上限，按 2 秒算）$/);
  });

  test('命令结束时留在后台的进程一并收掉，不等它', async () => {
    const { registry, workspace } = rig();
    const started = Date.now();
    assert.equal(
      await run(registry, { command: `(sleep 30; touch '${join(workspace, 'late')}') & echo ok` }),
      '退出码 0\nok',
    );
    assert.ok(Date.now() - started < 5000);
  });

  test('输出有上限：开头和结尾留着，中间省略', async () => {
    const { registry } = rig();
    const answer = await run(registry, {
      command: 'echo START; head -c 300000 /dev/zero | tr "\\0" x; echo; echo END',
    });
    assert.match(answer, /^退出码 0\nSTART\n/);
    assert.match(answer, /……中间省略了 \d+ 字节……/);
    assert.match(answer, /END$/);
    assert.ok(answer.length < BASH_HEAD + BASH_TAIL + 200, `${answer.length}`);
    const omitted = Number(/省略了 (\d+) 字节/.exec(answer)?.[1]);
    assert.equal(omitted, 300000 + 'START\n\nEND\n'.length - BASH_HEAD - BASH_TAIL);
  });

  test('每次都记进轨迹：命令的前一段、退出码，不带输出', async () => {
    const { registry, repos } = rig();
    await run(registry, { command: 'echo secret-output; exit 2' });
    const long = `echo ${'x'.repeat(300)}`;
    await run(registry, { command: long });
    const [first, second] = repos.activity.list(2);
    assert.equal(first?.type, 'bash');
    assert.equal(first?.['command'], 'echo secret-output; exit 2');
    assert.equal(first?.['code'], 2);
    assert.doesNotMatch(JSON.stringify(first), /^.*"output"/);
    assert.equal(String(second?.['command']).length, 121);
    assert.equal(commandHead('a\n  b'), 'a b');
  });

  test('命令没跑起来、被信号杀掉也说清楚', () => {
    assert.equal(
      bashAnswer({ code: null, signal: null, timedOut: false, output: '', failed: 'x' }, 5),
      '命令没跑起来：x',
    );
    assert.match(
      bashAnswer({ code: null, signal: 'SIGKILL', timedOut: false, output: 'a\n' }, 5),
      /^被信号 SIGKILL 杀掉了，没有退出码。输出：\na$/,
    );
  });
});

describe('bash 工具：ask 要先批准', () => {
  test('调了只记批准请求，不跑；批准后照动作跑，命令和平时一样经沙箱；没装沙箱照样没有', async () => {
    const actions: ActionTable = new Map();
    const repos = memoryRepos();
    const { registry, calls, workspace } = rig({ bash: 'ask' }, {}, true, {
      actions,
      gate: createApprovalGate({ repos }),
    });
    assert.match(registry.list()[0]?.description ?? '', /要主人在工作台里批准才会真的做/);
    const picked = registry.toolSet(['bash'], { session: 'pet:main', runId: 'run_3' })['bash'];
    const output = (await picked!.execute!(
      { command: 'echo 你好;\n  pwd' },
      { toolCallId: 'c1', messages: [], context: {} },
    )) as ToolOutput;
    assert.match(
      output.type === 'text' ? output.text : '',
      /要主人在工作台里批准才会做：「跑命令：echo 你好; pwd」（批准请求 #1）/,
    );
    assert.deepEqual(calls(), [], '没批准不跑');
    const [request] = repos.approvals.list();
    assert.deepEqual(
      [request?.tool, request?.summary, request?.runId, JSON.parse(request?.input ?? '{}')],
      ['bash', '跑命令：echo 你好; pwd', 'run_3', { command: 'echo 你好;\n  pwd' }],
    );
    assert.equal(await actions.get('bash')!.perform(JSON.parse(request!.input)), `退出码 0\n你好\n${workspace}`);
    assert.equal(calls().length, 1, '批准后跑了一次，经沙箱');
    // 空命令不用等批准就告诉模型
    const empty = (await picked!.execute!(
      { command: '  ' },
      { toolCallId: 'c2', messages: [], context: {} },
    )) as ToolOutput;
    assert.equal(empty.type === 'text' ? empty.text : '', '要给命令');
    assert.equal(repos.approvals.list().length, 1);

    const none = rig({ bash: 'ask' }, {}, false);
    assert.deepEqual(none.registry.list(), []);
    assert.match(none.logger.lines[0] ?? '', /没有 bash 工具：沙箱程序 srt 找不到/);
  });
});

describe('prepareBash：沙箱设置和有没有这个工具', () => {
  test('设置：只能写工作区和临时目录，读不到的位置照 read 的规则，网络放行 files.bashNetwork', async () => {
    const { calls, prepared, workspace, home, paths, registry } = rig({ bashNetwork: ['pypi.org'] });
    assert.ok(prepared);
    await run(registry, { command: 'true' });
    const { settings } = calls()[0]!;
    assert.deepEqual(settings.filesystem.allowWrite, [workspace, prepared.tmpDir]);
    assert.deepEqual(settings.network, { allowedDomains: ['pypi.org'], deniedDomains: [] });
    const denied = settings.filesystem.denyRead as string[];
    for (const path of [
      paths.dataDir,
      paths.configFile,
      join(home, '.ssh'),
      join(home, '.aws'),
      join(home, '.gnupg'),
      join(home, 'Documents', 'private'),
    ]) {
      assert.ok(denied.includes(realpathSync(dirname(path)) + path.slice(dirname(path).length)), path);
    }
    // 工作区和交付物在被挡的数据目录里面，要放回来；文稿不在被挡的目录里，不用
    assert.deepEqual(settings.filesystem.allowRead, [workspace, join(realpathSync(paths.dataDir), 'artifacts')]);
    // 工作区缺省在数据目录里，数据目录不进 denyWrite（否则工作区也写不了）；它本来就不可写
    assert.deepEqual(settings.filesystem.denyWrite, []);
  });

  test('网络缺省全关；工作区包着数据目录和配置时，它们进 denyWrite', async () => {
    const { calls, registry, paths, home } = rig({ workspace: '~' });
    await run(registry, { command: 'true' });
    const { settings } = calls()[0]!;
    assert.deepEqual(settings.network, { allowedDomains: [], deniedDomains: [] });
    assert.deepEqual(settings.filesystem.allowWrite[0], realpathSync(home));
    assert.deepEqual(settings.filesystem.denyWrite, [
      realpathSync(paths.dataDir),
      join(realpathSync(dirname(paths.configFile)), basename(paths.configFile)),
    ]);
  });

  test('sandbox.policy 里和范围无关的字段留着，给 MCP 放行的域名和可写目录不借给 bash', async () => {
    const policy = {
      enableWeakerNestedSandbox: true,
      network: { allowedDomains: ['api.example.com'], deniedDomains: ['evil.example'] },
      filesystem: { allowWrite: ['/opt/notes'], denyRead: ['/etc/shadow'], denyWrite: ['/etc'] },
    };
    const { calls, registry } = rig({}, { policy });
    await run(registry, { command: 'true' });
    const { settings } = calls()[0]!;
    assert.equal(settings.enableWeakerNestedSandbox, true);
    assert.deepEqual(settings.network, { allowedDomains: [], deniedDomains: ['evil.example'] });
    assert.equal(settings.filesystem.allowWrite.includes('/opt/notes'), false);
    assert.equal(settings.filesystem.denyRead[0], '/etc/shadow');
    assert.deepEqual(settings.filesystem.denyWrite, ['/etc']);
  });

  test('没装沙箱程序就没有 bash，记一行为什么；files.bash 是 deny 时不找也不记', () => {
    const none = rig({}, {}, false);
    assert.equal(none.prepared, null);
    assert.deepEqual(none.registry.list(), []);
    assert.deepEqual(none.logger.lines, [
      '没有 bash 工具：沙箱程序 srt 找不到（命令一律经沙箱跑，不退回不加沙箱的跑法）',
    ]);
    const denied = rig({ bash: 'deny' });
    assert.equal(denied.prepared, null);
    assert.deepEqual(denied.logger.lines, []);
    assert.equal(existsSync(join(denied.paths.dataDir, 'sandbox')), false, '没写设置文件');
  });

  test('sandbox.command 指到别处照用；policy 读不出也没有 bash，不退回；sandbox.enabled 不管 bash', () => {
    const custom = rig({}, { command: [fakeSrt, '--debug'] });
    assert.deepEqual(custom.prepared?.launcher.options, ['--debug']);
    assert.equal(custom.prepared?.launcher.command, fakeSrt);
    const broken = rig({}, { policy: 'nope.json' });
    assert.equal(broken.prepared, null);
    assert.match(broken.logger.lines[0] ?? '', /^没有 bash 工具：sandbox\.policy 的文件 .*nope\.json 读不出/);
    const off = rig({}, { enabled: false });
    assert.ok(off.prepared, 'sandbox.enabled 是给 MCP 服务器的');
  });
});
