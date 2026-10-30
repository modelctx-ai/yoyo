/**
 * 子任务的交付物：整理好的 Markdown、表格、图。子 agent 用 `task_deliver` 交，存在
 * `artifacts/<子任务编号>/<文件名>`，表 `artifacts` 记一条。只能交给在做的那个子任务，文件名只留最后一段，单个最大 5 MB。
 * 子任务不删，交付物跟着留着，要删在工作台或命令行里一个个删。
 */
import type { AgentTask, Artifact } from '../../kernel/types.ts';
import type { ArtifactFiles, Repos } from '../../ports/index.ts';
import { TaskError, artifactLine, runningTask, sizeText } from './tasks.ts';

/** 单个交付物最大多少字节。 */
export const ARTIFACT_MAX = 5 * 1024 * 1024;
/** 文件名最长多少字。 */
export const ARTIFACT_NAME_MAX = 100;
/** 一个子任务最多交几个。 */
export const ARTIFACTS_PER_TASK = 20;

type ArtifactRepos = Pick<Repos, 'agentTasks' | 'activity' | 'artifacts'>;

const TYPES: Readonly<Record<string, string>> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  html: 'text/html',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

/** 工作台怎么给人看：文本直接显示、图片显示，别的下载。HTML 和 SVG 能带脚本，只给下载。 */
export type ArtifactView = 'text' | 'image' | 'file';

export function artifactType(name: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  return TYPES[ext] ?? 'application/octet-stream';
}

export function artifactView(type: string): ArtifactView {
  if (type === 'text/html') return 'file';
  if (type.startsWith('text/') || type === 'application/json') return 'text';
  if (type.startsWith('image/') && type !== 'image/svg+xml') return 'image';
  return 'file';
}

/** 文件名只留最后一段，去掉控制字符和首尾空白；空的、`.` 开头的、太长的不收。 */
export function artifactName(raw: unknown): string {
  const last = (typeof raw === 'string' ? raw : '').split(/[\\/]/).at(-1) ?? '';
  // eslint-disable-next-line no-control-regex
  const name = last.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name) throw new TaskError('文件名不能空着，例如「周报.md」');
  if (name.startsWith('.')) throw new TaskError(`文件名不能以 . 开头：${name}`);
  if (name.length > ARTIFACT_NAME_MAX) throw new TaskError(`文件名太长了，最多 ${ARTIFACT_NAME_MAX} 字`);
  return name;
}

export interface DeliverInput {
  readonly id: number;
  readonly name: unknown;
  /** 文字，或者已经读出来的字节（从工作区里交文件时）。 */
  readonly content: unknown;
  /** `utf8`（缺省）或 `base64`（图片之类）。 */
  readonly encoding?: 'utf8' | 'base64';
}

/** 交一个文件给在做的子任务；同名的换成新的。 */
export function deliverArtifact(repos: ArtifactRepos, files: ArtifactFiles, input: DeliverInput, now: Date): Artifact {
  const task = runningTask(repos, input.id);
  const name = artifactName(input.name);
  const { content } = input;
  if (typeof content !== 'string' && !(content instanceof Uint8Array)) {
    throw new TaskError('内容要是一段文字；图片之类用 base64，encoding 写 base64');
  }
  const bytes =
    content instanceof Uint8Array
      ? Buffer.from(content)
      : input.encoding === 'base64'
        ? Buffer.from(content, 'base64')
        : Buffer.from(content, 'utf8');
  if (bytes.length === 0) throw new TaskError('内容不能空着');
  if (bytes.length > ARTIFACT_MAX) throw new TaskError(`太大了：${sizeText(bytes.length)}，单个最多 5 MB`);
  const existing = repos.artifacts.list({ task: task.id, limit: ARTIFACTS_PER_TASK + 1 });
  if (existing.length >= ARTIFACTS_PER_TASK && !existing.some((item) => item.name === name)) {
    throw new TaskError(`一个子任务最多交 ${ARTIFACTS_PER_TASK} 个文件`);
  }
  files.write(task.id, name, bytes);
  const artifact = repos.artifacts.save({
    task: task.id,
    name,
    type: artifactType(name),
    size: bytes.length,
    createdAt: now.getTime(),
  });
  repos.activity.record({ type: 'task-deliver', id: task.id, name, size: bytes.length });
  return artifact;
}

/** 删一个交付物：文件和记录一起删。没有这个返回 null。 */
export function removeArtifact(
  repos: Pick<Repos, 'artifacts' | 'activity'>,
  files: ArtifactFiles,
  id: number,
): Artifact | null {
  const artifact = repos.artifacts.get(id);
  if (!artifact) return null;
  files.remove(artifact.task, artifact.name);
  repos.artifacts.remove(id);
  repos.activity.record({ type: 'artifact-remove', id: artifact.task, name: artifact.name });
  return artifact;
}

/** 命令行的一行：编号、子任务、大小、类型、文件名。 */
export function artifactRow(artifact: Artifact): string {
  return `${artifact.id}\t#${artifact.task}\t${sizeText(artifact.size)}\t${artifact.type}\t${artifact.name}`;
}

/** 交好以后回给子 agent 的那句。 */
export function deliveredNote(task: Pick<AgentTask, 'id'>, artifact: Artifact, total: number): string {
  return `交好了：${artifactLine(artifact)}，子任务 #${task.id} 一共交了 ${total} 个文件`;
}
