/**
 * 合并一轮里的多路来源条目：模型提取优先，callout 规则与清单规则补充。
 *
 * 去重按「规范化文本相似」判断：换行、空白、标点与 Markdown 记号都不参与比较；
 * 一边包含另一边算同一条；否则看较短文本的字符二元组有多少出现在较长文本里，
 * 两边点名了同一个对象时阈值宽松（换措辞的同一件事），没有共同点名对象时阈值严格
 * （避免把只差一个关键词的两条并成一条）。两边点名了不同对象时一律不算同一条。
 * 同一件事同时有平铺条目与带子任务的清单时以带子任务的为准，并把它挪到最早出现的重复位置。
 */
const STRIP = /[\s`*_~>#\-–—:：。，、,.;；!！?？"'“”‘’()（）[\]【】<>《》|\\/…+]/g
const QUOTED = /「([^」]{1,40})」|『([^』]{1,40})』|“([^”]{1,40})”|`([^`]{1,80})`/g
const MIN_OVERLAP = 8
const MIN_FUZZY = 12
/** 两边点名了同一对象：换措辞的同一件事，阈值宽松。 */
const FUZZY_SHARED = 0.62
/** 没有共同点名对象：只认几乎逐字相同的两条。 */
const FUZZY_PLAIN = 0.8
/** 自动勾选旧条目时更严：宁可漏勾，也不能错勾。 */
export const STRICT_COVERAGE = 0.88

/** 规范化文本：去掉空白、标点与 Markdown 记号，只留用来比较的内容。 */
export function normalizeMemoText(text) {
  return String(text).toLowerCase().replace(STRIP, '')
}

function bigrams(text) {
  const set = new Set()
  for (let index = 0; index < text.length - 1; index += 1) set.add(text.slice(index, index + 2))
  return set
}

/** 较短文本的字符二元组落在较长文本里的比例。 */
function coverage(shorter, longer) {
  const own = bigrams(shorter)
  if (own.size === 0) return 0
  const target = bigrams(longer)
  let hit = 0
  for (const gram of own) if (target.has(gram)) hit += 1
  return hit / own.size
}

/** 引号或代码记号里点名的对象，用来区分「同一个对象的两条说法」。 */
function quotedOf(text) {
  const found = []
  if (typeof text !== 'string' || text === '') return found
  QUOTED.lastIndex = 0
  let match = QUOTED.exec(text)
  while (match !== null) {
    const value = normalizeMemoText(match[1] ?? match[2] ?? match[3] ?? match[4] ?? '')
    if (value !== '') found.push(value)
    match = QUOTED.exec(text)
  }
  return found
}

/** 两条原文里的点名对象关系：`shared` 同一对象、`different` 不同对象、`unknown` 至少一边没点名。 */
function objectRelation(leftText, rightText) {
  const left = quotedOf(leftText)
  const right = quotedOf(rightText)
  if (left.length === 0 || right.length === 0) return 'unknown'
  const shared = left.some((mine) => right.some((other) => mine === other || mine.includes(other) || other.includes(mine)))
  return shared ? 'shared' : 'different'
}

/**
 * 判断两段规范化文本是不是同一条。
 * @param left - 已规范化的文本。
 * @param right - 已规范化的文本。
 * @param threshold - 模糊判定的覆盖比例下限。
 */
export function similarMemoText(left, right, threshold = FUZZY_PLAIN) {
  if (left === '' || right === '') return false
  if (left === right) return true
  const shorter = left.length <= right.length ? left : right
  const longer = left.length <= right.length ? right : left
  if (shorter.length >= MIN_OVERLAP && longer.includes(shorter)) return true
  if (shorter.length < MIN_FUZZY) return false
  return coverage(shorter, longer) >= threshold
}

/**
 * 按原文判断两条条目是不是同一条：先看点名的对象，再按对应阈值比对规范化文本。
 * @param leftText - 原文。
 * @param rightText - 原文。
 */
export function similarMemoItem(leftText, rightText) {
  if (typeof leftText !== 'string' || typeof rightText !== 'string') return false
  const relation = objectRelation(leftText, rightText)
  if (relation === 'different') return false
  const threshold = relation === 'shared' ? FUZZY_SHARED : FUZZY_PLAIN
  return similarMemoText(normalizeMemoText(leftText), normalizeMemoText(rightText), threshold)
}

/**
 * 给「把一段文本对齐到旧条目」打分，用于挑最佳命中，而不是先到先得。
 * @param oldText - 旧条目原文。
 * @param newText - 模型给出的文本。
 * @param threshold - 覆盖率门槛。
 * @returns `null` 表示不算同一条；否则 `{ rank, quality }`，rank 越大越优先（逐字 3 > 包含 2 > 模糊 1）。
 */
export function memoTextMatch(oldText, newText, threshold = STRICT_COVERAGE) {
  if (typeof oldText !== 'string' || typeof newText !== 'string') return null
  if (objectRelation(oldText, newText) === 'different') return null
  const oldKey = normalizeMemoText(oldText)
  const newKey = normalizeMemoText(newText)
  if (oldKey === '' || newKey === '') return null
  if (oldKey === newKey) return { rank: 3, quality: 1 }
  const shorter = oldKey.length <= newKey.length ? oldKey : newKey
  const longer = oldKey.length <= newKey.length ? newKey : oldKey
  if (shorter.length >= MIN_OVERLAP && longer.includes(shorter)) {
    return { rank: 2, quality: shorter.length / longer.length }
  }
  if (shorter.length < MIN_FUZZY) return null
  const ratio = coverage(shorter, longer)
  if (ratio < threshold) return null
  return { rank: 1, quality: ratio }
}

/**
 * 自动回收用的严格判定：只认「几乎逐字相同」或「点名同一对象的包含关系」。
 * 换措辞、只沾边的说法一律不算，漏勾可以接受，错勾不行。
 * @param leftText - 原文。
 * @param rightText - 原文。
 * @param threshold - 覆盖率门槛；自动回收传 0.8，跨轮取代沿用 0.88。
 */
export function similarMemoItemStrict(leftText, rightText, threshold = STRICT_COVERAGE) {
  if (typeof leftText !== 'string' || typeof rightText !== 'string') return false
  if (objectRelation(leftText, rightText) === 'different') return false
  const left = normalizeMemoText(leftText)
  const right = normalizeMemoText(rightText)
  if (left === '' || right === '') return false
  if (left === right) return true
  const shorter = left.length <= right.length ? left : right
  const longer = left.length <= right.length ? right : left
  if (shorter.length >= MIN_OVERLAP && longer.includes(shorter)) return true
  if (shorter.length < MIN_FUZZY) return false
  return coverage(shorter, longer) >= threshold
}

/**
 * 跨轮取代用的方向性判定：只有「新写法覆盖旧写法」才算取代。
 * 新写法更短、或只是旧写法的一部分时一律不算，避免用随手写的短版清掉细节待办。
 * @param oldText - 更早轮次的条目原文。
 * @param newText - 本轮写入的条目原文。
 */
export function supersedesMemoText(oldText, newText) {
  if (typeof oldText !== 'string' || typeof newText !== 'string') return false
  if (objectRelation(oldText, newText) === 'different') return false
  const oldKey = normalizeMemoText(oldText)
  const newKey = normalizeMemoText(newText)
  if (oldKey === '' || newKey === '') return false
  if (oldKey === newKey) return true
  if (newKey.length < oldKey.length) return false
  if (oldKey.length >= MIN_OVERLAP && newKey.includes(oldKey)) return true
  if (oldKey.length < MIN_FUZZY) return false
  return coverage(oldKey, newKey) >= STRICT_COVERAGE
}

/** 条目覆盖的可勾选单元数：叶子为 1，带子任务的累加，用来判断哪一条信息更全。 */
export function memoLeaves(node) {
  if (node === null || node === undefined) return 0
  const children = Array.isArray(node.children) ? node.children : []
  if (children.length === 0) return 1
  let total = 0
  for (const child of children) total += memoLeaves(child)
  return total
}

function isStructured(node) {
  return node !== null && node !== undefined && Array.isArray(node.children) && node.children.length > 0
}

/** 整棵树里所有叶子的原文；子任务可以是字符串。 */
function leafTexts(node, texts = []) {
  if (typeof node === 'string') {
    if (node !== '') texts.push(node)
    return texts
  }
  if (node === null || node === undefined) return texts
  const children = Array.isArray(node.children) ? node.children : []
  if (children.length === 0) {
    if (typeof node.text === 'string' && node.text !== '') texts.push(node.text)
    return texts
  }
  for (const child of children) leafTexts(child, texts)
  return texts
}

/** 新条目是否比已有条目更值得保留：带子任务的优先，再比可勾选单元数与文本长度。 */
export function richerMemoItem(candidate, existing) {
  const candidateStructured = isStructured(candidate)
  const existingStructured = isStructured(existing)
  if (candidateStructured !== existingStructured) return candidateStructured
  const candidateLeaves = memoLeaves(candidate)
  const existingLeaves = memoLeaves(existing)
  if (candidateLeaves !== existingLeaves) return candidateLeaves > existingLeaves
  return normalizeMemoText(candidate.text).length > normalizeMemoText(existing.text).length
}

/**
 * 以带子任务的条目为准：它的某个子任务已经以平铺条目收录过时，去掉那条平铺条目，
 * 并把带子任务的条目挪到最早那条重复的位置；被吸收条目带的 callout 类型转移到它身上。
 * 不修改入参：需要补 callout 时返回副本。
 * @param list - 同一轮的全部顶层条目。
 * @returns 吸收后的新数组（没有可吸收项时原样返回）。
 */
export function reconcileMemoNodes(list) {
  const nodes = Array.isArray(list) ? list : []
  const absorbBy = new Map()
  const calloutBy = new Map()
  nodes.forEach((node, nodeIndex) => {
    if (!isStructured(node)) return
    const texts = leafTexts(node)
    if (texts.length === 0) return
    nodes.forEach((other, index) => {
      if (index === nodeIndex || absorbBy.has(index) || isStructured(other)) return
      if (typeof other.text !== 'string' || other.text === '') return
      if (!texts.some((text) => similarMemoItem(text, other.text))) return
      absorbBy.set(index, nodeIndex)
      if (node.callout === undefined && other.callout !== undefined && calloutBy.get(nodeIndex) === undefined) {
        calloutBy.set(nodeIndex, other.callout)
      }
    })
  })
  if (absorbBy.size === 0) return nodes
  const moves = new Map()
  for (const [index, nodeIndex] of absorbBy) {
    const at = moves.get(nodeIndex)
    if (at === undefined || index < at) moves.set(nodeIndex, index)
  }
  const withCallout = (node, index) => {
    const callout = calloutBy.get(index)
    if (callout === undefined || node.callout !== undefined) return node
    return { ...node, callout }
  }
  const result = []
  const placed = new Set()
  nodes.forEach((node, index) => {
    if (absorbBy.has(index)) {
      for (const [nodeIndex, at] of moves) {
        if (at !== index || placed.has(nodeIndex)) continue
        result.push(withCallout(nodes[nodeIndex], nodeIndex))
        placed.add(nodeIndex)
      }
      return
    }
    if (moves.has(index)) {
      if (placed.has(index)) return
      result.push(withCallout(node, index))
      placed.add(index)
      return
    }
    result.push(node)
  })
  return result
}

/**
 * 合并条目。
 * @param primary - 模型提取的条目，保持原顺序。
 * @param extras - 规则提取的条目，按顺序追加。
 * @param limit - 顶层条目上限；不传表示不截断，数量由提示词控制。
 * @returns 合并后的条目数组。
 */
export function mergeMemoItems(primary, extras, limit = Number.POSITIVE_INFINITY) {
  const merged = []
  const push = (item) => {
    if (item === null || item === undefined || typeof item.text !== 'string') return
    if (normalizeMemoText(item.text) === '') return
    const at = merged.findIndex((existing) => similarMemoItem(existing.text, item.text))
    if (at < 0) {
      merged.push(item)
      return
    }
    const kept = merged[at]
    if (richerMemoItem(item, kept)) {
      const replacement = { ...item }
      if (replacement.callout === undefined && kept.callout !== undefined) replacement.callout = kept.callout
      merged[at] = replacement
      return
    }
    if (kept.callout === undefined && item.callout !== undefined) merged[at] = { ...kept, callout: item.callout }
  }
  for (const item of Array.isArray(primary) ? primary : []) push(item)
  for (const item of Array.isArray(extras) ? extras : []) push(item)
  return reconcileMemoNodes(merged).slice(0, limit)
}
