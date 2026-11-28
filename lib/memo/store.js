/**
 * 备忘录存储：按会话分文件的插件私有 JSON，条目是任意层级的树。
 *
 * - 位置 `$DSH_HOME/plugin-data/dsh-nevstop-lab-flavor/memo/<sessionId>.json`；
 * - 与会话日志完全分离：文件损坏、缺失或删除只影响面板读取，不影响会话加载；
 * - 校验是「逐字段回落」的：坏节点丢弃、好节点照常，深度与每层数量都有上限；
 * - 有子节点的节点，`done` 恒等于子节点全部完成；父节点勾选时整组切换（全完成→全部取消，否则全部标记完成）；
 * - 写入走同目录临时文件 + rename，避免半截文件。
 */
import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { normalizeMemoText, reconcileMemoNodes, richerMemoItem, similarMemoItem, supersedesMemoText } from './merge.js'

export const MEMO_VERSION = 1

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/
const MAX_GROUPS = 400
const MAX_ITEMS_PER_GROUP = 200
const MAX_DEPTH = 5
const MAX_TITLE = 400
const MAX_PROMPT = 200
const MAX_TEXT = 800
const CALLOUTS = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']

export function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID.test(value)
}

export function memoRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'plugin-data', 'dsh-nevstop-lab-flavor', 'memo')
}

function memoFile(sessionId) {
  if (!isSessionId(sessionId)) throw new Error('invalid session id')
  return join(memoRoot(), sessionId + '.json')
}

function calloutOf(value) {
  if (typeof value !== 'string') return undefined
  const upper = value.toUpperCase()
  return CALLOUTS.includes(upper) ? upper : undefined
}

function text(value, limit) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed.length <= limit) return trimmed
  return trimmed.slice(0, limit - 1).trimEnd() + '…'
}

function positiveInt(value) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0
}

function newId(prefix) {
  return prefix + '_' + randomUUID().replace(/-/g, '').slice(0, 12)
}

/** 递归归一化一个节点；字符串按叶子节点处理。 */
function normalizeNode(raw, depth) {
  if (typeof raw === 'string') {
    const value = text(raw, MAX_TITLE)
    return value === '' ? null : { id: newId('m'), text: value, done: false, source: 'agent', children: [] }
  }
  if (raw === null || typeof raw !== 'object') return null
  const value = text(raw.text, MAX_TITLE)
  if (value === '') return null
  const children = []
  if (depth < MAX_DEPTH && Array.isArray(raw.children)) {
    for (const child of raw.children) {
      const node = normalizeNode(child, depth + 1)
      if (node !== null) children.push(node)
    }
  }
  const node = {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : newId('m'),
    text: value,
    done: raw.done === true,
    source: raw.source === 'user' ? 'user' : 'agent',
    children,
  }
  const callout = calloutOf(raw.callout)
  if (callout !== undefined) node.callout = callout
  // 子代理父节点的结构性标记要持久保存：主会话的去重与回收靠它跳过整棵子树。
  if (raw.subagent === true) node.subagent = true
  // 兼容 0.17.15 及更早写入的子代理父节点：当时没有标记，按标题与子节点推断回来。
  else if (raw.subagent === undefined && children.length > 0 && LEGACY_SUBAGENT_LABEL.test(value)) node.subagent = true
  if (children.length > 0) node.done = children.every((child) => child.done === true)
  return node
}

function normalizeGroup(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const items = Array.isArray(raw.items) ? raw.items.map((item) => normalizeNode(item, 0)).filter(Boolean).slice(0, MAX_ITEMS_PER_GROUP) : []
  if (items.length === 0) return null
  const group = {
    turn: positiveInt(raw.turn),
    prompt: text(raw.prompt, MAX_PROMPT),
    items,
  }
  // 合成组标记要持久保存：面板靠它显示「(新一轮)」，写入侧靠它避开真实轮次编号。
  if (raw.newTurn === true) group.newTurn = true
  // 兼容旧版：标记曾经写进提示词，读到时按合成组处理，避免它继续冒充真实轮次。
  else if (group.prompt === NEW_TURN_LABEL) {
    group.newTurn = true
    group.prompt = ''
  }
  return group
}

export function normalizeMemo(raw, sessionId) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const groups = Array.isArray(source.groups) ? source.groups.map(normalizeGroup).filter(Boolean).slice(-MAX_GROUPS) : []
  return { version: MEMO_VERSION, sessionId, groups }
}

export function emptyMemo(sessionId) {
  return { version: MEMO_VERSION, sessionId, groups: [] }
}

/** 统计口径：只数叶子节点；总数含已完成。 */
export function countMemo(doc) {
  const totals = { total: 0, unfinished: 0 }
  const visit = (node) => {
    if (node.children.length === 0) {
      totals.total += 1
      if (node.done !== true) totals.unfinished += 1
      return
    }
    for (const child of node.children) visit(child)
  }
  for (const group of doc.groups) for (const item of group.items) visit(item)
  return { total: totals.total, unfinished: totals.unfinished, done: totals.total > 0 && totals.unfinished === 0 }
}

export async function readMemo(sessionId) {
  if (!isSessionId(sessionId)) return emptyMemo('')
  try {
    const raw = await readFile(memoFile(sessionId), 'utf8')
    return normalizeMemo(JSON.parse(raw), sessionId)
  } catch {
    // 文件缺失、不可读或不是合法 JSON：当作空文档，面板照常出现。
    return emptyMemo(sessionId)
  }
}

export async function writeMemo(sessionId, doc) {
  if (!isSessionId(sessionId)) throw new Error('invalid session id')
  const normalized = normalizeMemo(doc, sessionId)
  const file = memoFile(sessionId)
  await mkdir(dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  await writeFile(tmp, JSON.stringify(normalized, null, 2) + '\n', 'utf8')
  await rename(tmp, file)
  return normalized
}

/** 把被吸收条目的 id 转到吸收它的叶子身上：白名单按 id 勾选时不会因为「条目换了形态」而漏勾。 */
function transferAbsorbedIds(before, after) {
  const present = new Set(after.map((node) => node.id))
  const gone = before.filter((node) => !present.has(node.id))
  if (gone.length === 0) return after
  const leaves = []
  const collect = (node) => {
    for (const child of node.children) collect(child)
    if (node.children.length === 0) leaves.push(node)
  }
  for (const node of after) collect(node)
  const assigned = new Set()
  for (const node of gone) {
    if (assigned.has(node.id)) continue
    const target = leaves.find((leaf) => !assigned.has(leaf.id) && similarMemoItem(leaf.text, node.text))
    if (target === undefined) continue
    assigned.add(node.id)
    target.id = node.id
  }
  return after
}

/**
 * 同一条目的新写法替换旧条目时，保留用户侧的状态：id、来源、勾选结果与 callout 类型。
 * 带子任务的写法按子任务重算自身完成状态，子任务文本与旧条目叶子同名的照样保留勾选。
 */
function keepNodeState(candidate, existing) {
  const node = { ...candidate, id: existing.id, source: existing.source }
  if (node.callout === undefined && existing.callout !== undefined) node.callout = existing.callout
  if (node.children.length === 0) {
    node.done = existing.done
    return node
  }
  return markDone(node, doneTextsOf(existing))
}

/** 收集已勾选的叶子文本；只记完成态，用来把勾选结果搬到重写后的条目上。 */
function doneTextsOf(node, texts = []) {
  if (node === null || node === undefined || typeof node === 'string') return texts
  if (node.children.length === 0) {
    if (node.done === true) texts.push(node.text)
    return texts
  }
  for (const child of node.children) doneTextsOf(child, texts)
  return texts
}

/** 按文本恢复勾选：命中的叶子标为完成（相似写法也算命中），父项状态继续由子树推导。 */
function markDone(node, doneTexts) {
  const children = node.children.map((child) => markDone(child, doneTexts))
  const next = { ...node, children }
  if (children.length > 0) next.done = children.every((child) => child.done === true)
  else if (doneTexts.some((text) => similarMemoItem(text, node.text))) next.done = true
  return next
}

/**
 * 轮次缺失时新开一组：压缩后合成事件可能带 0 或负数轮次，
 * 这时按「现有最大轮次 + 1」新建一组并打上 `newTurn` 标记（面板显示「(新一轮)」），
 * 既不丢条目也不并进旧组。提示词是什么都照常保留，标记与提示词互不影响。
 */
const NEW_TURN_LABEL = '(新一轮)'
/** 旧版子代理父节点的标题形态：`子代理(<名字>)`；裸标题「子代理」不参与推断，避免误吞用户自建的同名节点。 */
const LEGACY_SUBAGENT_LABEL = /^子代理\s*[\(（]/

function freeTurnNumber(doc) {
  const taken = new Set(doc.groups.map((group) => group.turn))
  let turn = doc.groups.reduce((latest, group) => Math.max(latest, group.turn), 0) + 1
  while (taken.has(turn)) turn += 1
  return turn
}

/**
 * 真实轮次到来时给同号合成组让位：合成组的编号只是排序用的占位，顺延到最高编号之后，
 * 否则真实条目会并进合成组，组头仍挂着「(新一轮)」，真假轮次混在一起。
 */
function releaseTurnNumber(doc, turnNumber) {
  const holder = doc.groups.find((group) => group.turn === turnNumber && group.newTurn === true)
  if (holder === undefined) return
  holder.turn = freeTurnNumber(doc)
  doc.groups.sort((left, right) => left.turn - right.turn)
}

/**
 * 自动收录的防重复签名：同一次回复被真实回合与合成事件各触发一次时只提取一次。
 * @param turn - 落点轮次。
 * @param reply - 回复全文。
 * @param scope - 可选归属标记（子代理名字等），同一轮里不同子代理的相同回复不应互相顶掉。
 */
export function captureSignature(turn, reply, scope) {
  const value = typeof reply === 'string' ? reply : ''
  const number = Number.isFinite(Number(turn)) ? Number(turn) : 0
  const extra = typeof scope === 'string' && scope !== '' ? '|' + scope : ''
  return number + '|' + value.length + '|' + value.slice(0, 48) + extra
}

/**
 * 子代理收录节点的标题：`子代理(<名字>)`；拿不到名字时退回「子代理」。
 * 嵌套子代理的 `self` 是斜杠路径（如 `reviewer/checker`），标题只取最后一段。
 * @param name - 子代理名称（`subagents.namesOf().self`）。
 */
export function subagentMemoLabel(name) {
  const full = text(name, 120)
  const leaf = full.split('/').filter((part) => part !== '').pop() || ''
  const value = text(leaf, 60)
  return value === '' ? '子代理' : '子代理(' + value + ')'
}

/** 整棵树的节点 id：统计写入结果时子代理节点下的条目也要算进去。 */
function nodeIdsOf(nodes, ids = new Set()) {
  for (const node of nodes) {
    ids.add(node.id)
    nodeIdsOf(node.children, ids)
  }
  return ids
}

/**
 * 追加一条或多条待办到指定轮次的分组，条目可以是树。
 * 同轮内按内容去重：换措辞、拆成子项的重复不再写入；带子任务的写法替换平铺写法并保留勾选状态。
 * 给 `parentText` 时把条目挂到该标题的节点下（子代理收录用），同名节点复用并继续追加。
 */
export async function addMemoItems(sessionId, { turn, prompt, items, parentText }) {
  const doc = await readMemo(sessionId)
  const requestedTurn = positiveInt(turn)
  const synthetic = requestedTurn < 1
  if (!synthetic) releaseTurnNumber(doc, requestedTurn)
  const turnNumber = synthetic ? freeTurnNumber(doc) : requestedTurn
  const promptText = text(prompt, MAX_PROMPT)
  let group = synthetic ? undefined : doc.groups.find((entry) => entry.turn === turnNumber)
  if (group === undefined) {
    group = { turn: turnNumber, prompt: promptText, items: [] }
    if (synthetic) group.newTurn = true
    doc.groups.push(group)
    doc.groups.sort((left, right) => left.turn - right.turn)
  } else if (group.prompt === '' && promptText !== '') {
    group.prompt = promptText
  }
  // 子代理收录：同一轮里同名子代理只留一个父节点，后续条目继续往它的子节点里加。
  const parentLabel = text(parentText, MAX_TITLE)
  let parent = null
  if (parentLabel !== '') {
    parent = group.items.find((node) => node.text === parentLabel && node.children.length > 0) || null
    if (parent === null) {
      parent = { id: newId('m'), text: parentLabel, done: false, source: 'agent', children: [], subagent: true }
      group.items.push(parent)
    }
  }
  const container = parent !== null ? parent.children : group.items
  const incoming = []
  const replaced = []
  for (const raw of Array.isArray(items) ? items : []) {
    const item = normalizeNode(raw, 0)
    if (item === null) continue
    incoming.push(item)
    // 每次都跟当前清单比：上一条替换掉旧写法后，后面的条目要跟新写法比才判得准。
    const at = container.findIndex((existing) => similarMemoItem(existing.text, item.text))
    if (at < 0) {
      container.push(item)
      continue
    }
    if (richerMemoItem(item, container[at])) {
      const kept = container[at]
      container[at] = keepNodeState(item, kept)
      replaced.push(kept.id)
    }
  }
  // 与自动收录路径同一套规则：子任务已经平铺收录过的，平铺条目让位给带子任务的条目。
  // 只有被吸收掉的条目才把勾选结果搬到新条目上，未涉及的条目保持原状。
  const beforeReconcile = container.slice()
  let next = reconcileMemoNodes(container)
  const surviving = new Set(next.map((item) => item.id))
  const doneTexts = []
  for (const node of beforeReconcile) if (!surviving.has(node.id)) doneTextsOf(node, doneTexts)
  next = transferAbsorbedIds(beforeReconcile, next)
  if (doneTexts.length > 0) next = next.map((node) => markDone(node, doneTexts))
  if (next.length > MAX_ITEMS_PER_GROUP) next = next.slice(-MAX_ITEMS_PER_GROUP)
  if (parent !== null) {
    parent.children = next
    parent.done = next.length > 0 && next.every((node) => node.done === true)
  } else {
    group.items = next
  }
  // 跨轮重复：新写法取代更早轮次里几乎逐字相同的未完成条目，旧的那条自动勾掉。
  // 子代理的收录是它自己的工作记录，不去勾主会话的旧条目。
  const superseded = parent === null ? supersedeEarlier(group, doc, incoming) : 0
  const saved = await writeMemo(sessionId, doc)
  // 实际落进面板的条目数：新写入的与替换掉旧写法的都算，被吸收掉的不算。
  const present = nodeIdsOf(group.items)
  const counted = new Set()
  for (const item of incoming) if (present.has(item.id)) counted.add(item.id)
  for (const id of replaced) if (present.has(id)) counted.add(id)
  return { doc: saved, turn: group.turn, newTurn: group.newTurn === true, added: counted.size, skipped: incoming.length - counted.size, superseded, ...countMemo(saved) }
}

/** 找到节点及其祖先链（根在前）；找不到返回 null。 */
function trailOf(nodes, nodeId, trail = []) {
  for (const node of nodes) {
    const next = [...trail, node]
    if (node.id === nodeId) return next
    const nested = trailOf(node.children, nodeId, next)
    if (nested !== null) return nested
  }
  return null
}

/** 收集所有文本相似的叶子及其祖先链；跨轮重复的条目会全部命中，`allow` 给定时只认这些 id。 */
function leafTrailsOf(nodes, text, trail = [], found = [], allow = null) {
  for (const node of nodes) {
    const next = [...trail, node]
    if (node.children.length === 0) {
      if (allow !== null && !allow.has(node.id)) continue
      if (similarMemoItem(node.text, text)) found.push(next)
      continue
    }
    leafTrailsOf(node.children, text, next, found, allow)
  }
  return found
}

/** 自底向上重算祖先的推导状态。 */
function recomputeTrail(trail) {
  for (let index = trail.length - 2; index >= 0; index -= 1) {
    trail[index].done = trail[index].children.every((child) => child.done === true)
  }
}

/**
 * 仍未完成的叶子及其轮次与 id，供 Agent 在勾选前先看清单、也给自动回收当白名单。
 * 不按条数截断：清单本身就是 Agent 判断的依据。
 * @param doc - 备忘录文档。
 * @param options - `includeSubagents: false` 时跳过「子代理(<名字>)」子树（主会话的自动回收与去重不看它）。
 */
export function openMemoItems(doc, options) {
  const includeSubagents = !(options !== null && options !== undefined && options.includeSubagents === false)
  const open = []
  const visit = (node, turn, newTurn, underSubagent) => {
    if (!includeSubagents && node.subagent === true) return
    const flagged = underSubagent || node.subagent === true
    if (node.children.length === 0) {
      if (node.done !== true) {
        const item = { id: node.id, turn, text: node.text }
        if (newTurn) item.newTurn = true
        if (flagged) item.subagent = true
        open.push(item)
      }
      return
    }
    for (const child of node.children) visit(child, turn, newTurn, flagged)
  }
  for (const group of doc.groups) for (const item of group.items) visit(item, group.turn, group.newTurn === true, false)
  return open
}

/**
 * 把整份文档摊平成可读列表：父项在前、子项随后，带层级深度。
 * @param doc - 备忘录文档。
 * @returns `{ turn, id, text, done, depth, callout? }[]`，按文档顺序。
 */
export function flattenMemoItems(doc) {
  const rows = []
  const visit = (node, turn, depth, newTurn) => {
    const row = { turn, id: node.id, text: node.text, done: node.done === true, depth }
    if (newTurn) row.newTurn = true
    if (node.callout !== undefined) row.callout = node.callout
    rows.push(row)
    for (const child of node.children) visit(child, turn, depth + 1, newTurn)
  }
  for (const group of doc.groups) for (const item of group.items) visit(item, group.turn, 0, group.newTurn === true)
  return rows
}

/**
 * 读取提取诊断日志的尾部：只读文件末尾若干 KB，避免把整份日志读进内存。
 * @param limit - 最多返回行数（上限 200）；0 表示不读。
 * @returns 行数组；文件不存在或读取失败时为空数组。
 */
export async function readExtractLog(limit = 0) {
  const count = Number.isFinite(Number(limit)) ? Math.min(200, Math.max(0, Math.round(Number(limit)))) : 0
  if (count === 0) return []
  try {
    const file = join(memoRoot(), '_extract.log')
    const info = await stat(file)
    const tailBytes = Math.min(info.size, 64 * 1024)
    if (tailBytes === 0) return []
    const handle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(tailBytes)
      const { bytesRead } = await handle.read(buffer, 0, tailBytes, info.size - tailBytes)
      const lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/).filter((line) => line !== '')
      // 从文件中间读起时第一行是残行，丢掉。
      if (info.size > tailBytes && lines.length > 0) lines.shift()
      return lines.slice(-count)
    } finally {
      await handle.close()
    }
  } catch {
    return []
  }
}

/** 叶子文本的排序键：轮次优先（留最新的），同轮时取信息更全的。 */
function leafScore(entry) {
  return [entry.group.turn, normalizeMemoText(entry.node.text).length]
}

function betterThan(left, right) {
  if (left[0] !== right[0]) return left[0] > right[0]
  return left[1] > right[1]
}

/**
 * 复查去重：面板里同一件事留下的多条未完成叶子只留一条，其余标为完成。
 * 判据与写入去重一致（换措辞也算同一条）；保留最新的一条，同轮时保留信息更全的。
 * @param doc - 备忘录文档（就地修改）。
 * @returns `{ count, merges }`：被标为完成的条数，以及每对合并的原文（供日志审计）。
 */
export function dedupeMemoItems(doc) {
  const open = []
  const collect = (nodes, group, trail) => {
    for (const node of nodes) {
      // 子代理子树不参与主会话的机械去重：用它的工作记录把主会话待办勾掉属于误伤。
      if (node.subagent === true) continue
      const next = [...trail, node]
      if (node.children.length === 0) {
        if (node.done !== true) open.push({ node, group, trail: next })
        continue
      }
      collect(node.children, group, next)
    }
  }
  for (const group of doc.groups) collect(group.items, group, [])
  const dropped = new Set()
  const merges = []
  for (let index = 0; index < open.length; index += 1) {
    if (dropped.has(index)) continue
    for (let other = index + 1; other < open.length; other += 1) {
      if (dropped.has(other)) continue
      if (!similarMemoItem(open[index].node.text, open[other].node.text)) continue
      const keepIndex = betterThan(leafScore(open[index]), leafScore(open[other])) ? index : other
      const dropIndex = keepIndex === index ? other : index
      dropped.add(dropIndex)
      open[dropIndex].node.done = true
      recomputeTrail(open[dropIndex].trail)
      merges.push({ kept: open[keepIndex].node.text, dropped: open[dropIndex].node.text })
      if (dropIndex === index) break
    }
  }
  return { count: merges.length, merges }
}

/**
 * 按 id 勾选未完成条目：自动回收专用，不做文本匹配，避免把同义改写的条目一起勾掉。
 * @param sessionId - 会话标识。
 * @param options - `ids` 要勾选的叶子 id 集合。
 * @returns 文档、更新条数与计数、未完成清单。
 */
export async function resolveMemoItems(sessionId, { ids }) {
  const doc = await readMemo(sessionId)
  const wanted = new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string'))
  let updated = 0
  if (wanted.size > 0) {
    const visit = (nodes, trail) => {
      for (const node of nodes) {
        const next = [...trail, node]
        if (node.children.length === 0) {
          if (wanted.has(node.id) && node.done !== true) {
            node.done = true
            recomputeTrail(next)
            updated += 1
          }
          continue
        }
        visit(node.children, next)
      }
    }
    for (const group of doc.groups) visit(group.items, [])
  }
  const saved = updated > 0 ? await writeMemo(sessionId, doc) : doc
  const counts = countMemo(saved)
  return { doc: saved, updated, ...counts, openTotal: counts.unfinished, open: openMemoItems(saved) }
}

/**
 * 勾选或取消勾选已有条目：按文本相似匹配叶子，父项状态随之推导。
 * 只改状态，不新增条目；匹配不到时原样返回给 Agent 判断。
 * @param sessionId - 会话标识。
 * @param options - `items` 每项为 `{ text, done? }`，`done` 缺省为 true；
 *   `allowIds` 给定时只勾这些 id 的叶子（自动回收用它锁定「提取前就存在」的条目）。
 * @returns 更新条数、已是最新状态条数、未匹配文本与总数、计数、未完成总数与未完成清单。
 */
export async function updateMemoItems(sessionId, { items, allowIds }) {
  const doc = await readMemo(sessionId)
  const allow = Array.isArray(allowIds) ? new Set(allowIds.filter((id) => typeof id === 'string')) : null
  let updated = 0
  let unchanged = 0
  const unmatched = []
  for (const raw of Array.isArray(items) ? items : []) {
    const text = typeof raw === 'string' ? raw : raw !== null && raw !== undefined && typeof raw.text === 'string' ? raw.text : ''
    if (text.trim() === '') continue
    const wantDone = !(raw !== null && raw !== undefined && typeof raw === 'object' && raw.done === false)
    let matched = false
    let touched = 0
    for (const group of doc.groups) {
      for (const trail of leafTrailsOf(group.items, text, [], [], allow)) {
        matched = true
        const leaf = trail[trail.length - 1]
        if (leaf.done === wantDone) continue
        leaf.done = wantDone
        recomputeTrail(trail)
        touched += 1
      }
    }
    if (!matched) unmatched.push(text)
    else if (touched === 0) unchanged += 1
    else updated += touched
  }
  const saved = updated > 0 ? await writeMemo(sessionId, doc) : doc
  const counts = countMemo(saved)
  return {
    doc: saved,
    updated,
    unchanged,
    unmatched: unmatched.slice(0, 8),
    unmatchedTotal: unmatched.length,
    ...counts,
    openTotal: counts.unfinished,
    open: openMemoItems(saved),
  }
}

/** 整棵子树的叶子是否全部完成。 */
function allLeavesDone(node) {
  if (node.children.length === 0) return node.done === true
  return node.children.every(allLeavesDone)
}

/** 把整棵子树的每个节点设为同一个完成状态。 */
function setSubtreeDone(node, done) {
  node.done = done
  for (const child of node.children) setSubtreeDone(child, done)
}

/** 收集一棵树的所有叶子文本。 */
function leafTextsOf(node, texts = []) {
  if (typeof node === 'string') {
    if (node !== '') texts.push(node)
    return texts
  }
  if (node === null || node === undefined) return texts
  if (node.children.length === 0) {
    if (typeof node.text === 'string' && node.text !== '') texts.push(node.text)
    return texts
  }
  for (const child of node.children) leafTextsOf(child, texts)
  return texts
}

/**
 * 新写法取代旧写法：更早轮次里与本轮写入叶子「几乎逐字且不比新写法更全」的未完成叶子自动标为完成。
 * - 只比较叶子：旧条目的裸标题不会因为同名新标题就被整组勾掉；
 * - 方向性判定：新写法更短时不算取代，避免短版清掉细节；
 * - 勾完叶子后按祖先链重算父项状态。
 * @param current - 当前轮次的分组（同组跳过）。
 * @param doc - 备忘录文档。
 * @param incoming - 本轮写入的条目。
 * @returns 被勾掉的叶子数。
 */
function supersedeEarlier(current, doc, incoming) {
  const texts = []
  for (const item of incoming) leafTextsOf(item, texts)
  if (texts.length === 0) return 0
  let count = 0
  for (const group of doc.groups) {
    if (group === current) continue
    if (group.turn > current.turn) continue
    const visit = (nodes, trail) => {
      for (const node of nodes) {
        // 子代理子树不参与跨轮取代：它的条目不是主会话的旧待办。
        if (node.subagent === true) continue
        const next = [...trail, node]
        if (node.children.length === 0) {
          if (node.done === true) continue
          if (!texts.some((text) => supersedesMemoText(node.text, text))) continue
          node.done = true
          recomputeTrail(next)
          count += 1
          continue
        }
        visit(node.children, next)
      }
    }
    visit(group.items, [])
  }
  return count
}

/**
 * 勾选一个节点：叶子节点翻转自身；有子节点的节点整组切换——整组已完成时全部取消完成，否则整组标记完成。
 * @param sessionId - 会话标识。
 * @param nodeId - 目标节点 id。
 * @returns 写入后的文档与计数；找不到节点时返回错误码。
 */
export async function toggleMemoNode(sessionId, nodeId) {
  const doc = await readMemo(sessionId)
  for (const group of doc.groups) {
    const trail = trailOf(group.items, nodeId)
    if (trail === null) continue
    const target = trail[trail.length - 1]
    if (target.children.length > 0) setSubtreeDone(target, !allLeavesDone(target))
    else target.done = target.done !== true
    // 自底向上重算祖先的推导状态。
    for (let index = trail.length - 2; index >= 0; index -= 1) {
      trail[index].done = trail[index].children.every((child) => child.done === true)
    }
    const saved = await writeMemo(sessionId, doc)
    return { ok: true, doc: saved, ...countMemo(saved) }
  }
  return { ok: false, error: 'node-not-found' }
}

/** 分叉复制：目标已有数据时保持不变（幂等，重复调用无害）。 */
export async function copyMemo(fromSessionId, toSessionId) {
  if (!isSessionId(fromSessionId) || !isSessionId(toSessionId)) return { ok: false, error: 'invalid-session' }
  const existing = await readMemo(toSessionId)
  if (existing.groups.length > 0) return { ok: true, copied: false, doc: existing, ...countMemo(existing) }
  const source = await readMemo(fromSessionId)
  if (source.groups.length === 0) return { ok: true, copied: false, doc: existing, ...countMemo(existing) }
  const saved = await writeMemo(toSessionId, { ...source, sessionId: toSessionId })
  return { ok: true, copied: true, doc: saved, ...countMemo(saved) }
}


