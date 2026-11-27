/** 备忘录的模型侧提示词：只在功能与注入开关都开启时贡献文本。 */
export const MEMO_PROMPT = [
  'Callout-worthy notices, constraints the user must remember, and follow-ups the user has to act on later belong in the Memo panel, not only in prose.',
  'Record them with `memo_add` in the turn that raises them, batching everything from one turn into one call.',
  'Use one item per distinct reminder and keep titles short; skip routine progress and anything already recorded.',
].join(' ')
