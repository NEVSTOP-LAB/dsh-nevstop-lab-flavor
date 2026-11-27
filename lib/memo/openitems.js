/**
 * 从助手回复里提取「仍未覆盖 / 需要你手动补测 / 下一步」这类清单，作为确定性兜底。
 *
 * 触发条件：某一行是标题、粗体行或以冒号收尾，且含「未覆盖、待验证、需要你、下一步」等词；
 * 之后紧跟的有序/无序列表逐条成为条目，更深缩进的列表成为子任务。
 * 纯文本处理，不抛错；只认明确点名的清单，避免把普通段落拆成条目。
 */
const MAX_ITEMS = 10
const MAX_TEXT = 400
const MAX_LINES = 60
const MAX_DEPTH = 3

const TRIGGER = /(仍未覆盖|未覆盖|尚未覆盖|未验证|未被验证|待验证|待补测|手动补测|需要你|请你在|还需|下一步|剩余|尚未|还没|待办|TODO|后续)/i
const BULLET = /^(\s*)(?:[-*+]|\d{1,2}[.)])\s+(.+)$/
const HEADING = /^\s{0,3}#{1,6}\s+\S/
const CLOSING = /[:：]\s*$/
const BOLD_ONLY = /^\s{0,3}\*\*[^*]+\*\*\s*[:：]?\s*$/

function clip(value) {
  const text = value.trim()
  return text.length <= MAX_TEXT ? text : text.slice(0, MAX_TEXT - 1).trimEnd() + '…'
}

function isTrigger(line) {
  if (!TRIGGER.test(line)) return false
  const trimmed = line.trim()
  if (BULLET.test(line)) return false
  return HEADING.test(line) || CLOSING.test(trimmed) || BOLD_ONLY.test(line)
}

/** 从起始行往下收集一段缩进列表，返回扁平条目与扫描结束位置。 */
function collectList(lines, start) {
  const entries = []
  let index = start
  let blanks = 0
  let baseIndent = -1
  while (index < lines.length && index - start < MAX_LINES) {
    const line = lines[index]
    if (line.trim() === '') {
      blanks += 1
      if (blanks >= 2) break
      index += 1
      continue
    }
    const bullet = BULLET.exec(line)
    if (bullet === null) {
      // 缩进的续行并入上一条；其它内容结束本段清单。
      if (entries.length > 0 && /^\s{2,}/.test(line) && blanks === 0) {
        entries[entries.length - 1].text += ' ' + line.trim()
        index += 1
        continue
      }
      break
    }
    blanks = 0
    const indent = bullet[1].replace(/\t/g, '    ').length
    if (baseIndent < 0) baseIndent = indent
    if (indent < baseIndent) break
    entries.push({ indent, text: bullet[2].trim() })
    index += 1
  }
  return { entries, end: index }
}

/** 按缩进把扁平条目还原成树。 */
function nest(entries) {
  const roots = []
  const stack = []
  for (const entry of entries) {
    const node = { text: entry.text, indent: entry.indent, children: [] }
    while (stack.length > 0 && stack[stack.length - 1].indent >= entry.indent) stack.pop()
    if (stack.length === 0) {
      if (roots.length >= MAX_ITEMS) continue
      roots.push(node)
    } else if (stack.length < MAX_DEPTH) {
      stack[stack.length - 1].children.push(node)
    }
    stack.push(node)
  }
  const strip = (node) => {
    const text = clip(node.text)
    if (text === '') return null
    const children = node.children.map(strip).filter(Boolean)
    return children.length > 0 ? { text, children } : { text }
  }
  return roots.map(strip).filter(Boolean)
}

/**
 * 提取「未覆盖 / 待补测 / 下一步」清单。
 * @param text - 助手消息全文。
 * @returns `{ text, children? }[]`，没有符合的清单时为空数组。
 */
export function extractOpenItems(text) {
  if (typeof text !== 'string' || text === '') return []
  const lines = text.split(/\r?\n/)
  const items = []
  const seen = new Set()
  for (let index = 0; index < lines.length && items.length < MAX_ITEMS; index += 1) {
    if (!isTrigger(lines[index])) continue
    const { entries, end } = collectList(lines, index + 1)
    if (entries.length === 0) continue
    index = end - 1
    for (const node of nest(entries)) {
      if (seen.has(node.text)) continue
      seen.add(node.text)
      items.push(node)
      if (items.length >= MAX_ITEMS) break
    }
  }
  return items
}
