import { TONE_CUES } from './catalog.js';

const TONE_ACTION = {
  lively: '碎碎念-对屏碎碎念',
  warm: '碎碎念-对屏碎碎念',
  calm: '碎碎念-发呆碎碎念',
  brisk: '写代码',
};

const TONE_HINT = {
  lively: '活泼。句首情绪会由外面加上 [happy]，你不要自己写方括号。',
  warm: '温和。句首情绪会由外面加上 [relaxed]，你不要自己写方括号。',
  calm: '平静、轻声。句首情绪会由外面加上 [calm]，你不要自己写方括号。',
  brisk: '利落。句首情绪会由外面加上 [confident]，你不要自己写方括号。',
};

/** 去掉模型可能带上的引号和句首标签，留下能直接念的一句。 */
export function parseWhisper(raw, tone) {
  let text = String(raw ?? '')
    .replace(/```[\s\S]*?```/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)[0] ?? '';
  text = text.replace(/^[「『"']+/, '').replace(/[」』"']+$/, '').trim();
  text = text.replace(/^\[[^\]\n]+\]\s*/, '').trim();
  if (text.length < 4 || text.length > 80) return null;
  const cue = TONE_CUES[tone];
  const action = TONE_ACTION[tone];
  if (!cue || !action) return null;
  return { text, tone, cue, action, kind: 'generated' };
}

export function whisperMessages({ tone, messages, task }) {
  const job = task?.trim() ? `当前任务：${task.trim()}\n` : '';
  return [
    {
      role: 'system',
      content:
        '你是主人桌面上的 Q 版蓝发小女仆，在说一句碎碎念。' +
        '只输出要念出来的正文，一两句，不超过 60 个字。' +
        '不要解释，不要引号，不要方括号标签，不要表情符号。' +
        '前面的对话和碎碎念都算数，没有的事不要编，也不要重复刚说过的句子。' +
        TONE_HINT[tone],
    },
    ...(messages ?? []),
    { role: 'user', content: `${job}请再说一句碎碎念。` },
  ];
}

export async function generateWhisper(llm, input, fetcher = fetch) {
  const response = await fetcher(`${llm.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${llm.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: llm.model,
      temperature: 0.8,
      messages: whisperMessages(input),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).replaceAll(llm.apiKey, '').slice(0, 180);
    throw new Error(`模型接口返回 ${response.status}${detail ? `：${detail}` : ''}`);
  }
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  const line = parseWhisper(content, input.tone);
  if (!line) throw new Error('模型没有返回可用的碎碎念');
  const said = (input.messages ?? []).map((message) => message.content).join('\n');
  if (said.includes(line.text)) throw new Error('模型重复了最近说过的句子');
  return line;
}

export function replyMessages({ tone, messages, searchText }) {
  const found = searchText?.trim();
  return [
    {
      role: 'system',
      content:
        '你是主人桌面上的 Q 版蓝发小女仆。' +
        '只输出要念出来的回复，一两句，不超过 60 个字。' +
        '不要解释，不要引号，不要方括号标签，不要表情符号。' +
        '前面的对话和碎碎念都要接着说，不要把已经发生的事丢掉。' +
        '有搜索结果时只用里面的事实，没有就不要编新闻或数字。' +
        TONE_HINT[tone],
    },
    ...(messages ?? []),
    ...(found ? [{ role: 'user', content: `搜索结果：\n${found}` }] : []),
  ];
}

export async function generateReply(llm, input, fetcher = fetch) {
  const response = await fetcher(`${llm.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${llm.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: llm.model,
      temperature: 0.7,
      messages: replyMessages(input),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).replaceAll(llm.apiKey, '').slice(0, 180);
    throw new Error(`模型接口返回 ${response.status}${detail ? `：${detail}` : ''}`);
  }
  const data = await response.json();
  const line = parseWhisper(data?.choices?.[0]?.message?.content, input.tone);
  if (!line) throw new Error('模型没有返回可用的回复');
  return { ...line, reply: true };
}
