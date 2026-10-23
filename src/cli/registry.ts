/**
 * 命令从这张表长出来。顶层只列领域，细项要再问一层。
 * 找命令用 find，看用法用 inspect。不要在顶层把所有参数倒出来。
 */

/** `--key value` 记成字符串，后面没有值的 `--key` 记成 true。 */
export type Flags = Readonly<Record<string, string | true>>;

export interface Verb {
  readonly name: string;
  readonly summary: string;
  readonly flags?: readonly string[];
  run(flags: Flags): void | Promise<void>;
}

export interface Domain {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly summary: string;
  readonly detail?: string;
  readonly verbs: readonly Verb[];
}

export type DispatchResult =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'run'; readonly domain: Domain; readonly verb: Verb; readonly flags: Flags };

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
    const flags = (verb.flags ?? []).map((flag) => `--${flag}`).join(' ');
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
    if (domain.verbs.length === 1 && only?.name === 'now') return { kind: 'run', domain, verb: only, flags };
    return { kind: 'text', text: domainText(domain) };
  }
  const verb = domain.verbs.find((item) => item.name === verbName);
  if (!verb) return { kind: 'text', text: domainText(domain) };
  return { kind: 'run', domain, verb, flags };
}
