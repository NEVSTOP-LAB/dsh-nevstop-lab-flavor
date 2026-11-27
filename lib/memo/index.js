/**
 * 备忘录的宿主半侧：配置驱动的启用状态、提示词段落与 `memo_add` 工具。
 *
 * 设计约束：
 * - 功能关闭时不注册工具，提示词段落返回空串，模型侧完全消失；
 * - 段落即使在关闭时也保持注册，切换开关不需要重载插件；
 * - 所有注册都包在调用方的 effect 里，卸载即移除；任何一步失败都只让该功能缺席，不抛到插件外。
 */
import { extractCallouts } from './callouts.js'
import { addMemoItems } from './store.js'
import { readTurn } from './turn.js'
import { MEMO_PROMPT } from './prompt.js'
import { createMemoTool } from './tool.js'

const SECTION_NAME = 'dsh-nevstop-lab-flavor:memo'
const SECTION_ORDER = 9000

const settings = { enabled: true, injectPrompt: true, autoCallouts: true }
const watchers = new Set()

/** 由配置读写处调用：同步最新开关并通知已挂载的宿主半侧。 */
export function setMemoSettings(config) {
  const features = config !== null && config !== undefined && config.features !== null && config.features !== undefined ? config.features : {}
  const memo = config !== null && config !== undefined && config.memo !== null && config.memo !== undefined ? config.memo : {}
  settings.enabled = features.memo !== false
  settings.injectPrompt = memo.injectPrompt !== false
  settings.autoCallouts = memo.autoCallouts !== false
  for (const watcher of watchers) {
    try {
      watcher()
    } catch {
      // 单个观察者失败不影响其余功能。
    }
  }
}

export function memoEnabled() {
  return settings.enabled
}

export function memoPromptText() {
  return settings.enabled && settings.injectPrompt ? MEMO_PROMPT : ''
}

const EVENT_SCAN = 200

/** 把助手消息的文本块拼成全文。 */
function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block === null || block === undefined || block.type !== 'text' || typeof block.text !== 'string') continue
    text += text === '' ? block.text : '\n' + block.text
  }
  return text
}

/** 取本次回合最后一条助手消息的全文；读不到时返回空串。 */
function lastAssistantText(session) {
  try {
    if (typeof session.snapshotEvents !== 'function' || typeof session.seq !== 'number' || session.seq <= 0) return ''
    const from = Math.max(0, session.seq - EVENT_SCAN)
    const events = session.snapshotEvents(from, session.seq)
    if (!Array.isArray(events)) return ''
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event === null || event === undefined || event.type !== 'assistant/message') continue
      const message = event.data !== null && event.data !== undefined ? event.data.message : undefined
      return message !== null && message !== undefined ? textOfContent(message.content) : ''
    }
  } catch {
    // 读取失败时跳过自动捕获，不影响回合。
  }
  return ''
}

/**
 * 在 `tools` 与 `systemPrompt` 都可用的 scope 上挂载模型侧。
 * @param scope - 已注入 `tools`、`systemPrompt` 的 Cordis scope。
 * @returns 释放函数；调用方的 effect 负责调用。
 */
export function mountMemo(scope) {
  const tools = scope.get('tools')
  const systemPrompt = scope.get('systemPrompt')
  let subagents
  try {
    subagents = scope.get('subagents')
  } catch {
    subagents = undefined
  }
  const disposers = []
  if (systemPrompt !== null && systemPrompt !== undefined && typeof systemPrompt.section === 'function') {
    disposers.push(
      systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        text: () => memoPromptText(),
      }),
    )
  }
  let disposeTool = null
  // 确定性兜底：回合结束自动把回复里的 callout 记进备忘录，不依赖模型自觉调用工具。
  if (typeof scope.on === 'function') {
    disposers.push(scope.on('session/event', (session, event) => {
      if (!settings.enabled || !settings.autoCallouts) return
      try {
        if (event === null || event === undefined || event.type !== 'turn/end') return
        const turn = event.data !== null && event.data !== undefined && typeof event.data.turn === 'number' ? event.data.turn : undefined
        if (turn === undefined) return
        const text = lastAssistantText(session)
        if (text === '') return
        const callouts = extractCallouts(text)
        if (callouts.length === 0) return
        const sessionId = session !== null && session !== undefined && typeof session.id === 'string' ? session.id : ''
        if (sessionId === '') return
        const { prompt } = readTurn(session)
        const items = callouts.map((callout) => ({ text: '[' + callout.kind + '] ' + callout.text }))
        void addMemoItems(sessionId, { turn, prompt, items }).catch(() => {})
      } catch {
        // 自动捕获是尽力而为：任何失败都不影响回合与会话。
      }
    }))
  }
  const syncTool = () => {
    if (settings.enabled && disposeTool === null) {
      if (tools === null || tools === undefined || typeof tools.register !== 'function') return
      try {
        disposeTool = tools.register(createMemoTool({ subagents }))
      } catch (error) {
        // 注册失败让工具缺席，但留下可排查的痕迹，不静默吞掉。
        console.warn('dsh-nevstop-lab-flavor: memo_add registration failed:', error)
        disposeTool = null
      }
      return
    }
    if (!settings.enabled && disposeTool !== null) {
      try {
        disposeTool()
      } catch {
        // 反注册失败时保持原状，下一次同步再试。
      }
      disposeTool = null
    }
  }
  watchers.add(syncTool)
  syncTool()
  scope.effect(
    () => () => {
      watchers.delete(syncTool)
      if (disposeTool !== null) {
        try {
          disposeTool()
        } catch {
          // 卸载路径不抛错。
        }
        disposeTool = null
      }
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // 同上。
        }
      }
    },
    'dsh-nevstop-lab-flavor: memo model surface',
  )
}
