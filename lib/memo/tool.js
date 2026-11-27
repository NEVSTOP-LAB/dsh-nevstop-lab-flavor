/**
 * 备忘录的两个模型侧工具。
 *
 * - `memo_add`：写入提醒与待办，返回轮次、轮内去重计数与剩余未完成数，不回灌清单；
 * - `memo_update`：按内容勾选/取消勾选已有叶子，返回更新条数、未匹配文本与未完成清单（最多 20 条，另给未完成总数）。
 *
 * 两者共用同一套会话归属：取调用方 Agent 的会话；子代理经 `subagents.rootOf` 归到根会话，用户只需看一个面板。
 * 轮次与提示词来自会话日志的只读扫描（见 `turn.js`），读不到时按未识别轮次记录。
 */
import { addMemoItems, updateMemoItems } from './store.js'
import { readTurn } from './turn.js'

export const MEMO_TOOL_NAME = 'memo_add'
export const MEMO_UPDATE_TOOL_NAME = 'memo_update'

const DESCRIPTION = [
  'Record reminders, constraints the user must remember, and follow-ups the user has to act on later in this session\'s Memo panel.',
  'Call it in the turn that raises them and batch everything from that turn into one call, keeping the items in the order they appear in your reply.',
  'Keep each text a short reminder; skip routine progress and anything already recorded.',
].join(' ')

const UPDATE_DESCRIPTION = [
  'Tick off Memo items this conversation has already resolved, including items recorded in earlier turns; every matching item in the session is updated.',
  'Pass the text of the resolved items; matching is by content, so a short quote of the recorded item is enough — a short quote can also match several similar items, so quote the recorded text to tick exactly one. Pass `done: false` to reopen one.',
  'Only leaf items can be ticked: an item with subtasks follows its children, so pass the subtask text instead of the heading.',
  'Omit `items` only when unsure what is still open; the reply then lists up to 20 open items and their total.',
].join(' ')

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
        required: ['turn', 'prompt', 'added', 'skipped', 'unfinished', 'total'],
        properties: {
          turn: { type: 'integer' },
          prompt: { type: 'string' },
          added: { type: 'integer' },
          skipped: { type: 'integer' },
          unfinished: { type: 'integer' },
          total: { type: 'integer' },
        },
      },
      render: (_args, value) => {
        const head = `Recorded ${value.added} memo item(s) under turn ${value.turn}; ${value.unfinished}/${value.total} still open.`
        return [{ type: 'text', text: value.skipped > 0 ? `${head} ${value.skipped} duplicate(s) skipped.` : head }]
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
          openTotal: { type: 'integer', description: 'How many items are still open in total; `open` lists at most 20 of them.' },
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
        open: result.open,
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Update memo items', kind: 'other', rawInput: args !== null && args !== undefined ? args.items : undefined }),
  }
}
