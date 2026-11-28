/**
 * 轮次读取：从会话日志还原「第 N 轮 + 该轮用户提示词」。
 *
 * 只读、纯函数式，不订阅任何事件，也不向会话写入；读不到时返回 `turn: 0`，
 * 由写入侧（`addMemoItems`）新开一组并标注「(新一轮)」，绝不抛错影响工具调用或会话加载。
 */
const SCAN_LIMIT = 600
const PROMPT_LIMIT = 200

/** 把若干文本块合并成单行预览。 */
function preview(content) {
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block === null || block === undefined || block.type !== 'text') continue
    if (typeof block.text !== 'string') continue
    text += text === '' ? block.text : ' ' + block.text
    if (text.length > PROMPT_LIMIT * 2) break
  }
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= PROMPT_LIMIT) return normalized
  return normalized.slice(0, PROMPT_LIMIT - 1).trimEnd() + '…'
}

/** 读取最近的会话事件；两种读取面都不可用时返回空数组。 */
function recentEvents(session) {
  try {
    if (typeof session.snapshotEvents === 'function' && typeof session.seq === 'number' && session.seq >= 0) {
      const all = session.snapshotEvents(0, session.seq)
      if (Array.isArray(all)) return all.slice(-SCAN_LIMIT)
    }
  } catch {
    // 继续尝试逐条读取。
  }
  try {
    const end = session.seq
    if (typeof end !== 'number' || end <= 0 || typeof session.eventAt !== 'function') return []
    const probe = (value) => {
      try {
        return session.eventAt(value)
      } catch {
        return undefined
      }
    }
    // 序列号基准随宿主实现而定：末尾能直接读到就按 1 基，否则按 0 基回退。
    const offset = probe(end) !== undefined && probe(end) !== null ? 0 : 1
    const events = []
    for (let index = end; index > end - SCAN_LIMIT && index - offset >= 0; index -= 1) {
      const event = probe(index - offset)
      if (event !== undefined && event !== null) events.push(event)
    }
    return events.reverse()
  } catch {
    return []
  }
}

/**
 * 当前轮次与提示词。
 *
 * 正常运行取最近一个 `turn/start` 的轮次及其后的用户消息。压缩会话后常见两种形态：
 * - 完全没有 `turn/start`：用窗口内最大的有效轮次；`turn/end` 之后还有用户消息时视为它的下一轮；
 * - 残留着上一轮的 `turn/start`，但最新 `turn/end` 之后又来了用户消息：当前轮 = 该 `turn/end` 的轮次 + 1。
 * 两种情况都避免把新条目记到「未识别轮次」或上一轮。
 * @param session - 会话对象（Agent 的 session）。
 * @returns `{ turn, prompt }`；无法识别时为 `{ turn: 0, prompt: '' }`。
 */
export function readTurn(session) {
  const fallback = { turn: 0, prompt: '' }
  if (session === null || session === undefined) return fallback
  const events = recentEvents(session)
  if (events.length === 0) return fallback
  let startIndex = -1
  let startTurn = 0
  let endIndex = -1
  let endTurn = 0
  let userIndex = -1
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event === null || event === undefined) continue
    const value = event.data !== null && event.data !== undefined ? event.data.turn : undefined
    if (event.type === 'turn/start' && typeof value === 'number' && value >= 1) {
      startIndex = index
      startTurn = value
      continue
    }
    if (event.type === 'turn/end' && typeof value === 'number' && value >= 1) {
      endIndex = index
      endTurn = value
      continue
    }
    if (event.type !== 'user/message') continue
    const source = event.data !== null && event.data !== undefined ? event.data.source : undefined
    if (source === null || source === undefined || source.kind !== 'user') continue
    if (preview(event.data.content) !== '') userIndex = index
  }
  // 最新 turn/end 之后又出现用户消息、且其后没有新的 turn/start：当前轮是它的下一轮。
  if (userIndex > endIndex && startIndex < endIndex) {
    return { turn: endTurn + 1, prompt: promptAt(events[userIndex]) }
  }
  if (startIndex >= 0) {
    for (let index = startIndex + 1; index < events.length; index += 1) {
      const prompt = promptAt(events[index])
      if (prompt !== '') return { turn: startTurn, prompt }
    }
    return { turn: startTurn, prompt: lastUserPrompt(events) }
  }
  if (endIndex >= 0) {
    const hasUserAfter = userIndex > endIndex
    return {
      turn: endTurn + (hasUserAfter ? 1 : 0),
      prompt: hasUserAfter ? promptAt(events[userIndex]) : lastUserPrompt(events),
    }
  }
  return fallback
}

/** 取一条用户消息的提示词预览；不是用户消息时返回空串。 */
function promptAt(event) {
  if (event === null || event === undefined || event.type !== 'user/message') return ''
  const source = event.data !== null && event.data !== undefined ? event.data.source : undefined
  if (source === null || source === undefined || source.kind !== 'user') return ''
  return preview(event.data.content)
}

/** 窗口内最后一条用户消息的预览；没有时为空串。 */
function lastUserPrompt(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const prompt = promptAt(events[index])
    if (prompt !== '') return prompt
  }
  return ''
}
