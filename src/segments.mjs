/**
 * 讲稿分段模型。
 *
 * 设计要点：一节课不是一整段文本，而是一串带「可中断边界」的 Segment。
 * 每个 Segment 只在被推进到时才生成（lazy generation），这样：
 *   1. 讲解过程中才能按需触发检索 / 生成代码 / 画图；
 *   2. 打断后可以从干净的边界续讲，而不必丢弃整段生成结果；
 *   3. 插话改变方向时，可以只重规划「还没讲」的段。
 */

export const SegmentKind = Object.freeze({
  INTRO: 'intro',
  EXPLAIN: 'explain',
  DIAGRAM: 'diagram',
  CODE: 'code',
  SOURCES: 'sources',
  CHECK: 'check',
  SUMMARY: 'summary',
  ANSWER: 'answer',
});

/** 段的状态机：只讲过 pending -> generated -> speaking -> done 的段才进历史。 */
export const SegmentStatus = Object.freeze({
  PENDING: 'pending',
  GENERATED: 'generated',
  SPEAKING: 'speaking',
  DONE: 'done',
  SKIPPED: 'skipped',
});

let seq = 0;

export function nextSegmentId(prefix = 'seg') {
  seq += 1;
  return `${prefix}-${String(seq).padStart(3, '0')}`;
}

export function resetSegmentIdCounter() {
  seq = 0;
}

/**
 * 一个可中断的讲解段。
 * @typedef {object} SegmentSpec
 * @property {string} id
 * @property {string} kind            SegmentKind 之一
 * @property {string} title           大纲里的标题（生成前就有）
 * @property {string} [narration]    讲解文本，lazy 生成后才有
 * @property {Array}  [artifacts]    生成时附带的产物：code / diagram / sources / quiz
 * @property {boolean}[interruptible=true] 是否允许在此段中途打断
 * @property {string} [checkpoint]   讲完此段后的知识点锚，用于续讲时提示 LLM
 */
export class Segment {
  constructor({
    id = nextSegmentId(),
    kind = SegmentKind.EXPLAIN,
    title,
    narration = '',
    artifacts = [],
    interruptible = true,
    checkpoint = '',
    status = SegmentStatus.PENDING,
    origin = 'plan',
    providerMeta = {},
  }) {
    if (!title) throw new TypeError('Segment 需要 title');
    this.id = id;
    this.kind = kind;
    this.title = title;
    this.narration = narration;
    this.artifacts = artifacts;
    this.interruptible = interruptible;
    this.checkpoint = checkpoint;
    this.status = status;
    this.origin = origin; // plan | replan | answer
    this.providerMeta = { ...providerMeta }; // Provider 自定义元数据，引擎不解释
    this.createdAt = null;
    this.generatedAt = null;
  }

  get isGenerated() {
    return this.status !== SegmentStatus.PENDING;
  }

  toJSON() {
    return {
      id: this.id,
      kind: this.kind,
      title: this.title,
      narration: this.narration,
      artifacts: this.artifacts,
      interruptible: this.interruptible,
      checkpoint: this.checkpoint,
      status: this.status,
      origin: this.origin,
      providerMeta: { ...this.providerMeta },
      createdAt: this.createdAt,
      generatedAt: this.generatedAt,
    };
  }

  static fromJSON(json) {
    const s = new Segment({ ...json, id: json.id });
    s.createdAt = json.createdAt ?? null;
    s.generatedAt = json.generatedAt ?? null;
    return s;
  }
}

/** 段产物：可执行代码、结构化图、检索来源、小测验。 */
export const ArtifactType = Object.freeze({
  CODE: 'code',
  DIAGRAM: 'diagram',
  SOURCES: 'sources',
  QUIZ: 'quiz',
});

export function codeArtifact({ language = 'javascript', source, title = '' }) {
  return { type: ArtifactType.CODE, language, source, title, output: null, error: null };
}

export function diagramArtifact({ nodes, edges, title = '' }) {
  return { type: ArtifactType.DIAGRAM, nodes, edges, title };
}

export function sourcesArtifact({ items, title = '' }) {
  return { type: ArtifactType.SOURCES, items, title };
}

export function quizArtifact({ question, choices, answerIndex, explanation }) {
  return { type: ArtifactType.QUIZ, question, choices, answerIndex, explanation };
}
