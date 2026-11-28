/**
 * 轻量提醒提取器：用一次小模型调用，从「本轮用户提示 + 最终回复 + 当前未完成条目」里挑出值得记住的提醒，
 * 同时回收本轮已经处理掉或过时的旧条目。
 *
 * - 输入只有这几段文本，不带历史、不建会话、不写会话日志；
 * - 输出是严格 JSON：`{ items: [{ text, callout?, children? }], resolved: string[] }`；
 * - 任何失败（无模型、超时、格式错）都返回空结果，由调用方回退到 callout 规则提取。
 */
import { similarMemoItemStrict } from './merge.js'

const MAX_INPUT = 12000
const MAX_TEXT = 400
const MAX_OPEN_TEXT = 200
const MIN_REPLY = 2000
const CALLOUTS = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']

/** 内置提取指令；设置里的自定义提示词留空时使用它。 */
export const DEFAULT_PROMPT = [
  '你是编码会话的提醒提取器：输入是「本会话当前未完成的条目」「本轮用户提示」与「助手最终回复」，任务是挑出值得记下的提醒，并回收已经处理掉或过时的旧条目。',
  '只输出 JSON，不要任何说明文字：{"items":[{"text":"...","callout":"NOTE|TIP|IMPORTANT|WARNING|CAUTION","children":["..."]}],"resolved":["已有条目的原文"]}',
  'children 的元素可以是字符串，也可以是带 text 与自身 children 的对象；子任务最多嵌套 3 层。',
  '条目宁少勿多：只收本轮真正新增、用户之后必须处理或记住的内容；能并进同一条就并，一轮通常 0–3 条，没有可记的就返回空。',
  '「宁少勿多」只针对清单之外的提醒；回复末尾「还没做 / 下一步」这类清单仍逐条列出，子项放进 children。',
  '回复里的 Callout 块各成一条，callout 填它自己的类型。',
  '回复里「还没做、没验证、需要用户手工补测、下一步、待确认」的清单也要成条：一条列表项一条条目，子级列表放进 children。',
  '用户需要记住的限制、需要用户后续确认或执行的决策、等待用户回答的问题，同样成条。',
  '末尾的「二选一」「告诉我你选哪个」也算一条等待用户回复的条目，哪怕前面是报告。',
  'resolved 只放「本轮回复里明确写了已经完成、验证通过、已被新结论取代、或明确不需要再做」的已有未完成条目；填条目原文的开头，照抄便于对上。宁缺勿滥：回复没有明确表态、只是提到、或你在两可之间，就不要放——漏勾可以接受，错勾不行。',
  'callout 卡片（「注意 / 警告 / 重要」这类）同样是条目：被明确解除、已失效、或已被新结论取代时可以放进 resolved；判断不清就不放。',
  '只排除三类内容：过程叙述、对已改代码的复述、与本轮已列条目重复的说法——换措辞、加解释、把整条拆成子项都算重复。',
  '同一件事只输出一条，留信息最全的那条：已经写成父项带子任务的，不要再把它的子项单独输出一遍。',
  '提到具体对象（按钮、页面、文件、接口、路径、开关）时用「」或反引号把对象名括起来，同一件事换个说法时对象名保持一致。',
  '每条 text 直接摘用回复里的原句或短语（可去掉列表符号与行首标记），不要改写措辞；不适用的字段直接省略。',
  '条目顺序必须与回复中首次出现的顺序一致：不要按类型分组、不要按重要性重排、不要把 callout 挪到一端。',
  '没有可记内容时返回 {"items":[],"resolved":[]}。',
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
 * 拼装一次提取的输入：本会话未完成条目 + 本轮提示 + 最终回复。
 * 未完成清单完整给出，不按条数截断；回复超出预算时保留「开头 + 结尾」，
 * 因为结尾往往是「还没做 / 下一步」清单，也是回收旧条目的主要依据。
 * @param prompt - 本轮用户提示。
 * @param reply - 助手最终回复。
 * @param open - 本会话当前未完成的条目（`{ turn, text }`）。
 */
export function extractionInput(prompt, reply, open) {
  const list = Array.isArray(open) ? open : []
  const lines = list.map((item) => {
    const turn = Number.isFinite(Number(item.turn)) ? Number(item.turn) : 0
    return '- [' + turn + '] ' + clip(String(item.text ?? ''), MAX_OPEN_TEXT)
  })
  const promptBlock = 'User prompt:\n' + clip(prompt, 2000) + '\n\nAssistant reply:\n'
  const openBudget = Math.max(0, MAX_INPUT - promptBlock.length - MIN_REPLY)
  const openBlock = lines.length === 0 ? '' : clipBlock('Open memo items in this session:\n' + lines.join('\n') + '\n\n', openBudget)
  const budget = Math.max(MIN_REPLY, MAX_INPUT - openBlock.length - promptBlock.length)
  return clipReply(openBlock + promptBlock, reply, budget)
}

/** 清单超长时保留首尾条目、中间省略：不按条数截断，只保证整体长度可传。 */
function clipBlock(text, limit) {
  if (limit <= 0) return ''
  if (text.length <= limit) return text
  const head = Math.max(0, Math.floor(limit * 0.5) - 1)
  const tail = Math.max(0, limit - head - 3)
  return text.slice(0, head) + '\n…\n' + text.slice(text.length - tail)
}

/** 回复超出预算时保留开头与结尾，中间用省略号连接。 */
function clipReply(prefix, reply, budget) {
  const value = typeof reply === 'string' ? reply : ''
  if (value.length <= budget) return prefix + value
  const head = Math.max(0, Math.floor(budget * 0.6) - 1)
  const tail = Math.max(0, budget - head - 1)
  return prefix + value.slice(0, head).trimEnd() + '…' + value.slice(value.length - tail).trimStart()
}

/**
 * 解析模型输出：条目与「已处理掉的旧条目」两张表。
 * @param raw - 模型完整文本。
 * @returns `{ items, resolved }`；无法解析时两项都为空。
 */
export function parseExtractionResult(raw) {
  const empty = { items: [], resolved: [] }
  if (typeof raw !== 'string' || raw.trim() === '') return empty
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return empty
  let parsed
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return empty
  }
  const source = parsed !== null && typeof parsed === 'object' ? parsed : {}
  const items = []
  for (const entry of Array.isArray(source.items) ? source.items : []) {
    const node = parseNode(entry, 0)
    if (node === null) continue
    items.push(node)
  }
  const resolved = []
  for (const entry of Array.isArray(source.resolved) ? source.resolved : []) {
    const value = clip(entry, MAX_TEXT)
    if (value === '') continue
    resolved.push(value)
  }
  return { items, resolved }
}

/**
 * 解析模型输出里的提醒条目。
 * @param raw - 模型完整文本。
 * @returns 合法条目数组；无法解析时为空数组。
 */
export function parseExtraction(raw) {
  return parseExtractionResult(raw).items
}

/**
 * 把模型给出的「已处理」文本对齐到真实存在的未完成条目。
 * 匹配用严格判定（换措辞不算）；返回命中的条目 id 与原文，落地时按 id 精确勾选，不再按文本二次匹配。
 * @param resolved - 模型给出的已处理文本。
 * @param open - 提取前读到的未完成条目。
 * @returns `{ id, text }[]`，按首次命中顺序、按 id 去重。
 */
export function matchResolved(resolved, open) {
  const list = Array.isArray(open) ? open : []
  const found = []
  for (const text of Array.isArray(resolved) ? resolved : []) {
    const hit = list.find((item) => similarMemoItemStrict(item.text, text))
    if (hit === undefined) continue
    if (found.some((entry) => entry.id === hit.id)) continue
    found.push({ id: hit.id, text: hit.text })
  }
  return found
}

/**
 * 从流式分片里取出文本，并带出终止分片里的失败原因。
 *
 * 优先用 `text-delta` 增量；增量全空时回落到 `block-end` 里的完整文本块，
 * 兼容只发完整块、不发增量的适配器。终止分片是 `{ type: 'finish', reason }`：
 * `reason.kind` 为 `stop` / `max-tokens` / `error` / `aborted`，失败原因在 `reason.failure`，
 * 它不会抛异常，只能从分片里读出来，否则调用方只会看到空文本。
 * @param stream - `llm.stream()` 返回的异步可迭代流。
 * @returns `{ text, failure }`；`failure` 为空串表示正常结束。
 */
export async function collectText(stream) {
  let text = ''
  const blocks = []
  let failure = ''
  for await (const chunk of stream) {
    if (chunk === null || chunk === undefined) continue
    // 终止分片是 { type: 'finish', reason }：reason.kind 为 stop / max-tokens / error / aborted。
    if (chunk.type === 'finish') {
      const reason = chunk.reason !== null && chunk.reason !== undefined && typeof chunk.reason === 'object' ? chunk.reason : {}
      if (reason.kind === 'error' || reason.kind === 'aborted') {
        const detail = reason.failure !== null && reason.failure !== undefined && typeof reason.failure === 'object' ? reason.failure : {}
        const code = typeof detail.code === 'string' ? detail.code : ''
        const message = typeof detail.message === 'string' ? detail.message : ''
        failure = [reason.kind, code, message].filter((part) => part !== '').join(' ')
      } else if (reason.kind === 'max-tokens') {
        failure = 'max-tokens'
      }
      continue
    }
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text
      continue
    }
    if (chunk.type === 'block-end' && chunk.block !== null && chunk.block !== undefined) {
      if (chunk.block.type === 'text' && typeof chunk.block.text === 'string') blocks.push(chunk.block.text)
    }
  }
  return { text: text.trim() !== '' ? text : blocks.join('\n'), failure }
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
 * @param options - llm 服务、模型选择、本轮提示词与回复文本、当前未完成条目、取消信号。
 * @returns `{ items, resolved }`；调用失败或没有模型时两项都为空。
 */
export async function extractReminders(options) {
  const { llm, selection, prompt, reply, open, sessionId, signal, promptText, onRaw } = options
  const empty = { items: [], resolved: [], failure: '' }
  if (llm === null || llm === undefined || typeof llm.stream !== 'function') return { ...empty, failure: 'llm service unavailable' }
  if (selection === null || selection === undefined) return { ...empty, failure: 'no model selection' }
  const provider = typeof selection.provider === 'string' ? selection.provider : ''
  const model = typeof selection.model === 'string' ? selection.model : ''
  if (provider === '' || model === '') return { ...empty, failure: 'no provider or model' }
  const instruction = typeof promptText === 'string' && promptText.trim() !== '' ? promptText.trim() : DEFAULT_PROMPT
  const input = extractionInput(prompt, reply, open)
  const stream = llm.stream({
    provider,
    model,
    // 指令走 one-shot 的 system 槽，输入只留本轮文本与未完成清单：格式遵循更稳，也避免被当成对话历史。
    system: instruction,
    messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
    // 部分供应商（如 opencode-go）要求带会话标识做路由，缺了会被 400 拒绝。
    ...(typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {}),
    maxTokens: 3000,
    signal,
  })
  const collected = await collectText(stream)
  if (typeof onRaw === 'function') onRaw(collected.text)
  if (collected.text.trim() === '') return { ...empty, failure: collected.failure !== '' ? collected.failure : 'empty reply' }
  const parsed = parseExtractionResult(collected.text)
  return { items: orderByAppearance(parsed.items, reply), resolved: parsed.resolved, failure: collected.failure }
}
