#!/usr/bin/env node
/**
 * 备忘录存储校验：新增、去重、父子推导、勾选、分叉复制、坏文件恢复与路径校验。
 *
 * 只依赖 Node 内置模块，在 `.tmp/memo-verify` 下自建 `DSH_HOME`，跑完清理。
 * 任何断言失败打印 `memo verify: <原因>` 并以退出码 1 结束；全部通过输出一行 `memo verified`。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addMemoItems, captureSignature, copyMemo, countMemo, dedupeMemoItems, emptyMemo, flattenMemoItems, openMemoItems, readExtractLog, readMemo, resolveMemoItems, toggleMemoNode, updateMemoItems, writeMemo, memoRoot } from '../../lib/memo/store.js'
import { extractCallouts } from '../../lib/memo/callouts.js'
import { parseExtraction } from '../../lib/memo/extract.js'
import { extractionInput, matchResolved, parseExtractionResult } from '../../lib/memo/extract.js'
import { readTurn } from '../../lib/memo/turn.js'
import { DEFAULT_PROMPT as MEMO_DEFAULT_PROMPT } from '../../lib/memo/extract.js'
import { MEMO_PROMPT } from '../../lib/memo/prompt.js'
import { similarMemoItemStrict, supersedesMemoText } from '../../lib/memo/merge.js'
import { collectText } from '../../lib/memo/extract.js'
import { orderByAppearance } from '../../lib/memo/extract.js'
import { extractOpenItems } from '../../lib/memo/openitems.js'
import { mergeMemoItems } from '../../lib/memo/merge.js'
import { createMemoReadTool, createMemoUpdateTool } from '../../lib/memo/tool.js'

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

    // 父项点击整组切换：未全完成时全部标记完成，已全完成时全部取消
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
    const parentClear = await toggleMemoNode(session, parent.id)
    check(parentClear.ok === true, '已完成父项仍可点击')
    const afterClear = await readMemo(session)
    const afterClearItem = afterClear.groups[0].items.find((item) => item.id === parent.id)
    check(
      afterClearItem !== undefined && afterClearItem.done === false && afterClearItem.children.every((child) => child.done === false),
      '再次点击父项把所有子任务取消完成',
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
  const fiveCallouts = extractCallouts(
    ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'].map((kind) => `> [!${kind}]\n> ${kind} 正文`).join('\n\n'),
  )
  check(fiveCallouts.length === 5, '五张 callout 全部收录且不截断')
  const twelveCallouts = extractCallouts(
    Array.from({ length: 12 }, (_, index) => `> [!NOTE]\n> 第 ${index + 1} 张`).join('\n\n'),
  )
  check(twelveCallouts.length === 12, 'callout 不按张数截断')
  const manyBullets = extractOpenItems(
    '下一步：\n\n' + Array.from({ length: 12 }, (_, index) => `- 第 ${index + 1} 项`).join('\n'),
  )
  check(manyBullets[0] !== undefined && manyBullets[0].children.length === 12, '清单不按条数截断')
  const seventyBullets = extractOpenItems(
    '下一步：\n\n' + Array.from({ length: 70 }, (_, index) => `- 第 ${index + 1} 项`).join('\n'),
  )
  check(seventyBullets[0] !== undefined && seventyBullets[0].children.length === 70, '清单扫描不按行数截断')
  const thirtyChildren = await addMemoItems('sess-many-children', {
    turn: 1,
    prompt: 'p',
    items: [{ text: '一大批子任务', children: Array.from({ length: 30 }, (_, index) => `第 ${index + 1} 个子任务`) }],
  })
  check(thirtyChildren.doc.groups[0].items[0].children.length === 30, '子任务不按条数截断')

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
  check(many.length === 7, '提取器不再截断七条')

  const withResolved = parseExtractionResult(
    '{"items":[{"text":"还有一项没测"}],"resolved":["刷新页面手测自动收起","完全无关的一条"]}',
  )
  check(withResolved.items.length === 1, '提取结果保留新条目')
  check(withResolved.resolved.length === 2, '提取结果带出已处理条目')
  check(parseExtractionResult('{"items":[]}').resolved.length === 0, '没有 resolved 字段时为空')
  check(parseExtractionResult('{"items":[]}').duplicates.length === 0, '没有 duplicates 字段时为空')
  const withDuplicates = parseExtractionResult('{"items":[],"resolved":[],"duplicates":["待你处理的仍是两件"]}')
  check(withDuplicates.duplicates.length === 1, '提取结果带出重复条目')
  check(MEMO_DEFAULT_PROMPT.includes('## 去重'), '提取指令含去重段')
  const duplicateTargets = matchResolved(
    ['待你处理的仍是两件'],
    [{ id: 'm_dup_fixture', turn: 11, text: '待你处理的仍是两件' }],
  )
  check(duplicateTargets.length === 1 && duplicateTargets[0].id === 'm_dup_fixture', '重复条目对齐到真实条目 id')
  const doubleResolve = await addMemoItems('sess-double-resolve', { turn: 1, prompt: 'p', items: [{ text: '同一件事的旧条目' }] })
  const doubleOpen = openMemoItems(doubleResolve.doc)
  const firstResolve = await resolveMemoItems('sess-double-resolve', { ids: doubleOpen.map((item) => item.id) })
  const secondResolve = await resolveMemoItems('sess-double-resolve', { ids: doubleOpen.map((item) => item.id) })
  check(firstResolve.updated === 1 && secondResolve.updated === 0 && secondResolve.openTotal === 0, '同一 id 被重复勾选是幂等的')

  const openForInput = Array.from({ length: 25 }, (_, index) => ({ turn: index + 1, text: `未完成条目 ${index + 1}` }))
  const withOpen = extractionInput('这轮的提示', '回复正文', openForInput)
  check(withOpen.includes('Open memo items in this session'), '提取输入带未完成清单')
  check(withOpen.includes('[1] 未完成条目 1'), '未完成清单带轮次')
  check(withOpen.includes('未完成条目 25'), '未完成清单不按条数截断')
  const longReply = 'A'.repeat(20000) + 'TAIL_MARKER'
  const oversized = extractionInput('提示', longReply, openForInput)
  check(oversized.includes('TAIL_MARKER'), '长回复保留结尾内容')
  check(oversized.includes('…'), '长回复中间用省略号连接')
  check(oversized.includes('Open memo items in this session'), '长回复下未完成清单仍在')

  const matchedResolved = matchResolved(
    ['刷新页面手测自动收起', '完全无关的一条'],
    [{ id: 'm_fixture', turn: 2, text: '刷新页面手测自动收起（面板是否收起）' }],
  )
  check(matchedResolved.length === 1 && matchedResolved[0].text.includes('刷新页面手测自动收起'), '已处理条目对齐到真实未完成条目')
  check(typeof matchedResolved[0].id === 'string' && matchedResolved[0].id !== '', '对齐结果带条目 id')

  check(
    similarMemoItemStrict('刷新页面手测自动收起', '刷新页面手测自动收起（面板是否收起）'),
    '严格判定接受包含关系',
  )
  check(
    !similarMemoItemStrict(
      '托盘「启动网关」尚未自动拉起网页视图，现在是两步',
      '托盘「启动网关」没有自动拉起网页视图，目前是两步操作。',
    ),
    '严格判定不接受换措辞',
  )
  check(
    !similarMemoItemStrict(
      'job 的 run.jsonl 现在是历史快照，不是运行中的实时事件流；要直播需接 /run/<id>/events',
      'job 的 run.jsonl 现在是历史快照，不是运行中的实时事件流（插件的 /run/<id>/events 已经有了，没接进 job 落盘）。',
    ),
    '严格判定不接受覆盖率不足的改写',
  )
  check(similarMemoItemStrict('备份后再升级。', '备份后再升级'), '严格判定接受逐字相同')
  check(supersedesMemoText('备份后再升级。', '备份后再升级'), '跨轮取代接受逐字相同')
  check(
    supersedesMemoText('备份 profile 并导出配置，升级后刷新页面', '备份 profile 并导出配置，升级后刷新页面并验证'),
    '跨轮取代接受信息更多的写法',
  )
  check(
    !supersedesMemoText('托盘「启动网关」要手动点，没有开机自启', '托盘「打开网页视图」要手动点，没有开机自启'),
    '点名不同对象时即使更长也不取代',
  )
  const strictMiss = matchResolved(
    ['托盘「启动网关」没有自动拉起网页视图，目前是两步操作。'],
    [{ id: 'm_fixture2', turn: 1, text: '托盘「启动网关」尚未自动拉起网页视图，现在是两步' }],
  )
  check(strictMiss.length === 0, '自动回收不会因为换措辞而勾掉条目')
  check(MEMO_DEFAULT_PROMPT.includes('宁缺勿滥'), '提取指令写明宁缺勿滥')
  check(MEMO_DEFAULT_PROMPT.includes('Callout 卡片'), '提取指令写明 callout 卡片同样可回收')
  check(MEMO_DEFAULT_PROMPT.includes('## 新增') && MEMO_DEFAULT_PROMPT.includes('## 审查'), '提取指令分新增与审查两段')
  check(MEMO_DEFAULT_PROMPT.includes('不适用于这类清单'), '提取指令保留「宁少勿多不适用于结尾清单」的例外')
  check(MEMO_DEFAULT_PROMPT.includes('原文开头'), '提取指令要求照抄条目原文开头')
  check(MEMO_DEFAULT_PROMPT.includes('候选只来自'), '提取指令限定审查候选来自输入清单')
  check(MEMO_PROMPT.includes('Add (`memo_add`)') && MEMO_PROMPT.includes('Review (`memo_update`)'), '注入提示分新增与审查两段')
  check(MEMO_PROMPT.includes('closing checklist above is the exception'), '注入提示写明结尾清单不适用合并')
  check(MEMO_DEFAULT_PROMPT.includes('自指的过程说明不要收'), '提取指令排除自指过程说明')
  check(MEMO_PROMPT.includes('your own process'), '注入提示排除自指过程说明')
  const recallPair = [
    { id: 'm_recall', turn: 1, text: 'job 的 run.jsonl 现在是历史快照，不是运行中的实时事件流；要直播需接 /run/<id>/events' },
  ]
  check(
    matchResolved(
      ['job 的 run.jsonl 现在是历史快照，不是运行中的实时事件流（插件的 /run/<id>/events 已经有了，没接进 job 落盘）。'],
      recallPair,
    ).length === 1,
    '自动回收在 0.8 门槛下接受同义改写',
  )
  check(
    !similarMemoItemStrict(
      'job 的 run.jsonl 现在是历史快照，不是运行中的实时事件流；要直播需接 /run/<id>/events',
      'job 的 run.jsonl 现在是历史快照，不是运行中的实时事件流（插件的 /run/<id>/events 已经有了，没接进 job 落盘）。',
    ),
    '跨轮取代仍沿用 0.88 的严格门槛',
  )
  const recallItems = [
    { id: 'm_recall2', turn: 1, text: 'job 的 run.jsonl 现在是历史快照，不是运行中的实时事件流；要直播需接 /run/<id>/events' },
  ]
  const paraphraseText = [
    'job 的 run.jsonl 现在是历史快照，不是运行中的实时事件流（插件的 /run/<id>/events 已经有了，没接进 job 落盘）。',
  ]
  check(matchResolved(paraphraseText, recallItems).length === 1, '自动回收按 0.8 对齐')
  check(matchResolved(paraphraseText, recallItems, 0.88).length === 0, '模型判定的重复仍按 0.88 对齐')

  const bestHit = matchResolved(['备份 profile 并导出配置，升级后刷新页面'], [
    { id: 'm_long', turn: 1, text: '备份 profile 并导出配置，升级后刷新页面并验证回滚' },
    { id: 'm_exact', turn: 2, text: '备份 profile 并导出配置，升级后刷新页面' },
  ])
  check(bestHit.length === 1 && bestHit[0].id === 'm_exact', '精确文本不会被更早的包含项遮蔽')

  const turnStartSession = {
    seq: 3,
    snapshotEvents: () => [
      { type: 'turn/start', data: { turn: 5 } },
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第五轮提示' }] } },
      { type: 'turn/end', data: { turn: 5 } },
    ],
  }
  const turnStartRead = readTurn(turnStartSession)
  check(turnStartRead.turn === 5 && turnStartRead.prompt === '第五轮提示', '正常回合按 turn/start 归组')
  const compactedSession = {
    seq: 2,
    snapshotEvents: () => [
      { type: 'turn/end', data: { turn: 7 } },
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '压缩后的提示' }] } },
    ],
  }
  const compactedRead = readTurn(compactedSession)
  check(compactedRead.turn === 8 && compactedRead.prompt === '压缩后的提示', '压缩后没有 turn/start 时接在上一轮之后')
  const staleStartSession = {
    seq: 4,
    snapshotEvents: () => [
      { type: 'turn/start', data: { turn: 5 } },
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '旧提示' }] } },
      { type: 'turn/end', data: { turn: 5 } },
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '新提示' }] } },
    ],
  }
  const staleStartRead = readTurn(staleStartSession)
  check(staleStartRead.turn === 6 && staleStartRead.prompt === '新提示', '残留上一轮 turn/start 时仍归到当前轮')
  const emptyTurnSession = { seq: 1, snapshotEvents: () => [{ type: 'turn/end', data: { turn: 0 } }] }
  check(readTurn(emptyTurnSession).turn === 0, '零轮次按未识别处理')

  await addMemoItems('sess-turn-fallback', { turn: 3, prompt: 'p3', items: [{ text: '第三轮事项' }] })
  const fallbackAdd = await addMemoItems('sess-turn-fallback', { turn: 0, prompt: '压缩后的提示', items: [{ text: '压缩后的事项' }] })
  check(fallbackAdd.doc.groups.length === 2, '轮次缺失时新开一组而不是并入旧组')
  const fallbackGroup = fallbackAdd.doc.groups[1]
  check(fallbackGroup.turn === 4, '新一组的编号接在现有最大轮次之后')
  check(fallbackGroup.newTurn === true, '提示词非空时合成组仍带标记')
  check(fallbackGroup.prompt === '压缩后的提示', '合成组保留原提示词，不用标记覆盖')
  check(fallbackGroup.items.some((item) => item.text === '压缩后的事项'), '轮次缺失的条目照常写入')
  check(fallbackAdd.newTurn === true && fallbackAdd.turn === 4, '写入结果带回合成的轮次与标记')
  check(fallbackAdd.doc.groups[0].turn === 3 && fallbackAdd.doc.groups[0].newTurn !== true, '旧的真实轮次不被标成合成组')
  const fallbackReread = await readMemo('sess-turn-fallback')
  check(fallbackReread.groups[1].newTurn === true, '合成标记写入文件并在重读后保留')
  // 真实轮次恰好用到合成组占过的编号：合成组让位，真假轮次不混在一组。
  const reclaimed = await addMemoItems('sess-turn-fallback', { turn: 4, prompt: '真正的第四轮', items: [{ text: '真实第四轮事项' }] })
  const realGroup = reclaimed.doc.groups.find((group) => group.turn === 4)
  check(realGroup !== undefined && realGroup.newTurn !== true, '真实轮次占用同号时新建真实组而不是并入合成组')
  check(realGroup !== undefined && realGroup.items.some((item) => item.text === '真实第四轮事项'), '真实条目落在真实组里')
  const shiftedGroup = reclaimed.doc.groups.find((group) => group.newTurn === true)
  check(shiftedGroup !== undefined && shiftedGroup.turn > 4, '被占号的合成组顺延到更高编号')
  check(shiftedGroup !== undefined && shiftedGroup.items.some((item) => item.text === '压缩后的事项'), '合成组的条目留在合成组里')
  check(flattenMemoItems(reclaimed.doc).filter((row) => row.newTurn === true).length === 1, '摊平列表标出合成组的行')
  const emptyPromptAdd = await addMemoItems('sess-turn-fallback3', { turn: 0, prompt: '', items: [{ text: '首条事项' }] })
  check(emptyPromptAdd.doc.groups[0].turn === 1 && emptyPromptAdd.doc.groups[0].newTurn === true, '没有历史轮次时从第 1 组开始并标记')
  await writeMemo('sess-turn-legacy', {
    version: 2,
    sessionId: 'sess-turn-legacy',
    groups: [{ turn: 7, prompt: '(新一轮)', items: [{ text: '旧版合成组条目' }] }],
  })
  const legacyDoc = await readMemo('sess-turn-legacy')
  check(legacyDoc.groups[0].newTurn === true && legacyDoc.groups[0].prompt === '', '旧版写进提示词的标记读回时按合成组处理')
  check(flattenMemoItems(legacyDoc)[0].newTurn === true, '旧版合成组的行同样带标记')
  check(captureSignature(4, 'x'.repeat(60)) === captureSignature(4, 'x'.repeat(60)), '同一回复的签名稳定')
  check(captureSignature(4, 'x'.repeat(60)) !== captureSignature(5, 'x'.repeat(60)), '轮次不同则签名不同')
  check(captureSignature(4, 'x'.repeat(60)) !== captureSignature(4, 'y'.repeat(60)), '回复不同则签名不同')
  check(captureSignature(0, 'ab') === '0|2|ab', '签名格式为轮次|长度|前缀')

  const okStream = (async function* () {
    yield { type: 'text-delta', text: 'hello' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
  const okCollected = await collectText(okStream)
  check(okCollected.text === 'hello' && okCollected.failure === '', '正常流收集文本且无失败原因')
  const errStream = (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'bad key' } } }
  })()
  const errCollected = await collectText(errStream)
  check(errCollected.text === '' && errCollected.failure.includes('AUTH'), '终止分片带出失败代码')
  const abortedStream = (async function* () {
    yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'CANCELLED' } } }
  })()
  check((await collectText(abortedStream)).failure.includes('aborted'), '终止分片带出 aborted')
  const maxTokenStream = (async function* () {
    yield { type: 'text-delta', text: '{"items":[' }
    yield { type: 'finish', reason: { kind: 'max-tokens' } }
  })()
  check((await collectText(maxTokenStream)).failure === 'max-tokens', '终止分片带出 max-tokens 截断')
  const blockStream = (async function* () {
    yield { type: 'block-end', block: { type: 'text', text: 'from block' } }
  })()
  check((await collectText(blockStream)).text === 'from block', '只发完整块时回落到 block-end')

  const manyOpenLines = Array.from({ length: 80 }, () => ({ turn: 1, text: '很长的一条未完成条目'.repeat(20) }))
  const budgeted = extractionInput('提示', 'A'.repeat(30000), manyOpenLines)
  check(budgeted.length <= 12000, '清单与回复合并后不超过输入预算')
  check(budgeted.includes('Open memo items in this session'), '超长清单仍保留清单块')

  const fifteen = parseExtraction('{"items":[' + Array.from({ length: 15 }, (_, index) => `{"text":"y${index}"}`).join(',') + ']}')
  check(fifteen.length === 15, '提取器不再截断条目数量')
  const manyMerged = mergeMemoItems(Array.from({ length: 30 }, (_, index) => ({ text: `条目 ${index}` })), [])
  check(manyMerged.length === 30, '合并不再截断条目数量')

  const absorbIdSeed = await addMemoItems('sess-absorb-id', {
    turn: 1,
    prompt: 'p',
    items: [{ text: '备份 profile 并导出配置，升级后刷新页面' }],
  })
  const absorbIdOpen = openMemoItems(absorbIdSeed.doc)
  await addMemoItems('sess-absorb-id', {
    turn: 1,
    prompt: 'p',
    items: [{ text: '还没做的', children: ['备份 profile 并导出配置，升级后刷新页面再验证'] }],
  })
  const absorbIdDoc = await readMemo('sess-absorb-id')
  check(absorbIdDoc.groups[0].items[0].children[0].id === absorbIdOpen[0].id, '被吸收条目的 id 转到新叶子上')
  const absorbIdResolved = await updateMemoItems('sess-absorb-id', {
    items: [{ text: '备份 profile 并导出配置，升级后刷新页面' }],
    allowIds: absorbIdOpen.map((item) => item.id),
  })
  check(absorbIdResolved.updated === 1, '白名单仍能勾掉被吸收过的那一条')

  const resolveSeed = await addMemoItems('sess-resolve', {
    turn: 4,
    prompt: 'p',
    items: [{ text: '刷新页面手测自动收起（面板是否收起）' }, { text: '回归 check 脚本' }],
  })
  const resolveOpen = openMemoItems(resolveSeed.doc)
  const resolveTargets = matchResolved(['刷新页面手测自动收起'], resolveOpen)
  const resolveApplied = await resolveMemoItems('sess-resolve', { ids: resolveTargets.map((entry) => entry.id) })
  check(resolveApplied.updated === 1 && resolveApplied.unfinished === 1, '自动回收只勾掉命中的那一条')

  // 严格判定不命中时，落地也不能按宽松相似再匹配一次：两条同义改写的旧条目只留另一条未勾。
  await addMemoItems('sess-strict-land', {
    turn: 1,
    prompt: 'p',
    items: [{ text: 'job 的 run.jsonl 现在是历史快照，不是运行中的实时事件流；要直播需接 /run/<id>/events' }],
  })
  await addMemoItems('sess-strict-land', {
    turn: 2,
    prompt: 'p',
    items: [{ text: 'job 的 run.jsonl 现在是历史快照，不是运行中的实时事件流（插件的 /run/<id>/events 已经有了，没接进 job 落盘）。' }],
  })
  const strictLandOpen = openMemoItems(await readMemo('sess-strict-land'))
  const strictLandTargets = matchResolved(['job 的 run.jsonl 现在是历史快照，不是运行中的实时事件流；要直播需接 /run/<id>/events'], strictLandOpen)
  check(strictLandTargets.length === 1, '严格判定只命中逐字那条')
  const strictLandApplied = await resolveMemoItems('sess-strict-land', { ids: strictLandTargets.map((entry) => entry.id) })
  const strictLandDoc = await readMemo('sess-strict-land')
  check(strictLandApplied.updated === 1, '按 id 落地只勾一条')
  check(strictLandDoc.groups[0].items[0].done === true && strictLandDoc.groups[1].items[0].done === false, '同义改写的旧条目不会被连带勾掉')

  const ordered = orderByAppearance([{ text: 'C' }, { text: 'A' }, { text: 'B' }], '先做 A，然后 B，最后 C。')
  check(ordered.map((item) => item.text).join('') === 'ABC', '按文中首次出现位置排序')
  const paraphrased = orderByAppearance([{ text: '乙' }, { text: '甲' }], '甲 与 乙')
  check(paraphrased[0].text === '甲', '能定位原文时排序')
  const unfindable = orderByAppearance([{ text: '不存在' }, { text: '甲' }], '甲')
  check(unfindable[0].text === '不存在', '无法定位时保持模型顺序')

  const openReply = [
    '本轮改动完成。',
    '',
    '仍未覆盖，需要你在界面上手动补测的三项：',
    '',
    '- 完全重复文本：写两条一字不差的备忘，看是否去重。',
    '- 删除与完成态：勾选后父项完成的判定只能在 GUI 里点。',
    '- 跨会话/并发写入：换新会话或两个会话同时写的没有测。',
    '',
    '以上是说明。',
  ].join('\n')
  const open = extractOpenItems(openReply)
  check(open.length === 1, '清单归到一个父项')
  check(open[0] !== undefined && open[0].text.includes('仍未覆盖'), '父项取触发句')
  check(open[0] !== undefined && open[0].children.length === 3, '三条列表项成为子任务')
  check(open[0] !== undefined && open[0].children[0].text.includes('完全重复文本'), '保留清单原文顺序')
  check(extractOpenItems('改完了，说明如下：\n\n- 第一条\n- 第二条').length === 0, '无触发词的列表不收录')
  const nestedOpen = extractOpenItems('下一步：\n\n- 一级\n  - 二级\n  - 二级 B')
  check(nestedOpen.length === 1 && nestedOpen[0].children.length === 1, '清单父项只挂一级列表项')
  check(nestedOpen[0] !== undefined && nestedOpen[0].children[0].children.length === 2, '嵌套列表继续成为子任务')

  const merged = mergeMemoItems(
    [{ text: '备份后再升级' }],
    [{ text: '备份后再升级。', callout: 'WARNING' }, { text: '回归 check 脚本', callout: 'NOTE' }],
  )
  check(merged.length === 2, '同一句的重复补充被合并')
  check(merged[0].text === '备份后再升级' && merged[1].text === '回归 check 脚本', '模型条目优先且保持顺序')
  check(mergeMemoItems([], [{ text: 'a' }, { text: 'b' }], 1).length === 1, '合并受上限约束')

  const paraphrasedPair = mergeMemoItems(
    [{ text: 'job 的 run.jsonl 现在是历史快照，不是运行中的实时事件流；要直播需接 /run/<id>/events' }],
    [{ text: 'job 的 run.jsonl 现在是历史快照，不是运行中的实时事件流（插件的 /run/<id>/events 已经有了，没接进 job 落盘）。' }],
  )
  check(paraphrasedPair.length === 1, '换措辞的同一件事只留一条')
  check(paraphrasedPair[0].text.includes('没接进 job 落盘'), '重复时保留信息更全的那条')

  const structuredWins = mergeMemoItems(
    [
      { text: '作业现在依赖网页视图在跑：托盘先「打开网页视图」再启动网关，否则闸门报错' },
      { text: 'job 的 run.jsonl 现在是历史快照，不是运行中的实时事件流；要直播需接 /run/<id>/events', callout: 'WARNING' },
      { text: '托盘「启动网关」尚未自动拉起网页视图，现在是两步' },
    ],
    [
      {
        text: '还没做的',
        children: [
          { text: 'job 的 run.jsonl 现在是历史快照，不是运行中的实时事件流（插件的 /run/<id>/events 已经有了，没接进 job 落盘）。' },
          '托盘「启动网关」没有自动拉起网页视图，目前是两步操作。',
        ],
      },
    ],
  )
  check(structuredWins.length === 2, '平铺条目被子任务清单吸收')
  check(structuredWins[1] !== undefined && structuredWins[1].text === '还没做的', '带子任务的条目挪到最早重复位置')
  check(structuredWins[1] !== undefined && structuredWins[1].children.length === 2, '保留带子任务的那条及其子任务')
  check(structuredWins[1] !== undefined && structuredWins[1].callout === 'WARNING', '被吸收条目的 callout 类型转移到结构化条目')

  const keptApart = mergeMemoItems(
    [{ text: '托盘「打开网页视图」要手动点，没有开机自启' }],
    [{ text: '托盘「启动网关」要手动点，没有开机自启' }],
  )
  check(keptApart.length === 2, '点名对象不同的条目不被合并')

  const dedupeFirst = await addMemoItems('sess-dedupe', {
    turn: 1,
    prompt: 'p',
    items: [{ text: 'job 的 run.jsonl 现在是历史快照，不是运行中的实时事件流；要直播需接 /run/<id>/events' }],
  })
  const dedupeSecond = await addMemoItems('sess-dedupe', {
    turn: 1,
    prompt: 'p',
    items: [{ text: 'job 的 run.jsonl 现在是历史快照，不是运行中的实时事件流（插件的 /run/<id>/events 已经有了，没接进 job 落盘）。' }],
  })
  check(dedupeFirst.added === 1, '首次写入一条')
  check(dedupeSecond.doc.groups[0].items.length === 1, '同一轮换措辞不新增条目')
  check(dedupeSecond.doc.groups[0].items[0].text.includes('没接进 job 落盘'), '同一轮换措辞保留更全的写法')

  await addMemoItems('sess-dedupe', { turn: 2, prompt: 'p', items: [{ text: '回归 check 脚本' }] })
  const upgraded = await addMemoItems('sess-dedupe', { turn: 2, prompt: 'p', items: [{ text: '回归 check 脚本', children: ['跑 npm run check'] }] })
  const upgradedItem = upgraded.doc.groups.find((group) => group.turn === 2).items[0]
  check(upgraded.added === 1 && upgraded.skipped === 0, '替换掉旧写法算作写入而不是跳过')
  check(upgradedItem.children.length === 1, '带子任务的写法替换掉平铺写法')

  const structFirst = await addMemoItems('sess-child-state', {
    turn: 1,
    prompt: 'p',
    items: [{ text: '备份 profile 并导出配置，升级后刷新页面' }],
  })
  await toggleMemoNode('sess-child-state', structFirst.doc.groups[0].items[0].id)
  const structNext = await addMemoItems('sess-child-state', {
    turn: 1,
    prompt: 'p',
    items: [{ text: '还没做的', children: ['备份 profile 并导出配置，升级后刷新页面'] }],
  })
  const structItems = structNext.doc.groups[0].items
  check(structItems.length === 1 && structItems[0].text === '还没做的', '平铺条目被结构化写法吸收')
  check(structItems[0].children[0].done === true && structItems[0].done === true, '吸收后已勾选的子任务保持完成')

  const softFirst = await addMemoItems('sess-soft-state', {
    turn: 1,
    prompt: 'p',
    items: [{ text: '备份 profile 并导出配置，升级后刷新页面' }],
  })
  await toggleMemoNode('sess-soft-state', softFirst.doc.groups[0].items[0].id)
  await addMemoItems('sess-soft-state', {
    turn: 1,
    prompt: 'p',
    items: [{ text: '还没做的', children: ['备份 profile 并导出配置，升级后刷新页面再验证'] }],
  })
  const softItems = (await readMemo('sess-soft-state')).groups[0].items
  check(softItems.length === 1 && softItems[0].children[0].done === true, '换措辞吸收时保留勾选状态')

  const sameLeaf = await addMemoItems('sess-same-leaf', {
    turn: 1,
    prompt: 'p',
    items: [
      { text: '清单 A', children: ['跑同一脚本'] },
      { text: '清单 B', children: ['跑同一脚本'] },
    ],
  })
  await toggleMemoNode('sess-same-leaf', sameLeaf.doc.groups[0].items[0].children[0].id)
  await addMemoItems('sess-same-leaf', { turn: 1, prompt: 'p', items: [{ text: '写一条无关的备忘' }] })
  const sameLeafDoc = await readMemo('sess-same-leaf')
  const firstChild = sameLeafDoc.groups[0].items[0].children[0]
  const secondChild = sameLeafDoc.groups[0].items[1].children[0]
  check(firstChild.done === true, '无关写入不会把已勾选的子任务改回未完成')
  check(secondChild.done === false, '同名但未勾选的子任务保持未完成')

  // 阈值边界：没有共同点名对象时，只差一个关键词的条目不能被并成一条。
  const nearMiss = mergeMemoItems(
    [{ text: 'memo 面板按轮次分组显示' }],
    [{ text: 'memo 面板按轮次折叠显示' }],
  )
  check(nearMiss.length === 2, '覆盖率 0.75 的两条不合并')
  const unnamedObjects = mergeMemoItems(
    [{ text: '托盘启动网关要手动点' }],
    [{ text: '托盘打开网页视图要手动点' }],
  )
  check(unnamedObjects.length === 2, '未点名对象时只差关键词的两条不合并')

  const stateFirst = await addMemoItems('sess-state', {
    turn: 1,
    prompt: 'p',
    items: [{ text: '升级前先备份 profile 再重启 DSH', callout: 'WARNING' }],
  })
  const stateItem = stateFirst.doc.groups[0].items[0]
  await toggleMemoNode('sess-state', stateItem.id)
  const longerText = '升级前先备份 profile 再重启 DSH，否则加载的还是旧代码'
  await addMemoItems('sess-state', { turn: 1, prompt: 'p', items: [{ text: longerText }] })
  const stateAfter = (await readMemo('sess-state')).groups[0].items[0]
  check(stateAfter.id === stateItem.id, '替换时保留条目 id')
  check(stateAfter.done === true, '替换时保留勾选状态')
  check(stateAfter.callout === 'WARNING', '替换时保留 callout 类型')
  check(stateAfter.text === longerText, '替换成信息更全的写法')

  const batch = await addMemoItems('sess-batch', {
    turn: 1,
    prompt: 'p',
    items: [
      { text: 'job 的 run.jsonl 现在是历史快照，不是运行中的实时事件流；要直播需接 /run/<id>/events' },
      { text: 'job 的 run.jsonl 现在是历史快照，不是运行中的实时事件流（插件的 /run/<id>/events 已经有了，没接进 job 落盘）。' },
    ],
  })
  check(batch.added === 1 && batch.skipped === 1, '同批次后面的条目跟替换后的写法比对')
  check(batch.doc.groups[0].items.length === 1, '同批次只留一条')

  const batchLongFirst = await addMemoItems('sess-batch-long', {
    turn: 1,
    prompt: 'p',
    items: [
      { text: 'job 的 run.jsonl 现在是历史快照，不是运行中的实时事件流（插件的 /run/<id>/events 已经有了，没接进 job 落盘）。' },
      { text: 'job 的 run.jsonl 现在是历史快照，不是运行中的实时事件流；要直播需接 /run/<id>/events' },
    ],
  })
  check(batchLongFirst.doc.groups[0].items.length === 1, '同批次先写长版本也只留一条')

  const toolAbsorb = await addMemoItems('sess-tool', {
    turn: 1,
    prompt: 'p',
    items: [
      { text: '还没做的', children: ['备份 profile 并导出配置，升级后刷新页面再验证'] },
      { text: '备份 profile 并导出配置，升级后刷新页面' },
    ],
  })
  check(toolAbsorb.doc.groups[0].items.length === 1, '工具写入路径同样让子任务吸收平铺条目')
  check(toolAbsorb.doc.groups[0].items[0].text === '还没做的', '工具写入路径保留带子任务的条目')

  const limited = mergeMemoItems(
    [{ text: '备份 profile 并导出配置，升级后刷新页面' }, { text: '回归 check 脚本' }],
    [{ text: '还没做的', children: ['备份 profile 并导出配置，升级后刷新页面再验证'] }],
    2,
  )
  check(limited.length === 2 && limited[0].text === '还没做的', '先吸收再截断，结构化条目不被截掉')

  await addMemoItems('sess-update', {
    turn: 3,
    prompt: '第 3 轮',
    items: [
      { text: '还没做的', children: ['备份 profile 并导出配置，升级后刷新页面', '补齐 CHANGELOG'] },
    ],
  })
  const updateOne = await updateMemoItems('sess-update', { items: [{ text: '备份 profile 并导出配置，升级后刷新页面再验证' }] })
  check(updateOne.updated === 1 && updateOne.unfinished === 1 && updateOne.total === 2, '按相似文本勾选已有子任务')
  check(updateOne.doc.groups[0].items[0].done === false, '勾一个子任务后父项仍未完成')
  check(updateOne.open.length === 1 && updateOne.open[0].text === '补齐 CHANGELOG' && updateOne.open[0].turn === 3, '未完成清单带轮次')
  const updateOpen = openMemoItems(updateOne.doc)
  check(updateOpen.length === 1 && updateOpen[0].text === '补齐 CHANGELOG', 'openMemoItems 只列未完成的叶子')

  const updateSecond = await updateMemoItems('sess-update', { items: [{ text: '补齐 CHANGELOG' }] })
  check(updateSecond.updated === 1 && updateSecond.unfinished === 0 && updateSecond.open.length === 0, '勾完最后一条后全部完成')
  check(updateSecond.doc.groups[0].items[0].done === true, '父项随子任务全部完成')

  const updateAgain = await updateMemoItems('sess-update', { items: [{ text: '补齐 CHANGELOG' }] })
  check(updateAgain.updated === 0 && updateAgain.unchanged === 1, '重复勾选计入已是最新状态')

  const updateMiss = await updateMemoItems('sess-update', { items: [{ text: '完全无关的一条' }] })
  check(updateMiss.updated === 0 && updateMiss.unmatched.length === 1, '匹配不到时返回未匹配文本')
  check(updateMiss.unmatchedTotal === 1, '未匹配条数给出总数')
  const manyMisses = await updateMemoItems('sess-update', {
    items: Array.from({ length: 9 }, (_, index) => `完全无关的第 ${index + 1} 条`),
  })
  check(manyMisses.unmatched.length === 8 && manyMisses.unmatchedTotal === 9, '未匹配文本最多回 8 条并给出总数')

  const updateReopen = await updateMemoItems('sess-update', { items: [{ text: '补齐 CHANGELOG', done: false }] })
  check(updateReopen.updated === 1 && updateReopen.unfinished === 1, 'done: false 可重新打开')

  const readOnlyFile = join(memoRoot(), 'sess-update.json')
  const readOnlyBefore = readFileSync(readOnlyFile, 'utf8')
  const readOnly = await updateMemoItems('sess-update', { items: [] })
  check(readOnly.updated === 0 && readOnly.open.length === 1, '只读调用返回未完成清单')
  check(readFileSync(readOnlyFile, 'utf8') === readOnlyBefore, '只读调用不写盘')

  const crossFirst = await addMemoItems('sess-cross', { turn: 1, prompt: 'p1', items: [{ text: '整理提交说明与 PR 描述' }] })
  const crossSecond = await addMemoItems('sess-cross', { turn: 2, prompt: 'p2', items: [{ text: '整理提交说明与 PR 描述' }] })
  check(crossFirst.superseded === 0 && crossSecond.superseded === 1, '更早轮次的同一条被新写法取代')
  const crossDoc = await readMemo('sess-cross')
  check(crossDoc.groups[0].items[0].done === true && crossDoc.groups[1].items[0].done === false, '跨轮重复只留最新一条未完成')
  const cross = await updateMemoItems('sess-cross', { items: [{ text: '整理提交说明与 PR 描述' }] })
  check(cross.updated === 1 && cross.unfinished === 0, '再勾一次把最新那条也勾掉')

  // 换措辞的近似说法不触发跨轮取代，避免误勾。
  await addMemoItems('sess-supersede-keep', {
    turn: 1,
    prompt: 'p1',
    items: [{ text: '托盘「启动网关」尚未自动拉起网页视图，现在是两步' }],
  })
  const superKeep = await addMemoItems('sess-supersede-keep', {
    turn: 2,
    prompt: 'p2',
    items: [{ text: '托盘「启动网关」没有自动拉起网页视图，目前是两步操作。' }],
  })
  check(superKeep.superseded === 0, '换措辞不触发跨轮取代')
  check((await readMemo('sess-supersede-keep')).groups[0].items[0].done === false, '旧条目保持未完成')

  await addMemoItems('sess-sup-keep-long', {
    turn: 1,
    prompt: 'p1',
    items: [{ text: '备份 profile 并导出配置，升级后刷新页面' }],
  })
  const shortNew = await addMemoItems('sess-sup-keep-long', {
    turn: 2,
    prompt: 'p2',
    items: [{ text: '备份 profile 并导出配置' }],
  })
  check(shortNew.superseded === 0, '更短的新写法不取代旧条目')
  check((await readMemo('sess-sup-keep-long')).groups[0].items[0].done === false, '长版旧条目保持未完成')

  await addMemoItems('sess-sup-parent', {
    turn: 1,
    prompt: 'p1',
    items: [{ text: '还没做的', children: ['补齐 CHANGELOG', '跑 npm run check'] }],
  })
  const bareNew = await addMemoItems('sess-sup-parent', { turn: 2, prompt: 'p2', items: [{ text: '还没做的' }] })
  check(bareNew.superseded === 0, '裸标题不取代带子任务的旧父项')
  const supParentDoc = await readMemo('sess-sup-parent')
  check(
    supParentDoc.groups[0].items[0].done === false && supParentDoc.groups[0].items[0].children.every((child) => child.done === false),
    '旧父项与子任务都保持未完成',
  )

  await addMemoItems('sess-sup-leaf', {
    turn: 1,
    prompt: 'p1',
    items: [{ text: '还没做的', children: ['刷新页面手测自动收起面板', '跑 npm run check'] }],
  })
  const leafNew = await addMemoItems('sess-sup-leaf', {
    turn: 2,
    prompt: 'p2',
    items: [{ text: '刷新页面手测自动收起面板' }],
  })
  check(leafNew.superseded === 1, '子任务级重复也能被取代')
  const supLeafDoc = await readMemo('sess-sup-leaf')
  check(
    supLeafDoc.groups[0].items[0].children[0].done === true && supLeafDoc.groups[0].items[0].done === false,
    '只勾被取代的子任务，父项仍未完成',
  )

  await addMemoItems('sess-dup-pass', {
    turn: 1,
    prompt: 'p1',
    items: [{ text: '备份 profile 并导出配置，升级后刷新页面并验证' }],
  })
  const dupSecond = await addMemoItems('sess-dup-pass', {
    turn: 2,
    prompt: 'p2',
    items: [{ text: '备份 profile 并导出配置，升级后刷新页面' }],
  })
  check(dupSecond.superseded === 0, '短版不会在写入时取代旧条目')
  const dupDoc = await readMemo('sess-dup-pass')
  const dupResult = dedupeMemoItems(dupDoc)
  check(dupResult.count === 1, '复查去重把同义改写的重复标为完成')
  const dupOpen = [dupDoc.groups[0].items[0], dupDoc.groups[1].items[0]].filter((item) => item.done !== true)
  check(dupOpen.length === 1 && !dupOpen[0].text.includes('并验证'), '复查去重保留最新的那条')
  check(dupResult.merges[0].dropped.includes('并验证'), '复查去重记录被合并的旧条目原文')

  await addMemoItems('sess-dup-pass2', {
    turn: 1,
    prompt: 'p',
    items: [{ text: '托盘「启动网关」要手动点，没有开机自启' }],
  })
  await addMemoItems('sess-dup-pass2', {
    turn: 2,
    prompt: 'p',
    items: [{ text: '托盘「打开网页视图」要手动点，没有开机自启' }],
  })
  check(dedupeMemoItems(await readMemo('sess-dup-pass2')).count === 0, '点名对象不同的条目不被复查去重')

  const sameTurnDoc = emptyMemo('sess-dup-same-turn')
  sameTurnDoc.groups.push({
    turn: 5,
    prompt: 'p',
    items: [
      { id: 'm_same_short', text: '备份 profile 并导出配置，升级后刷新页面', done: false, source: 'agent', children: [] },
      { id: 'm_same_long', text: '备份 profile 并导出配置，升级后刷新页面并验证回滚', done: false, source: 'agent', children: [] },
    ],
  })
  const sameTurnResult = dedupeMemoItems(sameTurnDoc)
  check(sameTurnResult.count === 1 && sameTurnResult.merges[0].kept.includes('并验证回滚'), '同轮并列时保留信息更全的那条')

  await addMemoItems('sess-deep-update', {
    turn: 1,
    prompt: 'p',
    items: [{ text: '一级', children: [{ text: '二级', children: ['三级'] }] }],
  })
  const deepUpdate = await updateMemoItems('sess-deep-update', { items: [{ text: '三级' }] })
  const deepRoot = deepUpdate.doc.groups[0].items[0]
  check(deepUpdate.updated === 1 && deepRoot.done === true && deepRoot.children[0].done === true, '三层子任务勾选后逐级重算')

  const manyItems = Array.from({ length: 25 }, (_, index) => `待办 ${index + 1}`)
  await addMemoItems('sess-open-cap', { turn: 1, prompt: 'p', items: [{ text: '一大批', children: manyItems }] })
  const capped = await updateMemoItems('sess-open-cap', { items: [] })
  check(capped.open.length === 25 && capped.openTotal === 25, '未完成清单不截断并给出总数')

  const allowSeed = await addMemoItems('sess-allow', {
    turn: 1,
    prompt: 'p',
    items: [{ text: '刷新页面手测自动收起（面板是否收起）' }],
  })
  const allowOpen = openMemoItems(allowSeed.doc)
  check(typeof allowOpen[0].id === 'string' && allowOpen[0].id !== '', '未完成清单带条目 id')
  await addMemoItems('sess-allow', { turn: 2, prompt: 'p', items: [{ text: '刷新页面手测自动收起（面板收起是否正常）' }] })
  const scoped = await updateMemoItems('sess-allow', {
    items: [{ text: '刷新页面手测自动收起' }],
    allowIds: allowOpen.map((item) => item.id),
  })
  check(scoped.updated === 1, '白名单只勾提取前存在的那一条')
  const scopedDoc = await readMemo('sess-allow')
  check(scopedDoc.groups[0].items[0].done === true && scopedDoc.groups[1].items[0].done === false, '本轮新写入的同文本条目不被牵连')
  const blocked = await updateMemoItems('sess-allow', { items: [{ text: '刷新页面手测自动收起' }], allowIds: [] })
  check(blocked.updated === 0 && blocked.unmatchedTotal === 1, '白名单为空时不勾任何条目（等价于关闭自动回收）')

  const updateTool = createMemoUpdateTool({})
  check(updateTool.name === 'memo_update', '更新工具名')
  check(updateTool.parameters.required === undefined, '更新工具的 items 可省略（只读取清单）')
  check(updateTool.output.schema.required.includes('open'), '更新工具返回未完成清单')
  check(updateTool.output.schema.required.includes('openTotal'), '更新工具返回未完成总数')
  check(updateTool.output.schema.required.includes('unmatchedTotal'), '更新工具返回未匹配总数')

  const flatSeed = await addMemoItems('sess-flat', {
    turn: 1,
    prompt: 'p',
    items: [{ text: '父项', children: ['子项一', '子项二'] }, { text: '独立项' }],
  })
  const flatRows = flattenMemoItems(flatSeed.doc)
  check(flatRows.length === 4, '摊平列表含父项与子项')
  check(flatRows[0].depth === 0 && flatRows[0].text === '父项', '父项在前、深度为 0')
  check(flatRows[1].depth === 1 && flatRows[1].text === '子项一', '子项深度为 1')
  check(typeof flatRows[0].id === 'string' && flatRows[0].id !== '', '摊平列表带条目 id')

  writeFileSync(join(memoRoot(), '_extract.log'), 'a\nb\nc\n', 'utf8')
  const tailLog = await readExtractLog(2)
  check(tailLog.length === 2 && tailLog[1] === 'c', '读取诊断日志尾部')
  check((await readExtractLog(0)).length === 0, '不传行数时不读日志')

  const readTool = createMemoReadTool({})
  check(readTool.name === 'memo_read', '只读工具名')
  check(readTool.output.schema.required.includes('items'), '只读工具返回条目列表')
  check(readTool.output.schema.required.includes('log'), '只读工具返回日志字段')

  const readExec = { agent: { session: { id: 'sess-flat', seq: 0, snapshotEvents: () => [] } } }
  const readResult = await readTool.execute({ limit: 2, unfinishedOnly: true }, readExec)
  check(readResult.rowTotal === 4 && readResult.items.length === 2, '只读工具按 limit 截断并给出匹配总数')
  check(readResult.items.every((row) => row.done !== true), '只读工具能按未完成筛选')
  const readRender = readTool.output.render({}, readResult)
  check(readRender[0].text.includes('showing 2/4'), '只读工具渲染给出已显示/总数')
  check(readRender[0].text.includes('more row(s) not shown'), '只读工具渲染提示未显示的行数')
  const readByTurn = await readTool.execute({ turn: 1 }, { agent: { session: { id: 'sess-flat', seq: 0, snapshotEvents: () => [] } } })
  check(readByTurn.rowTotal === 4, '只读工具按轮次筛选')
  await addMemoItems('sess-flat', { turn: 2, prompt: 'p2', items: [{ text: '第二轮独立项' }] })
  const readTurn1 = await readTool.execute({ turn: 1 }, readExec)
  const readTurn2 = await readTool.execute({ turn: 2 }, readExec)
  check(readTurn1.rowTotal === 4 && readTurn2.rowTotal === 1, '按轮次筛选真的生效')
  const readCountsOnly = await readTool.execute({ limit: 0 }, readExec)
  check(readCountsOnly.rowTotal === 5 && readCountsOnly.items.length === 0, 'limit 为 0 时只回计数')
  const longText = '很长的一条备忘'.repeat(40)
  await addMemoItems('sess-flat', { turn: 3, prompt: 'p3', items: [{ text: longText }] })
  const readClipped = await readTool.execute({ turn: 3 }, readExec)
  check(readClipped.items[0] !== undefined && readClipped.items[0].text.length <= 201, '只读工具回灌的文本截成短引')
  const emptyRead = await readTool.execute({}, { agent: { session: { id: 'sess-none', seq: 0, snapshotEvents: () => [] } } })
  check(emptyRead.items.length === 0 && emptyRead.total === 0, '空会话返回空明细')

  rmSync(join(memoRoot(), '_extract.log'), { force: true })
  check((await readExtractLog(3)).length === 0, '日志文件不存在时返回空数组')
  check(flattenMemoItems(emptyMemo('sess-empty')).length === 0, '空文档摊平为空数组')
} finally {
  rmSync(home, { recursive: true, force: true })
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`memo verify: ${failure}`)
  process.exit(1)
}
console.log('memo verified')






