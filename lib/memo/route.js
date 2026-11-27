/**
 * 备忘录 HTTP 路由：面板读取与勾选。
 *
 * - `GET  /__dsh-nevstop-lab-flavor/memo?session=<id>` 返回整份文档与计数；
 * - `POST /__dsh-nevstop-lab-flavor/memo` 接受 `toggle` 与 `copy`；
 * - 写入要求同源；读取不设限（与 config 路由一致）；
 * - 任何异常都收敛成 JSON 错误，处理器本身不会抛到宿主。
 */
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { copyMemo, readMemo, countMemo, toggleMemoNode, memoRoot } from './store.js'

export const MEMO_ROUTE = '/__dsh-nevstop-lab-flavor/memo'

const LIMIT = 65536

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

/**
 * 同源判定：浏览器会带上 `Sec-Fetch-Site`；经反向代理/隧道访问时 `Origin` 域名
 * 与宿主收到的 `Host` 并不相等。因此依次接受：浏览器同源/同站标记、缺省或不透明来源、
 * `Origin` 与 `Host`/`X-Forwarded-Host` 相符。带外部 `Origin` 的跨站请求仍然被拒。
 */
function sameOrigin(req) {
  const site = req.headers['sec-fetch-site']
  if (site === 'same-origin' || site === 'same-site' || site === 'none') return true
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return true
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  // Electron 桌面端的渲染进程以 file://（或 app: 一类自定义协议）加载，经 IPC 桥发请求。
  // 这类来源只可能来自本机外壳，跨站网页始终是 http(s) 来源。
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true
  const forwarded = typeof req.headers['x-forwarded-host'] === 'string' ? req.headers['x-forwarded-host'].split(',')[0].trim() : ''
  return [req.headers.host, forwarded].some((value) => typeof value === 'string' && value !== '' && value === parsed.host)
}

/** 记录被拒请求的关键头，便于排查访问链路；失败不影响响应。 */
function logRejection(req) {
  try {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      origin: req.headers.origin,
      host: req.headers.host,
      forwarded: req.headers['x-forwarded-host'],
      site: req.headers['sec-fetch-site'],
      userAgent: req.headers['user-agent'],
      referer: req.headers.referer,
    })
    void appendFile(join(memoRoot(), '_origin.log'), line + '\n', 'utf8').catch(() => {})
  } catch {
    // 诊断日志失败不影响请求处理。
  }
}

function sessionOf(url) {
  const value = url.searchParams.get('session')
  return typeof value === 'string' ? value : ''
}

export async function handleMemoRequest(req, res) {
  try {
    const url = new URL(req.url || '/', 'http://localhost')
    if (req.method === 'GET' || req.method === 'HEAD') {
      const sessionId = sessionOf(url)
      const doc = await readMemo(sessionId)
      sendJson(res, 200, { ok: true, doc, counts: countMemo(doc) })
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, HEAD, POST' })
      res.end()
      return
    }
    if (!sameOrigin(req)) {
      logRejection(req)
      sendJson(res, 403, { ok: false, error: 'same-origin request required' })
      return
    }
    const raw = await readBody(req)
    let parsed = {}
    try {
      parsed = JSON.parse(raw || '{}')
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid json' })
      return
    }
    const body = parsed !== null && typeof parsed === 'object' ? parsed : {}
    if (body.op === 'toggle') {
      const result = await toggleMemoNode(body.session, body.nodeId)
      sendJson(res, result.ok === false ? 400 : 200, result)
      return
    }
    if (body.op === 'copy') {
      const result = await copyMemo(body.from, body.to)
      sendJson(res, result.ok === false ? 400 : 200, result)
      return
    }
    sendJson(res, 400, { ok: false, error: 'unknown op' })
  } catch {
    sendJson(res, 500, { ok: false, error: 'memo request failed' })
  }
}
