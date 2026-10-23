import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, test } from 'vite-plus/test';

import { isSqliteWarning, quietSqliteWarning } from './warnings.ts';

function warning(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

describe('warnings', () => {
  test('只丢掉 node:sqlite 的 ExperimentalWarning，别的警告照常交给原来的监听', () => {
    const target = new EventEmitter();
    const printed: string[] = [];
    target.on('warning', (item: Error) => printed.push(`${item.name}: ${item.message}`));
    quietSqliteWarning(target);
    target.emit(
      'warning',
      warning('ExperimentalWarning', 'SQLite is an experimental feature and might change at any time'),
    );
    target.emit('warning', warning('ExperimentalWarning', 'WASI is an experimental feature'));
    target.emit('warning', warning('DeprecationWarning', 'old api'));
    assert.deepEqual(printed, ['ExperimentalWarning: WASI is an experimental feature', 'DeprecationWarning: old api']);
    assert.equal(target.listenerCount('warning'), 1);
  });

  test('按名字和内容一起认', () => {
    assert.equal(isSqliteWarning(warning('ExperimentalWarning', 'SQLite is an experimental feature')), true);
    assert.equal(isSqliteWarning(warning('DeprecationWarning', 'SQLite something')), false);
  });
});
