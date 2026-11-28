/**
 * 规则兜底提取的去噪：把「助手自己的下一步」从 callout 与清单条目里剔掉。
 *
 * 备忘录是给用户看的提醒；「下一轮我会看日志」「拿到 PASS 我再更新 PR」这类是会话过程，
 * 过期后只会变成噪音。这里只做句子级的窄判定：判断不清就保留，宁可漏删也不误删。
 */

/** 分析一条句子是否为助手自述的后续动作。 */
const PLAN_SENTENCE = [
  // 下一轮我 / 下回合我会 / 接下来我 / 下一轮观察
  /^(下一轮|下回合|下一步|接下来|稍后|之后再?)\s*(我|会|再|就|观察|看|检查|确认|盯)/,
  // 等到下一轮 / 待 reviewer 结论
  /^(等到?|等待)\s*(下一轮|下回合|reviewer|结果|结论|回复|你)/,
  // 拿到 PASS 我再更新 PR
  /^(拿|得|收)到[^。；!?;\n]{0,24}(PASS|通过|结论|回复|结果)[^。；!?;\n]{0,12}我/,
  // 我会去检查 / 我再跑一遍 / 我这边更新
  /^我(会|将|再|先|这边|去|来|打算|准备|需要)[^。；!?;\n]{0,20}(看|查|检查|确认|更新|改|跑|发|提交|安装|验证|重装|合并|观察)/,
  // 如果这轮出现 X，就说明新代码在跑（自己的验证计划）
  /^(如果|若)[^。；!?;\n]{0,50}(就|则)(说明|表示|可以认为)/,
  // English
  /^(I'll|I will|I'm going to|Next round|Next I|After that,? I)\b/i,
]

/** 去掉列表符号、引用符号与行首空白，句子判定只看正文。 */
function cleanLine(value) {
  return String(value).replace(/^[\s>]*([-*+]|\d+[.)、])\s*/, '').trim()
}

/**
 * 判断一条句子是不是助手自述的后续动作。
 * @param sentence - 单个句子（不含句末标点也可以）。
 */
export function assistantPlanSentence(sentence) {
  const value = cleanLine(sentence)
  if (value === '') return false
  // 明确写了「你 / 您」的是给用户的事，即使句式像计划也保留。
  if (/[你您]/.test(value)) return false
  return PLAN_SENTENCE.some((pattern) => pattern.test(value))
}

/** 按中文句末标点与换行切句，保留标点，便于原样拼回。 */
function splitSentences(value) {
  return value.split(/(?<=[。；!?;\n])/).map((part) => part)
}

/**
 * 剔掉条目里的助手计划句，并递归处理 children：清单常把计划句写成子项，只过滤父项会漏掉。
 * 父项文本全是计划时：子项还有用户内容就把子项提升上来，否则整条丢弃。
 * @param items - 规则兜底产生的条目（字符串或 `{ text, callout?, children? }`）。
 * @returns `{ items, dropped }`，dropped 是被丢弃的原文，供日志排查。
 */
export function stripAssistantPlans(items) {
  const out = []
  const dropped = []
  for (const item of Array.isArray(items) ? items : []) {
    if (typeof item === 'string') {
      const text = keepUserSentences(item)
      if (text === '') {
        if (item.trim() !== '') dropped.push(item.trim())
        continue
      }
      out.push(text)
      continue
    }
    if (item === null || item === undefined || typeof item.text !== 'string') continue
    const children = stripAssistantPlans(item.children).items
    const text = keepUserSentences(item.text)
    if (text === '') {
      if (children.length === 0) {
        if (item.text.trim() !== '') dropped.push(item.text.trim())
        continue
      }
      // 父项是计划、子项还有给用户的内容：只留子项，不保留计划标题。
      out.push(...children)
      continue
    }
    out.push({ ...item, text, children })
  }
  return { items: out, dropped }
}

/** 去掉一条文本里的计划句；整条都是计划时返回空串。 */
function keepUserSentences(value) {
  const sentences = splitSentences(String(value)).filter((sentence) => sentence.trim() !== '')
  return sentences.filter((sentence) => !assistantPlanSentence(sentence)).join('').trim()
}
