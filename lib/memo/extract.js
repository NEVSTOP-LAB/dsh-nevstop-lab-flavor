/**
 * 轻量提醒提取器：用一次小模型调用，从「本轮用户提示 + 最终回复」里挑出值得记住的提醒。
 *
 * - 输入只有这两段文本，不带历史、不建会话、不写会话日志；
 * - 输出是严格 JSON：`{ items: [{ text, callout?, children? }] }`；
 * - 任何失败（无模型、超时、格式错）都返回空数组，由调用方回退到 callout 规则提取。
 */
const MAX_INPUT = 12000
const MAX_ITEMS = 6
const MAX_TEXT = 400
const CALLOUTS = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']

const SYSTEM = [
  'You extract durable reminders from one assistant reply of a coding session.',
  'Return JSON only, no prose: {"items":[{"text":"...","callout":"NOTE|TIP|IMPORTANT|WARNING|CAUTION","children":["..."]}]}',
  'Include: callout blocks, constraints the user must remember, follow-ups or decisions the user must act on later, and open questions awaiting the user.',
  'Exclude: progress narration, restatements of code changes, completed work, and duplicates of the same point.',
  'Keep each text a short imperative or noun phrase in the reply\'s language; at most 6 items; omit "callout" and "children" when they do not apply.',
  'If nothing qualifies, return {"items":[]}.',
].join('\n')

function clip(value, limit) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length <= limit) return text
  return text.slice(0, limit - 1).trimEnd() + '…'
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
    if (entry === null || typeof entry !== 'object') continue
    const text = clip(entry.text, MAX_TEXT)
    if (text === '') continue
    const item = { text }
    const callout = typeof entry.callout === 'string' ? entry.callout.toUpperCase() : ''
    if (CALLOUTS.includes(callout)) item.callout = callout
    if (Array.isArray(entry.children)) {
      const children = entry.children
        .map((child) => (typeof child === 'string' ? clip(child, MAX_TEXT) : ''))
        .filter((child) => child !== '')
        .slice(0, 8)
      if (children.length > 0) item.children = children
    }
    items.push(item)
    if (items.length >= MAX_ITEMS) break
  }
  return items
}

/** 从流式分片里取出文本；忽略推理与工具调用分片。 */
export async function collectText(stream) {
  let text = ''
  for await (const chunk of stream) {
    if (chunk === null || chunk === undefined) continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
  }
  return text
}

/**
 * 执行一次提取调用。
 * @param options - llm 服务、模型选择、本轮提示词与回复文本、取消信号。
 * @returns 条目数组；调用失败或没有模型时为空数组。
 */
export async function extractReminders(options) {
  const { llm, selection, prompt, reply, signal } = options
  if (llm === null || llm === undefined || typeof llm.stream !== 'function') return []
  if (selection === null || selection === undefined) return []
  const provider = typeof selection.provider === 'string' ? selection.provider : ''
  const model = typeof selection.model === 'string' ? selection.model : ''
  if (provider === '' || model === '') return []
  const input = clip('User prompt:\n' + clip(prompt, 2000) + '\n\nAssistant reply:\n' + clip(reply, MAX_INPUT), MAX_INPUT)
  const stream = llm.stream({
    provider,
    model,
    // 只用一条 user 输入：宿主文档只保证用户角色请求输入，避免系统角色兼容问题。
    messages: [{ role: 'user', content: [{ type: 'text', text: SYSTEM + '\n\n' + input }] }],
    signal,
  })
  const text = await collectText(stream)
  return parseExtraction(text)
}
