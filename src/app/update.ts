/**
 * yoyo.app 的自我更新：从 GitHub Release 取最新版本，下载这台机器架构的 dmg、校验，挂上取出 yoyo.app，
 * 交给 `swap.sh` 等 app 退出后换掉旧的再重开。从源码跑的不走这里，照旧 git pull。
 * 下载走 Node 的 fetch，换上的 app 不带隔离属性，不会再被系统拦一次。
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  accessSync,
  closeSync,
  constants,
  copyFileSync,
  createWriteStream,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { finished } from 'node:stream/promises';

import type { Paths } from './paths.ts';

/** 从哪个仓库的 Release 取新版本。`YOYO_UPDATE_REPO` 可以换，试更新流程时用。 */
export const UPDATE_REPO = 'modelctx-ai/yoyo';

export interface ReleaseAsset {
  readonly name: string;
  readonly url: string;
  readonly size: number;
  /** GitHub 给的 `sha256:<hex>`，旧的 Release 可能没有。 */
  readonly digest: string | null;
}

export interface Release {
  readonly version: string;
  readonly page: string;
  /** Release 的正文（更新说明），已经截断到 `NOTES_MAX` 个字以内。 */
  readonly body: string;
  readonly assets: readonly ReleaseAsset[];
}

/** 更新说明最多留多少字：给人在对话框里看的，太长的到 Release 页上看。 */
export const NOTES_MAX = 4000;

/** 换行统一成 `\n`、去掉首尾空白；太长就截断，末尾补「…」。 */
export function trimNotes(text: string, max = NOTES_MAX): string {
  const clean = text.replaceAll('\r\n', '\n').trim();
  return clean.length > max ? `${clean.slice(0, max).trimEnd()}\n…` : clean;
}

export interface UpdateCheck {
  /** 装着的版本；从源码跑时是 null。 */
  readonly current: string | null;
  /** Release 上最新的版本；还没发过是 null。 */
  readonly latest: string | null;
  /** 有比装着的新、这台机器能装的版本。 */
  readonly available: boolean;
  readonly page: string | null;
  /** Release 的正文（更新说明），没有是空串。 */
  readonly body: string;
  /** 这台机器架构的 dmg。 */
  readonly asset: ReleaseAsset | null;
  /** 和 dmg 同名的 `.sha256`。 */
  readonly checksum: ReleaseAsset | null;
  /** 给人看的一句话。 */
  readonly message: string;
}

/** 更新要碰的外部东西，测试时换成替身。 */
export interface UpdateSystem {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** 跑一个命令等它结束，失败就抛错。 */
  run(command: string, args: readonly string[]): void;
  /** 起一个脱离当前进程的命令，输出写进 `log`。 */
  spawnDetached(command: string, args: readonly string[], log: string): void;
  /** 进程还在就返回 true。 */
  alive(pid: number): boolean;
  kill(pid: number, signal: NodeJS.Signals): void;
  /** 这台机器的架构，按 `uname -m` 的叫法：arm64、x86_64。 */
  readonly arch: string;
}

export function createUpdateSystem(): UpdateSystem {
  return {
    fetch: (url, init) => fetch(url, init),
    run(command, args) {
      execFileSync(command, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 10 * 60_000 });
    },
    spawnDetached(command, args, log) {
      const fd = openSync(log, 'a', 0o600);
      try {
        const child = spawn(command, args, { detached: true, stdio: ['ignore', fd, fd] });
        child.once('error', () => {});
        child.unref();
      } finally {
        closeSync(fd);
      }
    },
    alive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    kill: (pid, signal) => process.kill(pid, signal),
    arch: process.arch === 'x64' ? 'x86_64' : process.arch,
  };
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** 按 semver 比：`a` 新返回正数。带预发布后缀（`-dev.abc`）的比同号的正式版旧。认不出的版本号当最旧。 */
export function compareVersions(a: string, b: string): number {
  const left = VERSION_PATTERN.exec(a.trim());
  const right = VERSION_PATTERN.exec(b.trim());
  if (!left || !right) return (left ? 1 : 0) - (right ? 1 : 0);
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(left[i]) - Number(right[i]);
    if (diff !== 0) return Math.sign(diff);
  }
  const [preA, preB] = [left[4], right[4]];
  if (preA === undefined || preB === undefined) return (preA === undefined ? 1 : 0) - (preB === undefined ? 1 : 0);
  const partsA = preA.split('.');
  const partsB = preB.split('.');
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i += 1) {
    const [x, y] = [partsA[i], partsB[i]];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const [nx, ny] = [/^\d+$/.test(x) ? Number(x) : null, /^\d+$/.test(y) ? Number(y) : null];
    if (nx !== null && ny !== null) return Math.sign(nx - ny);
    if (nx !== null || ny !== null) return nx !== null ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** 安装包里 `lib/VERSION` 写着的版本；从源码跑时没有，返回 null。 */
export function installedVersion(root: string): string | null {
  try {
    return readFileSync(join(root, 'lib', 'VERSION'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** 这个版本、这个架构的 dmg 叫什么，和 `scripts/release/package.sh` 一致。 */
export function dmgName(version: string, arch: string): string {
  return `yoyo-${version}-macos-${arch}.dmg`;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** 取最新的正式版（不含草稿和预发布）；还没发过返回 null。 */
export async function latestRelease(system: Pick<UpdateSystem, 'fetch'>, repo = UPDATE_REPO): Promise<Release | null> {
  const response = await system.fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'yoyo', 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return null;
  if (response.status === 403 || response.status === 429) throw new Error('GitHub 限流了，过一会儿再试');
  if (!response.ok) throw new Error(`GitHub 回了 ${response.status}`);
  const body = record(await response.json());
  const tag = typeof body['tag_name'] === 'string' ? body['tag_name'] : '';
  if (!VERSION_PATTERN.test(tag)) throw new Error(`最新的 Release 标签 ${tag || '(空)'} 不是版本号`);
  const assets = (Array.isArray(body['assets']) ? body['assets'] : []).map(record).map((asset): ReleaseAsset => ({
    name: typeof asset['name'] === 'string' ? asset['name'] : '',
    url: typeof asset['browser_download_url'] === 'string' ? asset['browser_download_url'] : '',
    size: Number(asset['size'] ?? 0),
    digest: typeof asset['digest'] === 'string' ? asset['digest'] : null,
  }));
  return {
    version: tag.replace(/^v/, ''),
    page: typeof body['html_url'] === 'string' ? body['html_url'] : `https://github.com/${repo}/releases/tag/${tag}`,
    body: typeof body['body'] === 'string' ? trimNotes(body['body']) : '',
    assets,
  };
}

export async function checkUpdate(
  current: string | null,
  system: Pick<UpdateSystem, 'fetch' | 'arch'>,
  repo = UPDATE_REPO,
): Promise<UpdateCheck> {
  const release = await latestRelease(system, repo);
  if (!release) {
    return {
      current,
      latest: null,
      available: false,
      page: null,
      body: '',
      asset: null,
      checksum: null,
      message: '还没有发布过的版本',
    };
  }
  const name = dmgName(release.version, system.arch);
  const asset = release.assets.find((item) => item.name === name) ?? null;
  const checksum = release.assets.find((item) => item.name === `${name}.sha256`) ?? null;
  const base = { current, latest: release.version, page: release.page, body: release.body, checksum };
  if (current === null) {
    return { ...base, available: false, asset, message: `最新的是 ${release.version}；从源码跑的用 git pull 更新` };
  }
  if (compareVersions(release.version, current) <= 0) {
    return { ...base, available: false, asset, message: `已经是最新的 ${current}` };
  }
  if (!asset) {
    return { ...base, available: false, asset, message: `${release.version} 发了，但没有 ${system.arch} 的安装包` };
  }
  return { ...base, available: true, asset, message: `${release.version} 可以更新了，现在是 ${current}` };
}

/** 校验和：先用 GitHub 给的 digest，没有就读同名的 `.sha256`。都没有不装。 */
async function expectedSha(
  system: Pick<UpdateSystem, 'fetch'>,
  asset: ReleaseAsset,
  file: ReleaseAsset | null,
): Promise<string> {
  const digest = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? '')?.[1];
  if (digest) return digest.toLowerCase();
  if (!file) throw new Error(`Release 里没有 ${asset.name} 的校验和`);
  const response = await system.fetch(file.url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`校验和没下下来：${response.status}`);
  const sha = /^[0-9a-f]{64}\b/i.exec((await response.text()).trim())?.[0];
  if (!sha) throw new Error(`${file.name} 里没有校验和`);
  return sha.toLowerCase();
}

/** 下载进度：已经下了多少字节、一共多少（Content-Length，没有就按 Release 里写的大小；都不知道是 0）。 */
export type DownloadProgress = (done: number, total: number) => void;

/** 下载到 `file`，边下边算 sha256，对不上就删掉并报错。每收到一块、开始时（0）都报一次进度。 */
export async function download(
  system: Pick<UpdateSystem, 'fetch'>,
  asset: ReleaseAsset,
  sha: string,
  file: string,
  progress: DownloadProgress = () => {},
): Promise<void> {
  const response = await system.fetch(asset.url, { signal: AbortSignal.timeout(30 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`安装包没下下来：${response.status}`);
  const total = Number(response.headers.get('content-length')) || asset.size || 0;
  const hash = createHash('sha256');
  const out = createWriteStream(file, { mode: 0o600 });
  let got = 0;
  progress(0, total);
  try {
    for await (const chunk of response.body) {
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await once(out, 'drain');
      progress(got, total);
    }
  } finally {
    out.end();
    await finished(out);
  }
  if (hash.digest('hex') !== sha) {
    rmSync(file, { force: true });
    throw new Error('下下来的安装包校验和对不上，没装');
  }
}

/**
 * 把每块都报的进度收成稀疏的：每涨 `percent`% 报一次（0 也报一次）；不知道总大小就每下 `unknownBytes` 报一次。
 * 终端里每 5% 一行、给 app 读的每 1% 一条，不刷屏。
 */
export function stepProgress(
  percent: number,
  report: DownloadProgress,
  unknownBytes = 4 * 1024 * 1024,
): DownloadProgress {
  let last = -1;
  return (done, total) => {
    const step = total > 0 ? Math.floor(((done / total) * 100) / percent) : Math.floor(done / unknownBytes);
    if (step <= last) return;
    last = step;
    report(done, total);
  };
}

/** 文件里的进程号还活着就返回它。 */
export function livePid(file: string, system: Pick<UpdateSystem, 'alive'>): number | null {
  let pid = 0;
  try {
    pid = Number(readFileSync(file, 'utf8').trim());
  } catch {
    return null;
  }
  return Number.isInteger(pid) && pid > 0 && system.alive(pid) ? pid : null;
}

export interface InstallOptions {
  readonly check: UpdateCheck;
  readonly paths: Pick<Paths, 'root' | 'dataDir' | 'appBundle' | 'appPidFile'>;
  readonly system: UpdateSystem;
  /** 一步一步做到哪了（给人看的一句话）。 */
  readonly out: (text: string) => void;
  /** 下载的进度，每收到一块报一次；要稀疏一点自己用 `stepProgress` 包。 */
  readonly progress?: DownloadProgress;
}

/** 装 dmg 里的这个 app。 */
const APP_IN_DMG = 'yoyo.app';

/**
 * 下载、校验、取出新的 yoyo.app，交给 `swap.sh`。app 开着就给它发 TERM：它收好常驻进程和桌宠后退出，
 * `swap.sh` 等它退了再换、再重开。返回要不要重开。
 */
export async function installUpdate(options: InstallOptions): Promise<{ readonly relaunch: boolean }> {
  const { check, paths, system, out, progress } = options;
  const app = paths.appBundle;
  if (!app) throw new Error('只有 yoyo.app 能自己更新；从源码跑的用 git pull');
  if (!check.available || !check.asset || !check.latest) throw new Error(check.message);
  try {
    accessSync(dirname(app), constants.W_OK);
    accessSync(app, constants.W_OK);
  } catch {
    throw new Error(`没有权限改 ${dirname(app)}：到 ${check.page ?? 'Release 页'} 下载 dmg 手动换`);
  }
  const swap = join(paths.root, 'lib', 'swap.sh');
  const dir = join(paths.dataDir, 'updates');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const sha = await expectedSha(system, check.asset, check.checksum);
  const dmg = join(dir, check.asset.name);
  out(`下载 ${check.asset.name}`);
  await download(system, check.asset, sha, dmg, progress);

  out('取出新的 yoyo.app');
  const mount = join(dir, 'mount');
  const staged = join(dir, APP_IN_DMG);
  mkdirSync(mount);
  system.run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, dmg]);
  try {
    system.run('ditto', [join(mount, APP_IN_DMG), staged]);
  } finally {
    try {
      system.run('hdiutil', ['detach', mount, '-force']);
    } catch {
      // 卸不掉也不影响换，下次开机就没了
    }
  }
  rmSync(dmg, { force: true });
  const version = installedVersion(join(staged, 'Contents', 'Resources'));
  if (version !== check.latest) throw new Error(`dmg 里的版本是 ${version ?? '(没有)'}，不是 ${check.latest}`);
  system.run('codesign', ['--verify', staged]);

  // swap.sh 从数据目录里跑：要换掉的 app 里的那份会跟着被挪走
  const script = join(dir, 'swap.sh');
  copyFileSync(swap, script);
  const pid = livePid(paths.appPidFile, system);
  system.spawnDetached('/bin/bash', [script, app, staged, String(pid ?? 0)], join(dir, 'swap.log'));
  if (pid !== null) system.kill(pid, 'SIGTERM');
  return { relaunch: pid !== null };
}
