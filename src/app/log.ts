import type { Logger } from '../ports/index.ts';

export const consoleLogger: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.error(message),
  error: (message) => console.error(message),
};

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
