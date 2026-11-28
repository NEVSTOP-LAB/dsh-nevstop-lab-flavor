/**
 * 备忘录的宿主半侧：配置驱动的启用状态、提示词段落与 `memo_add` 工具。
 *
 * 设计约束：
 * - 功能关闭时不注册工具，提示词段落返回空串，模型侧完全消失；
 * - 段落即使在关闭时也保持注册，切换开关不需要重载插件；
 * - 所有注册都包在调用方的 effect 里，卸载即移除；任何一步失败都只让该功能缺席，不抛到插件外。
 */
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { extractCallouts } from './callouts.js'
import { extractReminders, matchResolved } from './extract.js'
import { mergeMemoItems } from './merge.js'
import { extractOpenItems } from './openitems.js'
import { addMemoItems, dedupeMemoItems, memoRoot, openMemoItems, readMemo, resolveMemoItems, writeMemo } from './store.js'
import { readTurn } from './turn.js'
import { MEMO_PROMPT } from './prompt.js'
import { createMemoReadTool, createMemoTool, createMemoUpdateTool } from './tool.js'

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
  let disposeTools = []
  let llm = null
  let defaultModel = null
  // 这两个服务必须经 inject 才可访问；直接 get 会抛错并被吞掉，提取器就永远不跑。
  if (typeof scope.inject === 'function') {
    disposers.push(scope.inject(['llm', 'agentDefaultModel'], (injected) => {
      llm = injected.get('llm')
      defaultModel = injected.get('agentDefaultModel')
    }))
  }
  const logExtract = (message) => {
    try {
      void appendFile(join(memoRoot(), '_extract.log'), new Date().toISOString() + ' ' + message + '\n', 'utf8').catch(() => {})
    } catch {
      // 诊断日志失败不影响提取。
    }
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
          let extracted = { items: [], resolved: [], duplicates: [], failure: '' }
          let raw = ''
          let failure = ''
          // 提取前先读一次未完成清单：它既喂给模型判断「哪些已经处理掉」，也是回写勾选时的白名单。
          const open = openMemoItems(await readMemo(sessionId))
          if (settings.autoExtract) {
            if (llm === null || llm === undefined || defaultModel === null || defaultModel === undefined) {
              failure = 'llm or agentDefaultModel not injected'
            } else {
              try {
                const current = typeof defaultModel.currentSelection === 'function' ? defaultModel.currentSelection() : undefined
                const selection = {
                  provider: settings.extractProvider !== '' ? settings.extractProvider : (current !== null && current !== undefined ? current.provider : ''),
                  model: settings.extractModel !== '' ? settings.extractModel : (current !== null && current !== undefined ? current.model : ''),
                }
                extracted = await extractReminders({
                  llm,
                  selection,
                  prompt,
                  reply,
                  open,
                  sessionId,
                  promptText: settings.extractPrompt,
                  signal: AbortSignal.timeout(25000),
                  onRaw: (value) => {
                    raw = value
                  },
                })
                if (extracted.failure !== '') failure = 'extract: ' + extracted.failure
                else if (extracted.items.length === 0 && extracted.resolved.length === 0 && extracted.duplicates.length === 0) failure = 'model returned nothing'
              } catch (error) {
                const message = error !== null && error !== undefined && typeof error.message === 'string' ? error.message : String(error)
                failure = 'call failed: ' + message
              }
            }
          }
          // 规则兜底与模型结果合并：宁可多收，也不让回复末尾的卡片或清单整段丢失。
          const extras = []
          if (settings.autoCallouts) {
            for (const callout of extractCallouts(reply)) extras.push({ text: callout.text, callout: callout.kind })
            for (const item of extractOpenItems(reply)) extras.push(item)
          }
          const items = mergeMemoItems(extracted.items, extras)
          if (failure !== '') logExtract(failure + ' | items=' + items.length + ' | raw=' + String(raw).replace(/\s+/g, ' ').slice(0, 240) + ' | session=' + sessionId)
          if (items.length > 0) await addMemoItems(sessionId, { turn, prompt, items })
          // 日志里只放短引：压掉换行，避免一条日志被拆行或伪造字段。
          const shortList = (list) => list.map((text) => String(text).replace(/\s+/g, ' ').slice(0, 60)).join(' | ').slice(0, 200)
          const resolvedList = Array.isArray(extracted.resolved) ? extracted.resolved : []
          const duplicatesList = Array.isArray(extracted.duplicates) ? extracted.duplicates : []
          // 回收本轮处理掉的旧条目：严格匹配挑出 id，按 id 精确勾选，不做二次文本匹配。
          if (settings.autoExtract && resolvedList.length > 0) {
            const targets = matchResolved(resolvedList, open)
            if (targets.length === 0) {
              logExtract('resolved 0/' + resolvedList.length + ' (0 item(s)) | ' + shortList(resolvedList) + ' | session=' + sessionId)
            } else {
              const resolvedResult = await resolveMemoItems(sessionId, { ids: targets.map((entry) => entry.id) })
              logExtract(
                'resolved ' + targets.length + '/' + resolvedList.length + ' (' + resolvedResult.updated + ' item(s)) | ' + shortList(targets.map((entry) => entry.text)) + ' | session=' + sessionId,
              )
            }
          }
          // 模型判定的重复：把更早的重复条目标为完成，只留最新的那条。
          if (settings.autoExtract && duplicatesList.length > 0) {
            const duplicateTargets = matchResolved(duplicatesList, open)
            if (duplicateTargets.length === 0) {
              logExtract('duplicates 0/' + duplicatesList.length + ' (0 item(s)) | ' + shortList(duplicatesList) + ' | session=' + sessionId)
            } else {
              const duplicateResult = await resolveMemoItems(sessionId, { ids: duplicateTargets.map((entry) => entry.id) })
              logExtract(
                'duplicates ' + duplicateTargets.length + '/' + duplicatesList.length + ' (' + duplicateResult.updated + ' item(s)) | ' + shortList(duplicateTargets.map((entry) => entry.text)) + ' | session=' + sessionId,
              )
            }
          }
          // 复查去重：同一件事在面板里留下的多条未完成条目，只保留最新的一条（同轮时留信息更全的）。
          // 它不受「自动提取」开关控制：确定性检查，不调用模型。
          const latest = await readMemo(sessionId)
          const dedupeResult = dedupeMemoItems(latest)
          if (dedupeResult.count > 0) {
            await writeMemo(sessionId, latest)
            const pairs = dedupeResult.merges
              .slice(0, 3)
              .map((merge) => 'kept=' + String(merge.kept).replace(/\s+/g, ' ').slice(0, 40) + ' dropped=' + String(merge.dropped).replace(/\s+/g, ' ').slice(0, 40))
              .join(' | ')
            logExtract('deduped ' + dedupeResult.count + ' | ' + pairs + ' | session=' + sessionId)
          }
        })().catch(() => {})
      } catch {
        // 自动收录是尽力而为：任何失败都不影响回合与会话。
      }
    }))
  }
  const syncTools = () => {
    if (settings.enabled && disposeTools.length === 0) {
      if (tools === null || tools === undefined || typeof tools.register !== 'function') return
      const disposers = []
      let failed = false
      for (const [create, label] of [[createMemoTool, 'memo_add'], [createMemoUpdateTool, 'memo_update'], [createMemoReadTool, 'memo_read']]) {
        try {
          disposers.push(tools.register(create({ subagents })))
        } catch (error) {
          // 注册失败让该工具缺席，但留下可排查的痕迹，不静默吞掉。
          failed = true
          console.warn('dsh-nevstop-lab-flavor: ' + label + ' registration failed:', error)
        }
      }
      if (failed) {
        // 一个失败就整组回滚：下一次同步会重试，不让两个工具长期停在只注册一半的状态。
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            // 回滚失败不影响下次重试。
          }
        }
        return
      }
      disposeTools = disposers
      return
    }
    if (!settings.enabled && disposeTools.length > 0) {
      for (const dispose of disposeTools) {
        try {
          dispose()
        } catch {
          // 反注册失败时保持原状，下一次同步再试。
        }
      }
      disposeTools = []
    }
  }
  watchers.add(syncTools)
  syncTools()
  scope.effect(
    () => () => {
      watchers.delete(syncTools)
      for (const dispose of disposeTools) {
        try {
          dispose()
        } catch {
          // 卸载路径不抛错。
        }
      }
      disposeTools = []
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
