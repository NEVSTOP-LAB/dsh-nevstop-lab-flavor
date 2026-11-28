/**
 * 备忘录的两个模型侧工具。
 *
 * - `memo_add`：写入提醒与待办，返回轮次、轮内去重计数与剩余未完成数，不回灌清单；
 * - `memo_update`：按内容勾选/取消勾选已有叶子，返回更新条数、未匹配文本（最多 8 条 + 总数）与全部未完成条目的短引；
 * - `memo_read`：只读返回条目明细（默认前 40 行、每条 200 字短引，可选按轮次/未完成筛选）与提取日志尾部。
 *
 * 两者共用同一套会话归属：取调用方 Agent 的会话；子代理经 `subagents.rootOf` 归到根会话，用户只需看一个面板。
 * 轮次与提示词来自会话日志的只读扫描（见 `turn.js`），读不到时按未识别轮次记录。
 */
import { join } from 'node:path'
import { addMemoItems, flattenMemoItems, readExtractLog, readMemo, countMemo, updateMemoItems, memoRoot } from './store.js'
import { readTurn } from './turn.js'

export const MEMO_TOOL_NAME = 'memo_add'
export const MEMO_UPDATE_TOOL_NAME = 'memo_update'
export const MEMO_READ_TOOL_NAME = 'memo_read'

const DESCRIPTION = [
  'Record reminders, constraints the user must remember, and follow-ups the user has to act on later in this session\'s Memo panel.',
  'Call it in the turn that raises them and batch everything from that turn into one call, keeping the items in the order they appear in your reply.',
  'Keep each text a short reminder; skip routine progress and anything already recorded.',
].join(' ')

const UPDATE_DESCRIPTION = [
  'Tick off Memo items this conversation has already resolved, including items recorded in earlier turns; every matching item in the session is updated.',
  'Pass the text of the resolved items; matching is by content, so a short quote of the recorded item is enough — a short quote can also match several similar items, so quote the recorded text to tick exactly one. Pass `done: false` to reopen one.',
  'Only leaf items can be ticked: an item with subtasks follows its children, so pass the subtask text instead of the heading.',
  'Omit `items` only when unsure what is still open; the reply then lists every open item in the session.',
].join(' ')

const READ_DESCRIPTION = [
  'Read this session\'s Memo document for inspection: items in document order with id, text, done flag, depth and callout kind, plus the totals.',
  'Returns the first 40 rows by default; pass `limit` (max 400), `turn` or `unfinishedOnly` to narrow or widen it.',
  'Pass `logLines` to also include the tail of the extractor log — use it to tell "the model returned nothing" from "the provider rejected the call" when automatic capture looks wrong.',
  'Read-only: it never changes an item. Use `memo_update` to change one.',
].join(' ')

const OPEN_TEXT_LIMIT = 200

/** 回灌给模型的未完成条目只留短引：条目全部列出，但每条不占太多上下文。 */
function clipMemoText(value) {
  const text = typeof value === 'string' ? value : ''
  if (text.length <= OPEN_TEXT_LIMIT) return text
  return text.slice(0, OPEN_TEXT_LIMIT - 1).trimEnd() + '…'
}

function owningSession(agent, subagents) {
  const own = agent !== null && agent !== undefined && agent.session ? agent.session : undefined
  if (subagents === null || subagents === undefined || agent === null || agent === undefined) return own
  try {
    const root = subagents.rootOf(agent)
    if (root !== null && root !== undefined && root.session) return root.session
  } catch {
    // 拿不到根代理时退回调用方自己的会话。
  }
  return own
}

/** 子任务 schema：可以是纯文本，也可以是带 callout 与更下一层子任务的节点。 */
function childSchema(depth) {
  const asString = { type: 'string', description: 'A subtask title.' }
  if (depth <= 0) return asString
  return {
    oneOf: [
      asString,
      {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: { type: 'string', description: 'A subtask title; Markdown is supported.' },
          callout: {
            type: 'string',
            enum: ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'],
            description: 'Optional callout kind for this subtask.',
          },
          children: {
            type: 'array',
            description: 'Nested subtasks of this subtask, in order.',
            items: childSchema(depth - 1),
          },
        },
      },
    ],
  }
}

/**
 * 构造工具定义。
 * @param options - `subagents` 可选，用于把子代理的条目归到根会话。
 * @returns 注册到 `ctx.tools` 的定义对象。
 */
export function createMemoTool(options) {
  const subagents = options !== null && options !== undefined ? options.subagents : undefined
  return {
    name: MEMO_TOOL_NAME,
    description: DESCRIPTION,
    // 这里是注册表直接校验的原始 JSON Schema（不是作者 DSL）：必填项放在 required 数组里。
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['items'],
      properties: {
        items: {
          type: 'array',
          description: 'Everything from this turn worth the user\'s later attention, in the order it appears in the reply.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['text'],
            properties: {
              text: {
                type: 'string',
                description: 'One reminder or follow-up, phrased as a short imperative or noun phrase. Markdown is supported (bold, inline code, links, lists, and `> [!NOTE]` callout blocks).',
              },
              callout: {
                type: 'string',
                enum: ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'],
                description: 'Optional callout kind; the item renders as that callout instead of plain text.',
              },
              children: {
                type: 'array',
                description: 'Optional subtasks, in order; they may nest through their own children.',
                items: childSchema(2),
              },
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['turn', 'prompt', 'added', 'skipped', 'superseded', 'unfinished', 'total'],
        properties: {
          turn: { type: 'integer' },
          prompt: { type: 'string' },
          added: { type: 'integer' },
          skipped: { type: 'integer' },
          superseded: { type: 'integer', description: 'How many older open entries this call ticked off because the new wording supersedes them.' },
          unfinished: { type: 'integer' },
          total: { type: 'integer' },
        },
      },
      render: (_args, value) => {
        const parts = [`Recorded ${value.added} memo item(s) under turn ${value.turn}; ${value.unfinished}/${value.total} still open.`]
        if (value.skipped > 0) parts.push(`${value.skipped} duplicate(s) skipped.`)
        if (value.superseded > 0) parts.push(`${value.superseded} older item(s) superseded.`)
        return [{ type: 'text', text: parts.join(' ') }]
      },
    },
    async execute(args, exec) {
      const agent = exec !== null && exec !== undefined ? exec.agent : undefined
      if (agent === null || agent === undefined) throw new Error('memo_add requires an owning agent session')
      const session = owningSession(agent, subagents)
      const sessionId = session !== null && session !== undefined && typeof session.id === 'string' ? session.id : ''
      if (sessionId === '') throw new Error('memo_add requires a session id')
      const items = Array.isArray(args !== null && args !== undefined ? args.items : undefined) ? args.items : []
      if (items.length === 0) throw new Error('memo_add requires at least one item')
      const { turn, prompt } = readTurn(session)
      const result = await addMemoItems(sessionId, { turn, prompt, items })
      const group = result.doc.groups.find((entry) => entry.turn === turn)
      return {
        turn,
        prompt: group !== undefined ? group.prompt : prompt,
        added: result.added,
        skipped: result.skipped,
        superseded: result.superseded,
        unfinished: result.unfinished,
        total: result.total,
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Add memo items', kind: 'other', rawInput: args.items }),
  }
}

/**
 * 构造「勾选已有备忘」的工具定义。
 * @param options - `subagents` 可选，用于把子代理的调用归到根会话。
 * @returns 注册到 `ctx.tools` 的定义对象。
 */
export function createMemoUpdateTool(options) {
  const subagents = options !== null && options !== undefined ? options.subagents : undefined
  return {
    name: MEMO_UPDATE_TOOL_NAME,
    description: UPDATE_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        items: {
          type: 'array',
          description: 'Open items this turn resolved, matched by content; omit to only list what is still open.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['text'],
            properties: {
              text: { type: 'string', description: 'Text of the existing leaf item; a short quote of it is enough. Items with subtasks cannot be ticked directly.' },
              done: { type: 'boolean', description: 'true (default) marks it done; false reopens it.' },
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['turn', 'updated', 'unchanged', 'unmatched', 'unmatchedTotal', 'unfinished', 'total', 'openTotal', 'open'],
        properties: {
          turn: { type: 'integer' },
          updated: { type: 'integer' },
          unchanged: { type: 'integer' },
          unmatched: { type: 'array', items: { type: 'string' } },
          unmatchedTotal: { type: 'integer', description: 'How many requested texts matched nothing; `unmatched` lists at most 8 of them.' },
          unfinished: { type: 'integer' },
          total: { type: 'integer' },
          openTotal: { type: 'integer', description: 'How many items are still open in total.' },
          open: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['turn', 'text'],
              properties: {
                turn: { type: 'integer' },
                text: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const parts = [`Memo: ${value.updated} updated, ${value.unfinished}/${value.total} still open.`]
        if (value.unchanged > 0) parts.push(`${value.unchanged} already in that state.`)
        if (value.unmatched.length > 0) {
          const rest = value.unmatchedTotal - value.unmatched.length
          parts.push(`No match for: ${value.unmatched.join('; ')}${rest > 0 ? ` and ${rest} more` : ''}.`)
        }
        const hidden = value.openTotal - value.open.length
        if (hidden > 0) parts.push(`${hidden} more open item(s) not listed.`)
        if (value.open.length > 0) parts.push(`Open: ${value.open.map((item) => `[${item.turn}] ${item.text}`).join(' | ')}`)
        return [{ type: 'text', text: parts.join(' ') }]
      },
    },
    async execute(args, exec) {
      const agent = exec !== null && exec !== undefined ? exec.agent : undefined
      if (agent === null || agent === undefined) throw new Error('memo_update requires an owning agent session')
      const session = owningSession(agent, subagents)
      const sessionId = session !== null && session !== undefined && typeof session.id === 'string' ? session.id : ''
      if (sessionId === '') throw new Error('memo_update requires a session id')
      const items = Array.isArray(args !== null && args !== undefined ? args.items : undefined) ? args.items : []
      const { turn } = readTurn(session)
      const result = await updateMemoItems(sessionId, { items })
      return {
        turn,
        updated: result.updated,
        unchanged: result.unchanged,
        unmatched: result.unmatched,
        unmatchedTotal: result.unmatchedTotal,
        unfinished: result.unfinished,
        total: result.total,
        openTotal: result.openTotal,
        open: result.open.map((item) => ({ turn: item.turn, text: clipMemoText(item.text) })),
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Update memo items', kind: 'other', rawInput: args !== null && args !== undefined ? args.items : undefined }),
  }
}

/**
 * 构造「只读查看备忘录」的工具定义：给 Agent 自查、也给排查自动收录用。
 * @param options - `subagents` 可选，用于把子代理的读取归到根会话。
 * @returns 注册到 `ctx.tools` 的定义对象。
 */
export function createMemoReadTool(options) {
  const subagents = options !== null && options !== undefined ? options.subagents : undefined
  return {
    name: MEMO_READ_TOOL_NAME,
    description: READ_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', description: 'Max rows to return from the start of the filtered list; default 40, max 400, 0 for counts only.' },
        turn: { type: 'integer', description: 'Only rows recorded under this turn.' },
        unfinishedOnly: { type: 'boolean', description: 'Only rows that are still open.' },
        logLines: { type: 'integer', description: 'Trailing lines of the extractor log to include; omit or 0 for none, max 200.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['turn', 'total', 'unfinished', 'items', 'rowTotal', 'logPath', 'log'],
        properties: {
          turn: { type: 'integer' },
          total: { type: 'integer' },
          unfinished: { type: 'integer' },
          rowTotal: { type: 'integer', description: 'Rows matching the filters; `items` returns at most `limit` of them.' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['turn', 'id', 'text', 'done', 'depth'],
              properties: {
                turn: { type: 'integer' },
                id: { type: 'string' },
                text: { type: 'string' },
                done: { type: 'boolean' },
                depth: { type: 'integer' },
                callout: {
                  type: 'string',
                  enum: ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'],
                },
              },
            },
          },
          logPath: { type: 'string' },
          log: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const lines = [`Memo: ${value.unfinished}/${value.total} open, showing ${value.items.length}/${value.rowTotal} row(s).`]
        for (const item of value.items) {
          const mark = item.done ? '[x]' : '[ ]'
          const indent = '  '.repeat(Math.min(3, item.depth))
          const callout = item.callout !== undefined ? ' <' + item.callout + '>' : ''
          lines.push(`${indent}${mark} (T${item.turn} ${item.id}) ${clipMemoText(item.text)}${callout}`)
        }
        if (value.rowTotal > value.items.length) lines.push(`… ${value.rowTotal - value.items.length} more row(s) not shown.`)
        if (value.log.length > 0) {
          lines.push('Log:')
          for (const line of value.log) lines.push('  ' + clipMemoText(line))
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const agent = exec !== null && exec !== undefined ? exec.agent : undefined
      if (agent === null || agent === undefined) throw new Error('memo_read requires an owning agent session')
      const session = owningSession(agent, subagents)
      const sessionId = session !== null && session !== undefined && typeof session.id === 'string' ? session.id : ''
      if (sessionId === '') throw new Error('memo_read requires a session id')
      const { turn } = readTurn(session)
      const doc = await readMemo(sessionId)
      const counts = countMemo(doc)
      const args0 = args !== null && args !== undefined ? args : {}
      const turnFilter = Number.isFinite(Number(args0.turn)) ? Number(args0.turn) : null
      const unfinishedOnly = args0.unfinishedOnly === true
      const limit = Number.isFinite(Number(args0.limit)) ? Math.min(400, Math.max(0, Math.round(Number(args0.limit)))) : 40
      const rows = flattenMemoItems(doc).filter(
        (row) => (turnFilter === null || row.turn === turnFilter) && (!unfinishedOnly || row.done !== true),
      )
      const logLines = Number.isFinite(Number(args0.logLines)) ? Number(args0.logLines) : 0
      const log = await readExtractLog(logLines)
      return {
        turn,
        total: counts.total,
        unfinished: counts.unfinished,
        rowTotal: rows.length,
        items: rows.slice(0, limit).map((row) => ({ ...row, text: clipMemoText(row.text) })),
        logPath: join(memoRoot(), '_extract.log'),
        log,
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Read memo', kind: 'other' }),
  }
}
