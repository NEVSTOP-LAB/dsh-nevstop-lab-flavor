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
import { STRICT_COVERAGE } from './merge.js'
import { extractReminders, matchResolved } from './extract.js'
import { mergeMemoItems } from './merge.js'
import { extractOpenItems } from './openitems.js'
import { stripAssistantPlans } from './plans.js'
import { addMemoItems, captureSignature, dedupeMemoItems, memoRoot, openMemoItems, readMemo, resolveMemoItems, subagentMemoLabel, writeMemo } from './store.js'
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
 * 子代理名字：优先取 `subagents.namesOf(agent).self`（如 `reviewer`），
 * 取不到时退回子代理会话里的 `subagent/descriptor` 描述，都没有则为空。
 */
function subagentNameOf(session, agent, subagents) {
  try {
    const names = subagents.namesOf(agent)
    if (names !== null && names !== undefined && typeof names.self === 'string' && names.self !== '') return names.self
  } catch {
    // 没有常驻激活时（例如一次性子代理已收尾）退回会话里的描述。
  }
  try {
    if (typeof session.snapshotEvents !== 'function' || typeof session.seq !== 'number' || session.seq <= 0) return ''
    const from = Math.max(0, session.seq - EVENT_SCAN)
    const events = session.snapshotEvents(from, session.seq)
    if (!Array.isArray(events)) return ''
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event === null || event === undefined || event.type !== 'subagent/descriptor') continue
      const label = event.data !== null && event.data !== undefined ? event.data.label : undefined
      if (typeof label === 'string' && label !== '') return label
    }
  } catch {
    // 读不到描述就算了，节点标题退回「子代理」。
  }
  return ''
}

/**
 * 自动收录的落点：普通会话写自己的文件；子代理的回合结束并入根会话的当前轮次，
 * 条目挂在「子代理(<名字>)」节点下，用户只需要看一个面板。
 * @param session - 回合结束的会话，可能是子代理。
 * @param agents - `agents` 服务，按会话取回代理。
 * @param subagents - `subagents` 服务，取根代理与名字。
 * @returns `{ session, name, subagent }`；解析失败时退回写自己的文件。
 */
export function memoCaptureTargetOf(session, agents, subagents) {
  const own = { session, name: '', subagent: false }
  try {
    if (session === null || session === undefined || typeof session.id !== 'string') return own
    const header = session.header
    if (header === null || header === undefined || header.origin !== 'subagent') return own
    if (agents === null || agents === undefined || subagents === null || subagents === undefined) return own
    if (typeof agents.get !== 'function' || typeof subagents.rootOf !== 'function') return own
    const agent = agents.get(session.id)
    if (agent === null || agent === undefined) return own
    const root = subagents.rootOf(agent)
    if (root === null || root === undefined || root === agent) return own
    const rootSession = root.session
    if (rootSession === null || rootSession === undefined || typeof rootSession.id !== 'string' || rootSession.id === '') return own
    return { session: rootSession, name: subagentNameOf(session, agent, subagents), subagent: true }
  } catch {
    return own
  }
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
  // 子代理收录需要按会话找回代理与根会话；服务缺席时退回各写各的文件。
  let agents
  try {
    agents = scope.get('agents')
  } catch {
    agents = undefined
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
    // 同上：`agents` 也要经 inject 才稳定可取，否则子代理收录会一直退回各写各的文件。
    disposers.push(scope.inject(['agents'], (injected) => {
      agents = injected.get('agents')
    }))
  }
  /** 每个会话最近一次捕获的签名：同一次回复只提取一次。 */
  const lastCapture = new Map()

  const logExtract = (message) => {    try {
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
        // 压缩等合成事件可能带 0 或负数轮次：不跳过，记一行日志后交给写入侧新开「(新一轮)」。
        if (turn < 1) logExtract('turn fallback: event=' + turn + ' | session=' + (typeof session.id === 'string' ? session.id : ''))
        const reply = lastAssistantText(session)
        if (reply === '') return
        // 子代理的收录并入根会话：轮次、提示词与清单都按根会话读，条目挂到「子代理(<名字>)」节点下。
        const target = memoCaptureTargetOf(session, agents, subagents)
        const targetSession = target.session
        const sessionId = targetSession !== null && targetSession !== undefined && typeof targetSession.id === 'string' ? targetSession.id : ''
        if (sessionId === '') return
        const label = target.subagent ? subagentMemoLabel(target.name) : ''
        const route = target.subagent ? ' | sub=' + (target.name === '' ? '?' : target.name) : ''
        const read = readTurn(targetSession)
        // 同一次回复可能被真实回合与压缩产生的合成事件各触发一次：按「轮次 + 回复特征」去重，避免重复提取。
        const signature = captureSignature(read.turn, reply, target.subagent ? target.name : '')
        if (lastCapture.get(sessionId) === signature) return
        if (lastCapture.size > 200) lastCapture.clear()
        lastCapture.set(sessionId, signature)
        const prompt = read.prompt
        void (async () => {
          let extracted = { items: [], resolved: [], duplicates: [], failure: '' }
          let raw = ''
          let failure = ''
          // 提取前先读一次未完成清单：它既喂给模型判断「哪些已经处理掉」，也是回写勾选时的白名单。
          // 子代理只提供自己的内容，不参与主会话条目的回收判断；主会话也不把子代理子树当候选。
          const open = target.subagent ? [] : openMemoItems(await readMemo(sessionId), { includeSubagents: false })
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
          // 规则兜底只在模型缺席、失败或返回空时使用：模型成功时以它的判断为准，
          // 否则回复里的卡片与清单会被无条件收录，把「我下一步要做什么」也带进面板。
          const extras = []
          if (settings.autoCallouts && (!settings.autoExtract || failure !== '')) {
            for (const callout of extractCallouts(reply)) extras.push({ text: callout.text, callout: callout.kind })
            for (const item of extractOpenItems(reply)) extras.push(item)
          }
          const rule = stripAssistantPlans(extras)
          if (rule.dropped.length > 0) {
            const shortDrop = rule.dropped.map((text) => String(text).replace(/\s+/g, ' ').slice(0, 40)).join(' | ').slice(0, 200)
            logExtract('skipped own-plan ' + rule.dropped.length + ' | ' + shortDrop + ' | session=' + sessionId + route)
          }
          const items = mergeMemoItems(extracted.items, rule.items)
          if (failure !== '') logExtract(failure + ' | items=' + items.length + ' | raw=' + String(raw).replace(/\s+/g, ' ').slice(0, 240) + ' | session=' + sessionId + route)
          if (items.length > 0) await addMemoItems(sessionId, { turn: read.turn, prompt, items, ...(label === '' ? {} : { parentText: label }) })
          if (label !== '' && items.length > 0) logExtract('subagent merged ' + items.length + ' item(s) | ' + label + route + ' | session=' + sessionId)
          // 日志里只放短引：压掉换行，避免一条日志被拆行或伪造字段。
          const shortList = (list) => list.map((text) => String(text).replace(/\s+/g, ' ').slice(0, 60)).join(' | ').slice(0, 200)
          const resolvedList = Array.isArray(extracted.resolved) ? extracted.resolved : []
          const duplicatesList = Array.isArray(extracted.duplicates) ? extracted.duplicates : []
          // 回收本轮处理掉的旧条目：严格匹配挑出 id，按 id 精确勾选，不做二次文本匹配。
          // 子代理的收录不参与：它的回复讲的是自己的活，不是主会话待办的完成证据。
          if (label === '' && settings.autoExtract && resolvedList.length > 0) {
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
          if (label === '' && settings.autoExtract && duplicatesList.length > 0) {
            const duplicateTargets = matchResolved(duplicatesList, open, STRICT_COVERAGE)
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
          // 它不受「自动提取」开关控制：确定性检查，不调用模型。子代理的条目不去动主会话的清单。
          if (label === '') {
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

