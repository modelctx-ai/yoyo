/**
 * `bash` 工具：跑一条命令，一律经沙箱程序（缺省 srt，见 `sandbox.ts`）：只能写工作区和一个临时目录，
 * 数据目录、配置、`~/.ssh` 这些读不到（和 `read` 同一份规则），网络缺省全关、按 `files.bashNetwork` 放行，
 * 有超时和输出上限。沙箱程序找不到、`sandbox.policy` 读不出，就没有这个工具，不退回到不加沙箱的跑法。
 * 不问主人：范围本身就是把关，和 `read`、`write`、`edit` 一样只在主人发起的那一轮给。每次都记进轨迹。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tool, type LocalToolRegistry } from '@modelctx-ai/ctx';
import { z } from 'zod';

import type { FilesConfig, SandboxConfig } from '../app/config.ts';
import { errorText } from '../app/log.ts';
import type { Paths } from '../app/paths.ts';
import { inside } from '../features/files/access.ts';
import type { Logger, Repos } from '../ports/index.ts';
import type { FileAccess } from './files.ts';
import { findProgram, prepareBashSandbox, sandboxArgv, type SandboxLauncher } from './sandbox.ts';

/** 一次最多交回多少字节：开头和结尾各留一段，中间省略（报错一般在结尾）。 */
export const BASH_HEAD = 20_000;
export const BASH_TAIL = 40_000;
/** 轨迹里记命令的前多少个字。 */
export const COMMAND_SHOWN = 120;
/** 超时后先请它自己停，这么久还不停就强杀。 */
const KILL_GRACE_MS = 2000;
/** 命令退出后等输出收完的时间；后台进程占着管道不放时到点就不等了。 */
const DRAIN_MS = 300;

/** 进沙箱的进程只带这些环境变量：yoyo 自己的环境里可能有密钥。 */
const ENV_KEEP = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TERM', 'TZ'];

/** 收输出：开头 `BASH_HEAD` 字节全留，后面只留最近 `BASH_TAIL` 字节，内存不随输出变大。 */
class Capture {
  private head: Buffer[] = [];
  private headSize = 0;
  private tail: Buffer = Buffer.alloc(0);
  private total = 0;

  push(chunk: Buffer): void {
    this.total += chunk.length;
    let rest = chunk;
    if (this.headSize < BASH_HEAD) {
      const take = rest.subarray(0, BASH_HEAD - this.headSize);
      this.head.push(take);
      this.headSize += take.length;
      rest = rest.subarray(take.length);
    }
    if (rest.length === 0) return;
    this.tail = Buffer.concat([this.tail, rest]);
    if (this.tail.length > BASH_TAIL * 2) this.tail = this.tail.subarray(-BASH_TAIL);
  }

  text(): string {
    const tail = this.tail.length > BASH_TAIL ? this.tail.subarray(-BASH_TAIL) : this.tail;
    const dropped = this.total - this.headSize - tail.length;
    const head = Buffer.concat(this.head).toString('utf8');
    if (dropped <= 0) return `${head}${tail.toString('utf8')}`;
    return `${head}\n……中间省略了 ${dropped} 字节……\n${tail.toString('utf8')}`;
  }
}

export interface BashRun {
  /** 正常退出的退出码；被信号杀掉、起不来是 null。 */
  readonly code: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly output: string;
  /** 进程起不来的原因。 */
  readonly failed?: string;
}

/** 一条命令的执行：自成一组进程，超时、中止或结束时整组收掉。 */
function execute(options: {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  readonly graceMs: number;
}): Promise<BashRun> {
  return new Promise((resolve) => {
    const [program = '', ...args] = options.argv;
    const capture = new Capture();
    let child: ChildProcess;
    try {
      child = spawn(program, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (error) {
      resolve({ code: null, signal: null, timedOut: false, output: '', failed: errorText(error) });
      return;
    }
    let timedOut = false;
    let finished = false;
    let killTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;

    const killGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        // 整组已经没了
      }
    };
    const finish = (run: Omit<BashRun, 'output' | 'timedOut'>): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      options.signal?.removeEventListener('abort', stop);
      // 留在后台的进程一并收掉
      killGroup('SIGKILL');
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ ...run, timedOut, output: capture.text() });
    };
    const stop = (): void => {
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), options.graceMs);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted) stop();

    child.stdout?.on('data', (chunk: Buffer) => capture.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => capture.push(chunk));
    child.on('error', (error) => finish({ code: null, signal: null, failed: errorText(error) }));
    // 输出收完（close）就交；后台进程占着管道不放时，退出后等一小会儿就不等了
    child.on('exit', (code, signal) => {
      drainTimer = setTimeout(() => finish({ code, signal }), DRAIN_MS);
    });
    child.on('close', (code, signal) => finish({ code, signal }));
  });
}

/** 给模型看的结果：第一行是退出码或者出了什么事，后面是 stdout 和 stderr 合在一起的输出。 */
export function bashAnswer(run: BashRun, timeoutSec: number, note = ''): string {
  const out = run.output.replace(/\s+$/, '');
  if (run.failed) return `命令没跑起来：${run.failed}`;
  const body = out || '（没有输出）';
  if (run.timedOut) return `超时了（${timeoutSec} 秒），已经杀掉。超时前的输出：\n${body}${note}`;
  if (run.code === null) return `被信号 ${run.signal ?? '未知'} 杀掉了，没有退出码。输出：\n${body}${note}`;
  return `退出码 ${run.code}\n${body}${note}`;
}

/** 命令的前一段，压成一行，给轨迹用。 */
export function commandHead(command: string): string {
  const line = command.replace(/\s+/g, ' ').trim();
  return line.length > COMMAND_SHOWN ? `${line.slice(0, COMMAND_SHOWN)}…` : line;
}

/** 用得上的沙箱：启动命令、跑命令用的 shell 和能写的临时目录。 */
export interface BashSandbox {
  readonly launcher: SandboxLauncher;
  readonly shell: string;
  readonly tmpDir: string;
}

export interface PrepareBashDeps {
  readonly files: Pick<FilesConfig, 'bash' | 'bashNetwork'>;
  readonly sandbox: SandboxConfig;
  readonly paths: Pick<Paths, 'dataDir' | 'configFile'>;
  readonly access: FileAccess;
  readonly logger: Logger;
  /** 找沙箱程序和 shell 用的环境变量，缺省 `process.env`。 */
  readonly env?: NodeJS.ProcessEnv;
  /** 临时目录所在的目录，缺省系统的。 */
  readonly tmpRoot?: string;
}

/** 命令能写的临时目录：每个用户一个固定的名字，在系统临时目录里。 */
function tmpDirOf(root: string): string {
  return join(realpathSync(root), `yoyo-bash-${process.getuid?.() ?? 'user'}`);
}

/** 建好，只有自己能进；别人的占了位置就不用。 */
function ensureTmpDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.getuid && statSync(dir).uid !== process.getuid()) throw new Error(`临时目录 ${dir} 不是你的`);
}

/**
 * 看沙箱能不能用：找沙箱程序、读 `sandbox.policy`、写设置文件、备好临时目录。
 * 不成就返回 null，并记一行为什么没有 `bash`；`files.bash` 设成 `deny` 时不找也不记。
 * 沙箱打不打开（`sandbox.enabled`）管的是 MCP 服务器，和这里无关。
 */
export function prepareBash(deps: PrepareBashDeps): BashSandbox | null {
  if (deps.files.bash !== 'allow') return null;
  const { workspace, readable, denied } = deps.access.rules;
  try {
    const tmpDir = tmpDirOf(deps.tmpRoot ?? tmpdir());
    const launcher = prepareBashSandbox(deps.sandbox, {
      dataDir: deps.paths.dataDir,
      configFile: deps.paths.configFile,
      ...(deps.env ? { env: deps.env } : {}),
      scope: {
        workspace,
        tmpDir,
        denyRead: denied,
        // 工作区缺省在数据目录里：整个数据目录读不到，工作区和交付物这类更深的要再放开
        allowRead: [workspace, ...readable].filter((path) => denied.some((dir) => path !== dir && inside(path, dir))),
        allowedDomains: deps.files.bashNetwork,
      },
    });
    ensureTmpDir(tmpDir);
    const shell = findProgram('bash', deps.env) ?? '/bin/sh';
    return { launcher, shell, tmpDir };
  } catch (error) {
    deps.logger.info(`没有 bash 工具：${errorText(error)}（命令一律经沙箱跑，不退回不加沙箱的跑法）`);
    return null;
  }
}

export interface BashToolDeps {
  readonly access: FileAccess;
  readonly repos: Pick<Repos, 'activity'>;
  readonly sandbox: BashSandbox;
  readonly config: Pick<FilesConfig, 'bashNetwork' | 'bashTimeout' | 'bashMaxTimeout'>;
  /** 命令的环境变量来源，缺省 `process.env`；只挑 `ENV_KEEP` 里的。 */
  readonly env?: NodeJS.ProcessEnv;
  /** 超时后到强杀的等待，测试里缩短。 */
  readonly graceMs?: number;
}

function sandboxEnv(source: NodeJS.ProcessEnv, tmpDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (ENV_KEEP.includes(key) || key.startsWith('LC_'))) env[key] = value;
  }
  env['TMPDIR'] = tmpDir;
  return env;
}

export function addBashTool(registry: LocalToolRegistry, deps: BashToolDeps): void {
  const { access, repos, sandbox, config } = deps;
  const max = config.bashMaxTimeout;
  const fallback = Math.min(config.bashTimeout, max);
  const network = config.bashNetwork.length > 0 ? `只能连：${config.bashNetwork.join('、')}` : '不能上网';
  registry.addTool(
    'bash',
    tool({
      description:
        `在沙箱里跑一条命令（bash），工作目录是工作区（${access.workspace}）。只能写工作区，别处只读；配置、yoyo 自己的数据和密钥读不到；${network}。` +
        `每次都是新开的 shell，cd 和变量不会留到下一次；没有输入，别跑要交互的。` +
        `stdout 和 stderr 合在一起交回，第一行是退出码，太长会省略中间。默认最多跑 ${fallback} 秒，用 timeout 可以要更久，最多 ${max} 秒，超时就杀掉。` +
        `读写文件优先用 read、write、edit；用命令生成的文件（例如画图脚本的输出）放在工作区里，再用 task_deliver 的 path 交。`,
      inputSchema: z.object({
        command: z.string().describe('要跑的命令，例如「ls -la」「python3 plot.py」'),
        timeout: z.number().positive().optional().describe(`最多跑几秒，缺省 ${fallback}，最多 ${max}`),
      }),
      execute: async (input, options) => {
        if (!input.command.trim()) return '要给命令';
        const seconds = Math.min(input.timeout ?? fallback, max);
        const clamped = input.timeout !== undefined && input.timeout > max;
        const run = await execute({
          argv: sandboxArgv(sandbox.launcher, [sandbox.shell, '-c', input.command]),
          cwd: access.workspace,
          env: sandboxEnv(deps.env ?? process.env, sandbox.tmpDir),
          timeoutMs: seconds * 1000,
          signal: options?.abortSignal,
          graceMs: deps.graceMs ?? KILL_GRACE_MS,
        });
        repos.activity.record({
          type: 'bash',
          command: commandHead(input.command),
          code: run.code,
          ...(run.signal ? { signal: run.signal } : {}),
          ...(run.timedOut ? { timedOut: true } : {}),
          ...(run.failed ? { failed: true } : {}),
        });
        return bashAnswer(run, seconds, clamped ? `\n（timeout 超过上限，按 ${max} 秒算）` : '');
      },
    }),
  );
}
