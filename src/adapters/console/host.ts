import type { Logger, PetHost } from '../../ports/index.ts';

/** 什么也不产出，signal 中止时结束。不轮询，不占 CPU。 */
function idleUntil(signal: AbortSignal): AsyncIterable<never> {
  const aborted = new Promise<IteratorReturnResult<undefined>>((resolve) => {
    const end = (): void => resolve({ done: true, value: undefined });
    if (signal.aborted) end();
    else signal.addEventListener('abort', end, { once: true });
  });
  return { [Symbol.asyncIterator]: () => ({ next: () => aborted }) };
}

/** 没有桌宠的机器上调试用：台词打印到终端，语音照常播放。 */
export function createConsoleHost(logger: Logger): PetHost {
  return {
    name: 'console',
    async present(line, during) {
      logger.info(`[${line.action}] ${line.text}${line.imageUrl ? ` ${line.imageUrl}` : ''}`);
      if (during) await during();
    },
    async cue() {
      /* 终端里没有动作可播 */
    },
    async chatHistory() {
      return [];
    },
    async workStatus() {
      return null;
    },
    menu(_owner, _labels, signal) {
      return idleUntil(signal);
    },
    sayings(signal) {
      return idleUntil(signal);
    },
    async bindChat(binding) {
      logger.info('控制台模式没有桌宠对话，渠道不用接');
      return { model: binding.model };
    },
  };
}
