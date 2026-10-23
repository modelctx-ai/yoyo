/**
 * node:sqlite 一加载就打一行 ExperimentalWarning，每条命令都看到很烦。只去掉这一条，别的警告照 Node 原样打印。
 * 入口要在加载 node:sqlite 之前引入本模块（放在第一条 import）。
 */

type WarningListener = (warning: Error) => void;

interface WarningTarget {
  listeners(event: 'warning'): Function[];
  removeAllListeners(event: 'warning'): unknown;
  on(event: 'warning', listener: WarningListener): unknown;
}

export function isSqliteWarning(warning: Error): boolean {
  return warning.name === 'ExperimentalWarning' && warning.message.includes('SQLite');
}

/** 换掉 Node 缺省的 warning 监听：SQLite 那条丢掉，别的交回原来的监听去打印。 */
export function quietSqliteWarning(target: WarningTarget = process): void {
  const defaults = target.listeners('warning') as WarningListener[];
  target.removeAllListeners('warning');
  target.on('warning', (warning) => {
    if (isSqliteWarning(warning)) return;
    for (const listener of defaults) listener(warning);
  });
}

quietSqliteWarning();
