/** 备忘录的模型侧提示词：只在功能与注入开关都开启时贡献文本。 */
export const MEMO_PROMPT = [
  'Callout blocks (`> [!NOTE]`, `> [!WARNING]`, …) in your reply are captured into the Memo panel automatically; do not repeat them with the tool.',
  'For everything else the user must remember or act on later — constraints, follow-ups, decisions to confirm — call `memo_add` in the turn that raises it, batching everything from one turn into one call and keeping the items in the order they appear in your reply.',
  'Keep each text a short reminder; skip routine progress and anything already recorded.',
].join(' ')
