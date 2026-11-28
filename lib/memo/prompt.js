/** 备忘录的模型侧提示词：只在功能与注入开关都开启时贡献文本，分「新增」与「审查」两段。 */
export const MEMO_PROMPT = [
  'Memo panel: record what must not be lost, and keep earlier items current.',
  '',
  'Add (`memo_add`)',
  '- Callout blocks in your reply are captured automatically; do not repeat them with the tool.',
  '- Everything else the user must remember or act on later — constraints, follow-ups, decisions to confirm — goes into one call in the turn that raises it, in the order it appears in your reply.',
  '- A closing list of what is still uncovered, what the user must test by hand, or what comes next belongs in that same call, with subtasks as children instead of separate top-level items.',
  '- Keep the set small: the fewest items that still cover what the user must act on; merge related points into one item instead of listing each one. The closing checklist above is the exception — keep one sub-item per line.',
  '- Check for repeats before writing: the same point worded differently, or already recorded in an earlier turn, counts as recorded — add it once, in its fullest form.',
  '- Skip routine progress, and skip anything already recorded.',
  '',
  'Review (`memo_update`)',
  '- An earlier item — a reminder or a callout card alike — gets ticked off when this turn clearly completes it, replaces it, or proves it obsolete.',
  '- Quote the recorded text so the match lands on the intended item; omit `items` only when unsure what is still open.',
  '- When the evidence is ambiguous, leave it open: a missing tick is cheaper than a wrong one.',
].join('\n')
