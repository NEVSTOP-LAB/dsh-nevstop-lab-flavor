/**
 * 备忘录存储：按会话分文件的插件私有 JSON，条目是任意层级的树。
 *
 * - 位置 `$DSH_HOME/plugin-data/dsh-nevstop-lab-flavor/memo/<sessionId>.json`；
 * - 与会话日志完全分离：文件损坏、缺失或删除只影响面板读取，不影响会话加载；
 * - 校验是「逐字段回落」的：坏节点丢弃、好节点照常，深度与每层数量都有上限；
 * - 有子节点的节点，`done` 恒等于子节点全部完成；父节点勾选时整组切换（全完成→全部取消，否则全部标记完成）；
 * - 写入走同目录临时文件 + rename，避免半截文件。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const MEMO_VERSION = 1

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/
const MAX_GROUPS = 400
const MAX_ITEMS_PER_GROUP = 200
const MAX_CHILDREN = 25
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
    for (const child of raw.children.slice(0, MAX_CHILDREN)) {
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
  if (children.length > 0) node.done = children.every((child) => child.done === true)
  return node
}

function normalizeGroup(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const items = Array.isArray(raw.items) ? raw.items.map((item) => normalizeNode(item, 0)).filter(Boolean).slice(0, MAX_ITEMS_PER_GROUP) : []
  if (items.length === 0) return null
  return {
    turn: positiveInt(raw.turn),
    prompt: text(raw.prompt, MAX_PROMPT),
    items,
  }
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

/**
 * 追加一条或多条待办到指定轮次的分组，条目可以是树。
 * 同轮内按顶层文本去重：Agent 重试或重复描述同一件事时不会产生重复条目。
 */
export async function addMemoItems(sessionId, { turn, prompt, items }) {
  const doc = await readMemo(sessionId)
  const turnNumber = positiveInt(turn)
  const promptText = text(prompt, MAX_PROMPT)
  let group = doc.groups.find((entry) => entry.turn === turnNumber)
  if (group === undefined) {
    group = { turn: turnNumber, prompt: promptText, items: [] }
    doc.groups.push(group)
    doc.groups.sort((left, right) => left.turn - right.turn)
  } else if (group.prompt === '' && promptText !== '') {
    group.prompt = promptText
  }
  const seen = new Set(group.items.map((item) => item.text))
  let added = 0
  let skipped = 0
  for (const raw of Array.isArray(items) ? items : []) {
    const item = normalizeNode(raw, 0)
    if (item === null) continue
    if (seen.has(item.text)) {
      skipped += 1
      continue
    }
    seen.add(item.text)
    group.items.push(item)
    added += 1
  }
  if (group.items.length > MAX_ITEMS_PER_GROUP) group.items = group.items.slice(-MAX_ITEMS_PER_GROUP)
  const saved = await writeMemo(sessionId, doc)
  return { doc: saved, added, skipped, ...countMemo(saved) }
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
