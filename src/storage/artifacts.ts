/**
 * 交付物的文件：`<目录>/<子任务编号>/<文件名>`。目录和文件只给自己读写（0700、0600）。
 * 文件名由调用的一方洗过；这里再挡一次，拼出来的路径出了这个子任务的目录就报错。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import type { ArtifactFiles } from '../ports/index.ts';

export function createArtifactFiles(dir: string): ArtifactFiles {
  const root = resolve(dir);

  function path(task: number, name: string): string {
    if (!Number.isInteger(task) || task <= 0) throw new Error(`子任务编号不对：${task}`);
    const folder = join(root, String(task));
    const file = resolve(folder, name);
    if (!file.startsWith(folder + sep) || file.slice(folder.length + 1).includes(sep)) {
      throw new Error(`文件名不对：${name}`);
    }
    return file;
  }

  return {
    path,
    write(task, name, bytes) {
      const file = path(task, name);
      mkdirSync(join(root, String(task)), { recursive: true, mode: 0o700 });
      writeFileSync(file, bytes, { mode: 0o600 });
      return file;
    },
    read(task, name) {
      try {
        return readFileSync(path(task, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    remove(task, name) {
      rmSync(path(task, name), { force: true });
    },
  };
}
