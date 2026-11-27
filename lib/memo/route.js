/**
 * 备忘录 HTTP 路由：面板读取与勾选。
 *
 * - `GET  /__dsh-nevstop-lab-flavor/memo?session=<id>` 返回整份文档与计数；
 * - `POST /__dsh-nevstop-lab-flavor/memo` 接受 `toggle` 与 `copy`；
 * - 写入要求同源；读取不设限（与 config 路由一致）；
 * - 任何异常都收敛成 JSON 错误，处理器本身不会抛到宿主。
 */
import { copyMemo, readMemo, countMemo, toggleMemoItem } from './store.js'

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

function sameOrigin(req) {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return false
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
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
      const result = await toggleMemoItem(body.session, body.itemId, body.childId)
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
