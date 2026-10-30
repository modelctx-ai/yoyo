/**
 * 读写文件的工具能碰哪里：工作区能读能写，`readable` 里的只能读，`denied` 里的读不到。
 * 一条路径落在好几条规则里时，最具体的那条（目录最深的）说了算，一样深时不给。
 * 所以数据目录整个不给读，它下面的工作区和交付物照样能读；读得到的目录里的 `config.json` 照样读不到。
 * 这里只比路径，调用的一方先把路径（连同规则里的）解析成真实的绝对路径。
 */
import { isAbsolute, relative, sep } from 'node:path';

export interface FileRules {
  /** 能读能写。 */
  readonly workspace: string;
  /** 另外能读的。 */
  readonly readable: readonly string[];
  /** 读不到的。 */
  readonly denied: readonly string[];
}

export type FileMode = 'read' | 'write';

/** `path` 在 `dir` 里面（或者就是它）。 */
export function inside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** 落在哪几条规则里，取最深的那条的深度。 */
function depth(path: string, dirs: readonly string[]): number {
  return Math.max(-1, ...dirs.filter((dir) => inside(path, dir)).map((dir) => dir.split(sep).length));
}

/** 能不能这样碰；不能就回一句为什么。 */
export function checkAccess(rules: FileRules, path: string, mode: FileMode): string | null {
  const allowed = mode === 'write' ? [rules.workspace] : [rules.workspace, ...rules.readable];
  const allow = depth(path, allowed);
  const deny = depth(path, rules.denied);
  if (allow >= 0 && allow > deny) return null;
  if (deny >= 0 && deny >= allow) return '这个位置不给读写（密钥、配置、yoyo 自己的数据）';
  return mode === 'write'
    ? `只能写在工作区里：${rules.workspace}`
    : `读不到工作区和 files.readable 以外的地方：${rules.workspace}`;
}
