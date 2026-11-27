# 备忘录面板：设计与实施计划

状态：已批准（2026-11-27）

## 目标

在 DSH Web 右侧栏增加一个与当前会话绑定的「备忘录」面板，记录 Agent 在会话中产生的提醒与待办，供用户事后 review。条目按「用户每一轮输入的提示词」分组，支持子任务与勾选完成。

## 功能范围

| 维度 | 决定 |
|---|---|
| 条目 | 单一类型，全部可勾选；父项由子任务推导，父项不可单独勾选 |
| 完成项 | 原地划线保留 |
| 分组 | 「第 N 轮」+ 提示词预览（约 50 字，悬停显示全文） |
| Agent 写入 | 只能新增；一次调用可传多条；callout 类提示、用户需记住的限制、留给用户的后续动作都记入 |
| 用户操作 | 勾选、双击、条目菜单 |
| 条目菜单 | 追加到输入框 / 复制文本 / 标记完成（父项置灰）；⋯ 按钮与右键都能打开 |
| 双击动作 | 可配置：追加到输入框（默认）/ 打开菜单 / 复制文本 / 无操作 |
| 入口 | 右侧栏 guide 卡片 + `Ctrl+Alt+M`（mac `Cmd+Alt+M`）+ 会话标题栏计数按钮 |
| 计数 | 「备忘 2/7」，总数含已完成与子任务（父项不重复计入）；全部完成显示「备忘 ✓」；无条目时按钮隐藏 |
| 提示词注入 | 英文约 60 tokens/请求，可开关；子代理同样注入，写入根会话 |
| 生命周期 | 分叉复制（仅浏览器侧发起的 fork）；归档保留数据 |

## 数据

`$DSH_HOME/plugin-data/dsh-nevstop-lab-flavor/memo/<sessionId>.json`

```json
{
  "version": 1,
  "sessionId": "…",
  "groups": [
    {
      "turn": 3,
      "prompt": "该轮用户提示词（≤200 字）",
      "items": [
        {
          "id": "m_…",
          "text": "补齐 CHANGELOG",
          "done": false,
          "source": "agent",
          "children": [{ "id": "m_…_1", "text": "写明默认值", "done": true }]
        }
      ]
    }
  ]
}
```

- 父项 `done` 恒等于 `children.every(done)`，由宿主计算，客户端不能直接改父项。
- 同轮内按文本去重，重复条目跳过并回报 `skipped`。
- 校验：`sessionId` 白名单正则、字段逐项回落、`tmp + rename` 原子写、条数与长度上限。

## 宿主接口

- 工具 `memo_add({ items: [{ text, children? }] })` → `{ turn, prompt, added, skipped, unfinished, total }`。
- 轮次：会话日志中最近的 `turn/start`（`data.turn`）与其后首条 `user/message`（`source.kind === 'user'`）的文本。
- 路由：
  - `GET /__dsh-nevstop-lab-flavor/memo?session=<id>`
  - `POST /__dsh-nevstop-lab-flavor/memo`，`op` 为 `toggle` 或 `copy`，要求同源。
- 提示词：`ctx.systemPrompt.section`，`text()` 内部捕获异常并返回空串。
- 配置：`features.memo`（默认开）、`memo.injectPrompt`（默认开）、`memo.doubleClick`（默认 `append`）。

## 客户端

- 标签页类型 `kind: 'memo'`，guide 卡片「备忘录」。
- 面板：轮次分组、条目标题、子任务缩进、勾选、双击、⋯ 菜单。
- 标题栏：`conversation.session.header.utilities` 注册计数按钮，点击打开面板。
- 快捷键：`ctx.shortcuts.register`。
- 数据：按会话的客户端 store，面板可见时约 2s 轮询，面板与标题栏共享。
- 降级：`sidebarRightTabs`、`contextMenus`、`shortcuts` 缺失时逐项降级，不抛错。

## 数据安全约束

1. 不写会话日志：不新增事件类型，不写 plugin record；唯一进日志的是标准 tool call/result。
2. 不挂会话加载路径：不注册消息投射，不监听会话创建与反序列化。
3. 所有注册与渲染捕获异常：面板内容加 ErrorBoundary，提示词段落出错返回空串。

最坏情况是面板空白或提示读取失败，会话始终可正常打开；插件停用或删除后残留的浏览器标签页由宿主显示占位。

## 实施阶段

1. 分支与文档（本文件）。
2. 宿主：存储、路由、`memo_add`、提示词、配置接线。
3. 客户端：标签页、guide 卡片、面板、双击动作、条目菜单、计数按钮、快捷键、文案、设置卡片。
4. 分叉复制：`sessions.fork` 挂钩调用 `op:'copy'`，失败静默降级。
5. 资产与文档：`assets/icons/memo.svg`、README、`docs/features/memo.md`、`docs/settings.md`、头图、版本号。
6. 验证与 PR。

## 验收清单

1. Agent 批量 `memo_add` 后，条目落在正确轮次，子任务正常。
2. 子任务全勾后父项自动完成；父项不可单独勾；刷新后状态保留。
3. 双击把文字追加为草稿新行且保留原草稿；输入处于发送中时无效。
4. 双击动作切换到其它选项后行为随之变化。
5. ⋯ 与右键都能打开菜单，三项动作可用。
6. 标题栏计数随勾选变化，全部完成显示「备忘 ✓」，无条目时隐藏。
7. `Ctrl+Alt+M` 与 guide 卡片都能打开面板。
8. 关闭功能开关后工具、注入、面板入口全部消失。
9. 分叉后子会话带同一份备忘录；归档不删数据。
10. 写坏 JSON、删除数据文件、停用插件后，会话仍能正常打开。

## 本版不做

- 在对话中定位到某一轮（将来加回时偏好：自动切回 Chat 视图再定位）。
- 用户手动新增、删除、编辑条目文本。
- Agent 更新或删除既有条目。
- 实时推送、跨设备同步、批量操作。
