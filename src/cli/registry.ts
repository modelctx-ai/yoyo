/**
 * 命令从这张表长出来。顶层只列领域，细项要再问一层。
 * 找命令用 find，看用法用 inspect。不要在顶层把所有参数倒出来。
 * 人和 agent 用的是同一张表：标了 `agent` 的动作，yoyo 自己的 agent（经 `yoyo` 工具）和别的 agent 都能调，
 * 见 `agentDomains`。
 */

/** `--key value` 记成字符串，后面没有值的 `--key` 记成 true。 */
export type Flags = Readonly<Record<string, string | true>>;

export interface Verb {
  readonly name: string;
  readonly summary: string;
  readonly flags?: readonly string[];
  /** 位置参数的写法，只给 inspect 看，例如 `<id>`。 */
  readonly usage?: string;
  /** agent 也能调：只读，不改东西、不碰桌宠和网络之外的设备、不打出密钥。 */
  readonly agent?: boolean;
  /** `args` 是动作后面的位置参数，例如 `yoyo memory forget <id>` 里的 id。 */
  run(flags: Flags, args: readonly string[]): void | Promise<void>;
}

export interface Domain {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly summary: string;
  readonly detail?: string;
  readonly verbs: readonly Verb[];
  /** 领域后面那个词不是动作时，当成这个动作的参数，例如 `yoyo search 周报` 就是 `yoyo search all 周报`。 */
  readonly fallback?: string;
}

/** agent 能看到、能调的那部分：只留标了 `agent` 的动作，一个都没有的领域整个不列。 */
export function agentDomains(domains: readonly Domain[]): Domain[] {
  const visible: Domain[] = [];
  for (const { fallback, ...domain } of domains) {
    const verbs = domain.verbs.filter((verb) => verb.agent);
    if (verbs.length === 0) continue;
    const keep = fallback && verbs.some((verb) => verb.name === fallback);
    visible.push({ ...domain, verbs, ...(keep ? { fallback } : {}) });
  }
  return visible;
}

export type DispatchResult =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'run';
      readonly domain: Domain;
      readonly verb: Verb;
      readonly flags: Flags;
      readonly args: readonly string[];
    };

export function parseArgs(argv: readonly string[]): { position: string[]; flags: Record<string, string | true> } {
  const position: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith('--')) {
      position.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else {
      flags[key] = next;
      i += 1;
    }
  }
  return { position, flags };
}

/** 一个 flag 的文字值；没给或只写了 `--key` 都算没有。 */
export function flagText(flags: Flags, key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' ? value : undefined;
}

function line(name: string, summary: string): string {
  return `${name.padEnd(10)} ${summary}`;
}

export function indexText(domains: readonly Domain[]): string {
  return [
    'yoyo <领域> [动作]',
    '',
    ...domains.map((domain) => line(domain.name, domain.summary)),
    '',
    '下一步：yoyo <领域>    yoyo find <词>    yoyo inspect <领域>',
  ].join('\n');
}

export function domainText(domain: Domain): string {
  const rows = domain.verbs.map((verb) => line(verb.name, verb.summary));
  return [`yoyo ${domain.name} <动作>`, '', ...rows].join('\n');
}

export function inspectText(domain: Domain): string {
  const usage = domain.verbs.map((verb) => {
    const flags = [verb.usage ?? '', ...(verb.flags ?? []).map((flag) => `--${flag}`)].filter(Boolean).join(' ');
    return `${line(verb.name, verb.summary)}${flags ? `\n           ${flags}` : ''}`;
  });
  return [`${domain.name}  ${domain.summary}`, '', ...usage, '', domain.detail ?? ''].join('\n').trim();
}

export function findDomains(domains: readonly Domain[], query: string | null | undefined): Domain[] {
  const needle = (query ?? '').trim().toLowerCase();
  if (!needle) return [];
  const hits: Domain[] = [];
  for (const domain of domains) {
    const blob =
      `${domain.name} ${(domain.aliases ?? []).join(' ')} ${domain.summary} ${domain.detail ?? ''}`.toLowerCase();
    if (blob.includes(needle)) hits.push(domain);
    for (const verb of domain.verbs) {
      const verbBlob = `${domain.name} ${verb.name} ${verb.summary}`.toLowerCase();
      if (verbBlob.includes(needle) && !hits.includes(domain)) hits.push(domain);
    }
  }
  return hits;
}

export function findText(domains: readonly Domain[], query: string): string {
  const hits = findDomains(domains, query);
  if (hits.length === 0) return `没有「${query}」。`;
  return hits.map((domain) => line(domain.name, domain.summary)).join('\n');
}

function lookup(domains: readonly Domain[], name: string | undefined): Domain | undefined {
  if (name === undefined) return undefined;
  return domains.find((item) => item.name === name || item.aliases?.includes(name));
}

export function dispatch(domains: readonly Domain[], argv: readonly string[]): DispatchResult {
  const { position, flags } = parseArgs(argv);
  const [head, verbName] = position;
  if (!head) return { kind: 'text', text: indexText(domains) };
  if (head === 'find') {
    return { kind: 'text', text: findText(domains, position.slice(1).join(' ') || flagText(flags, 'query') || '') };
  }
  if (head === 'inspect') {
    const name = position[1];
    const domain = lookup(domains, name);
    if (!domain) return { kind: 'text', text: `没有 ${name ?? ''}。试 yoyo find ${name ?? ''}` };
    return { kind: 'text', text: inspectText(domain) };
  }
  const domain = lookup(domains, head);
  if (!domain) return { kind: 'text', text: `没有 ${head}。试 yoyo find ${head}` };
  if (!verbName) {
    const [only] = domain.verbs;
    if (domain.verbs.length === 1 && only?.name === 'now') return { kind: 'run', domain, verb: only, flags, args: [] };
    return { kind: 'text', text: domainText(domain) };
  }
  const verb = domain.verbs.find((item) => item.name === verbName);
  if (verb) return { kind: 'run', domain, verb, flags, args: position.slice(2) };
  const fallback = domain.verbs.find((item) => item.name === domain.fallback);
  if (fallback) return { kind: 'run', domain, verb: fallback, flags, args: position.slice(1) };
  return { kind: 'text', text: domainText(domain) };
}
