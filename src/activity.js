import { listActivity as readActivity, recordActivity } from './db.js';

/** 每一件做过的事记进 SQLite。不写密钥。 */
export function record(dataDir, event) {
  recordActivity(dataDir, event);
}

export function listActivity(dataDir, limit = 20) {
  return readActivity(dataDir, limit);
}
