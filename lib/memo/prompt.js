/** 备忘录的模型侧提示词：只在功能与注入开关都开启时贡献文本。 */
export const MEMO_PROMPT = [
  'Callout blocks (`> [!NOTE]`, `> [!WARNING]`, …) in your reply are captured into the Memo panel automatically; do not repeat them with the tool.',
  'For everything else the user must remember or act on later — constraints, follow-ups, decisions to confirm — call `memo_add` in the turn that raises it, batching everything from one turn into one call and keeping the items in the order they appear in your reply.',
  'A closing list of what is still uncovered, what the user must test by hand, or what comes next belongs in that same call too, with subtasks as children instead of separate top-level items.',
  'Keep the set small: one call per turn, the fewest items that still cover what the user must act on; merge related points into one item instead of listing each one.',
  'Check for repeats before writing: the same point worded differently, or already recorded in an earlier turn, counts as recorded — add it once, in its fullest form, instead of writing it again.',
  'When this turn resolves something an earlier turn left open, tick it off with `memo_update` and the recorded item text; omit its `items` only when unsure what is still open.',
  'Keep each text a short reminder; skip routine progress and anything already recorded.',
].join(' ')
