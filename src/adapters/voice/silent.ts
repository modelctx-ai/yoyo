import type { AudioPlayer, Logger, SfxPlayer, Synthesizer } from '../../ports/index.ts';

/** 没配语音时用：不合成，返回空路径，导演就不播放，只出字。 */
export const silentSynthesizer: Synthesizer = {
  async synthesize() {
    return '';
  },
};

/** 没有 afplay 的系统上用：不播放。第一次要播时记一行，之后不再提。 */
export function createSilentPlayer(logger: Logger): AudioPlayer {
  let told = false;
  const tell = (): void => {
    if (told) return;
    told = true;
    logger.info('这台机器不是 macOS，没有 afplay，语音和配音都不播放');
  };
  return {
    async play() {
      tell();
    },
    fire() {
      tell();
    },
  };
}

/** 没有 afplay 的系统上用：不生成也不放配音。 */
export const silentSfx: SfxPlayer = {
  play() {
    /* 没有播放器，配音省掉 */
  },
};
