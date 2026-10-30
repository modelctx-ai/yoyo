import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'vite-plus/test';

import {
  checkUpdate,
  compareVersions,
  createUpdateSystem,
  dmgName,
  download,
  installUpdate,
  installedVersion,
  livePid,
  NOTES_MAX,
  stepProgress,
  trimNotes,
  type ReleaseAsset,
  type UpdateCheck,
  type UpdateSystem,
} from './update.ts';

const DMG = Buffer.from('fake dmg');
const DMG_SHA = createHash('sha256').update(DMG).digest('hex');

function release(version: string, names: readonly string[], body?: string): unknown {
  return {
    tag_name: `v${version}`,
    ...(body === undefined ? {} : { body }),
    html_url: `https://github.com/modelctx-ai/yoyo/releases/tag/v${version}`,
    assets: names.map((name) => ({ name, browser_download_url: `https://dl/${name}`, size: DMG.length })),
  };
}

interface Fake extends UpdateSystem {
  readonly calls: string[];
}

/** 网络按地址回固定的内容，命令只记下来；`ditto` 照着 dmg 里的版本放一个假的 app。 */
function fakeSystem(routes: Record<string, () => Response>, options: { appVersion?: string; pid?: number } = {}): Fake {
  const calls: string[] = [];
  return {
    calls,
    arch: 'arm64',
    async fetch(url) {
      calls.push(`fetch ${url}`);
      const route = routes[url];
      return route ? route() : new Response('not found', { status: 404 });
    },
    run(command, args) {
      calls.push(`${command} ${args[0]}`);
      if (command === 'ditto') {
        const lib = join(args[1]!, 'Contents', 'Resources', 'lib');
        mkdirSync(lib, { recursive: true });
        writeFileSync(join(lib, 'VERSION'), `${options.appVersion ?? '0.2.0'}\n`);
      }
    },
    spawnDetached(command, args) {
      calls.push(
        `spawn ${command} ${args
          .slice(1)
          .join(' ')
          .replaceAll(/\/\S*\/updates\//g, '<updates>/')}`,
      );
    },
    alive: (pid) => pid === options.pid,
    kill(pid, signal) {
      calls.push(`kill ${pid} ${signal}`);
    },
  };
}

function home(): { root: string; dataDir: string; app: string; appPidFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'yoyo-update-'));
  const root = join(dir, 'yoyo.app', 'Contents', 'Resources');
  mkdirSync(join(root, 'lib'), { recursive: true });
  writeFileSync(join(root, 'lib', 'VERSION'), '0.1.0\n');
  writeFileSync(join(root, 'lib', 'swap.sh'), '#!/bin/bash\n');
  return { root, dataDir: join(dir, 'data'), app: join(dir, 'yoyo.app'), appPidFile: join(dir, 'data', 'app.pid') };
}

describe('update', () => {
  test('版本号按 semver 比，预发布比正式版旧', () => {
    assert.equal(compareVersions('0.2.0', '0.1.9'), 1);
    assert.equal(compareVersions('v0.10.0', '0.9.0'), 1);
    assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
    assert.equal(compareVersions('0.1.0', '0.1.0-dev.22845e3'), 1);
    assert.equal(compareVersions('0.1.0-dev.2', '0.1.0-dev.10'), -1);
    assert.equal(compareVersions('0.1.0-alpha', '0.1.0-1'), 1);
    assert.equal(compareVersions('不是版本', '0.0.1'), -1);
  });

  test('装着的版本读 lib/VERSION，从源码跑时没有', () => {
    const { root } = home();
    assert.equal(installedVersion(root), '0.1.0');
    assert.equal(installedVersion(join(root, 'nowhere')), null);
  });

  test('检查：有新版、这台机器的 dmg 也在，才算能更新', async () => {
    const name = dmgName('0.2.0', 'arm64');
    const latest = 'https://api.github.com/repos/modelctx-ai/yoyo/releases/latest';
    const ready = fakeSystem({ [latest]: () => Response.json(release('0.2.0', [name, `${name}.sha256`])) });
    const check = await checkUpdate('0.1.0', ready);
    assert.equal(check.available, true);
    assert.equal(check.asset?.url, `https://dl/${name}`);
    assert.equal(check.checksum?.name, `${name}.sha256`);
    assert.equal(check.message, '0.2.0 可以更新了，现在是 0.1.0');

    assert.equal((await checkUpdate('0.2.0', ready)).message, '已经是最新的 0.2.0');
    assert.equal((await checkUpdate('0.3.0-dev.1', ready)).available, false);
    const intel = { ...ready, arch: 'x86_64' };
    assert.equal((await checkUpdate('0.1.0', intel)).message, '0.2.0 发了，但没有 x86_64 的安装包');
    assert.equal((await checkUpdate('0.1.0', fakeSystem({}))).message, '还没有发布过的版本');
    assert.equal(check.body, '', 'Release 没写正文就是空串');
    const limited = fakeSystem({ [latest]: () => new Response('', { status: 403 }) });
    await assert.rejects(checkUpdate('0.1.0', limited), /限流/);
  });

  test('检查：两个架构的 dmg 都在，各取各的；Intel 的叫 x86_64，和 process.arch 的 x64 对得上', async () => {
    const arm = dmgName('0.2.0', 'arm64');
    const intel = dmgName('0.2.0', 'x86_64');
    assert.equal(arm, 'yoyo-0.2.0-macos-arm64.dmg');
    assert.equal(intel, 'yoyo-0.2.0-macos-x86_64.dmg');
    const latest = 'https://api.github.com/repos/modelctx-ai/yoyo/releases/latest';
    const names = [arm, `${arm}.sha256`, intel, `${intel}.sha256`];
    const base = fakeSystem({ [latest]: () => Response.json(release('0.2.0', names)) });
    const onArm = await checkUpdate('0.1.0', { ...base, arch: 'arm64' });
    const onIntel = await checkUpdate('0.1.0', { ...base, arch: 'x86_64' });
    assert.deepEqual([onArm.asset?.name, onArm.checksum?.name], [arm, `${arm}.sha256`]);
    assert.deepEqual([onIntel.asset?.name, onIntel.checksum?.name], [intel, `${intel}.sha256`]);
    // 只发了 arm64 的 Release：Intel 机器上不提示能更新
    const only = fakeSystem({ [latest]: () => Response.json(release('0.2.0', [arm])) });
    assert.equal((await checkUpdate('0.1.0', { ...only, arch: 'x86_64' })).available, false);
    // process.arch 的 x64 换成 uname -m 的叫法
    const nodeArch = createUpdateSystem().arch;
    assert.equal(nodeArch, process.arch === 'x64' ? 'x86_64' : process.arch);
  });

  test('打包脚本给 dmg 起的名字和 dmgName 一致：uname -m 的叫法', () => {
    const script = readFileSync(join(import.meta.dirname, '../../scripts/release/package.sh'), 'utf8');
    assert.ok(script.includes('arch="$(uname -m)"'));
    assert.ok(script.includes('name="yoyo-$VERSION-macos-$arch"'));
    const workflow = readFileSync(join(import.meta.dirname, '../../.github/workflows/release.yml'), 'utf8');
    assert.match(workflow, /arch: arm64\s+runner: macos-15\n/);
    assert.match(workflow, /arch: x86_64\s+runner: macos-15-intel\n/);
  });

  test('检查：Release 的正文带出来，换行统一、太长截断', async () => {
    const name = dmgName('0.2.0', 'arm64');
    const latest = 'https://api.github.com/repos/modelctx-ai/yoyo/releases/latest';
    const notes = '## 更新\r\n* 下载有进度了\r\n';
    const system = fakeSystem({ [latest]: () => Response.json(release('0.2.0', [name], notes)) });
    assert.equal((await checkUpdate('0.1.0', system)).body, '## 更新\n* 下载有进度了');
    const long = fakeSystem({ [latest]: () => Response.json(release('0.2.0', [name], 'x'.repeat(NOTES_MAX + 50))) });
    const cut = (await checkUpdate('0.1.0', long)).body;
    assert.equal(cut, `${'x'.repeat(NOTES_MAX)}\n…`);
    assert.equal(trimNotes('  短  '), '短');
    const nobody = fakeSystem({
      [latest]: () => Response.json({ ...(release('0.2.0', [name]) as object), body: null }),
    });
    assert.equal((await checkUpdate('0.1.0', nobody)).body, '');
  });

  test('下载时报进度：先报 0，再每块报已下多少、总共多少；按 Content-Length', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yoyo-dl-'));
    const parts = [Buffer.from('aaaa'), Buffer.from('bbbb'), Buffer.from('cc')];
    const body = Buffer.concat(parts);
    const asset: ReleaseAsset = { name: 'p.dmg', url: 'https://dl/p.dmg', size: 999, digest: null };
    const chunked = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
        { headers: { 'content-length': String(body.length) } },
      );
    const seen: Array<[number, number]> = [];
    await download(
      fakeSystem({ 'https://dl/p.dmg': chunked }),
      asset,
      createHash('sha256').update(body).digest('hex'),
      join(dir, 'p.dmg'),
      (done, total) => void seen.push([done, total]),
    );
    assert.deepEqual(seen, [
      [0, 10],
      [4, 10],
      [8, 10],
      [10, 10],
    ]);
    // 没有 Content-Length 就用 Release 里写的大小；都没有总数是 0
    const seenSize: number[] = [];
    await download(
      fakeSystem({ 'https://dl/p.dmg': () => new Response(body) }),
      { ...asset, size: 0 },
      createHash('sha256').update(body).digest('hex'),
      join(dir, 'q.dmg'),
      (_done, total) => void seenSize.push(total),
    );
    assert.ok(seenSize.every((total) => total === body.length || total === 0));
  });

  test('进度稀疏地报：每涨一档报一次，总数不知道时按字节', () => {
    const seen: number[] = [];
    const report = stepProgress(5, (done) => void seen.push(done));
    for (let done = 0; done <= 100; done += 1) report(done, 100);
    assert.deepEqual(
      seen,
      Array.from({ length: 21 }, (_, i) => i * 5),
    );
    const unknown: number[] = [];
    const bytes = stepProgress(5, (done) => void unknown.push(done), 10);
    for (const done of [0, 3, 10, 12, 25]) bytes(done, 0);
    assert.deepEqual(unknown, [0, 10, 25]);
  });

  test('下载时边下边校验，对不上就删掉', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yoyo-dl-'));
    const asset: ReleaseAsset = { name: 'a.dmg', url: 'https://dl/a.dmg', size: DMG.length, digest: null };
    const system = fakeSystem({ 'https://dl/a.dmg': () => new Response(DMG) });
    const seen: number[] = [];
    await download(system, asset, DMG_SHA, join(dir, 'a.dmg'), (done) => void seen.push(done));
    assert.deepEqual(readFileSync(join(dir, 'a.dmg')), DMG);
    assert.deepEqual(seen, [0, DMG.length]);
    await assert.rejects(download(system, asset, '0'.repeat(64), join(dir, 'b.dmg')), /校验和对不上/);
    assert.equal(existsSync(join(dir, 'b.dmg')), false);
  });

  test('进程号文件里的进程还活着才算', () => {
    const { appPidFile, dataDir } = home();
    const system = fakeSystem({}, { pid: 42 });
    assert.equal(livePid(appPidFile, system), null);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(appPidFile, '42\n');
    assert.equal(livePid(appPidFile, system), 42);
    writeFileSync(appPidFile, '43\n');
    assert.equal(livePid(appPidFile, system), null);
  });

  describe('安装', () => {
    const name = dmgName('0.2.0', 'arm64');
    const asset: ReleaseAsset = { name, url: `https://dl/${name}`, size: DMG.length, digest: `sha256:${DMG_SHA}` };
    const check: UpdateCheck = {
      current: '0.1.0',
      latest: '0.2.0',
      available: true,
      page: 'https://github.com/modelctx-ai/yoyo/releases/tag/v0.2.0',
      body: '',
      asset,
      checksum: null,
      message: '',
    };
    const routes = { [`https://dl/${name}`]: () => new Response(DMG) };

    test('下载、挂上 dmg 取出 app、对版本和签名，交给 swap.sh，再让开着的 app 退出', async () => {
      const paths = home();
      mkdirSync(paths.dataDir, { recursive: true });
      writeFileSync(paths.appPidFile, '42');
      const system = fakeSystem(routes, { pid: 42 });
      const lines: string[] = [];
      const done: number[] = [];
      const result = await installUpdate({
        check,
        paths: { ...paths, appBundle: paths.app },
        system,
        out: (text) => void lines.push(text),
        progress: (got) => void done.push(got),
      });
      assert.deepEqual(result, { relaunch: true });
      assert.deepEqual(system.calls, [
        `fetch https://dl/${name}`,
        'hdiutil attach',
        `ditto ${join(paths.dataDir, 'updates', 'mount', 'yoyo.app')}`,
        `hdiutil detach`,
        `codesign --verify`,
        `spawn /bin/bash ${paths.app} <updates>/yoyo.app 42`,
        'kill 42 SIGTERM',
      ]);
      assert.deepEqual(lines, [`下载 ${name}`, '取出新的 yoyo.app']);
      assert.deepEqual(done, [0, DMG.length], '下载进度交给调用的人');
      assert.equal(existsSync(join(paths.dataDir, 'updates', 'swap.sh')), true, 'swap.sh 放到数据目录里跑');
      assert.equal(existsSync(join(paths.dataDir, 'updates', name)), false, '取完就删掉 dmg');
    });

    test('app 没开着就只换不重开；校验和从 .sha256 读', async () => {
      const paths = home();
      const sums = { name: `${name}.sha256`, url: `https://dl/${name}.sha256`, size: 0, digest: null };
      const system = fakeSystem({ ...routes, [sums.url]: () => new Response(`${DMG_SHA}  ${name}\n`) });
      const result = await installUpdate({
        check: { ...check, asset: { ...asset, digest: null }, checksum: sums },
        paths: { ...paths, appBundle: paths.app },
        system,
        out: () => {},
      });
      assert.deepEqual(result, { relaunch: false });
      assert.equal(system.calls.at(-1), `spawn /bin/bash ${paths.app} <updates>/yoyo.app 0`);
    });

    test('dmg 里的版本不对、不在 app 里跑，都不换', async () => {
      const paths = home();
      const wrong = fakeSystem(routes, { appVersion: '0.1.5' });
      await assert.rejects(
        installUpdate({ check, paths: { ...paths, appBundle: paths.app }, system: wrong, out: () => {} }),
        /dmg 里的版本是 0\.1\.5/,
      );
      assert.equal(
        wrong.calls.some((call) => call.startsWith('spawn')),
        false,
      );
      await assert.rejects(
        installUpdate({ check, paths: { ...paths, appBundle: null }, system: wrong, out: () => {} }),
        /只有 yoyo\.app 能自己更新/,
      );
    });
  });
});
