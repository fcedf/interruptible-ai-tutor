---
name: interruptible-ai-tutor
description: 驱动一台「可打断的分段讲解引擎」：逐步讲解、边讲边生成代码与图表、学生随时插话、冻结上下文锚点后解答并决定续讲 / 重规划 / 跳过。用于构建 AI 导师、互动课堂、语音讲解 agent。
---

# Interruptible AI Tutor — Agent 操控指南

这个 skill 让你（AI agent）通过 HTTP 驱动一台**可打断的分段讲解引擎**。
引擎负责状态机、锚点、产物；你负责决定**讲什么、何时推进、如何回应插话**。

## 何时用

- 用户要「边讲边演示」「讲到一半我要能打断提问」「逐步讲解 + 实时生成代码/图」
- 需要给语音/前端层提供一个稳定的「讲解状态 + 打断锚点」后端
- 不适用场景：一次性生成完整课件/PPT、纯文本问答、不需要打断的静态课程

## 启动

```bash
npm start          # http://127.0.0.1:8787
# 或自定义：TUTOR_PORT=9000 TUTOR_HOST=127.0.0.1 npm start
```

零依赖、零构建、零 API key 即可运行（内置 RAG 讲解剧本）。
接真实模型：设置 `TUTOR_LLM_API_KEY` + 可选 `TUTOR_LLM_BASE_URL` / `TUTOR_LLM_MODEL`。
**默认只监听 127.0.0.1，服务没有任何鉴权，不要暴露到公网。**

## 核心心智模型

**一节课 = 一串可中断边界（Segment），不是一整段文本。**
只有调用 `POST /api/next` 时才生成下一段（lazy generation）。这让「讲解过程中按需检索/生成代码/画图」和「打断后从干净边界续讲」成为可能。

三个必须记住的不变量：

1. 已生成的段不会因为打断被重新生成；队列只前进。
2. `POST /api/interrupt` **不调用模型** —— 它只冻结 `ContextAnchor`（讲到哪、白板画了什么、跑过哪些代码、引用了哪些资料）。这样你有机会先做 VAD、掐断 TTS、清空音频缓冲。
3. `POST /api/answer` 之后状态仍是 `interrupted`，**必须由你显式调用 `/api/continue` 决定怎么继续**，引擎不会自作主张。

## 标准循环

```
POST /api/start   {"topic":"RAG"}          → 大纲（仅规划，不生成正文）
loop:
  POST /api/next                            → 生成并朗读一段（可能带 code/diagram/sources/quiz）
  POST /api/spoken {"fraction":0.45}       → 回报朗读进度（语音层持续调用）
  若用户开口：
    POST /api/interrupt {"question":"...", "spokenFraction":0.45}  → 锚点
    POST /api/answer                       → 你的回答（引擎向 Provider 取）
    POST /api/continue {"mode":"resume|replan|skip"}               → 决定后续
  until 大纲讲完 → state=finished
```

## 三种续讲模式

| mode | 行为 | 何时选 |
|---|---|---|
| `resume` | 保留队列，用锚点约束重生成当前段文本，避免重复已讲内容 | 插话只是澄清、不改变主线（默认） |
| `replan` | 丢弃未讲段，按插话主题重建后续大纲 | 用户明确「我想改讲 X」「这个方向不对」 |
| `skip` | 当前段标记 SKIPPED，直接讲下一段 | 用户说「这段我懂了，跳过」 |

## API 速查

| 方法 | 路径 | body | 说明 |
|---|---|---|---|
| GET | `/api/state` | — | 完整快照（queue / completed / anchor / board / transcript） |
| GET | `/api/events?replay=1` | — | SSE：先回放历史事件再持续推送 |
| POST | `/api/start` | `{topic?}` | 规划大纲 |
| POST | `/api/next` | — | 推进一段（lazy 生成） |
| POST | `/api/pause` / `/api/resume` | — | 暂停 / 恢复 |
| POST | `/api/spoken` | `{fraction}` | 语音层回报进度 0..1 |
| POST | `/api/interrupt` | `{question, spokenFraction?}` | barge-in，冻结锚点 |
| POST | `/api/answer` | `{question?}` | 回答插话，产物同样可带 code/diagram/sources |
| POST | `/api/continue` | `{mode}` | 决定续讲方式 |
| POST | `/api/reset` | — | 重置会话 |
| GET | `/SKILL.md` | — | 取本文件 |

另有 CLI（每条命令输出单行 JSON，便于 agent 解析）：
`node src/cli.mjs start --topic RAG` / `next` / `interrupt "..."` / `answer` / `continue --mode replan` / `snapshot`。

## SSE 事件类型

`planned` · `segment_generated` · `board` · `code` · `code_result` · `sources` · `quiz` · `speaking` · `segment_done` · `paused` · `resumed` · `interrupted` · `answering` · `answer` · `resegmented` · `replanned` · `segment_skipped` · `continued` · `finished` · `reset`

建议订阅 `interrupted`（拿锚点）、`answer`（展示回答）、`board`/`code_result`（渲染增量）、`continued`（恢复朗读）。

## 锚点长什么样

`ContextAnchor.toPrompt()` 生成一段硬约束注入给模型：

```
[续讲约束 / CONTEXT ANCHOR]
打断发生在段「检索增强生成的整体流程」(diagram)。
已经讲过的内容（不要重复，也不要推翻）：「来看整体流程，我一边说一边把这张图补上。」
已完成段落：RAG 解决的到底是什么问题 / 为什么不能只靠模型参数里的知识。
白板上已经画了 14 步：节点:用户问题 / ...；只增量添加，不要重画。
已经执行并展示过的代码：...；不要重复运行同一段。
续讲时先一句话回应用户刚才的插话，然后自然接回原主线。
```

**这是本 skill 最关键的价值**：barge-in 的难点不是停 TTS，是回答完插话后不重复、不跳步。

## 换成你自己的模型 / 检索

实现 `src/providers.mjs` 里的 Provider 接口即可（引擎不关心内容从哪来）：

```
plan(topic)                     -> SegmentSpec[]
generateSegment(spec, anchor)   -> {narration, artifacts[]}
answer(question, anchor)        -> {narration, artifacts[]}
replan(anchor, question)        -> SegmentSpec[]
search(query)                   -> {items:[{title,url,snippet}]}
```

`artifacts` 支持 `code` / `diagram`（{nodes,edges}）/ `sources` / `quiz` 四类，引擎会自动执行代码、累加白板、记录引用。
`OpenAICompatibleProvider` 已给出真实 LLM 的参考实现；联网检索建议由宿主通过 MCP / 工具注入后覆盖 `search()`。

## 安全边界（重要）

`runCode()` 是**演示级隔离**：只做关键字黑名单 + 输出截断 + `new Function` 作用域限制。
**Node 的 `vm`/`Function` 不是安全边界**。生产环境必须换成 E2B、gVisor、Firecracker 或独立容器执行代码。
服务端默认只监听 loopback 且无鉴权，若要对公网提供服务，请自行加反向代理与认证。

## 不要做的事

- 不要一次性让 LLM 生成整节课文本再塞回引擎 —— 会失去可打断性。
- 不要在 `interrupted` 状态下直接 `/api/next` —— 引擎会拒绝（返回 `NOT_SPEAKING`），请先 `/api/continue`。
- 不要把 API key 写进快照或提交到 git（`snapshot()` 不含凭证，但你自己接 Provider 时别把它塞进 `providerMeta`）。
