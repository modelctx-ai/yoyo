const QUESTION = /[?？]|什么|谁|哪|怎么|如何|为什么|多少|天气|新闻|最新|搜索|查一下|帮我看/;

/** 像在提问或要事实时才去搜，普通应答不搜。 */
export function shouldSearch(text: string): boolean {
  return QUESTION.test((text ?? '').trim());
}
