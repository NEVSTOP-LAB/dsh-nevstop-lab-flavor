/**
 * 从助手回复里提取 GitHub 风格的 callout，作为备忘录条目的确定性兜底。
 *
 * 只认 `> [!NOTE]` / `TIP` / `IMPORTANT` / `WARNING` / `CAUTION` 起始的引用块，
 * 取标题行与引用块正文合并成一条，最多三条、每条截断；纯文本处理，不抛错。
 */
const MAX_CALLOUTS = 3
const MAX_TEXT = 200
const HEADER = /^\s{0,3}>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i

/**
 * 提取 callout。
 * @param text - 助手消息全文。
 * @returns `{ kind, text }[]`，无 callout 时为空数组。
 */
export function extractCallouts(text) {
  if (typeof text !== 'string' || text === '') return []
  const lines = text.split(/\r?\n/)
  const found = []
  for (let index = 0; index < lines.length && found.length < MAX_CALLOUTS; index += 1) {
    const header = HEADER.exec(lines[index])
    if (header === null) continue
    const kind = header[1].toUpperCase()
    const body = []
    const head = header[2].trim()
    if (head !== '') body.push(head)
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next]
      if (!/^\s{0,3}>/.test(line)) break
      const content = line.replace(/^\s{0,3}>\s?/, '').trim()
      if (content !== '') body.push(content)
      index = next
    }
    const joined = body.join(' ').replace(/\s+/g, ' ').trim()
    if (joined === '') continue
    found.push({
      kind,
      text: joined.length > MAX_TEXT ? joined.slice(0, MAX_TEXT - 1).trimEnd() + '…' : joined,
    })
  }
  return found
}
