import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

import type {
  ActivityRecord,
  ActivityValue,
  AgentTask,
  AgentTaskState,
  Artifact,
  Contact,
  MemePack,
  Repeat,
  ScheduleItem,
  ScheduleKind,
  SpokenEntry,
} from '../kernel/types.ts';
import type { Repos } from '../ports/index.ts';
import { ensureSchema, transaction } from './db.ts';

/** 粘贴板只留最近这么多条。 */
const CLIP_LIMIT = 50;

type Value = SQLOutputValue | undefined;
type Row = Record<string, SQLOutputValue>;

function str(value: Value): string {
  return value === null || value === undefined ? '' : String(value);
}

function strOrNull(value: Value): string | null {
  return value === null || value === undefined ? null : String(value);
}

function numOrNull(value: Value): number | null {
  return typeof value === 'number' || typeof value === 'bigint' ? Number(value) : null;
}

function contactOf(row: Row): Contact {
  return {
    id: str(row.id),
    name: str(row.name),
    yoyo: str(row.yoyo),
    note: str(row.note),
    createdAt: str(row.createdAt),
  };
}

function scheduleOf(row: Row): ScheduleItem {
  return {
    id: str(row.id),
    title: str(row.title),
    kind: str(row.kind) as ScheduleKind,
    time: str(row.time),
    date: strOrNull(row.date),
    repeat: strOrNull(row.repeat) as Repeat | null,
    weekday: numOrNull(row.weekday),
    enabled: row.enabled === 1,
    lastFired: strOrNull(row.lastFired),
  };
}

function artifactOf(row: Row): Artifact {
  return {
    id: Number(row.id),
    task: Number(row.task_id),
    name: str(row.name),
    type: str(row.type),
    size: Number(row.size),
    createdAt: Number(row.created_at),
  };
}

function agentTaskOf(row: Row): AgentTask {
  return {
    id: Number(row.id),
    title: str(row.title),
    goal: str(row.goal),
    criteria: JSON.parse(str(row.criteria)) as string[],
    agent: str(row.agent) || 'general',
    state: str(row.state) as AgentTaskState,
    todos: JSON.parse(str(row.todos)) as AgentTask['todos'],
    result: strOrNull(row.result),
    checks: JSON.parse(str(row.checks)) as AgentTask['checks'],
    error: strOrNull(row.error),
    origin: str(row.origin),
    createdAt: Number(row.created_at),
    startedAt: numOrNull(row.started_at),
    finishedAt: numOrNull(row.finished_at),
    updatedAt: Number(row.updated_at),
    announcedAt: numOrNull(row.announced_at),
    question: strOrNull(row.question),
    askedAt: numOrNull(row.asked_at),
    answer: strOrNull(row.answer),
    answeredAt: numOrNull(row.answered_at),
    questionAnnouncedAt: numOrNull(row.question_announced_at),
  };
}

/** `update` 能改的字段对应的列；数组存成 JSON。 */
const TASK_COLUMNS: Readonly<Record<string, string>> = {
  state: 'state',
  todos: 'todos',
  result: 'result',
  checks: 'checks',
  error: 'error',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
  announcedAt: 'announced_at',
  question: 'question',
  askedAt: 'asked_at',
  answer: 'answer',
  answeredAt: 'answered_at',
  questionAnnouncedAt: 'question_announced_at',
};

function activityOf(row: Row): ActivityRecord {
  const payload = JSON.parse(str(row.payload)) as Record<string, ActivityValue>;
  return { at: str(row.at), type: str(row.type), ...payload };
}

/**
 * yoyo.db 上的各个 Repo，全部同步，语句和旧 db.js 一样。
 * `clock` 只用来给行为记录打时间。
 */
export function createRepos(db: DatabaseSync, clock: () => Date = () => new Date()): Repos {
  ensureSchema(db);
  const sql = {
    contacts: db.prepare('SELECT id, name, yoyo, note, created_at AS createdAt FROM contacts ORDER BY created_at'),
    insertContact: db.prepare('INSERT INTO contacts (id, name, yoyo, note, created_at) VALUES (?, ?, ?, ?, ?)'),
    removeContact: db.prepare('DELETE FROM contacts WHERE id = ?'),
    schedule: db.prepare(
      'SELECT id, title, kind, time, date, repeat, weekday, enabled, last_fired AS lastFired FROM schedule ORDER BY time',
    ),
    insertSchedule: db.prepare(
      'INSERT INTO schedule (id, title, kind, time, date, repeat, weekday, enabled, last_fired) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    markFired: db.prepare('UPDATE schedule SET last_fired = ? WHERE id = ?'),
    removeSchedule: db.prepare('DELETE FROM schedule WHERE id = ?'),
    clips: db.prepare('SELECT text, at FROM clipboard ORDER BY id DESC LIMIT ?'),
    insertClip: db.prepare('INSERT INTO clipboard (text, at) VALUES (?, ?)'),
    pruneClips: db.prepare('DELETE FROM clipboard WHERE id NOT IN (SELECT id FROM clipboard ORDER BY id DESC LIMIT ?)'),
    pack: db.prepare('SELECT fetched_at AS fetchedAt, query FROM meme_pack WHERE id = 1'),
    memes: db.prepare('SELECT url FROM memes ORDER BY rowid'),
    writePack: db.prepare('INSERT OR REPLACE INTO meme_pack (id, fetched_at, query) VALUES (1, ?, ?)'),
    clearMemes: db.prepare('DELETE FROM memes'),
    insertMeme: db.prepare('INSERT OR IGNORE INTO memes (url) VALUES (?)'),
    record: db.prepare('INSERT INTO activity (at, type, payload) VALUES (?, ?, ?)'),
    activity: db.prepare('SELECT at, type, payload FROM activity ORDER BY id DESC LIMIT ?'),
    spoken: db.prepare('SELECT text, at FROM spoken ORDER BY at, rowid'),
    forgetSpoken: db.prepare('DELETE FROM spoken WHERE at <= ?'),
    remember: db.prepare('INSERT OR REPLACE INTO spoken (text, at) VALUES (?, ?)'),
    getKv: db.prepare('SELECT value FROM kv WHERE key = ?'),
    setKv: db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)'),
    tasks: db.prepare('SELECT text FROM tasks ORDER BY id'),
    insertAgentTask: db.prepare(
      'INSERT INTO agent_tasks (title, goal, criteria, agent, state, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    agentTask: db.prepare('SELECT * FROM agent_tasks WHERE id = ?'),
    saveArtifact: db.prepare(
      'INSERT INTO artifacts (task_id, name, type, size, created_at) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT (task_id, name) DO UPDATE SET type = excluded.type, size = excluded.size, created_at = excluded.created_at',
    ),
    artifact: db.prepare('SELECT * FROM artifacts WHERE id = ?'),
    artifactByName: db.prepare('SELECT * FROM artifacts WHERE task_id = ? AND name = ?'),
    artifacts: db.prepare('SELECT * FROM artifacts ORDER BY created_at DESC, id DESC LIMIT ?'),
    taskArtifacts: db.prepare('SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'),
    removeArtifact: db.prepare('DELETE FROM artifacts WHERE id = ?'),
    agentTasks: db.prepare('SELECT * FROM agent_tasks ORDER BY id DESC LIMIT ?'),
  };

  return {
    contacts: {
      list() {
        return sql.contacts.all().map(contactOf);
      },
      insert(contact) {
        sql.insertContact.run(contact.id, contact.name, contact.yoyo, contact.note, contact.createdAt);
      },
      remove(id) {
        return Number(sql.removeContact.run(id).changes) > 0;
      },
    },
    schedule: {
      list() {
        return sql.schedule.all().map(scheduleOf);
      },
      insert(item) {
        sql.insertSchedule.run(
          item.id,
          item.title,
          item.kind,
          item.time,
          item.date ?? null,
          item.repeat ?? null,
          item.weekday ?? null,
          item.enabled ? 1 : 0,
          item.lastFired ?? null,
        );
      },
      markFired(id, occurrence) {
        sql.markFired.run(occurrence, id);
      },
      remove(id) {
        return Number(sql.removeSchedule.run(id).changes) > 0;
      },
    },
    clipboard: {
      list(limit = CLIP_LIMIT) {
        return sql.clips.all(limit).map((row) => ({ text: str(row.text), at: str(row.at) }));
      },
      insert(entry) {
        transaction(db, () => {
          sql.insertClip.run(entry.text, entry.at);
          sql.pruneClips.run(CLIP_LIMIT);
        });
      },
    },
    memes: {
      read(): MemePack | null {
        const pack = sql.pack.get();
        if (!pack) return null;
        const items = sql.memes.all().map((row) => ({ url: str(row.url) }));
        return { fetchedAt: str(pack.fetchedAt), query: str(pack.query), items };
      },
      write(pack) {
        transaction(db, () => {
          sql.writePack.run(pack.fetchedAt, pack.query);
          sql.clearMemes.run();
          for (const item of pack.items) sql.insertMeme.run(item.url);
        });
      },
    },
    activity: {
      record(event) {
        const { type, ...rest } = event;
        sql.record.run(clock().toISOString(), type, JSON.stringify(rest));
      },
      list(limit = 20) {
        return sql.activity.all(limit).toReversed().map(activityOf);
      },
    },
    spoken: {
      recent(now, windowMs) {
        const entries: SpokenEntry[] = [];
        for (const row of sql.spoken.all()) {
          if (typeof row.text !== 'string' || typeof row.at !== 'number') continue;
          if (now - row.at < windowMs) entries.push({ text: row.text, at: row.at });
        }
        return entries;
      },
      remember(text, at, windowMs) {
        // 结果和旧版 saveSpoken([...recent, 新句]) 一样：窗口外的丢掉，同一句只留最新的时间
        transaction(db, () => {
          sql.forgetSpoken.run(at - windowMs);
          sql.remember.run(text, at);
        });
      },
    },
    kv: {
      get(key) {
        return strOrNull(sql.getKv.get(key)?.value);
      },
      set(key, value) {
        sql.setKv.run(key, value);
      },
    },
    tasks: {
      list() {
        return sql.tasks.all().map((row) => str(row.text));
      },
    },
    agentTasks: {
      create(input, now) {
        const { lastInsertRowid } = sql.insertAgentTask.run(
          input.title,
          input.goal,
          JSON.stringify(input.criteria),
          input.agent,
          'queued',
          input.origin,
          now,
          now,
        );
        return agentTaskOf(sql.agentTask.get(lastInsertRowid)!);
      },
      get(id) {
        const row = sql.agentTask.get(id);
        return row ? agentTaskOf(row) : null;
      },
      list(options = {}) {
        // 子任务不会多：取最近的一批再按状态筛
        const rows = sql.agentTasks.all(options.states ? 500 : (options.limit ?? 50)).map(agentTaskOf);
        const picked = options.states ? rows.filter((task) => options.states!.includes(task.state)) : rows;
        return picked.slice(0, options.limit ?? 50);
      },
      update(id, patch, now) {
        const sets: string[] = ['updated_at = ?'];
        const values: (string | number | null)[] = [now];
        for (const [key, value] of Object.entries(patch)) {
          const column = TASK_COLUMNS[key];
          if (!column || value === undefined) continue;
          sets.push(`${column} = ?`);
          values.push(Array.isArray(value) ? JSON.stringify(value) : (value as string | number | null));
        }
        const changed = db.prepare(`UPDATE agent_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
        return Number(changed.changes) > 0 ? this.get(id) : null;
      },
    },
    artifacts: {
      save(input) {
        sql.saveArtifact.run(input.task, input.name, input.type, input.size, input.createdAt);
        return artifactOf(sql.artifactByName.get(input.task, input.name)!);
      },
      get(id) {
        const row = sql.artifact.get(id);
        return row ? artifactOf(row) : null;
      },
      list(options = {}) {
        const limit = options.limit ?? 200;
        const rows = options.task === undefined ? sql.artifacts.all(limit) : sql.taskArtifacts.all(options.task, limit);
        return rows.map(artifactOf);
      },
      remove(id) {
        return Number(sql.removeArtifact.run(id).changes) > 0;
      },
    },
  };
}
