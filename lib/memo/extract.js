/**
 * 轻量提醒提取器：用一次小模型调用，从「本轮用户提示 + 最终回复」里挑出值得记住的提醒。
 *
 * - 输入只有这两段文本，不带历史、不建会话、不写会话日志；
 * - 输出是严格 JSON：`{ items: [{ text, callout?, children? }] }`；
 * - 任何失败（无模型、超时、格式错）都返回空数组，由调用方回退到 callout 规则提取。
 */
const MAX_INPUT = 12000
const MAX_ITEMS = 12
const MAX_TEXT = 400
const CALLOUTS = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']

/** 内置提取指令；设置里的自定义提示词留空时使用它。 */
export const DEFAULT_PROMPT = [
  '你是编码会话的提醒提取器：输入只有「本轮用户提示」与「助手最终回复」，任务是挑出值得记下的提醒。',
  '只输出 JSON，不要任何说明文字：{"items":[{"text":"...","callout":"NOTE|TIP|IMPORTANT|WARNING|CAUTION","children":["..."]}]}',
  'children 的元素可以是字符串，也可以是带 text 与自身 children 的对象；子任务最多嵌套 3 层。',
  '回复里的每个 Callout 块都要单独成一条，callout 填它自己的类型。',
  '回复里「还没做、没验证、需要用户手工补测、下一步、待确认」的清单也要成条：一条列表项一条条目，子级列表放进 children。',
  '用户需要记住的限制、需要用户后续确认或执行的决策、等待用户回答的问题，同样成条。',
  '末尾的「二选一」「告诉我你选哪个」也算一条等待用户回复的条目，哪怕前面是报告。',
  '拿不准值不值得记时一律收录：漏掉一条的代价高于多收一条。',
  '只排除三类内容：过程叙述、对已改代码的复述、与本轮已列条目重复的说法——换措辞、加解释、把整条拆成子项都算重复。',
  '同一件事只输出一条，留信息最全的那条：已经写成父项带子任务的，不要再把它的子项单独输出一遍。',
  '提到具体对象（按钮、页面、文件、接口、路径、开关）时用「」或反引号把对象名括起来，同一件事换个说法时对象名保持一致。',
  '每条 text 直接摘用回复里的原句或短语（可去掉列表符号与行首标记），不要改写措辞；不超过 400 字；顶层最多 12 条；不适用的字段直接省略。',
  '条目顺序必须与回复中首次出现的顺序一致：不要按类型分组、不要按重要性重排、不要把 callout 挪到一端。',
  '没有可记内容时返回 {"items":[]}。',
].join('\n')

function clip(value, limit) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length <= limit) return text
  return text.slice(0, limit - 1).trimEnd() + '…'
}

/** 递归解析一个条目：字符串按叶子，对象可带 callout 与更下一层 children。 */
function parseNode(entry, depth) {
  if (typeof entry === 'string') {
    const value = clip(entry, MAX_TEXT)
    return value === '' ? null : { text: value }
  }
  if (entry === null || typeof entry !== 'object') return null
  const text = clip(entry.text, MAX_TEXT)
  if (text === '') return null
  const node = { text }
  const callout = typeof entry.callout === 'string' ? entry.callout.toUpperCase() : ''
  if (CALLOUTS.includes(callout)) node.callout = callout
  if (depth < 3 && Array.isArray(entry.children)) {
    const children = entry.children.map((child) => parseNode(child, depth + 1)).filter(Boolean).slice(0, 8)
    if (children.length > 0) node.children = children
  }
  return node
}

/**
 * 解析模型输出。
 * @param raw - 模型完整文本。
 * @returns 合法条目数组；无法解析时为空数组。
 */
export function parseExtraction(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  let parsed
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return []
  }
  const list = parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.items) ? parsed.items : []
  const items = []
  for (const entry of list) {
    const node = parseNode(entry, 0)
    if (node === null) continue
    items.push(node)
    if (items.length >= MAX_ITEMS) break
  }
  return items
}

/**
 * 从流式分片里取出文本；忽略推理与工具调用分片。
 *
 * 优先用 `text-delta` 增量；增量全空时回落到 `block-end` 里的完整文本块，
 * 兼容只发完整块、不发增量的适配器。
 */
export async function collectText(stream) {
  let text = ''
  const blocks = []
  for await (const chunk of stream) {
    if (chunk === null || chunk === undefined) continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text
      continue
    }
    if (chunk.type === 'block-end' && chunk.block !== null && chunk.block !== undefined) {
      if (chunk.block.type === 'text' && typeof chunk.block.text === 'string') blocks.push(chunk.block.text)
    }
  }
  if (text.trim() !== '') return text
  return blocks.join('\n')
}

/**
 * 按文中首次出现位置排序；任何一条找不到原文时保持模型给出的顺序。
 * @param items - 解析后的条目。
 * @param reply - 助手回复全文。
 * @returns 排序后的条目（不修改入参）。
 */
export function orderByAppearance(items, reply) {
  if (!Array.isArray(items) || items.length < 2 || typeof reply !== 'string' || reply === '') return items
  const positions = items.map((item) => reply.indexOf(item.text))
  if (positions.some((position) => position < 0)) return items
  return items
    .map((item, index) => ({ item, index, position: positions[index] }))
    .sort((left, right) => left.position - right.position || left.index - right.index)
    .map((entry) => entry.item)
}

/**
 * 执行一次提取调用。
 * @param options - llm 服务、模型选择、本轮提示词与回复文本、取消信号。
 * @returns 条目数组；调用失败或没有模型时为空数组。
 */
export async function extractReminders(options) {
  const { llm, selection, prompt, reply, signal, promptText, onRaw } = options
  if (llm === null || llm === undefined || typeof llm.stream !== 'function') return []
  if (selection === null || selection === undefined) return []
  const provider = typeof selection.provider === 'string' ? selection.provider : ''
  const model = typeof selection.model === 'string' ? selection.model : ''
  if (provider === '' || model === '') return []
  const instruction = typeof promptText === 'string' && promptText.trim() !== '' ? promptText.trim() : DEFAULT_PROMPT
  const input = clip('User prompt:\n' + clip(prompt, 2000) + '\n\nAssistant reply:\n' + clip(reply, MAX_INPUT), MAX_INPUT)
  const stream = llm.stream({
    provider,
    model,
    // 指令走 system 槽，输入只留本轮文本：格式遵循更稳，也避免被当成对话历史。
    system: instruction,
    messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
    maxTokens: 1200,
    signal,
  })
  const text = await collectText(stream)
  if (typeof onRaw === 'function') onRaw(text)
  return orderByAppearance(parseExtraction(text), reply)
}
