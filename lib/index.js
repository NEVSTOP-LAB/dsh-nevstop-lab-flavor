/**
 * Host 半边：为 NEVSTOP-LAB 定制口味插件提供配置读写。
 *
 * - 路由 `GET/POST /__dsh-nevstop-lab-flavor/config`；
 * - 路由 `GET /__dsh-nevstop-lab-flavor/machine`：本机标识，浏览器侧取不到主机名；
 * - 配置存 `$DSH_HOME/plugin-data/dsh-nevstop-lab-flavor/config.json`（默认 `~/.dsh/...`）；
 * - 写入要求同源请求，读取不设限；
 * - 校验是「总量式」的：任何缺字段、手改坏值都回落到该字段默认值，绝不因配置把插件带崩。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { BalanceRingService } from './balance/index.js'
import { createUsageSampler } from './machine-usage.js'
import { CONFIG_PATH as BALANCE_CONFIG_PATH, handleConfigRequest as handleBalanceConfigRequest } from './balance/config.js'
import { MEMO_ROUTE, handleMemoRequest } from './memo/route.js'
import { mountMemo, setMemoSettings } from './memo/index.js'
import { DEFAULT_PROMPT as MEMO_DEFAULT_PROMPT } from './memo/extract.js'
import { arch, homedir, hostname, platform, release, userInfo } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-nevstop-lab-flavor'

/** Hard dependency: the HTTP carrier must exist before the route registers. */
export const inject = ['webServer']

export const ROUTE = '/__dsh-nevstop-lab-flavor/config'

export const MACHINE_ROUTE = '/__dsh-nevstop-lab-flavor/machine'

export const KEY_BEHAVIORS = ['newline', 'queue', 'steer']

export const DOUBLE_CLICK_ACTIONS = ['append', 'menu', 'copy', 'none']

export const DEFAULTS = {
  features: {
    providerLabel: true,
    composerKeys: true,
    sidebarPanels: true,
    balanceChip: true,
    activeSessions: true,
    busyWorkspaceCompat: true,
    defaultModel: true,
    machineBadge: true,
    queueDock: true,
    memo: true,
  },
  composerKeys: {
    enter: 'newline',
    ctrlEnter: 'queue',
    shiftEnter: 'newline',
    altEnter: 'steer',
  },
  activeSessions: {
    windowHours: 12,
    fallbackCount: 5,
  },
  dashboard: {
    rows: 2,
    columns: 2,
    scale: 90,
  },
  defaultModel: {
    provider: '',
    model: '',
    reasoningEffort: '',
  },
  memo: {
    injectPrompt: true,
    autoCallouts: true,
    autoExtract: true,
    extractProvider: '',
    extractModel: '',
    extractPrompt: '',
    doubleClick: 'menu',
  },
  machine: {
    label: '',
  },
}

const LIMIT = 8192

function configFile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'plugin-data', 'dsh-nevstop-lab-flavor', 'config.json')
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function behavior(value, fallback) {
  return KEY_BEHAVIORS.includes(value) ? value : fallback
}

function count(value, fallback, min, max) {
  if (value === null || value === undefined || value === '') return fallback
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

function text(value, fallback) {
  return typeof value === 'string' ? value.trim() : fallback
}

function doubleClick(value, fallback) {
  return DOUBLE_CLICK_ACTIONS.includes(value) ? value : fallback
}

/** Coerce any stored value into a complete, valid config. */
export function normalizeConfig(raw) {
  const src = raw !== null && typeof raw === 'object' ? raw : {}
  const features = src.features !== null && typeof src.features === 'object' ? src.features : {}
  const keys = src.composerKeys !== null && typeof src.composerKeys === 'object' ? src.composerKeys : {}
  const active = src.activeSessions !== null && typeof src.activeSessions === 'object' ? src.activeSessions : {}
  const dashboard = src.dashboard !== null && typeof src.dashboard === 'object' ? src.dashboard : {}
  const fixModel = src.defaultModel !== null && typeof src.defaultModel === 'object' ? src.defaultModel : {}
  const memo = src.memo !== null && typeof src.memo === 'object' ? src.memo : {}
  const machine = src.machine !== null && typeof src.machine === 'object' ? src.machine : {}
  return {
    features: {
      providerLabel: bool(features.providerLabel, DEFAULTS.features.providerLabel),
      composerKeys: bool(features.composerKeys, DEFAULTS.features.composerKeys),
      sidebarPanels: bool(features.sidebarPanels, DEFAULTS.features.sidebarPanels),
      balanceChip: bool(features.balanceChip, DEFAULTS.features.balanceChip),
      activeSessions: bool(features.activeSessions, DEFAULTS.features.activeSessions),
      busyWorkspaceCompat: bool(features.busyWorkspaceCompat, DEFAULTS.features.busyWorkspaceCompat),
      defaultModel: bool(features.defaultModel, DEFAULTS.features.defaultModel),
      machineBadge: bool(features.machineBadge, DEFAULTS.features.machineBadge),
      queueDock: bool(features.queueDock, DEFAULTS.features.queueDock),
      memo: bool(features.memo, DEFAULTS.features.memo),
    },
    composerKeys: {
      enter: behavior(keys.enter, DEFAULTS.composerKeys.enter),
      ctrlEnter: behavior(keys.ctrlEnter, DEFAULTS.composerKeys.ctrlEnter),
      shiftEnter: behavior(keys.shiftEnter, DEFAULTS.composerKeys.shiftEnter),
      altEnter: behavior(keys.altEnter, DEFAULTS.composerKeys.altEnter),
    },
    activeSessions: {
      windowHours: count(active.windowHours, DEFAULTS.activeSessions.windowHours, 1, 168),
      fallbackCount: count(active.fallbackCount, DEFAULTS.activeSessions.fallbackCount, 1, 50),
    },
    dashboard: {
      rows: count(dashboard.rows, DEFAULTS.dashboard.rows, 1, 4),
      columns: count(dashboard.columns, DEFAULTS.dashboard.columns, 1, 4),
      scale: count(dashboard.scale, DEFAULTS.dashboard.scale, 50, 100),
    },
    defaultModel: {
      provider: text(fixModel.provider, DEFAULTS.defaultModel.provider),
      model: text(fixModel.model, DEFAULTS.defaultModel.model),
      reasoningEffort: text(fixModel.reasoningEffort, DEFAULTS.defaultModel.reasoningEffort),
    },
    memo: {
      injectPrompt: bool(memo.injectPrompt, DEFAULTS.memo.injectPrompt),
      autoCallouts: bool(memo.autoCallouts, DEFAULTS.memo.autoCallouts),
      autoExtract: bool(memo.autoExtract, DEFAULTS.memo.autoExtract),
      extractProvider: text(memo.extractProvider, DEFAULTS.memo.extractProvider),
      extractModel: text(memo.extractModel, DEFAULTS.memo.extractModel),
      extractPrompt: typeof memo.extractPrompt === 'string' ? memo.extractPrompt : DEFAULTS.memo.extractPrompt,
      doubleClick: doubleClick(memo.doubleClick, DEFAULTS.memo.doubleClick),
    },
    machine: {
      label: text(machine.label, DEFAULTS.machine.label),
    },
  }
}

export async function readConfig() {
  let config
  try {
    const raw = await readFile(configFile(), 'utf8')
    config = normalizeConfig(JSON.parse(raw))
  } catch {
    config = normalizeConfig(DEFAULTS)
  }
  setMemoSettings(config)
  return config
}

export async function writeConfig(value) {
  const config = normalizeConfig(value)
  const file = configFile()
  await mkdir(dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  await writeFile(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8')
  await rename(tmp, file)
  setMemoSettings(config)
  return config
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let text = ''
    req.on('data', (chunk) => {
      text += chunk
      if (text.length > LIMIT) {
        reject(new Error('too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(text))
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function sameOrigin(req) {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return false
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

export async function handleConfigRequest(req, res) {
  try {
    if (req.method === 'GET' || req.method === 'HEAD') {
      sendJson(res, 200, { ok: true, config: await readConfig(), memoDefaults: { prompt: MEMO_DEFAULT_PROMPT } })
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, HEAD, POST' })
      res.end()
      return
    }
    if (!sameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: 'same-origin request required' })
      return
    }
    const text = await readBody(req)
    let parsed = {}
    try {
      parsed = JSON.parse(text || '{}')
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid json' })
      return
    }
    sendJson(res, 200, { ok: true, config: await writeConfig(parsed) })
  } catch {
    sendJson(res, 400, { ok: false, error: 'bad request' })
  }
}

/**
 * 本机标识：主机名、登录用户、平台与 DSH 版本。
 * 浏览器侧取不到这些值——远程访问时 location.host 是隧道地址或 127.0.0.1——所以由 Host 提供。
 */
let cachedDshVersion = null

async function readDshVersion() {
  if (cachedDshVersion !== null) return cachedDshVersion
  cachedDshVersion = ''
  try {
    const dir = process.env.DSH_INSTALL_DIR
    if (typeof dir === 'string' && dir !== '') {
      const raw = await readFile(join(dir, 'package.json'), 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed.version === 'string') cachedDshVersion = parsed.version.trim()
    }
  } catch {
    // 读不到版本时留空，界面省略这一项，其余信息照常显示。
  }
  return cachedDshVersion
}

/** CPU / 内存采样器：只在收到请求时算一次，最短 1 秒复用一次结果。 */
const usageSampler = createUsageSampler()

export async function machineInfo(config) {
  let username = ''
  try {
    username = userInfo().username
  } catch {
    // 取不到用户名时留空。
  }
  const label = config !== null && config !== undefined && config.machine !== null && config.machine !== undefined ? config.machine.label : ''
  return {
    hostname: hostname(),
    username,
    platform: platform(),
    release: release(),
    arch: arch(),
    version: await readDshVersion(),
    label: text(label, ''),
    usage: await usageSampler.read(),
  }
}

export async function handleMachineRequest(req, res) {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }
    sendJson(res, 200, { ok: true, machine: await machineInfo(await readConfig()) })
  } catch {
    sendJson(res, 500, { ok: false })
  }
}

export function apply(ctx) {
  ctx.plugin(BalanceRingService)
  // 启动时同步一次开关；失败只影响备忘录功能，插件其余部分照常。
  void readConfig().catch(() => {})
  ctx.inject(['tools', 'systemPrompt'], (scope) => {
    mountMemo(scope)
  })
  ctx.inject(['webServer'], (scope) => {
    const webServer = scope.get('webServer')
    scope.effect(
      () => webServer.register({ kind: 'exact', path: ROUTE, handler: handleConfigRequest }),
      'dsh-nevstop-lab-flavor: config route',
    )
    scope.effect(() => webServer.register({ kind: 'exact', path: MACHINE_ROUTE, handler: handleMachineRequest }), 'dsh-nevstop-lab-flavor: machine route')
    scope.effect(() => webServer.register({ kind: 'exact', path: BALANCE_CONFIG_PATH, handler: handleBalanceConfigRequest }), 'dsh-nevstop-lab-flavor: balance config route')
    scope.effect(() => webServer.register({ kind: 'exact', path: MEMO_ROUTE, handler: handleMemoRequest }), 'dsh-nevstop-lab-flavor: memo route')
  })
}

