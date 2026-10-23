/**
 * 预制碎碎念。句首标签来自 Fish Audio S2 的方括号情绪。
 * action 是 dsh-pet 动作池里的名字，由导演另外点播，不交给宠物随机抽。
 */
import type { Line, SpokenEntry, Tone } from '../../kernel/types.ts';

export const LINES: readonly Line[] = [
  { text: '主人，我在这儿呢', tone: 'lively', cue: '[happy]', action: '碎碎念-对屏碎碎念', kind: 'whisper' },
  { text: '嘿嘿，看我一眼嘛', tone: 'lively', cue: '[happy]', action: '照镜子', kind: 'whisper' },
  { text: '今天的你也很棒', tone: 'lively', cue: '[delighted]', action: '工作状态-雀跃庆祝', kind: 'whisper' },
  { text: '我在给你加油呢', tone: 'lively', cue: '[excited]', action: '点击回应-元气挥手', kind: 'whisper' },
  { text: '想吃点甜的了', tone: 'lively', cue: '[curious]', action: '吃冰淇淋融化', kind: 'whisper' },
  { text: '我偷偷伸了个懒腰', tone: 'lively', cue: '[happy]', action: '超大伸懒腰', kind: 'whisper' },
  { text: '今天也要乖乖的哦', tone: 'warm', cue: '[relaxed]', action: '女仆屈膝礼仪', kind: 'whisper' },
  { text: '要不要歇一会儿呀', tone: 'warm', cue: '[empathetic]', action: '原地小憩沉眠', kind: 'whisper' },
  { text: '水记得喝一口哦', tone: 'warm', cue: '[relaxed]', action: '碎碎念-对屏碎碎念', kind: 'whisper' },
  { text: '肩膀放松一点嘛', tone: 'warm', cue: '[relaxed]', action: '超大伸懒腰', kind: 'whisper' },
  { text: '你忙你的，我看着', tone: 'warm', cue: '[grateful]', action: '东张西望', kind: 'whisper' },
  { text: '这会儿好安静呀', tone: 'calm', cue: '[calm]', action: '碎碎念-发呆碎碎念', kind: 'whisper' },
  { text: '我刚刚发了会儿呆', tone: 'calm', cue: '[calm]', action: '碎碎念-发呆碎碎念', kind: 'whisper' },
  { text: '别皱眉，我在呢', tone: 'calm', cue: '[soft tone]', action: '待机呼吸休闲', kind: 'whisper' },
  { text: '要是累了就靠会儿', tone: 'calm', cue: '[soft tone]', action: '哈欠连天', kind: 'whisper' },
  { text: '有我在，别着急', tone: 'brisk', cue: '[confident]', action: '碎碎念-对屏碎碎念', kind: 'whisper' },
  { text: '先把这一小步做完', tone: 'brisk', cue: '[confident]', action: '写代码', kind: 'whisper' },
  { text: '我在旁边盯着呢', tone: 'brisk', cue: '[confident]', action: '东张西望', kind: 'whisper' },
  {
    text: '讲个小笑话。我说今天一定早睡，桌面上的灰说它先躺下。结果灰赢了，我还在这儿陪你。',
    tone: 'lively',
    cue: '[happy]',
    action: '碎碎念-对屏碎碎念',
    kind: 'whisper',
  },
  {
    text: '再讲一个。下班前最诚实的话是：这个明天再说。明天的我已经在门口排队，准备抗议。',
    tone: 'warm',
    cue: '[relaxed]',
    action: '碎碎念-对屏碎碎念',
    kind: 'whisper',
  },
  {
    text: '夜里小声讲一个。有人数星星，数着数着打了个哈欠。星星说，你先睡，今晚我们替你值班。',
    tone: 'calm',
    cue: '[soft tone]',
    action: '碎碎念-发呆碎碎念',
    kind: 'whisper',
  },
  {
    text: '工作上也有个笑话。进度条走到百分之九十九，剩下那一截叫再看一眼。我帮你盯着，你先保存。',
    tone: 'brisk',
    cue: '[confident]',
    action: '写代码',
    kind: 'whisper',
  },
];

export const REPEAT_WINDOW_MS = 3 * 60 * 60 * 1000;

/**
 * 3 小时内说过的句子不再抽。当前语气用完了就换别的语气。
 * 全部都在窗口里时返回空，调用方这次不说话。
 * 有长句时大约一半概率抽长句。
 */
export function pickLine(
  lines: readonly Line[],
  tone: Tone,
  recent: readonly SpokenEntry[] = [],
  now = Date.now(),
  rand: () => number = Math.random,
): Line | undefined {
  const blocked = new Set(recent.filter((item) => now - item.at < REPEAT_WINDOW_MS).map((item) => item.text));
  const fresh = lines.filter((line) => line.text.trim() !== '' && !blocked.has(line.text));
  const inTone = fresh.filter((line) => line.tone === tone);
  const base = inTone.length > 0 ? inTone : fresh;
  const longer = base.filter((line) => line.text.length >= 24);
  const list = longer.length > 0 && rand() < 0.5 ? longer : base;
  if (list.length === 0) return undefined;
  const index = Math.min(list.length - 1, Math.floor(rand() * list.length));
  return list[index];
}
