import { createHash } from 'node:crypto';
import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

import type { McpServerConfig } from '@modelctx-ai/ctx-mcp';

import type { SandboxConfig } from '../app/config.ts';
import { inside } from '../features/files/access.ts';

/**
 * 把 stdio 的 MCP 服务器放进沙箱程序里启动（缺省 srt，`@anthropic-ai/sandbox-runtime`）。
 * yoyo 不依赖、不加载 srt 的包，只把启动命令改写成 `<sandbox.command…> --settings <文件> -- <command> <args…>`：
 * 任何接受这条命令行的程序都可以写进 `sandbox.command`。这里是 yoyo 唯一知道 srt 设置形状的地方。
 */

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 沙箱里的进程一律不能写的位置：数据目录（`yoyo.db`、设置文件）、`config.json`、`policy` 指向的文件。 */
export interface SandboxGuards {
  readonly dataDir: string;
  readonly configFile: string;
  readonly policyFile?: string;
}

/**
 * 交给沙箱程序的设置：用户的 `policy` 原样保留，`filesystem.denyWrite` 追加 yoyo 自己的位置，
 * `network.allowedDomains`、`network.deniedDomains`、`filesystem.denyRead`、`filesystem.allowWrite` 缺的补成空数组。
 * 别的字段不校验，由沙箱程序校验。
 */
export function sandboxSettings(policy: Json, guards: SandboxGuards): Json {
  const base = structuredClone(policy);
  const network: Json = isRecord(base['network']) ? { ...base['network'] } : {};
  network['allowedDomains'] ??= [];
  network['deniedDomains'] ??= [];
  const filesystem: Json = isRecord(base['filesystem']) ? { ...base['filesystem'] } : {};
  filesystem['denyRead'] ??= [];
  filesystem['allowWrite'] ??= [];
  const own = [guards.dataDir, guards.configFile, ...(guards.policyFile ? [guards.policyFile] : [])].map((path) =>
    resolve(path),
  );
  filesystem['denyWrite'] = [...list(filesystem['denyWrite']), ...own];
  return { ...base, network, filesystem };
}

/** 设置文件的内容和文件名：文件名按内容哈希，内容相同的复用同一个文件。 */
export function settingsFile(settings: Json): { readonly name: string; readonly text: string } {
  const text = `${JSON.stringify(settings, null, 2)}\n`;
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
  return { name: `settings-${hash}.json`, text };
}

/** 写到 `<dataDir>/sandbox/`（目录 0700、文件 0600），返回文件的路径。 */
export function writeSandboxSettings(dataDir: string, settings: Json): string {
  const { name, text } = settingsFile(settings);
  const dir = join(resolve(dataDir), 'sandbox');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, name);
  try {
    writeFileSync(file, text, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return file;
}

function runnable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 在 PATH 上找可执行文件；带 `/` 的按路径找。找不到返回 undefined。 */
export function findProgram(program: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (program.includes('/')) return runnable(program) ? resolve(program) : undefined;
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, program);
    if (runnable(file)) return isAbsolute(file) ? file : resolve(file);
  }
  return undefined;
}

/** 改写好的启动方式：沙箱程序（绝对路径）、它自己的选项，和设置文件。 */
export interface SandboxLauncher {
  readonly command: string;
  readonly options: readonly string[];
  readonly settingsFile: string;
}

/** 在沙箱程序里跑一条命令行：`<沙箱程序> <它的选项…> --settings <文件> -- <argv…>`。 */
export function sandboxArgv(launcher: SandboxLauncher, argv: readonly string[]): string[] {
  return [launcher.command, ...launcher.options, '--settings', launcher.settingsFile, '--', ...argv];
}

/** 把一台 stdio 服务器改成在沙箱程序里启动。`env`、`cwd` 和别的字段原样保留；`url` 的不动。 */
export function sandboxed(server: McpServerConfig, launcher: SandboxLauncher): McpServerConfig {
  if (!('command' in server)) return server;
  const { command, args = [], ...rest } = server;
  const [program = launcher.command, ...programArgs] = sandboxArgv(launcher, [command, ...args]);
  return { ...rest, command: program, args: programArgs };
}

/** 这台服务器要不要放进沙箱：有 `command`、没写 `"sandbox": false`。 */
export function wantsSandbox(raw: unknown, server: McpServerConfig): boolean {
  if (!('command' in server)) return false;
  const flag = isRecord(raw) ? raw['sandbox'] : undefined;
  return flag !== false && flag !== 'false';
}

function readPolicyFile(file: string): Json {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`sandbox.policy 的文件 ${file} 读不出（${(error as NodeJS.ErrnoException).code ?? '读取失败'}）`, {
      cause: error,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`sandbox.policy 的文件 ${file} 不是 JSON`, { cause: error });
  }
  if (!isRecord(value)) throw new Error(`sandbox.policy 的文件 ${file} 不是 JSON 对象`);
  return value;
}

export interface PrepareSandboxOptions {
  readonly dataDir: string;
  readonly configFile: string;
  /** 找沙箱程序用的环境变量，缺省 `process.env`。 */
  readonly env?: NodeJS.ProcessEnv;
}

/** 找沙箱程序、读 `policy`：返回程序的绝对路径、它自己的选项、policy 的内容和（是文件时）文件的路径。 */
function resolveSandbox(config: SandboxConfig, options: PrepareSandboxOptions) {
  const [program = 'srt', ...programOptions] = config.command;
  const command = findProgram(program, options.env);
  if (!command) throw new Error(`沙箱程序 ${program} 找不到`);
  const policyFile =
    typeof config.policy === 'string' ? resolve(dirname(resolve(options.configFile)), config.policy) : undefined;
  const policy = policyFile ? readPolicyFile(policyFile) : isRecord(config.policy) ? config.policy : {};
  return { command, programOptions, policy, policyFile };
}

/**
 * 找沙箱程序、读 `policy`、写设置文件。任何一步不成都抛错（说明为什么），调用方据此不启动要放进沙箱的服务器，
 * 不退回到不加沙箱运行。
 */
export function prepareSandbox(config: SandboxConfig, options: PrepareSandboxOptions): SandboxLauncher {
  const { command, programOptions, policy, policyFile } = resolveSandbox(config, options);
  const settings = sandboxSettings(policy, {
    dataDir: options.dataDir,
    configFile: options.configFile,
    ...(policyFile ? { policyFile } : {}),
  });
  return { command, options: programOptions, settingsFile: writeSandboxSettings(options.dataDir, settings) };
}

/** `bash` 工具的沙箱范围：能写哪里、读不到哪里、网络放行哪些域名。路径都是解析过的真实路径。 */
export interface BashScope extends SandboxGuards {
  /** 命令的工作目录，也是唯一能写的地方（再加 `tmpDir`）。 */
  readonly workspace: string;
  readonly tmpDir: string;
  readonly denyRead: readonly string[];
  /** 落在 `denyRead` 里、但又得读的位置（工作区缺省在数据目录里），沙箱程序里 `allowRead` 盖过 `denyRead`。 */
  readonly allowRead: readonly string[];
  readonly allowedDomains: readonly string[];
}

/**
 * `bash` 的设置：`sandbox.policy` 里和范围无关的字段（例如 `enableWeakerNestedSandbox`）、`network.deniedDomains`、
 * `filesystem.denyRead`、`filesystem.denyWrite` 保留；`network.allowedDomains`、`filesystem.allowWrite`、`filesystem.allowRead`
 * 换成这里的，policy 里给 MCP 服务器放行的域名和可写目录不借给 bash。`denyWrite` 追加 yoyo 的位置里落在工作区里面的
 * （在工作区外面的本来就不可写；包着工作区的不能加，`denyWrite` 盖过 `allowWrite`，加了工作区就写不了）。
 */
export function bashSandboxSettings(policy: Json, scope: BashScope): Json {
  const base = structuredClone(policy);
  const network = isRecord(base['network']) ? base['network'] : {};
  const filesystem = isRecord(base['filesystem']) ? base['filesystem'] : {};
  const own = [scope.dataDir, scope.configFile, ...(scope.policyFile ? [scope.policyFile] : [])]
    .map((path) => resolve(path))
    .filter((path) => path !== scope.workspace && inside(path, scope.workspace));
  return {
    ...base,
    network: { allowedDomains: [...scope.allowedDomains], deniedDomains: list(network['deniedDomains']) },
    filesystem: {
      denyRead: [...list(filesystem['denyRead']), ...scope.denyRead],
      allowRead: [...scope.allowRead],
      allowWrite: [scope.workspace, scope.tmpDir],
      denyWrite: [...list(filesystem['denyWrite']), ...own],
    },
  };
}

export interface PrepareBashOptions extends PrepareSandboxOptions {
  readonly scope: Omit<BashScope, 'dataDir' | 'configFile' | 'policyFile'>;
}

/** 和 `prepareSandbox` 一样，只是 bash 用自己的设置（文件名按内容哈希，和 MCP 的分开）。不成就抛错。 */
export function prepareBashSandbox(config: SandboxConfig, options: PrepareBashOptions): SandboxLauncher {
  const { command, programOptions, policy, policyFile } = resolveSandbox(config, options);
  const settings = bashSandboxSettings(policy, {
    ...options.scope,
    dataDir: options.dataDir,
    configFile: options.configFile,
    ...(policyFile ? { policyFile } : {}),
  });
  return { command, options: programOptions, settingsFile: writeSandboxSettings(options.dataDir, settings) };
}
