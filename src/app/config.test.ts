import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'vite-plus/test';

import { cacheFile } from '../adapters/voice/fish.ts';
import { assertDirectorReady, loadConfig, parseConfig, speechReady } from './config.ts';

/** 第一版的 config.example.json（af306de）。 */
const FIRST = {
  pet: { baseUrl: 'http://127.0.0.1:3080/dsh-pet-7340', id: 'main', surface: 'desktop' },
  intervalSec: 300,
  speech: { baseUrl: 'https://api.fish.audio/v1/tts', apiKey: '', model: 's2.1-pro-free', referenceId: '' },
};

/** 加上模型、听写、搜索以后的 config.example.json（963fe62）。 */
const LATER = {
  pet: { baseUrl: 'http://127.0.0.1:3080/dsh-pet-7340', id: 'main', surface: 'desktop' },
  intervalSec: 300,
  speech: {
    baseUrl: 'https://api.fish.audio/v1/tts',
    apiKey: '',
    model: 's2.1-pro-free',
    referenceId: '',
    autoplay: true,
  },
  llm: { baseUrl: 'https://example.test/v1', apiKey: '', model: '' },
  listen: { enabled: true, seconds: 5, device: ':0', action: '碎碎念-对屏碎碎念' },
  asr: { model: 'tiny' },
  anysearch: { script: '', apiKey: '', maxResults: 3 },
};

const SPEECH = { apiKey: 'fish-key', referenceId: 'ref' };

describe('config', () => {
  test('第一版的配置原样能用：缺的段都按缺省值，没写 listen 就不听', () => {
    const config = parseConfig(FIRST);
    assert.equal(config.stage, 'dsh-pet');
    assert.equal(config.intervalSec, 300);
    assert.deepEqual(
      { enabled: config.listen.enabled, seconds: config.listen.seconds, action: config.listen.action },
      { enabled: false, seconds: 5, action: '碎碎念-对屏碎碎念' },
    );
    assert.equal(config.speech.autoplay, true);
    assert.equal(config.speech.tone, undefined);
    assert.deepEqual([config.llm.provider, config.llm.model, config.llm.tools], ['openai-compatible', '', false]);
    assert.deepEqual([config.clipboard.enabled, config.hotkey.enabled], [true, true]);
    assert.deepEqual(
      [config.context.keep, config.context.compactAt, config.context.maxTokens],
      [40, undefined, undefined],
    );
    assert.deepEqual(config.mcpServers, {});
  });

  test('后来的配置：listen 写了 enabled 才听，其余照旧', () => {
    const config = parseConfig(LATER);
    assert.equal(config.listen.enabled, true);
    assert.equal(config.listen.seconds, 5);
    assert.equal(config.asr.model, 'tiny');
    assert.equal(config.asr.bin, undefined);
    assert.deepEqual([config.anysearch.script, config.anysearch.maxResults], ['', 3]);
    assert.equal(config.llm.baseUrl, 'https://example.test/v1');
  });

  test('数字可以写成字符串；不是有限数或超出范围按缺省值', () => {
    const config = parseConfig({
      intervalSec: '600',
      listen: { seconds: '7' },
      anysearch: { maxResults: 0 },
      context: { compactAt: '2000', maxTokens: -5, keep: 'many' },
    });
    assert.equal(config.intervalSec, 600);
    assert.equal(config.listen.seconds, 7);
    assert.equal(config.anysearch.maxResults, 3);
    assert.deepEqual([config.context.compactAt, config.context.maxTokens, config.context.keep], [2000, undefined, 40]);
    const odd = parseConfig({ intervalSec: 'abc', listen: { seconds: [] }, anysearch: { maxResults: '4.5' } });
    assert.equal(odd.intervalSec, 300);
    assert.equal(odd.listen.seconds, 0, '空数组是 0，听几秒由 listenSeconds 收到 1 到 10');
    assert.equal(odd.anysearch.maxResults, 3);
    assert.equal(parseConfig({ anysearch: { maxResults: '5' } }).anysearch.maxResults, 5);
  });

  test('开关只认 true/false 和字符串 "true"/"false"，别的按缺省值', () => {
    const config = parseConfig({
      speech: { autoplay: 'false' },
      listen: { enabled: 'true' },
      clipboard: { enabled: 'no' },
      hotkey: { enabled: 0 },
      llm: { tools: 'true' },
    });
    assert.equal(config.speech.autoplay, false);
    assert.equal(config.listen.enabled, true);
    assert.equal(config.clipboard.enabled, true);
    assert.equal(config.hotkey.enabled, true);
    assert.equal(config.llm.tools, true);
    assert.equal(parseConfig({ listen: { enabled: 1 } }).listen.enabled, false);
  });

  test('选项写错或空着按缺省值', () => {
    const config = parseConfig({
      stage: 'tv',
      pet: { surface: '' },
      speech: { tone: '' },
      llm: { provider: 'openai' },
    });
    assert.equal(config.stage, 'dsh-pet');
    assert.equal(config.pet.surface, 'desktop');
    assert.equal(config.speech.tone, undefined);
    assert.equal(config.llm.provider, 'openai-compatible');
    assert.equal(parseConfig({ speech: { tone: 'angry' } }).speech.tone, undefined);
    assert.equal(parseConfig({ speech: { tone: 'calm' } }).speech.tone, 'calm');
    assert.equal(parseConfig({ stage: 'console' }).stage, 'console');
  });

  test('整段写成 null 或者不是对象，当没写', () => {
    const config = parseConfig({ ...FIRST, llm: null, listen: null, speech: null, context: 'x', mcpServers: null });
    assert.equal(config.llm.apiKey, '');
    assert.equal(config.listen.enabled, false);
    assert.equal(config.speech.model, 's2.1-pro-free');
    assert.equal(config.context.keep, 40);
    assert.deepEqual(config.mcpServers, {});
    assert.equal(parseConfig(null).stage, 'dsh-pet');
    assert.throws(() => parseConfig('config'), /config\.json 不对/);
  });

  test('文字：数字转成字符串，别的类型按缺省值；认不出的键保留', () => {
    const config = parseConfig({
      pet: { id: 2, baseUrl: null },
      anysearch: { command: ['node', 'cli.js', 8080, null] },
      extra: 1,
    });
    assert.equal(config.pet.id, '2');
    assert.equal(config.pet.baseUrl, 'http://127.0.0.1:3080/dsh-pet-7340');
    assert.deepEqual(config.anysearch.command, ['node', 'cli.js', '8080']);
    assert.equal((config as Record<string, unknown>)['extra'], 1);
    assert.equal(parseConfig({ anysearch: { command: 'node cli.js' } }).anysearch.command, undefined);
  });

  test('speech.model 和 referenceId 不去空白，语音缓存的文件名和旧代码一样', () => {
    const raw = { ...FIRST.speech, apiKey: ' fish-key ', referenceId: 'ref ' };
    const config = parseConfig({ ...FIRST, speech: raw });
    assert.equal(config.speech.referenceId, 'ref ');
    assert.equal(config.speech.apiKey, 'fish-key');
    // 旧代码的算法：sha256(`${model}\n${cue}\n${referenceId}\n${spokenText}`)，用的是配置里的原文
    const legacy = createHash('sha256')
      .update(`${raw.model}\n[happy]\n${raw.referenceId}\n[happy] 主人，我在这儿呢`)
      .digest('hex');
    assert.equal(cacheFile('/cache', config.speech, '主人，我在这儿呢', '[happy]'), join('/cache', `${legacy}.mp3`));
  });

  test('mcpServers 写得再怪也不挡启动，到连接时才逐台检查', () => {
    const servers = {
      odd: { url: 'http://localhost/mcp', type: 'streamable-http' },
      wrong: { transport: 'stdio', cmd: 'npx' },
      broken: 'npx some-server',
    };
    assert.deepEqual(parseConfig({ mcpServers: servers }).mcpServers, servers);
  });

  test('sandbox：缺省关闭、程序是 srt、没有 policy；写错按缺省；policy 可以是对象或路径', () => {
    assert.deepEqual(parseConfig(FIRST).sandbox, { enabled: false, command: ['srt'] });
    assert.deepEqual(parseConfig({ sandbox: null }).sandbox, { enabled: false, command: ['srt'] });
    assert.deepEqual(parseConfig({ sandbox: 'on' }).sandbox, { enabled: false, command: ['srt'] });
    assert.deepEqual(parseConfig({ sandbox: { enabled: 'yes', command: '  ', policy: 3 } }).sandbox, {
      enabled: false,
      command: ['srt'],
      policy: undefined,
    });
    assert.deepEqual(parseConfig({ sandbox: { enabled: 'true', command: [], policy: [] } }).sandbox, {
      enabled: true,
      command: ['srt'],
      policy: undefined,
    });
    assert.deepEqual(parseConfig({ sandbox: { command: ' /opt/srt ', policy: ' ./policy.json ' } }).sandbox, {
      enabled: false,
      command: ['/opt/srt'],
      policy: './policy.json',
    });
    const policy = { network: { allowedDomains: ['api.example.com'] }, filesystem: { allowWrite: [] } };
    assert.deepEqual(parseConfig({ sandbox: { enabled: true, command: ['srt', '--debug', 1, ''], policy } }).sandbox, {
      enabled: true,
      command: ['srt', '--debug', '1'],
      policy,
    });
  });

  test('驱动桌宠时语音和宠物地址必须填好；控制台舞台不要求语音', () => {
    assert.throws(() => assertDirectorReady(parseConfig(FIRST)), /speech\.apiKey 还空着/);
    assert.throws(
      () => assertDirectorReady(parseConfig({ speech: { ...SPEECH, referenceId: '   ' } })),
      /speech\.referenceId 还空着/,
    );
    assert.throws(() => assertDirectorReady(parseConfig({ speech: SPEECH, pet: { baseUrl: '' } })), /pet 不完整/);
    assert.doesNotThrow(() => assertDirectorReady(parseConfig({ speech: SPEECH })));
    assert.doesNotThrow(() => assertDirectorReady(parseConfig({ ...FIRST, stage: 'console' })));
    assert.equal(speechReady(parseConfig(FIRST).speech), false);
    assert.equal(speechReady(parseConfig({ speech: SPEECH }).speech), true);
  });

  test('loadConfig：文件不在、JSON 坏了都给中文提示', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yoyo-'));
    const file = join(dir, 'config.json');
    assert.throws(() => loadConfig(file), /找不到 .*config\.json，先把 config\.example\.json 复制成 config\.json/);
    writeFileSync(file, '{ "pet": ');
    assert.throws(() => loadConfig(file), /config\.json 不是合法的 JSON/);
    writeFileSync(file, JSON.stringify(LATER));
    assert.equal(loadConfig(file).listen.enabled, true);
  });
});
