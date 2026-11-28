/**
 * 轻量提醒提取器：用一次小模型调用，从「本轮用户提示 + 最终回复 + 当前未完成条目」里挑出值得记住的提醒，
 * 同时回收本轮已经处理掉或过时的旧条目。
 *
 * - 输入只有这几段文本，不带历史、不建会话、不写会话日志；
 * - 输出是严格 JSON：`{ items: [{ text, callout?, children? }], resolved: string[] }`；
 * - 任何失败（无模型、超时、格式错）都返回空结果，由调用方回退到 callout 规则提取。
 */
import { memoTextMatch } from './merge.js'

/** 自动回收的匹配门槛：比跨轮取代松一点，宁可多勾同义改写。 */
const RECLAIM_COVERAGE = 0.8

const MAX_INPUT = 12000
const MAX_TEXT = 400
const MAX_OPEN_TEXT = 200
const MIN_REPLY = 2000
const CALLOUTS = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']

/** 内置提取指令；设置里的自定义提示词留空时使用它，分成「新增」与「审查」两段，判断逻辑用清单表达。 */
export const DEFAULT_PROMPT = [
  '你是编码会话的备忘录提取器。输入是：本会话当前未完成的条目清单、本轮用户提示、助手最终回复。只输出 JSON，不要说明文字。',
  '',
  '## 输出格式',
  '- {"items":[{"text":"...","callout":"NOTE|TIP|IMPORTANT|WARNING|CAUTION","children":["..."]}],"resolved":["已有条目的原文开头"],"duplicates":["重复旧条目的原文开头"]}',
  '- children 的元素可以是字符串，也可以是带 text 与自身 children 的对象，最多嵌套 3 层',
  '- 没有可记内容时返回 {"items":[],"resolved":[],"duplicates":[]}',
  '',
  '## 新增（items）：这轮要新记什么',
  '- 只收本轮真正新增、用户之后必须处理或记住的内容；能并进同一条就并，一轮通常 0–3 条',
  '- 自指的过程说明不要收：你下回合要做什么、你建议怎么改、你给的选项菜单、你在等你上一条的回复——这些都不是用户待办',
  '- 但需要用户拍板或回答的问题要收：这类会影响后续工作，写成「等用户决定 X」，而不是写成你的计划',
  '- 用户要记住的限制、要用户后续确认或执行的决策，各成一条',
  '- 回复里的 Callout 块各成一条，callout 填它自己的类型',
  '- 回复里「还没做 / 没验证 / 需要手工补测 / 下一步 / 待确认」的清单逐条列出，子项放进 children；「宁少勿多」不适用于这类清单',
  '- 末尾的「二选一」「让我选哪个」属于等用户决定的事项，写成「等用户决定 X」而不是列选项',
  '- 每条 text 直接摘用回复里的原句或短语（可去掉列表符号与行首标记），不要改写措辞',
  '- 提到具体对象（按钮、页面、文件、接口、路径、开关）时用「」或反引号括起来，同一件事的说法保持一致',
  '- 条目顺序与回复中首次出现的顺序一致：不按类型分组、不按重要性重排、不把 callout 挪到一端',
  '- 同一件事只输出一条，留信息最全的那条；已写成父项带子任务的，不要再单独输出它的子项',
  '- 排除三类：过程叙述、对已改代码的复述、与本轮已列条目重复的说法（换措辞、加解释、拆成子项都算重复）',
  '',
  '## 审查（resolved）：哪些旧条目该勾掉',
  '- 候选只来自输入的「未完成条目清单」，不要凭空造条目',
  '- 只放本轮回复里明确写了「已完成 / 验证通过 / 已被新结论取代 / 明确不需要再做」的条目',
  '- Callout 卡片同样是候选：被明确解除、已失效、或已被新结论取代时可以放',
  '- 填该条目的原文开头，照抄便于宿主对上',
  '- 宁缺勿滥：回复没有明确表态、只是提到、或你在两可之间，就不要放——漏勾可以接受，错勾不行',
  '',
  '## 去重（duplicates）：清单里哪些旧条目是重复的',
  '- 只看输入的「未完成条目清单」：如果多条在说同一件事（措辞完全不同也算），把其中**较旧的**放进 duplicates，每组只保留最新的一条',
  '- 只放比要保留那条更旧的条目，绝不能反过来把较新的放进 duplicates',
  '- 填那条旧条目的原文开头，照抄便于宿主对上',
  '- 只是相关、相近或互相补充的不算重复；判断不清就不放',
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
 * @returns `{ items, resolved, duplicates }`；无法解析时三项都为空。
 */
export function parseExtractionResult(raw) {
  const empty = { items: [], resolved: [], duplicates: [] }
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
  const duplicates = []
  for (const entry of Array.isArray(source.duplicates) ? source.duplicates : []) {
    const value = clip(entry, MAX_TEXT)
    if (value === '') continue
    duplicates.push(value)
  }
  return { items, resolved, duplicates }
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
 * 把模型给出的「已处理」文本对齐到真实存在的未完成条目：取最佳命中（逐字 > 包含 > 模糊），
 * 不是先到先得，避免精确文本被更早出现的包含项遮蔽。
 * 匹配用严格判定（换措辞不算）；返回命中的条目 id 与原文，落地时按 id 精确勾选。
 * @param resolved - 模型给出的已处理文本。
 * @param open - 提取前读到的未完成条目。
 * @param threshold - 覆盖率门槛：自动回收 0.8，模型判定的重复 0.88。
 * @returns `{ id, text }[]`，按首次命中顺序、按 id 去重。
 */
export function matchResolved(resolved, open, threshold = RECLAIM_COVERAGE) {
  const list = Array.isArray(open) ? open : []
  const found = []
  for (const text of Array.isArray(resolved) ? resolved : []) {
    let best = null
    for (const item of list) {
      const match = memoTextMatch(item.text, text, threshold)
      if (match === null) continue
      if (best === null || match.rank > best.match.rank || (match.rank === best.match.rank && match.quality > best.match.quality)) {
        best = { item, match }
      }
    }
    if (best === null) continue
    if (found.some((entry) => entry.id === best.item.id)) continue
    found.push({ id: best.item.id, text: best.item.text })
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
 * @returns `{ items, resolved, duplicates, failure }`；调用失败或没有模型时三项都为空。
 */
export async function extractReminders(options) {
  const { llm, selection, prompt, reply, open, sessionId, signal, promptText, onRaw } = options
  const empty = { items: [], resolved: [], duplicates: [], failure: '' }
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
  return { items: orderByAppearance(parsed.items, reply), resolved: parsed.resolved, duplicates: parsed.duplicates, failure: collected.failure }
}





