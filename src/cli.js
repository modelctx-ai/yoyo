/**
 * 命令从这张表长出来。顶层只列领域，细项要再问一层。
 * 找命令用 find，看用法用 inspect。不要在顶层把所有参数倒出来。
 */

export function parseArgs(argv) {
  const position = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
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

function line(name, summary) {
  return `${name.padEnd(10)} ${summary}`;
}

export function indexText(domains) {
  return ['yoyo <领域> [动作]', '', ...domains.map((domain) => line(domain.name, domain.summary)), '', '下一步：yoyo <领域>    yoyo find <词>    yoyo inspect <领域>'].join('\n');
}

export function domainText(domain) {
  const rows = domain.verbs.map((verb) => line(verb.name, verb.summary));
  return [`yoyo ${domain.name} <动作>`, '', ...rows].join('\n');
}

export function inspectText(domain) {
  const usage = domain.verbs.map((verb) => {
    const flags = (verb.flags ?? []).map((flag) => `--${flag}`).join(' ');
    return `${line(verb.name, verb.summary)}${flags ? `\n           ${flags}` : ''}`;
  });
  return [`${domain.name}  ${domain.summary}`, '', ...usage, '', domain.detail ?? ''].filter((part) => part !== undefined).join('\n').trim();
}

export function findDomains(domains, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return [];
  const hits = [];
  for (const domain of domains) {
    const blob = `${domain.name} ${(domain.aliases ?? []).join(' ')} ${domain.summary} ${domain.detail ?? ''}`.toLowerCase();
    if (blob.includes(needle)) hits.push(domain);
    for (const verb of domain.verbs) {
      const verbBlob = `${domain.name} ${verb.name} ${verb.summary}`.toLowerCase();
      if (verbBlob.includes(needle) && !hits.includes(domain)) hits.push(domain);
    }
  }
  return hits;
}

export function findText(domains, query) {
  const hits = findDomains(domains, query);
  if (hits.length === 0) return `没有「${query}」。`;
  return hits.map((domain) => line(domain.name, domain.summary)).join('\n');
}

export function dispatch(domains, argv) {
  const { position, flags } = parseArgs(argv);
  const [head, verbName] = position;
  if (!head) return { kind: 'text', text: indexText(domains) };
  if (head === 'find') return { kind: 'text', text: findText(domains, position.slice(1).join(' ') || flags.query || '') };
  if (head === 'inspect') {
    const name = position[1];
    const domain = domains.find((item) => item.name === name || item.aliases?.includes(name));
    if (!domain) return { kind: 'text', text: `没有 ${name ?? ''}。试 yoyo find ${name ?? ''}` };
    return { kind: 'text', text: inspectText(domain) };
  }
  const domain = domains.find((item) => item.name === head || item.aliases?.includes(head));
  if (!domain) return { kind: 'text', text: `没有 ${head}。试 yoyo find ${head}` };
  if (!verbName) {
    if (domain.verbs.length === 1 && domain.verbs[0].name === 'now') {
      return { kind: 'run', domain, verb: domain.verbs[0], flags };
    }
    return { kind: 'text', text: domainText(domain) };
  }
  const verb = domain.verbs.find((item) => item.name === verbName);
  if (!verb) return { kind: 'text', text: domainText(domain) };
  return { kind: 'run', domain, verb, flags };
}
