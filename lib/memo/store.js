/**
 * 备忘录存储：按会话分文件的插件私有 JSON。
 *
 * - 位置 `$DSH_HOME/plugin-data/dsh-nevstop-lab-flavor/memo/<sessionId>.json`；
 * - 与会话日志完全分离：文件损坏、缺失或删除只影响面板读取，不影响会话加载；
 * - 校验是「逐字段回落」的：坏条目丢弃、好条目照常，绝不因为一份数据把面板或插件带崩；
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
const MAX_TITLE = 400
const MAX_PROMPT = 200
const MAX_TEXT = 800
const CALLOUTS = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']

export function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID.test(value)
}

function calloutOf(value) {
  if (typeof value !== 'string') return undefined
  const upper = value.toUpperCase()
  return CALLOUTS.includes(upper) ? upper : undefined
}

export function memoRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'plugin-data', 'dsh-nevstop-lab-flavor', 'memo')
}

function memoFile(sessionId) {
  if (!isSessionId(sessionId)) throw new Error('invalid session id')
  return join(memoRoot(), sessionId + '.json')
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

function normalizeChild(raw) {
  // 工具入参用字符串数组表达子任务，面板与文件里存的是对象，两种都接受。
  if (typeof raw === 'string') {
    const value = text(raw, MAX_TITLE)
    return value === '' ? null : { id: newId('c'), text: value, done: false }
  }
  if (raw === null || typeof raw !== 'object') return null
  const value = text(raw.text, MAX_TITLE)
  if (value === '') return null
  return { id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : newId('c'), text: value, done: raw.done === true }
}

function normalizeItem(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const value = text(raw.text, MAX_TITLE)
  if (value === '') return null
  const children = Array.isArray(raw.children) ? raw.children.map(normalizeChild).filter(Boolean).slice(0, MAX_CHILDREN) : []
  const item = {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : newId('m'),
    text: value,
    done: raw.done === true,
    source: raw.source === 'user' ? 'user' : 'agent',
    children,
  }
  const callout = calloutOf(raw.callout)
  if (callout !== undefined) item.callout = callout
  // 有子任务时父项状态由子任务推导，不接受存储值。
  if (children.length > 0) item.done = children.every((child) => child.done)
  return item
}

function normalizeGroup(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const items = Array.isArray(raw.items) ? raw.items.map(normalizeItem).filter(Boolean).slice(0, MAX_ITEMS_PER_GROUP) : []
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

/** 统计口径：子任务计入，父项不重复计入；总数含已完成。 */
export function countMemo(doc) {
  let total = 0
  let unfinished = 0
  for (const group of doc.groups) {
    for (const item of group.items) {
      const leaves = item.children.length > 0 ? item.children : [item]
      for (const leaf of leaves) {
        total += 1
        if (leaf.done !== true) unfinished += 1
      }
    }
  }
  return { total, unfinished, done: total > 0 && unfinished === 0 }
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
 * 追加一条或多条待办到指定轮次的分组。
 * 同轮内按文本去重：Agent 重试或重复描述同一件事时不会产生重复条目。
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
    const item = normalizeItem(raw)
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

/** 勾选：叶子项直接切换；父项由子任务推导，单独勾选被拒绝。 */
export async function toggleMemoItem(sessionId, itemId, childId) {
  const doc = await readMemo(sessionId)
  for (const group of doc.groups) {
    for (const item of group.items) {
      if (item.id !== itemId) continue
      if (item.children.length > 0) {
        if (childId === undefined) {
          // 父项：未全部完成时全勾，已全部完成时全消。
          const next = !item.children.every((entry) => entry.done === true)
          for (const entry of item.children) entry.done = next
        } else {
          const child = item.children.find((entry) => entry.id === childId)
          if (child === undefined) return { ok: false, error: 'child-not-found' }
          child.done = child.done !== true
        }
        item.done = item.children.every((entry) => entry.done)
        const saved = await writeMemo(sessionId, doc)
        return { ok: true, doc: saved, ...countMemo(saved) }
      }
      if (childId !== undefined) return { ok: false, error: 'child-not-found' }
      item.done = item.done !== true
      const saved = await writeMemo(sessionId, doc)
      return { ok: true, doc: saved, ...countMemo(saved) }
    }
  }
  return { ok: false, error: 'item-not-found' }
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
