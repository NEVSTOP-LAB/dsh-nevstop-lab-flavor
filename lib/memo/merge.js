/**
 * 合并一轮里的多路来源条目：模型提取优先，callout 规则与清单规则补充。
 *
 * 去重按「规范化文本互相包含」判断：换行、空白、标点与 Markdown 记号都不参与比较，
 * 一边包含另一边即视为同一条，避免同一句话换个说法重复进面板。
 */
const STRIP = /[\s`*_~>#\-–—:：。，、,.;；!！?？"'“”‘’()（）[\]【】<>《》|\\/…+]/g
const MIN_OVERLAP = 8

function normalize(text) {
  return String(text).toLowerCase().replace(STRIP, '')
}

function overlaps(left, right) {
  if (left === '' || right === '') return false
  if (left === right) return true
  const shorter = left.length <= right.length ? left : right
  const longer = left.length <= right.length ? right : left
  return shorter.length >= MIN_OVERLAP && longer.includes(shorter)
}

/**
 * 合并条目。
 * @param primary - 模型提取的条目，保持原顺序。
 * @param extras - 规则提取的条目，按顺序追加。
 * @param limit - 顶层条目上限；超出部分丢弃。
 * @returns 合并后的条目数组。
 */
export function mergeMemoItems(primary, extras, limit = 16) {
  const merged = []
  const keys = []
  const push = (item) => {
    if (item === null || item === undefined || typeof item.text !== 'string') return false
    const key = normalize(item.text)
    if (key === '') return false
    if (keys.some((existing) => overlaps(existing, key))) return false
    keys.push(key)
    merged.push(item)
    return true
  }
  for (const item of Array.isArray(primary) ? primary : []) {
    push(item)
    if (merged.length >= limit) return merged
  }
  for (const item of Array.isArray(extras) ? extras : []) {
    push(item)
    if (merged.length >= limit) return merged
  }
  return merged
}
