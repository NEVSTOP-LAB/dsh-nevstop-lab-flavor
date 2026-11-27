/**
 * `memo_add`：Agent 把提醒与待办写进当前会话的备忘录。
 *
 * - 归属会话取调用方 Agent 的会话；子代理经 `subagents.rootOf` 归到根会话，用户只需看一个面板；
 * - 轮次与提示词来自会话日志的只读扫描（见 `turn.js`），读不到时按未识别轮次记录；
 * - 返回值有界：只给轮次与计数，不回灌整份清单。
 */
import { addMemoItems } from './store.js'
import { readTurn } from './turn.js'

export const MEMO_TOOL_NAME = 'memo_add'

const DESCRIPTION = [
  'Record reminders, constraints the user must remember, and follow-ups the user has to act on later in this session\'s Memo panel.',
  'Call it in the turn that raises them and batch everything from that turn into one call.',
  'Keep each text a short reminder; skip routine progress and anything already recorded.',
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
          description: 'Everything from this turn worth the user\'s later attention.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['text'],
            properties: {
              text: {
                type: 'string',
                description: 'One reminder or follow-up, phrased as a short imperative or noun phrase.',
              },
              children: {
                type: 'array',
                description: 'Optional subtasks; the parent completes when every subtask is checked.',
                items: { type: 'string' },
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
