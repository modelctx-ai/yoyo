/**
 * 读、写、改文件三个工具，照 Claude Code 和 pi 的 read、write、edit。能碰哪里由 `features/files/access.ts` 的规则定：
 * 工作区能读能写，`files.readable` 只能读，配置、yoyo 自己的数据和密钥读不到。路径先展开 `~`、相对路径从工作区算起，
 * 再顺着符号链接解析成真实路径才比规则，链接指到外面也出不去。不问主人：范围本身就是把关。
 * 写和改都记进轨迹。只在主人发起的那一轮给（回复、右键对话、工作台、子任务），转告那一轮不给。
 * 跑命令的 `bash` 在 `bash.ts`，用同一份范围。
 */
import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { tool, type LocalToolRegistry } from '@modelctx-ai/ctx';
import { z } from 'zod';

import type { FilesConfig } from '../app/config.ts';
import type { Paths } from '../app/paths.ts';
import { checkAccess, inside, type FileMode, type FileRules } from '../features/files/access.ts';
import type { Repos } from '../ports/index.ts';

/** 只在主人发起的那一轮给的工具：读写文件的三个和跑命令的 `bash`。转告那一轮按这个清单去掉。 */
export const OWNER_TOOL_NAMES: readonly string[] = ['read', 'write', 'edit', 'bash'];

/** 一次最多读多少行、一行最多多少字、一次最多交回多少字。 */
export const READ_LINES = 2000;
export const LINE_MAX = 2000;
export const READ_OUTPUT_MAX = 60_000;
/** 读得动的最大文件、写得进的最大内容。 */
export const READ_FILE_MAX = 10 * 1024 * 1024;
export const WRITE_MAX = 5 * 1024 * 1024;
/** 目录最多列多少项。 */
export const LIST_MAX = 200;

/** 规则不让、路径不对、文件不在：原样交回模型的一句话。 */
export class FileError extends Error {}

/** 不管有没有打开，一律读不到的位置（相对主目录）。 */
const SECRET_DIRS = ['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.netrc', '.config/gcloud', 'Library/Keychains'];

export interface FileAccess {
  readonly workspace: string;
  /** 解析好的规则（真实路径）；`bash` 的沙箱设置照它拼。 */
  readonly rules: FileRules;
  /** 主人给的路径解析成真实的绝对路径，按规则查过；不让就抛 `FileError`。 */
  resolve(path: string, mode: FileMode): string;
  /** 给模型和轨迹看的写法：工作区里的写相对路径，别的写 `~/…` 或绝对路径。 */
  show(path: string): string;
}

/** 解析符号链接：存在的最长前缀换成真实路径，后面还不存在的部分原样接上。 */
function real(path: string): string {
  const rest: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync(current), ...rest.toReversed());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) return path;
      rest.push(basename(current));
      current = parent;
    }
  }
}

export interface FileAccessOptions {
  readonly config: Pick<FilesConfig, 'workspace' | 'readable' | 'denyRead'>;
  readonly paths: Pick<Paths, 'dataDir' | 'configFile' | 'workspaceDir' | 'artifactsDir'>;
  readonly home?: string;
}

export function createFileAccess(options: FileAccessOptions): FileAccess {
  const home = options.home ?? homedir();
  const expand = (path: string, base: string): string => {
    const trimmed = path.trim();
    if (trimmed === '~' || trimmed.startsWith('~/')) return join(home, trimmed.slice(1));
    return isAbsolute(trimmed) ? resolve(trimmed) : resolve(base, trimmed);
  };
  const workspaceDir = options.config.workspace.trim()
    ? expand(options.config.workspace, home)
    : options.paths.workspaceDir;
  mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
  const workspace = real(workspaceDir);
  const rules: FileRules = {
    workspace,
    // 交付物也能读：主线程看子任务交的文件，子 agent 看自己交过的
    readable: [options.paths.artifactsDir, ...options.config.readable].map((path) => real(expand(path, home))),
    denied: [
      options.paths.dataDir,
      options.paths.configFile,
      ...SECRET_DIRS.map((dir) => join(home, dir)),
      ...options.config.denyRead,
    ].map((path) => real(expand(path, home))),
  };
  const realHome = real(home);
  return {
    workspace,
    rules,
    resolve(path, mode) {
      if (!path.trim()) throw new FileError('要给路径');
      const target = real(expand(path, workspace));
      const problem = checkAccess(rules, target, mode);
      if (problem) throw new FileError(`${path}：${problem}`);
      return target;
    },
    show(path) {
      if (inside(path, workspace)) return relative(workspace, path) || '.';
      if (inside(path, realHome)) return `~/${relative(realHome, path)}`;
      return path;
    },
  };
}

/** 前 8 KB 里有 0 字节就当二进制。 */
function binary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8192).includes(0);
}

function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, '')} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`;
}

/** 目录：一行一项，目录带 `/`，文件带大小，按名字排。 */
export function listDirectory(path: string): string {
  const entries = readdirSync(path, { withFileTypes: true }).toSorted((a, b) => a.name.localeCompare(b.name));
  if (entries.length === 0) return '（空目录）';
  const rows = entries.slice(0, LIST_MAX).map((entry) => {
    if (entry.isDirectory()) return `${entry.name}/`;
    try {
      return `${entry.name}\t${sizeOf(statSync(join(path, entry.name)).size)}`;
    } catch {
      return entry.name;
    }
  });
  if (entries.length > LIST_MAX) rows.push(`……还有 ${entries.length - LIST_MAX} 项`);
  return rows.join('\n');
}

/** 文件：带行号，从第 `offset` 行起最多 `limit` 行；太长的行截断，总长有上限。 */
export function readLines(text: string, offset = 1, limit = READ_LINES): string {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) return '（空文件）';
  const start = Math.max(1, Math.floor(offset));
  if (start > lines.length) return `文件只有 ${lines.length} 行`;
  const picked = lines.slice(start - 1, start - 1 + Math.max(1, Math.floor(limit)));
  const out: string[] = [];
  let size = 0;
  for (const [i, line] of picked.entries()) {
    const row = `${start + i}\t${line.length > LINE_MAX ? `${line.slice(0, LINE_MAX)}…` : line}`;
    size += row.length + 1;
    if (size > READ_OUTPUT_MAX) {
      out.push(`……太长了，从第 ${start + i} 行接着读（offset）`);
      return out.join('\n');
    }
    out.push(row);
  }
  const end = start + picked.length - 1;
  if (end < lines.length) out.push(`……一共 ${lines.length} 行，从第 ${end + 1} 行接着读（offset）`);
  return out.join('\n');
}

/** 规则不让、文件不在这些原样交回模型；别的错照常抛。 */
function answered(work: () => string): string {
  try {
    return work();
  } catch (error) {
    if (error instanceof FileError) return error.message;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return '没有这个文件或目录';
    if (code === 'EISDIR') return '这是目录';
    if (code === 'ENOTDIR') return '路径中间有一段不是目录';
    if (code === 'EACCES' || code === 'EPERM') return '系统不让读写这个位置';
    throw error;
  }
}

export interface FileToolDeps {
  readonly access: FileAccess;
  readonly repos: Pick<Repos, 'activity'>;
  /** 三个工具各自给不给，见 `files.read`、`files.write`、`files.edit`。 */
  readonly allow: Pick<FilesConfig, 'read' | 'write' | 'edit'>;
}

export function addFileTools(registry: LocalToolRegistry, deps: FileToolDeps): void {
  const { access, repos, allow } = deps;
  const where = `工作区是 ${access.workspace}，相对路径从这里算起`;

  if (allow.read === 'allow') {
    registry.addTool(
      'read',
      tool({
        description:
          `读一个文件（带行号）或列一个目录。${where}；另外能读子任务的交付物和主人给的只读目录，配置、yoyo 自己的数据和密钥读不到。` +
          `一次最多 ${READ_LINES} 行，长文件用 offset、limit 分段读。`,
        inputSchema: z.object({
          path: z.string().describe('文件或目录，例如「notes/周报.md」「~/Documents」'),
          offset: z.number().int().positive().optional().describe('从第几行读起，缺省 1'),
          limit: z.number().int().positive().optional().describe(`最多读几行，缺省 ${READ_LINES}`),
        }),
        execute: async (input) =>
          answered(() => {
            const path = access.resolve(input.path, 'read');
            const stat = statSync(path);
            if (stat.isDirectory()) return listDirectory(path);
            const { size } = stat;
            if (size > READ_FILE_MAX) throw new FileError(`太大了（${sizeOf(size)}），最多读 ${sizeOf(READ_FILE_MAX)}`);
            const bytes = readFileSync(path);
            if (binary(bytes)) return `二进制文件（${sizeOf(size)}），读不了内容`;
            return readLines(bytes.toString('utf8'), input.offset, input.limit);
          }),
      }),
    );
  }

  if (allow.write === 'allow') {
    registry.addTool(
      'write',
      tool({
        description: `写一个文本文件，已有的整个换掉，目录不在会建好。只能写在工作区里（${access.workspace}）。改一小段用 edit。`,
        inputSchema: z.object({
          path: z.string().describe('文件，例如「notes/周报.md」'),
          content: z.string().describe('全部内容'),
        }),
        execute: async (input) =>
          answered(() => {
            const path = access.resolve(input.path, 'write');
            const bytes = Buffer.from(input.content, 'utf8');
            if (bytes.length > WRITE_MAX)
              throw new FileError(`太大了（${sizeOf(bytes.length)}），最多 ${sizeOf(WRITE_MAX)}`);
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
            writeFileSync(path, bytes, { mode: 0o600 });
            const shown = access.show(path);
            repos.activity.record({ type: 'file-write', path: shown, size: bytes.length });
            // 末尾的换行不算一行
            const lines = input.content ? input.content.replace(/\n$/, '').split('\n').length : 0;
            return `写好了：${shown}（${lines} 行，${sizeOf(bytes.length)}）`;
          }),
      }),
    );
  }

  if (allow.edit === 'allow') {
    registry.addTool(
      'edit',
      tool({
        description:
          `改工作区里的一个文件：把一段原文换成新的。原文要一字不差，而且只出现一次（多给点上下文）；要全换就 all 写 true。` +
          `只能改工作区里的（${access.workspace}）。改之前先 read 看一眼。`,
        inputSchema: z.object({
          path: z.string().describe('文件'),
          old: z.string().describe('要换掉的原文，一字不差'),
          new: z.string().describe('换成什么'),
          all: z.boolean().optional().describe('出现几次换几次'),
        }),
        execute: async (input) =>
          answered(() => {
            const path = access.resolve(input.path, 'write');
            if (!input.old) throw new FileError('原文不能空着；要写新文件用 write');
            if (input.old === input.new) throw new FileError('原文和新的一样，不用改');
            const text = readFileSync(path, 'utf8');
            const count = text.split(input.old).length - 1;
            if (count === 0) throw new FileError('没找到要换的原文：要一字不差，先 read 看一眼');
            if (count > 1 && !input.all) {
              throw new FileError(`原文出现了 ${count} 次：多给点上下文让它只出现一次，或者 all 写 true`);
            }
            const next = input.all ? text.split(input.old).join(input.new) : text.replace(input.old, () => input.new);
            if (Buffer.byteLength(next) > WRITE_MAX) throw new FileError(`改完太大了，最多 ${sizeOf(WRITE_MAX)}`);
            writeFileSync(path, next, 'utf8');
            const shown = access.show(path);
            repos.activity.record({ type: 'file-edit', path: shown, count: input.all ? count : 1 });
            return `改好了：${shown}，换了 ${input.all ? count : 1} 处`;
          }),
      }),
    );
  }
}
