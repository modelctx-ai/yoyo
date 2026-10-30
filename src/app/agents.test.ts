import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'vite-plus/test';

import { memoryLogger } from '../runtime/testing.ts';
import { loadAgentProfiles } from './agents.ts';

describe('读子 agent 文件', () => {
  test('目录里的 .md 一个一种；写错的跳过记一行；目录不在就只有内置的', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'yoyo-agents-')), 'agents');
    const logger = memoryLogger();
    assert.deepEqual(
      loadAgentProfiles(dir, logger).map((profile) => profile.name),
      ['general', 'research', 'writer'],
    );
    mkdirSync(dir);
    writeFileSync(join(dir, 'reviewer.md'), '---\ndescription: 看 PR\ntools: web_search\n---\n看 PR 描述');
    writeFileSync(join(dir, 'broken.md'), '没有 frontmatter');
    writeFileSync(join(dir, 'notes.txt'), '不是 agent');
    const profiles = loadAgentProfiles(dir, logger);
    assert.deepEqual(
      profiles.map((profile) => profile.name),
      ['general', 'research', 'reviewer', 'writer'],
    );
    assert.equal(profiles[2]?.source, join(dir, 'reviewer.md'));
    assert.equal(logger.lines.filter((line) => line.includes('broken.md')).length, 1, logger.lines.join('\n'));
  });
});
