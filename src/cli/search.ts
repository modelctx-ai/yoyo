/**
 * `yoyo search`：在 yoyo 自己的数据里找一个词，对话、子任务、交付物、记住的事、日程、联系人一起找。
 * 这里只管比对和排版，数据由命令读好交进来。每一行开头是哪一类，后面带着能接着查的编号。
 */
import { textOf, type Entry, type MemoryFact } from '@modelctx-ai/ctx';

import { STATE_LABELS } from '../features/tasks/tasks.ts';
import { localDateKey } from '../kernel/time.ts';
import type { AgentTask, Artifact, Contact, ScheduleItem } from '../kernel/types.ts';

export const SEARCH_KINDS = ['chat', 'tasks', 'files', 'facts', 'alarms', 'contacts'] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

const LABELS: Readonly<Record<SearchKind, string>> = {
  chat: '对话',
  tasks: '子任务',
  files: '交付物',
  facts: '事实',
  alarms: '日程',
  contacts: '联系人',
};

const NEXT: Readonly<Partial<Record<SearchKind, string>>> = {
  tasks: 'yoyo task show <编号>',
  files: 'yoyo artifact show <编号>',
  facts: 'yoyo memory history <id>',
};

const ROLES: Readonly<Record<string, string>> = { user: '主人', assistant: 'yoyo' };

const REPEATS: Readonly<Record<string, string>> = { daily: '每天', weekdays: '工作日', weekly: '每周' };

export interface SearchData {
  /** 主会话的条目，先后顺序随意。 */
  readonly entries?: readonly Entry[];
  readonly tasks?: readonly AgentTask[];
  readonly artifacts?: readonly Artifact[];
  readonly facts?: readonly MemoryFact[];
  readonly schedule?: readonly ScheduleItem[];
  readonly contacts?: readonly Contact[];
}

/** 搜的词：按空白拆开、不分大小写，每个都要有。 */
export function searchTerms(words: readonly string[]): string[] {
  return words
    .join(' ')
    .split(/\s+/)
    .map((word) => word.toLowerCase())
    .filter(Boolean);
}

/** `--in` 写的哪几类；没写或写错的全找。 */
export function searchKinds(value: string | undefined): SearchKind[] {
  const picked = (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item): item is SearchKind => (SEARCH_KINDS as readonly string[]).includes(item));
  return picked.length > 0 ? picked : [...SEARCH_KINDS];
}

function matches(text: string, terms: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return terms.every((term) => lower.includes(term));
}

/** 第一个词附近的一段，压成一行。 */
function snippet(text: string, terms: readonly string[], width = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = Math.max(0, flat.toLowerCase().indexOf(terms[0] ?? ''));
  const start = Math.max(0, Math.min(at - 15, flat.length - width));
  const piece = flat.slice(start, start + width);
  return `${start > 0 ? '…' : ''}${piece}${start + width < flat.length ? '…' : ''}`;
}

function minute(at: number): string {
  const date = new Date(at);
  return `${localDateKey(date)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function chatRows(entries: readonly Entry[], terms: readonly string[]): string[] {
  return entries
    .filter(
      (entry) => entry.type === 'message' && (entry.message.role === 'user' || entry.message.role === 'assistant'),
    )
    .toSorted((a, b) => b.at - a.at || b.seq - a.seq)
    .flatMap((entry) => {
      if (entry.type !== 'message') return [];
      const text = textOf(entry.message);
      return text && matches(text, terms)
        ? [`${minute(entry.at)}\t${ROLES[entry.message.role] ?? entry.message.role}\t${snippet(text, terms)}`]
        : [];
    });
}

function taskRows(tasks: readonly AgentTask[], terms: readonly string[]): string[] {
  return tasks.flatMap((task) => {
    const body = [task.goal, ...task.criteria, ...task.todos.map((todo) => todo.text), task.result, task.error]
      .filter(Boolean)
      .join('\n');
    if (!matches(`${task.title}\n${body}`, terms)) return [];
    // 标题里就有，列标题；不然带上正文里有这个词的那一段
    const where = matches(task.title, terms) ? task.title : `${task.title}：${snippet(body, terms, 40)}`;
    return [`#${task.id}\t${STATE_LABELS[task.state]}\t${task.agent}\t${where}`];
  });
}

function fileRows(artifacts: readonly Artifact[], terms: readonly string[]): string[] {
  return artifacts
    .filter((artifact) => matches(artifact.name, terms))
    .map((artifact) => `${artifact.id}\t#${artifact.task}\t${artifact.name}`);
}

function factRows(facts: readonly MemoryFact[], terms: readonly string[]): string[] {
  return facts
    .filter((fact) => matches(`${fact.topic ?? ''}\n${fact.text}`, terms))
    .toSorted((a, b) => b.validFrom - a.validFrom)
    .map((fact) => `${fact.id}\t${fact.topic ?? '-'}\t${snippet(fact.text, terms)}`);
}

function scheduleRows(items: readonly ScheduleItem[], terms: readonly string[]): string[] {
  return items
    .filter((item) => matches(item.title, terms))
    .map((item) => {
      const when = item.repeat ? (REPEATS[item.repeat] ?? item.repeat) : (item.date ?? '');
      return `${item.id}\t${when} ${item.time}\t${item.enabled ? item.kind : '关着'}\t${item.title}`;
    });
}

function contactRows(contacts: readonly Contact[], terms: readonly string[]): string[] {
  return contacts
    .filter((contact) => matches(`${contact.name}\n${contact.yoyo}\n${contact.note}`, terms))
    .map((contact) => `${contact.name}\t${contact.yoyo}${contact.note ? `\t${contact.note}` : ''}`);
}

/** 每类最多 `limit` 行，新的在前；一行开头是哪一类。都没有返回空数组。 */
export function searchRows(data: SearchData, terms: readonly string[], limit: number): string[] {
  const found: Record<SearchKind, string[]> = {
    chat: data.entries ? chatRows(data.entries, terms) : [],
    tasks: data.tasks ? taskRows(data.tasks, terms) : [],
    files: data.artifacts ? fileRows(data.artifacts, terms) : [],
    facts: data.facts ? factRows(data.facts, terms) : [],
    alarms: data.schedule ? scheduleRows(data.schedule, terms) : [],
    contacts: data.contacts ? contactRows(data.contacts, terms) : [],
  };
  const rows: string[] = [];
  const next: string[] = [];
  for (const kind of SEARCH_KINDS) {
    const hits = found[kind];
    if (hits.length === 0) continue;
    for (const row of hits.slice(0, limit)) rows.push(`${LABELS[kind]}\t${row}`);
    if (hits.length > limit) rows.push(`${LABELS[kind]}\t还有 ${hits.length - limit} 条，加 --limit 看更多`);
    const hint = NEXT[kind];
    if (hint) next.push(hint);
  }
  if (rows.length > 0 && next.length > 0) rows.push('', `下一步：${next.join('    ')}`);
  return rows;
}
