/**
 * 备忘录的宿主半侧：配置驱动的启用状态、提示词段落与 `memo_add` 工具。
 *
 * 设计约束：
 * - 功能关闭时不注册工具，提示词段落返回空串，模型侧完全消失；
 * - 段落即使在关闭时也保持注册，切换开关不需要重载插件；
 * - 所有注册都包在调用方的 effect 里，卸载即移除；任何一步失败都只让该功能缺席，不抛到插件外。
 */
import { extractCallouts } from './callouts.js'
import { extractReminders } from './extract.js'
import { addMemoItems } from './store.js'
import { readTurn } from './turn.js'
import { MEMO_PROMPT } from './prompt.js'
import { createMemoTool } from './tool.js'

const SECTION_NAME = 'dsh-nevstop-lab-flavor:memo'
const SECTION_ORDER = 9000

const settings = { enabled: true, injectPrompt: true, autoCallouts: true, autoExtract: true, extractProvider: '', extractModel: '', extractPrompt: '' }
const watchers = new Set()

/** 由配置读写处调用：同步最新开关并通知已挂载的宿主半侧。 */
export function setMemoSettings(config) {
  const features = config !== null && config !== undefined && config.features !== null && config.features !== undefined ? config.features : {}
  const memo = config !== null && config !== undefined && config.memo !== null && config.memo !== undefined ? config.memo : {}
  settings.enabled = features.memo !== false
  settings.injectPrompt = memo.injectPrompt !== false
  settings.autoCallouts = memo.autoCallouts !== false
  settings.autoExtract = memo.autoExtract !== false
  settings.extractProvider = typeof memo.extractProvider === 'string' ? memo.extractProvider.trim() : ''
  settings.extractModel = typeof memo.extractModel === 'string' ? memo.extractModel.trim() : ''
  settings.extractPrompt = typeof memo.extractPrompt === 'string' ? memo.extractPrompt : ''
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
  let llm = null
  let defaultModel = null
  try {
    llm = scope.get('llm')
  } catch {
    llm = null
  }
  try {
    defaultModel = scope.get('agentDefaultModel')
  } catch {
    defaultModel = null
  }
  // 回合结束自动收录：先用轻量提取器判断「这一轮回复里有什么值得记住」，
  // 不可用时回退到 callout 规则；失败不影响回合与会话。
  if (typeof scope.on === 'function') {
    disposers.push(scope.on('session/event', (session, event) => {
      if (!settings.enabled) return
      try {
        if (event === null || event === undefined || event.type !== 'turn/end') return
        const turn = event.data !== null && event.data !== undefined && typeof event.data.turn === 'number' ? event.data.turn : undefined
        if (turn === undefined) return
        const reply = lastAssistantText(session)
        if (reply === '') return
        const sessionId = session !== null && session !== undefined && typeof session.id === 'string' ? session.id : ''
        if (sessionId === '') return
        const { prompt } = readTurn(session)
        void (async () => {
          let items = []
          if (settings.autoExtract && llm !== null && llm !== undefined && defaultModel !== null && defaultModel !== undefined) {
            try {
              const current = typeof defaultModel.currentSelection === 'function' ? defaultModel.currentSelection() : undefined
              const selection = {
                provider: settings.extractProvider !== '' ? settings.extractProvider : (current !== null && current !== undefined ? current.provider : ''),
                model: settings.extractModel !== '' ? settings.extractModel : (current !== null && current !== undefined ? current.model : ''),
              }
              items = await extractReminders({ llm, selection, prompt, reply, promptText: settings.extractPrompt, signal: AbortSignal.timeout(25000) })
            } catch {
              items = []
            }
          }
          if (items.length === 0 && settings.autoCallouts) {
            items = extractCallouts(reply).map((callout) => ({ text: callout.text, callout: callout.kind }))
          }
          if (items.length > 0) await addMemoItems(sessionId, { turn, prompt, items })
        })().catch(() => {})
      } catch {
        // 自动收录是尽力而为：任何失败都不影响回合与会话。
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
