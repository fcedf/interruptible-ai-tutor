/**
 * Provider 接口与两个实现。
 *
 * 关键设计：Provider 只负责「内容从哪来」，完全不知道打断、锚点、状态机。
 * 这样 AI agent 可以在不动引擎的前提下，把 MockProvider 换成任意真实模型。
 *
 * 接口（全部可选，返回 Promise）：
 *   plan(topic, ctx)                    -> SegmentSpec[]
 *   generateSegment(spec, anchor, ctx) -> { narration, artifacts[] }
 *   answer(question, anchor, ctx)      -> { narration, artifacts[] }
 *   search(query, ctx)                 -> { items: [{title,url,snippet}] }
 *   replan(anchor, question, ctx)      -> SegmentSpec[]
 *   drawDiagram(spec, ctx)             -> { nodes, edges }
 */

import { codeArtifact, diagramArtifact, sourcesArtifact, quizArtifact } from './segments.mjs';

/** 内置 RAG 讲解剧本。零依赖、零 API key，用于演示与单测。 */
const RAG_PLAN = [
  { kind: 'intro', title: 'RAG 解决的到底是什么问题' },
  { kind: 'explain', title: '为什么不能只靠模型参数里的知识' },
  { kind: 'diagram', title: '检索增强生成的整体流程' },
  { kind: 'explain', title: '离线的第一步：切分与向量化' },
  { kind: 'code', title: '现场生成并运行一段检索代码' },
  { kind: 'sources', title: '检索到的资料与出处' },
  { kind: 'explain', title: '重排与最终生成' },
  { kind: 'check', title: '随堂小测：RAG 的边界在哪' },
  { kind: 'summary', title: '小结' },
];

/**
 * 讲稿按大纲顺序存放（不能用 kind 做 key —— 一节课里会有多个 explain/code 段）。
 * 下标与 RAG_PLAN 一一对应。
 */
const RAG_NARRATION = [
  '我们先把问题说清楚。你问「RAG 是什么」，多数回答会直接背定义，但那没用。真正的问题是：一个语言模型的知识被冻结在训练结束那一刻，它既不知道你公司内部文档，也不知道上周刚发的论文。RAG，也就是检索增强生成，做的事只有一件——在回答之前，先去外部把相关资料取回来，再让模型基于这些资料作答。',
  '为什么不能干脆把资料全塞进参数里？三个原因。第一，成本高：微调一次不便宜，而且资料每天都在变。第二，不可追溯：模型记住了但说不出出处，出错时你没法核对。第三，权限：不同人能看的文档不一样，参数里没法做访问控制。RAG 把「知识」和「推理」解耦，知识留在可更新的库里，推理交给模型。',
  '来看整体流程，我一边说一边把这张图补上。用户的 query 先经过同样的向量化，然后去向量库做近似最近邻检索，取回 top-k 个片段；接着可选地做一次重排，把最相关的片段排到前面；最后把这些片段和原问题一起拼进 prompt，交给模型生成答案。注意箭头是双向的：离线建库和在线查询用的是同一个 embedding 模型。',
  '离线部分从切分开始。文档按语义或固定长度切成 chunk，通常几百个 token，带一点重叠避免把一句话切断。每个 chunk 过一遍 embedding 模型变成向量，连同原文和元数据一起存进向量库。这一步只做一次，之后文档更新时增量重建即可。切分策略其实比选哪个向量库更影响最终效果。',
  '光讲没感觉，我现在现场生成一段最小可运行的检索代码并真正执行它，你可以看到每一步取回了什么。这段代码不依赖任何第三方库，用一个玩具级的词频向量演示「向量化 → 相似度 → top-k」的完整链路。',
  '这是刚才会话里实际用到的资料。真实系统里这一步由 web_search 或你自己的知识库返回，每条都带 URL，生成答案时会标注引用位置，方便你回查。',
  '取回 top-k 之后别直接拼进 prompt。检索是「粗筛」，它按向量距离排序，但向量距离不等于「能回答这个问题」。工程上常加一个 cross-encoder 重排器，把 k 从 20 压到 5，再按 token 预算截断。然后才是生成：明确要求模型只依据给定片段回答，超出范围就说不知道。这一步的 prompt 约束决定了 RAG 会不会依然胡编。',
  '讲到这里停一下，考你一个边界问题：如果检索回来的片段本身就是错的，RAG 能保证答案正确吗？先想十秒，我等你。',
  '小结一下三条：RAG 把知识与推理解耦，因此可更新、可追溯、可做权限；典型链路是切分、向量化、检索、重排、生成；而效果瓶颈往往不在模型，在切分策略和重排。下一步你可以问「混合检索怎么做」或者「怎么评估 RAG」，我们接着往下讲。',
];

const RAG_CODE = `// 玩具级检索：词频向量 + 余弦相似度 + top-k
// 真实系统会把 tf 换成 embedding 模型，把线性扫描换成向量索引
const docs = [
  'RAG 在生成前检索外部资料，让答案可追溯',
  '向量库存储切分后的片段以及对应的 embedding',
  '重排器把粗筛结果按与问题的相关度重新排序',
  '切分策略通常比向量库的选型更影响最终效果',
];
const query = 'RAG 为什么可追溯，重排做什么';

const tokenize = (s) => s.toLowerCase().match(/[a-z0-9\\u4e00-\\u9fa5]+/g) || [];
const vec = (s) => {
  const v = new Map();
  for (const t of tokenize(s)) v.set(t, (v.get(t) || 0) + 1);
  return v;
};
const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (const [, x] of a) na += x * x;
  for (const [, y] of b) nb += y * y;
  for (const [k, x] of a) if (b.has(k)) dot += x * b.get(k);
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};
const q = vec(query);
const ranked = docs
  .map((d, i) => ({ i, d, score: +cosine(q, vec(d)).toFixed(3) }))
  .sort((a, b) => b.score - a.score);
const topK = ranked.slice(0, 2);
console.log('query:', query);
console.log('top-2:', JSON.stringify(topK, null, 2));
console.log('结论: 检索只做粗筛，排序不等于可回答性，所以还要重排');`;

const RAG_DIAGRAM = {
  nodes: [
    { id: 'q', label: '用户问题', type: 'input' },
    { id: 'emb', label: 'Embedding 模型', type: 'model' },
    { id: 'index', label: '向量库 / 文档切片', type: 'store' },
    { id: 'retr', label: '近似最近邻检索 top-k', type: 'step' },
    { id: 'rerank', label: '重排器 (可选)', type: 'step' },
    { id: 'llm', label: 'LLM 生成答案', type: 'model' },
    { id: 'ans', label: '带出处的回答', type: 'output' },
  ],
  edges: [
    { from: 'q', to: 'emb', label: '向量化' },
    { from: 'emb', to: 'retr', label: 'query 向量' },
    { from: 'index', to: 'retr', label: '相似片段' },
    { from: 'index', to: 'emb', label: '离线：同一模型建库', dashed: true },
    { from: 'retr', to: 'rerank', label: 'k=20' },
    { from: 'rerank', to: 'llm', label: 'k=5 + 问题' },
    { from: 'llm', to: 'ans', label: '只依据给定片段' },
  ],
};

const RAG_SOURCES = [
  { title: 'Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks (Lewis et al., 2020)', url: 'https://arxiv.org/abs/2005.11401', snippet: 'RAG 原始论文：把参数化记忆与非参数化记忆结合。' },
  { title: 'Lost in the Middle: How Language Models Use Long Contexts (Liu et al., 2023)', url: 'https://arxiv.org/abs/2307.03172', snippet: '解释为什么片段在 prompt 中的位置与重排很重要。' },
  { title: 'Anthropic — Contextual Retrieval', url: 'https://www.anthropic.com/news/contextual-retrieval', snippet: '通过为切片补充上下文显著降低检索失败率。' },
];

const RAG_QUIZ = {
  question: '如果检索回来的片段本身包含错误，下面哪个说法最准确？',
  choices: [
    'A. RAG 会自动纠正，因为模型会交叉验证',
    'B. RAG 不保证正确，它只是把「答案依据」从参数换成了可检查的片段',
    'C. 只要用了重排器就不会出错',
    'D. 换更大的 embedding 模型可以消除错误',
  ],
  answerIndex: 1,
  explanation: 'RAG 改变的是知识来源与可追溯性，不是事实性的保证。片段错了、切分丢了上下文、或问题超出库覆盖范围，答案照样会错——只是现在你能查到它依据了什么。',
};

export class MockProvider {
  constructor({ topic = 'RAG', now = () => new Date().toISOString() } = {}) {
    this.topic = topic;
    this.now = now;
    this.calls = [];
  }

  _log(name, args) {
    this.calls.push({ name, args, at: this.now() });
  }

  async plan(askedTopic) {
    this._log('plan', { askedTopic });
    // 把大纲序号带进 spec，generateSegment 才能取到对应讲稿（同一 kind 会出现多次）
    return RAG_PLAN.map((s, index) => ({ ...s, narrationIndex: index }));
  }

  async generateSegment(spec, anchor) {
    this._log('generateSegment', { kind: spec.kind, title: spec.title, index: spec.narrationIndex, anchorId: anchor?.id ?? null });
    const base = RAG_NARRATION[spec.narrationIndex] ?? `这一节讲 ${spec.title}。我们分几步把它拆开。`;
    const narration = anchor?.spokenPrefix
      ? `接着刚才的问题说回「${spec.title}」。${base}`
      : base;

    const artifacts = [];
    if (spec.kind === 'diagram') artifacts.push(diagramArtifact({ ...RAG_DIAGRAM, title: spec.title }));
    if (spec.kind === 'code') artifacts.push(codeArtifact({ language: 'javascript', source: RAG_CODE, title: spec.title }));
    if (spec.kind === 'sources') artifacts.push(sourcesArtifact({ items: RAG_SOURCES, title: spec.title }));
    if (spec.kind === 'check') artifacts.push(quizArtifact(RAG_QUIZ));
    return { narration, artifacts };
  }

  async answer(question, anchor) {
    this._log('answer', { question, anchorId: anchor?.id ?? null });
    const q = question.trim();
    let narration;
    const artifacts = [];

    if (/混合|bm25|关键词|hybrid/i.test(q)) {
      narration = '好问题，插一句。混合检索就是把稠密向量检索和 BM25 这类稀疏关键词检索的结果合并，常用 RRF（倒数排名融合）加权。向量检索擅长语义相近，BM25 擅长精确术语、编号和专有名词——RAG 里查「error 503」这种，纯向量反而容易漏。合并之后仍然接重排器，然后再回到主线。';
      artifacts.push(diagramArtifact({
        title: '混合检索',
        nodes: [
          { id: 'q', label: 'query' },
          { id: 'dense', label: '向量检索' },
          { id: 'sparse', label: 'BM25 检索' },
          { id: 'rrf', label: 'RRF 融合' },
          { id: 'rerank', label: '重排' },
        ],
        edges: [
          { from: 'q', to: 'dense' }, { from: 'q', to: 'sparse' },
          { from: 'dense', to: 'rrf' }, { from: 'sparse', to: 'rrf' }, { from: 'rrf', to: 'rerank' },
        ],
      }));
    } else if (/评估|评测|指标|eval/i.test(q)) {
      narration = '插一句评估。RAG 要拆成两段测，别只测最终答案：检索段看 recall@k 和 MRR，生成段看 faithfulness（是否只依据给定片段）和 answer relevance。常见坑是拿一个端到端准确率把两段问题混在一起，结果不知道该改切分还是改 prompt。好，我们回到刚才的主线。';
      artifacts.push(sourcesArtifact({
        title: 'RAG 评估常用指标',
        items: [
          { title: 'RAGAS: Automated Evaluation of Retrieval Augmented Generation', url: 'https://arxiv.org/abs/2309.15217', snippet: 'faithfulness / answer relevancy / context precision 等无参考评估指标。' },
          { title: 'ARES: An Automated Evaluation Framework for RAG Systems', url: 'https://arxiv.org/abs/2311.09476', snippet: '用少量标注数据训练轻量评判器。' },
        ],
      }));
    } else if (/代码|跑一下|执行|code/i.test(q)) {
      narration = '可以，我现场补一段代码并跑给你看，你看输出就行。这段是把刚才的 top-k 结果再做一次简单的关键词加权重排。看完我们接着讲。';
      artifacts.push(codeArtifact({
        language: 'javascript',
        title: '关键词加权重排（插话生成）',
        source: `const cands = [\n  { text: '重排器按相关度重新排序片段', vec: 0.81 },\n  { text: '切分策略影响检索效果', vec: 0.77 },\n  { text: 'RAG 让答案可追溯', vec: 0.72 },\n];\nconst keywords = ['重排', '相关度'];\nconst reranked = cands\n  .map(c => ({ ...c, boost: keywords.filter(k => c.text.includes(k)).length * 0.1 }))\n  .map(c => ({ ...c, final: +(c.vec + c.boost).toFixed(2) }))\n  .sort((a, b) => b.final - a.final);\nconsole.log('重排后:', JSON.stringify(reranked, null, 2));`,
      }));
    } else {
      narration = `先回答你的插话：「${q}」。这属于 ${this.topic} 里需要结合检索才能讲准的部分——我会把它记进白板，讲完当前主线后单开一段展开。现在先回到刚才被打断的地方。`;
    }
    return { narration, artifacts };
  }

  async search(query) {
    this._log('search', { query });
    return { items: RAG_SOURCES };
  }

  async replan(anchor, question) {
    this._log('replan', { anchorId: anchor?.id ?? null, question });
    return [
      { kind: 'answer', title: `展开：${question.slice(0, 24)}` },
      { kind: 'explain', title: '把插话主题放回 RAG 主线' },
      { kind: 'check', title: '确认理解' },
      { kind: 'summary', title: '小结' },
    ];
  }
}

/**
 * OpenAI 兼容 HTTP Provider（真实模型）。
 * 用 fetch，不引第三方 SDK；任何兼容 /chat/completions 的服务都能接。
 * 未配置 TUTOR_LLM_* 时不会被实例化。
 */
export class OpenAICompatibleProvider {
  constructor({
    baseUrl = process.env.TUTOR_LLM_BASE_URL ?? 'https://api.openai.com/v1',
    apiKey = process.env.TUTOR_LLM_API_KEY ?? process.env.OPENAI_API_KEY,
    model = process.env.TUTOR_LLM_MODEL ?? 'gpt-4o-mini',
    systemPrompt,
  } = {}) {
    if (!apiKey) throw new Error('OpenAICompatibleProvider 需要 TUTOR_LLM_API_KEY 或 OPENAI_API_KEY');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.model = model;
    this.systemPrompt = systemPrompt ?? '你是一位逐步讲解的 AI 导师。只讲当前这一段，不要一次性讲完全部内容；需要时给出可运行代码或结构化流程图。';
    this.calls = [];
  }

  async _chat(messages, { json = false } = {}) {
    this.calls.push({ at: new Date().toISOString(), messages: messages.length });
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'system', content: this.systemPrompt }, ...messages],
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? '';
  }

  async plan(topic) {
    const raw = await this._chat([
      { role: 'user', content: `把主题「${topic}」拆成 6-9 个可独立讲解的段落。只输出 JSON：{"segments":[{"kind":"intro|explain|diagram|code|sources|check|summary","title":"..."}]}` },
    ], { json: true });
    return JSON.parse(raw).segments;
  }

  async generateSegment(spec, anchor) {
    const raw = await this._chat([
      { role: 'user', content: `${anchor?.toPrompt?.() ?? ''}\n\n现在只讲这一段：${spec.title}（类型 ${spec.kind}）。输出 150-300 字讲解文本，不要讲后面的段落。${spec.kind === 'code' ? '附一段可运行 JavaScript 代码，用 <code> 标签包起来。' : ''}` },
    ]);
    const artifacts = [];
    const m = raw.match(/<code>([\s\S]*?)<\/code>/);
    if (m) artifacts.push(codeArtifact({ language: 'javascript', source: m[1].trim(), title: spec.title }));
    return { narration: raw.replace(/<code>[\s\S]*?<\/code>/g, '').trim(), artifacts };
  }

  async answer(question, anchor) {
    const narration = await this._chat([
      { role: 'user', content: `${anchor?.toPrompt?.() ?? ''}\n\n学生中途插话：「${question}」。先用一两句话直接回答，然后说明会怎么接回主线。不要展开成完整新课。` },
    ]);
    return { narration: narration.trim(), artifacts: [] };
  }

  async search(query) {
    // 真实联网检索留给宿主注入（MCP / 自建检索服务），这里明确返回空并提示。
    return { items: [], note: `需要宿主提供检索工具以查询：${query}` };
  }

  async replan(anchor, question) {
    const raw = await this._chat([
      { role: 'user', content: `${anchor?.toPrompt?.() ?? ''}\n\n学生插话：「${question}」后希望改变后续讲解方向。只输出 JSON：{"segments":[{"kind":"...","title":"..."}]}，3-5 段，只包含还没讲的内容。` },
    ], { json: true });
    return JSON.parse(raw).segments;
  }
}

export function createProvider(opts = {}) {
  if (opts.mock === false || process.env.TUTOR_LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.TUTOR_LLM_BASE_URL) {
    try {
      return new OpenAICompatibleProvider(opts);
    } catch {
      return new MockProvider(opts);
    }
  }
  return new MockProvider(opts);
}
