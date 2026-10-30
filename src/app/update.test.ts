import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'vite-plus/test';

import {
  checkUpdate,
  compareVersions,
  dmgName,
  download,
  installUpdate,
  installedVersion,
  livePid,
  type ReleaseAsset,
  type UpdateCheck,
  type UpdateSystem,
} from './update.ts';

const DMG = Buffer.from('fake dmg');
const DMG_SHA = createHash('sha256').update(DMG).digest('hex');

function release(version: string, names: readonly string[]): unknown {
  return {
    tag_name: `v${version}`,
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
    const limited = fakeSystem({ [latest]: () => new Response('', { status: 403 }) });
    await assert.rejects(checkUpdate('0.1.0', limited), /限流/);
  });

  test('下载时边下边校验，对不上就删掉', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yoyo-dl-'));
    const asset: ReleaseAsset = { name: 'a.dmg', url: 'https://dl/a.dmg', size: DMG.length, digest: null };
    const system = fakeSystem({ 'https://dl/a.dmg': () => new Response(DMG) });
    const seen: number[] = [];
    await download(system, asset, DMG_SHA, join(dir, 'a.dmg'), (percent) => void seen.push(percent));
    assert.deepEqual(readFileSync(join(dir, 'a.dmg')), DMG);
    assert.deepEqual(seen, [100]);
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
      const result = await installUpdate({
        check,
        paths: { ...paths, appBundle: paths.app },
        system,
        out: (text) => void lines.push(text),
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
      assert.deepEqual(lines, [`下载 ${name}`, '下载 100%', '取出新的 yoyo.app']);
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
