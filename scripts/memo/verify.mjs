#!/usr/bin/env node
/**
 * 备忘录存储校验：新增、去重、父子推导、勾选、分叉复制、坏文件恢复与路径校验。
 *
 * 只依赖 Node 内置模块，在 `.tmp/memo-verify` 下自建 `DSH_HOME`，跑完清理。
 * 任何断言失败打印 `memo verify: <原因>` 并以退出码 1 结束；全部通过输出一行 `memo verified`。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addMemoItems, copyMemo, countMemo, readMemo, toggleMemoItem, writeMemo, memoRoot } from '../../lib/memo/store.js'

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
    await toggleMemoItem(session, parent.id, parent.children[0].id)
    check(parent.done === false, '子任务未全勾时父项未完成')
    await toggleMemoItem(session, parent.id, parent.children[1].id)
    const afterAll = await readMemo(session)
    const parentAfter = afterAll.groups[0].items.find((item) => item.id === parent.id)
    check(parentAfter !== undefined && parentAfter.done === true, '子任务全勾后父项完成')

    const parentToggle = await toggleMemoItem(session, parent.id, undefined)
    check(parentToggle.ok === false && parentToggle.error === 'child-not-found', '父项不可单独勾选')
  }

  const bread = await readMemo(session)
  const leaf = bread.groups[0].items.find((item) => item.children.length === 0)
  check(leaf !== undefined, '独立条目存在')
  if (leaf !== undefined) {
    const leafToggle = await toggleMemoItem(session, leaf.id, undefined)
    check(leafToggle.ok === true, '叶子条目可勾选')
  }

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
} finally {
  rmSync(home, { recursive: true, force: true })
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`memo verify: ${failure}`)
  process.exit(1)
}
console.log('memo verified')
