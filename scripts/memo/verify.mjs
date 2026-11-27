#!/usr/bin/env node
/**
 * 备忘录存储校验：新增、去重、父子推导、勾选、分叉复制、坏文件恢复与路径校验。
 *
 * 只依赖 Node 内置模块，在 `.tmp/memo-verify` 下自建 `DSH_HOME`，跑完清理。
 * 任何断言失败打印 `memo verify: <原因>` 并以退出码 1 结束；全部通过输出一行 `memo verified`。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addMemoItems, copyMemo, countMemo, readMemo, toggleMemoNode, writeMemo, memoRoot } from '../../lib/memo/store.js'
import { extractCallouts } from '../../lib/memo/callouts.js'
import { parseExtraction } from '../../lib/memo/extract.js'
import { orderByAppearance } from '../../lib/memo/extract.js'

const home = join(process.cwd(), '.tmp', 'memo-verify')
rmSync(home, { recursive: true, force: true })
mkdirSync(home, { recursive: true })
process.env.DSH_HOME = home

const session = 'sess-abc'
const failures = []
const check = (value, message) => {
  if (!value) failures.push(message)
}

try {
  const first = await addMemoItems(session, {
    turn: 1,
    prompt: '第一轮提示词',
    items: [
      { text: '补齐 CHANGELOG', children: ['写明默认值', '补一条示例'] },
      { text: '检查文档链接' },
      { text: '补齐 CHANGELOG' },
    ],
  })
  check(first.added === 2, '新增两条')
  check(first.skipped === 1, '同轮去重')
  check(first.total === 3, '子任务计入、父项不重复计入')
  check(first.unfinished === 3, '初始全部未完成')
  check(first.doc.groups.length === 1, '同轮归入一个分组')

  const again = await addMemoItems(session, { turn: 1, prompt: '第一轮提示词', items: [{ text: '检查文档链接' }] })
  check(again.added === 0 && again.skipped === 1, '跨调用去重')

  const parent = again.doc.groups[0].items.find((item) => item.children.length > 0)
  check(parent !== undefined, '子任务父项存在')
  if (parent !== undefined) {
    await toggleMemoNode(session, parent.children[0].id)
    const afterFirst = await readMemo(session)
    const parentFirst = afterFirst.groups[0].items.find((item) => item.id === parent.id)
    check(parentFirst !== undefined && parentFirst.done === false, '子任务未全勾时父项未完成')
    await toggleMemoNode(session, parent.children[1].id)
    const afterAll = await readMemo(session)
    const parentAfter = afterAll.groups[0].items.find((item) => item.id === parent.id)
    check(parentAfter !== undefined && parentAfter.done === true, '子任务全勾后父项完成')

    // 父项点击只做「全部标记完成」，不反向取消
    await toggleMemoNode(session, parent.children[0].id)
    const beforeBulk = await readMemo(session)
    const beforeBulkItem = beforeBulk.groups[0].items.find((item) => item.id === parent.id)
    check(beforeBulkItem !== undefined && beforeBulkItem.done === false, '取消一个子任务后父项回到未完成')
    const parentBulk = await toggleMemoNode(session, parent.id)
    check(parentBulk.ok === true, '父项可批量标记')
    const afterBulk = await readMemo(session)
    const afterBulkItem = afterBulk.groups[0].items.find((item) => item.id === parent.id)
    check(
      afterBulkItem !== undefined && afterBulkItem.done === true && afterBulkItem.children.every((child) => child.done === true),
      '父项点击把所有子任务标为完成',
    )
    await toggleMemoNode(session, parent.id)
    const afterBulkAgain = await readMemo(session)
    const afterBulkAgainItem = afterBulkAgain.groups[0].items.find((item) => item.id === parent.id)
    check(
      afterBulkAgainItem !== undefined && afterBulkAgainItem.children.every((child) => child.done === true),
      '再次点击不会取消已完成的子任务',
    )
  }

  const bread = await readMemo(session)
  const leaf = bread.groups[0].items.find((item) => item.children.length === 0)
  check(leaf !== undefined, '独立条目存在')
  if (leaf !== undefined) {
    const leafToggle = await toggleMemoNode(session, leaf.id)
    check(leafToggle.ok === true, '叶子条目可勾选')
  }

  const deep = await addMemoItems('sess-deep', {
    turn: 1,
    prompt: 'p',
    items: [{ text: '一级', children: [{ text: '二级', children: [{ text: '三级' }] }] }],
  })
  check(deep.added === 1 && deep.total === 1, '多层级条目只统计最深一层叶子')
  const deepDoc = await readMemo('sess-deep')
  const level3 = deepDoc.groups[0].items[0].children[0].children[0]
  await toggleMemoNode('sess-deep', level3.id)
  const afterDeep = await readMemo('sess-deep')
  const rootDeep = afterDeep.groups[0].items[0]
  check(rootDeep.done === true && rootDeep.children[0].done === true, '最深一层完成后逐级向上推导')

  const copied = await copyMemo(session, 'sess-fork')
  check(copied.ok === true && copied.copied === true, '分叉复制')
  check(copied.doc.sessionId === 'sess-fork', '复制后改写会话标识')
  const copyAgain = await copyMemo(session, 'sess-fork')
  check(copyAgain.copied === false, '分叉复制幂等')

  writeFileSync(join(memoRoot(), session + '.json'), '{ not json', 'utf8')
  const broken = await readMemo(session)
  check(broken.groups.length === 0, '坏文件按空文档读取')
  const recovered = await addMemoItems(session, { turn: 2, prompt: '第二轮', items: [{ text: '恢复后仍可写入' }] })
  check(recovered.added === 1, '坏文件之后仍可写入')

  const counts = countMemo(recovered.doc)
  check(counts.total === recovered.total, '计数与工具结果一致')

  const traversal = await readMemo('../escape')
  check(traversal.groups.length === 0, '非法会话标识读取为空')
  const writeRejected = await writeMemo('../escape', { groups: [] }).then(() => false, () => true)
  check(writeRejected, '非法会话标识写入被拒')

  const callouts = extractCallouts([    '今天改完了。',
    '',
    '> [!WARNING]',
    '> 升级前先备份 profile。',
    '> 第二步再刷新页面。',
    '',
    '> 普通引用不算 callout。',
    '',
    '> [!NOTE]',
    '> 记得跑 check。',
  ].join('\n'))
  check(callouts.length === 2, '只提取 callout 块')
  check(callouts[0] !== undefined && callouts[0].kind === 'WARNING', '识别 callout 类型')
  check(callouts[0] !== undefined && callouts[0].text.includes('升级前先备份 profile'), '合并标题与正文')
  check(callouts[0] !== undefined && callouts[0].text.includes('第二步再刷新页面'), '合并多行正文')
  check(extractCallouts('没有 callout 的正文') .length === 0, '无 callout 时为空')

  const withCallout = await addMemoItems('sess-callout', {
    turn: 1,
    prompt: 'p',
    items: [{ text: '备份后再升级', callout: 'WARNING' }, { text: '普通条目', callout: 'bogus' }],
  })
  check(withCallout.added === 2, '带 callout 的条目可写入')
  const storedCallouts = (await readMemo('sess-callout')).groups[0].items
  check(storedCallouts[0] !== undefined && storedCallouts[0].callout === 'WARNING', 'callout 类型持久化')
  check(storedCallouts[1] !== undefined && storedCallouts[1].callout === undefined, '未知 callout 被忽略')

  const extracted = parseExtraction('Sure:\n{"items":[{"text":"备份后再升级","callout":"warning","children":["导出配置"]},{"text":""}]}\nDone')
  check(extracted.length === 1, '提取器忽略空条目')
  check(extracted[0] !== undefined && extracted[0].callout === 'WARNING', '提取器规范化 callout 类型')
  check(extracted[0] !== undefined && Array.isArray(extracted[0].children) && extracted[0].children[0].text === '导出配置', '提取器保留子任务')
  const nested = parseExtraction('{"items":[{"text":"一级","children":[{"text":"二级","children":["三级"]}]}]}')
  check(
    nested[0] !== undefined && nested[0].children[0].children[0].text === '三级',
    '提取器保留多层级子任务',
  )
  check(parseExtraction('no json here').length === 0, '提取器无 JSON 时为空')
  const many = parseExtraction('{"items":[{"text":"a"},{"text":"b"},{"text":"c"},{"text":"d"},{"text":"e"},{"text":"f"},{"text":"g"}]}')
  check(many.length === 6, '提取器限制条目数量')

  const ordered = orderByAppearance([{ text: 'C' }, { text: 'A' }, { text: 'B' }], '先做 A，然后 B，最后 C。')
  check(ordered.map((item) => item.text).join('') === 'ABC', '按文中首次出现位置排序')
  const paraphrased = orderByAppearance([{ text: '乙' }, { text: '甲' }], '甲 与 乙')
  check(paraphrased[0].text === '甲', '能定位原文时排序')
  const unfindable = orderByAppearance([{ text: '不存在' }, { text: '甲' }], '甲')
  check(unfindable[0].text === '不存在', '无法定位时保持模型顺序')
} finally {
  rmSync(home, { recursive: true, force: true })
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`memo verify: ${failure}`)
  process.exit(1)
}
console.log('memo verified')
