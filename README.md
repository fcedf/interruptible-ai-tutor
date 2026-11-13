# interruptible-ai-tutor

> 可打断的 AI 讲解引擎：问一个 RAG 问题 → 实时检索 → **逐段**讲解 → 边讲边生成并运行代码、增量画图表 → 讲到一半随时**插话提问** → 冻结上下文锚点 → 解答 → 决定续讲 / 改方向 / 跳过。

零依赖、零构建、**零 API key 即可跑通全部交互**（内置 RAG 讲解剧本）。主要面向「由 AI agent 操控」：提供 CLI、REST + SSE、`SKILL.md` 三种入口，另附浏览器演示页（Web Speech API 实现真实语音 barge-in）。

```
npm start        # http://127.0.0.1:8787  浏览器演示 + REST/SSE
npm run demo     # CLI 完整演示：9 段讲解、中途打断、生成并执行代码
npm test         # 36 个单测
```

---

## 它解决的具体问题

市面上多数「AI 讲课」项目是**先生成整节课，再播放**（课件生成器）。一旦生成完毕，讲解过程中就无法按需检索、无法真正边讲边生成，学生插话后也无法从干净的边界续讲。

本项目把一节课建模为**一串带可中断边界的 Segment**：

| 需求 | 本项目实现 |
|---|---|
| 问一个 RAG 问题 | `POST /api/start {"topic":"RAG"}` 规划 9 段大纲 |
| 实时检索 | `search()` Provider 接口；`sources` 段带真实出处；可接 MCP / web_search 工具 |
| 逐步讲解 | `advance()` 一次只生成一段（lazy generation），不预生成全部正文 |
| 边讲边生成代码 | `code` 段现场生成 JS，**真实执行**并把 stdout 写回 artifact |
| 边讲边生成图片/图表 | `diagram` 段输出 `{nodes, edges}`，前端 SVG 增量绘制；白板操作只追加不重画 |
| 暂停 / 插话 | `pause()` / `interrupt()`；浏览器端用 SpeechRecognition 在朗读中途掐断 TTS |
| 解答插话并接回 | `ContextAnchor` 冻结「讲到哪、白板画了什么、跑过哪些代码、引用了哪些资料」，`toPrompt()` 作为「不要重复」硬约束注入模型 |
| 插话后改方向 | `continue(resume\|replan\|skip)` 三种显式决策 |

**核心洞察**：barge-in 的难点不是停掉 TTS，而是回答完插话之后不重复、不跳步。因此引擎在打断时冻结 `ContextAnchor`，并在续讲时把它交给模型。

---

## 架构

```
┌─ 操控层（三选一，AI agent 友好）────────────────────────┐
│  CLI (src/cli.mjs)   REST+SSE (src/server.mjs)   SKILL.md │
└───────────────────────┬─────────────────────────────────┘
                        ▼
┌─ InterruptibleTutor (src/engine.mjs) ───────────────────┐
│  idle → planned → speaking ⇄ paused                     │
│              ↓ interrupt                                │
│         interrupted → answering → continue(resume/       │
│                                   replan/skip) → speaking│
│  不变量：lazy generation / 锚点冻结 / 队列只前进          │
└───────┬──────────────────────────┬─────────────────────┘
        ▼                          ▼
┌─ Provider 接口 ─────────┐  ┌─ 受限代码执行 runCode() ─┐
│ MockProvider（内置剧本）│  │ 演示级隔离，非安全边界   │
│ OpenAICompatibleProvider│  │ 生产请换 E2B / gVisor    │
│ （可换任意模型/检索）   │  └──────────────────────────┘
└─────────────────────────┘
        ▼ 事件
   SSE: planned / segment_generated / board / code_result
        / interrupted / answer / continued / finished ...
```

文件清单：

```
src/segments.mjs    分段模型（Segment / Artifact：code·diagram·sources·quiz）
src/anchors.mjs     ContextAnchor：barge-in 上下文锚点与 toPrompt() 约束
src/providers.mjs   Provider 接口 + 内置 RAG 剧本 + OpenAI 兼容实现
src/engine.mjs      核心状态机（含 runCode 演示沙箱）
src/cli.mjs         CLI 入口，单行 JSON 输出
src/server.mjs      REST + SSE，零依赖 node:http
web/                浏览器演示页（Web Speech API 语音打断 + SVG 白板）
SKILL.md            给 AI agent 的操控指南
test/engine.test.mjs 36 个单测
```

---

## 快速开始

```bash
# 无需安装依赖（package.json 无 dependencies）
npm start
# 浏览器打开 http://127.0.0.1:8787
#   1. 点「开始 (RAG)」
#   2. 点「下一段」逐段推进
#   3. 讲到一半在输入框打字点「插话并打断」，或勾选「语音打断」直接开口说话
#   4. 回答后出现「续讲 / 改方向 / 跳过本段」三选一
```

接真实模型（可选）：

```bash
TUTOR_LLM_API_KEY=sk-... \
TUTOR_LLM_BASE_URL=https://api.openai.com/v1 \
TUTOR_LLM_MODEL=gpt-4o-mini \
npm start
```

任何兼容 `/chat/completions` 的服务（含 Ollama、DeepSeek、Qwen、GLM、vLLM）都能接。联网检索建议由宿主通过 MCP 工具注入后覆盖 `Provider.search()`。

CLI 操控（每条命令输出单行 JSON）：

```bash
node src/cli.mjs start --topic RAG
node src/cli.mjs next
node src/cli.mjs interrupt "混合检索怎么做？" --spoken 0.45
node src/cli.mjs answer
node src/cli.mjs continue --mode replan
node src/cli.mjs snapshot
```

---

## ⚠️ 安全边界

- `runCode()` 是**演示级隔离**：关键字黑名单 + 输出截断 + `new Function` 作用域限制。**Node 的 `vm` / `Function` 不是安全边界**。生产环境请换成 E2B、gVisor、Firecracker 或独立容器。
- 服务端默认只监听 `127.0.0.1` 且**没有鉴权**，不要直接暴露到公网；需要对外时自行加反向代理与认证。
- 不要把 API key 写进 `providerMeta` / 快照 / git。

---

## 与现有方案的关系、以及完整出处

本项目是**独立实现**（未 fork、未复制任何现有仓库代码），但设计上明确参考了下面的工作。按你的要求，把检索到的同类实现与上游组件**全部列出**，包括那些只有 0–5 star 的早期作品。

### A. 同构实现（形态最接近，但均不成熟）

2026 年下半年出现了一批描述几乎相同的开源小项目。检索时 `stars:>20` 的组合查询（`interruptible voice tutor whiteboard`、`AI tutor whiteboard voice realtime`、`Socratic whiteboard tutor`、`voice tutor live board interrupt`、`realtime RAG tutor whiteboard` 等）**全部返回 0 个结果**；下面这些是放宽到全量后找到的，多为黑客松 / 个人作品，star 0–5，多数无许可证。**本项目未使用它们的代码**，仅作为「这个形态已被尝试过」的先验记录。

| 项目 | star / 许可 | 描述要点 | 本项目借鉴了什么 |
|---|---|---|---|
| [Shane12344321/chalk](https://github.com/Shane12344321/chalk) | 0 / 无 | Voice-first 数理导师，可打断的动画白板 | 「可打断白板」这一形态的确认 |
| [fakechris/lumen-learn](https://github.com/fakechris/lumen-learn) | 1 / MIT | 协议驱动的苏格拉底式白板导师，同步手写 + 语音 + 2D/3D 组件 | 「协议/状态机驱动」而非直接调模型 |
| [skandavaidyanath/teach-me-anything](https://github.com/skandavaidyanath/teach-me-anything) | 0 / 无 | 可打断、语音讲解、持久白板的 agentic tutor | 「持久板 + 可中断课」概念 |
| [harjothkhara/whiteboard-tutor](https://github.com/harjothkhara/whiteboard-tutor) | 1 / 自定义 | tldraw 语音白板，边答边画 | 白板增量绘制思路 |
| [Oyewole-Temiloluwa/SeydamTutor](https://github.com/Oyewole-Temiloluwa/SeydamTutor) | 1 / 无 | 基于自有教材的白板导师，明确写了 "you can interrupt it" | 打断交互的先验 |
| [TahaKhanM/LearnWithNoura](https://github.com/TahaKhanM/LearnWithNoura) | 0 / 无 | 共享白板 + 绘图编译器 + 语音协同 + 打断 | 语音与绘图协同 |
| [Keeganbalcerzak/when-it-clicked](https://github.com/Keeganbalcerzak/when-it-clicked) | 0 / 无 | 边讲边在白板速写的实时语音导师 | — |
| [SanjayS598/agentic-multimodal-tutor](https://github.com/SanjayS598/agentic-multimodal-tutor) | 0 / MIT | 实时多模态教学平台 | — |
| [MONaser04/Zyren-AI-Tutor](https://github.com/MONaser04/Zyren-AI-Tutor) | 2 / MIT | 多模态语音 + 苏格拉底式实时辅导 | — |
| [Four-Ahead/socratic-tutor-agent](https://github.com/Four-Ahead/socratic-tutor-agent) | 1 / MIT | LLM + RAG 的苏格拉底式启发教学，探究-引导-验证闭环 | 「分步引导」的教学结构 |
| [Flagrare/llm-tutor](https://github.com/Flagrare/llm-tutor) | 5 / MIT | Claude Code 的苏格拉底式导师插件，分层给提示 | 「不一次性给答案」的提示设计 |
| [wellofwisdom/wellofwisdom](https://github.com/wellofwisdom/wellofwisdom) | 5 / AGPL-3.0 | 把任意主题转成定制课程的开源学习平台 | — |
| [aniq63/Mavro](https://github.com/aniq63/Mavro) | 0 / MIT | 实时语音 + 动画形象讲解复杂概念 | — |
| [InfinitySudo/voice-tutor-platform](https://github.com/InfinitySudo/voice-tutor-platform) | 0 / MIT | VAD + barge-in + 链式语音回复的语言导师 | barge-in 链路参考 |
| [diego28e/gemini-live-language-tutor](https://github.com/diego28e/gemini-live-language-tutor) | 0 / MIT | Gemini Live 多模态语音导师，明确支持 barge-in | — |
| [Open-TutorAi/open-tutor-ai-CE](https://github.com/Open-TutorAi/open-tutor-ai-CE) | 117 / BSD-3-Clause | 引导式辅导平台，向导式创建会话；教学骨架含可验证目标、YAML 知识依赖、苏格拉底对话单元、rubric 评估 | 教学状态结构参考（体量最接近的「正经」项目） |

> 说明：上表 star / 许可 / 描述为 2026-11-13 通过 GitHub API 逐个核实的结果；这些项目迭代频繁，请以仓库实时信息为准。

### B. 成熟上游项目（覆盖部分能力，本项目未复用其代码）

| 项目 | star / 许可 | 覆盖的能力 | 缺口（本项目补的） |
|---|---|---|---|
| [THU-MAIC/OpenMAIC](https://github.com/THU-MAIC/OpenMAIC) | 43.4k / MIT | 清华多智能体互动课堂：主题/文档 → 幻灯片、测验、交互仿真、PBL；AI 老师 + AI 同学实时讨论、白板逐步推公式、TTS/语音克隆、web search/fetch、导出 PPTX/HTML/MP4；Q&A 模式 "Ask questions freely; the AI teacher responds with slides, diagrams, or whiteboard drawings" | 预生成整节课（非 lazy）、课堂讨论层面的插话，**不做语音播放中途的 barge-in**，也没有打断后的上下文锚点 |
| [HKUDS/DeepTutor](https://github.com/HKUDS/DeepTutor) | 58.7k / Apache-2.0 | 港大终身个性化 AI 导师：文档 RAG、出题、带旁白讲解视频、掌握度路径、Anki 导出 | 学习工作台形态，交互是文本问答 + 视频播放，无可打断语音 |
| [Omni-Interaction-Gander/Omni-Interaction-Agent](https://github.com/Omni-Interaction-Gander/Omni-Interaction-Agent) | 576 / Apache-2.0 | 腾讯 2026-09 开源的原生全双工交互模型："Talk while it works. Interrupt it, redirect it..."，Cerebellum-Brain 架构，打断/轮次/重叠为模型习得行为 | 通用「边干活边聊」agent，**没有教学状态机 / 白板 / 讲稿分段 / 锚点** |
| [lfnovo/open-notebook](https://github.com/lfnovo/open-notebook) | 41.9k / MIT | 开源 NotebookLM 实现，文档对话 + 播客式音频讲解 | 音频是预生成文件，不能边讲边打断 |
| [souzatharsis/podcastfy](https://github.com/souzatharsis/podcastfy) | 6.8k / Apache-2.0 | PDF/网页 → 多语言双人对话音频 | 同上 |
| [harry0703/MoneyPrinterTurbo](https://github.com/harry0703/MoneyPrinterTurbo) | 143k / MIT | 主题 → 文案 → 素材 → TTS → 字幕 → 合成短视频 | 一次性成片，无交互 |
| [linyqh/NarratoAI](https://github.com/linyqh/NarratoAI) | 11.8k / MIT | AI 解说 + 剪辑 + 配音 + 字幕 | 同上 |

### C. 底层组件（如自行拼装时可替换本项目对应部分）

| 用途 | 项目 | star / 许可 |
|---|---|---|
| 实时语音 + barge-in 框架 | [pipecat-ai/pipecat](https://github.com/pipecat-ai/pipecat)（`InterruptionFrame`） | 17.2k / BSD-2-Clause |
| 实时语音 + WebRTC | [livekit/agents](https://github.com/livekit/agents) | 15.2k / Apache-2.0 |
| 全本地语音链路 | [huggingface/speech-to-speech](https://github.com/huggingface/speech-to-speech) | 13.7k / Apache-2.0 |
| 轻量 barge-in 语音助手 | [fluxions-ai/vui](https://github.com/fluxions-ai/vui) | 777 / Apache-2.0 |
| 中文流式 ASR / VAD | [modelscope/FunASR](https://github.com/modelscope/FunASR) | 21k / MIT |
| TTS / 声音克隆 | [OpenBMB/VoxCPM](https://github.com/OpenBMB/VoxCPM) · [fishaudio/fish-speech](https://github.com/fishaudio/fish-speech) · [myshell-ai/OpenVoice](https://github.com/myshell-ai/OpenVoice) · [hexgrad/kokoro](https://github.com/hexgrad/kokoro) | 42k / 33.7k / 38.2k / 10k |
| 白板画布 | [excalidraw/excalidraw](https://github.com/excalidraw/excalidraw)（MIT）· [tldraw/tldraw](https://github.com/tldraw/tldraw)（自定义许可，商用需核对） | 135k / 51k |
| 代码沙箱（生产替换 `runCode`） | E2B · gVisor · Firecracker | — |

### D. 参考过的资料

- [腾讯全双工语音 Gander 解析（CSDN）](https://blog.csdn.net/weixin_30952479/article/details/170278300)、[混元发布全双工语音 Gander](https://baijiahao.baidu.com/s?id=1876985295361283060&wfr=spider&for=pc)
- [ASR+LLM+TTS 实时语音链路搭建（CSDN）](https://blog.csdn.net/weixin_29800471/article/details/170607374)、[全双工：让语音助手学会被打断（知乎）](https://zhuanlan.zhihu.com/p/2102396257968854907)
- [OpenMAIC 一个 prompt 生成一整间 AI 教室（腾讯云）](https://cloud.tencent.com/developer/article/2735429)、[清华 MAIC 项目页](https://learning.tsinghua.edu.cn/xxyfzxm/aitown/maic.htm)
- [RAG 原始论文 Lewis et al. 2020](https://arxiv.org/abs/2005.11401)、[Lost in the Middle](https://arxiv.org/abs/2307.03172)、[Anthropic Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval)、[RAGAS](https://arxiv.org/abs/2309.15217)（这些是内置演示剧本里引用的教学资料，非代码来源）
- [Google Learn About](https://baike.baidu.com/item/Learn%20About/67319754)（交互形态参考，闭源产品）

---

## 路线图 / 已知限制

- 内置剧本只覆盖 RAG 主题；换主题需实现自己的 `Provider.plan()`。
- `OpenAICompatibleProvider.search()` 明确返回空，联网检索需宿主注入（设计如此，避免硬编码某个搜索服务）。
- 语音层用浏览器 Web Speech API，进度是字数估算（非真实音频时间戳）；生产请换 Pipecat / LiveKit 的 VAD + 时间戳。
- 代码执行是演示级隔离，见上方安全边界。
- 没有做持久化（快照可 JSON 导出，但未接数据库）。

## 许可证

MIT，见 [LICENSE](LICENSE)。

> 本仓库为独立实现。上面「出处」章节列出的项目各自适用其原始许可证；本项目未复制其代码，引用仅用于说明设计来源与形态参考。
