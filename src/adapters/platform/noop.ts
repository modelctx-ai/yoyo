import type { Clipboard, UrlOpener } from '../../ports/index.ts';

/** 不是 macOS 时用：粘贴板总是空的。 */
export const noopClipboard: Clipboard = {
  read: () => '',
};

/** 不是 macOS 时用：什么也不打开。 */
export const noopOpener: UrlOpener = {
  open: () => undefined,
};
