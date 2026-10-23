import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import type { AudioPlayer, PlayOptions } from '../../ports/index.ts';
import { createSfxPlayer, ensureSfx, sceneFor, wavBytes } from './sfx.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'yoyo-'));
}

function fakePlayer(fire: AudioPlayer['fire'] = () => undefined) {
  const fired: { file: string; options: PlayOptions | undefined }[] = [];
  const player: AudioPlayer = {
    play: async () => undefined,
    fire(file, options) {
      fired.push({ file, options });
      fire(file, options);
    },
  };
  return { fired, player };
}

describe('sfx', () => {
  test('动作配上对应的轻声场景', () => {
    assert.equal(sceneFor('写代码'), 'keys');
    assert.equal(sceneFor('超大伸懒腰'), 'stretch');
    assert.equal(sceneFor('碎碎念-发呆碎碎念'), 'rest');
    assert.equal(sceneFor('碎碎念-对屏碎碎念'), 'murmur');
    assert.equal(sceneFor('打哈欠'), 'stretch');
    assert.equal(sceneFor('深呼吸'), 'rest');
    assert.equal(sceneFor('挥手'), 'cheer');
    assert.equal(sceneFor('吃冰淇淋'), 'clink');
    assert.equal(sceneFor('礼仪'), 'chime');
    assert.equal(sceneFor('东张西望'), 'look');
  });

  test('wav 文件头和 16 位采样', () => {
    const bytes = wavBytes(Float32Array.from([0, 0.5, -0.5, 1, -1, 2, -2]), 22050);
    assert.equal(bytes.length, 44 + 7 * 2);
    assert.equal(
      bytes.subarray(0, 44).toString('hex'),
      [
        '52494646', // RIFF
        '32000000', // 36 + 14
        '57415645', // WAVE
        '666d7420', // fmt
        '10000000', // 16
        '0100', // PCM
        '0100', // 单声道
        '22560000', // 22050
        '44ac0000', // 44100 字节/秒
        '0200', // 块对齐
        '1000', // 16 位
        '64617461', // data
        '0e000000', // 14
      ].join(''),
    );
    const samples = Array.from({ length: 7 }, (_, i) => bytes.readInt16LE(44 + i * 2));
    assert.deepEqual(samples, [0, 16384, -16383, 32767, -32767, 32767, -32767]);
  });

  test('每种场景只合成一次', () => {
    const dir = join(tempDir(), 'sfx');
    const file = ensureSfx(dir, '写代码');
    assert.equal(file, join(dir, 'keys.wav'));
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    const bytes = readFileSync(file);
    assert.equal(bytes.subarray(0, 4).toString(), 'RIFF');
    assert.equal(bytes.length, 44 + Math.floor(22050 * 0.05) * 2);

    writeFileSync(file, '已经有了');
    assert.equal(ensureSfx(dir, '敲键盘写代码'), file);
    assert.equal(readFileSync(file, 'utf8'), '已经有了');
  });

  test('配音用 0.18 的音量在后台放', () => {
    const dir = tempDir();
    const { fired, player } = fakePlayer();
    createSfxPlayer({ dir, player }).play('写代码');
    createSfxPlayer({ dir, player, volume: 0.3 }).play('东张西望');
    assert.deepEqual(fired, [
      { file: join(dir, 'keys.wav'), options: { volume: 0.18 } },
      { file: join(dir, 'look.wav'), options: { volume: 0.3 } },
    ]);
  });

  test('配音失败不影响台词', () => {
    const blocked = join(tempDir(), '是个文件');
    writeFileSync(blocked, '');
    const { fired, player } = fakePlayer();
    assert.doesNotThrow(() => createSfxPlayer({ dir: join(blocked, 'sfx'), player }).play('写代码'));
    assert.equal(fired.length, 0);

    const broken = fakePlayer(() => {
      throw new Error('放不出来');
    });
    assert.doesNotThrow(() => createSfxPlayer({ dir: tempDir(), player: broken.player }).play('写代码'));
  });
});
