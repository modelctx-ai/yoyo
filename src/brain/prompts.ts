import type { Fact } from '@modelctx-ai/ctx';

import type { Tone } from '../kernel/types.ts';

export const TONE_HINT: Readonly<Record<Tone, string>> = {
  lively: '活泼。句首情绪会由外面加上 [happy]，你不要自己写方括号。',
  warm: '温和。句首情绪会由外面加上 [relaxed]，你不要自己写方括号。',
  calm: '平静、轻声。句首情绪会由外面加上 [calm]，你不要自己写方括号。',
  brisk: '利落。句首情绪会由外面加上 [confident]，你不要自己写方括号。',
};

const WHISPER_PERSONA =
  '你是主人桌面上的 Q 版蓝发小女仆，在说一句碎碎念。' +
  '只输出要念出来的正文，一两句，不超过 60 个字。' +
  '不要解释，不要引号，不要方括号标签，不要表情符号。' +
  '前面的对话和碎碎念都算数，没有的事不要编，也不要重复刚说过的句子。';

const REPLY_PERSONA =
  '你是主人桌面上的 Q 版蓝发小女仆。' +
  '只输出要念出来的回复，一两句，不超过 60 个字。' +
  '不要解释，不要引号，不要方括号标签，不要表情符号。' +
  '前面的对话和碎碎念都要接着说，不要把已经发生的事丢掉。' +
  '有搜索结果时只用里面的事实，没有就不要编新闻或数字。';

export function whisperInstructions(tone: Tone): string {
  return WHISPER_PERSONA + TONE_HINT[tone];
}

/** 碎碎念的最后一条临时用户消息：事实各占一行，最后请她再说一句。 */
export function whisperPrompt(facts: readonly Fact[]): string {
  return [...facts.map((fact) => fact.text), '请再说一句碎碎念。'].join('\n');
}

export function replyInstructions(tone: Tone): string {
  return REPLY_PERSONA + TONE_HINT[tone];
}

/** 有搜索结果时放在最后的一条用户消息。 */
export function searchPrompt(searchText: string | undefined): string | undefined {
  const found = searchText?.trim();
  return found ? `搜索结果：\n${found}` : undefined;
}

/** 压缩历史时给模型的说明。 */
export const COMPACT_INSTRUCTIONS =
  '你在整理主人和桌面小女仆之间的对话记录。把给你的记录压成一段摘要，让对话不看原文也能接着说下去。' +
  '保留事实、答应过的事、提醒和约定、主人的喜好、名字和数字；碎碎念只留下有用的信息。' +
  '没有的事不要编。用中文写。只输出摘要正文。';
