/**
 * InterruptibleTutor —— 可打断的分段讲解引擎（项目核心）。
 *
 * 与「一次性生成整节课」的课件生成器不同，这里的每次 advance() 才生成下一段，
 * 因此讲解过程中可以随时触发检索、生成代码 / 图表，也可以被用户打断。
 *
 * 状态机：
 *   idle --start--> speaking --pause--> paused --resume--> speaking
 *                     |
 *                     +--interrupt--> interrupted --answer--> answering
 *                                          |
 *                                          +--continue(resume|replan|skip)--> speaking / finished
 *   speaking --advance(队列空)--> finished
 *
 * 三个不变量：
 *   1. 只有 PENDING 段会被生成；已生成的段不会因为打断而重新生成。
 *   2. 打断时冻结 ContextAnchor（已讲到哪、白板画到哪、跑过哪些代码）。
 *   3. 续讲 / 重规划时把锚点交给 Provider，作为「不要重复」的硬约束。
 */

import {
  Segment, SegmentStatus, SegmentKind,
  ArtifactType, nextSegmentId, resetSegmentIdCounter,
} from './segments.mjs';
import { ContextAnchor } from './anchors.mjs';
import { MockProvider, createProvider } from './providers.mjs';

export const TutorState = Object.freeze({
  IDLE: 'idle',
  PLANNED: 'planned',   // 大纲已就绪，还没开始讲第一段
  SPEAKING: 'speaking',
  PAUSED: 'paused',
  INTERRUPTED: 'interrupted',
  ANSWERING: 'answering',
  FINISHED: 'finished',
});

export const ContinueMode = Object.freeze({
  RESUME: 'resume',   // 从锚点接着讲当前段
  REPLAN: 'replan',   // 丢弃未讲段，按插话主题重规划
  SKIP: 'skip',       // 跳过当前段，直接讲下一段
});

export class TutorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TutorError';
    this.code = code;
  }
}

const DEFAULT_OPTIONS = {
  topic: 'RAG',
  provider: null,
  now: () => new Date().toISOString(),
  /** 代码产物是否在生成时真正执行（沙箱化由宿主负责，见 runCode） */
  executeCode: true,
  /** 单个代码单元最大输出字符数，防止刷屏 */
  maxCodeOutput: 4000,
};

export class InterruptibleTutor {
  constructor(options = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.topic = this.options.topic;
    this.provider = this.options.provider ?? createProvider();
    this.now = this.options.now;

    this.state = TutorState.IDLE;
    this.queue = [];            // 尚未讲完的 Segment（含当前段）
    this.completed = [];        // 已讲完的 Segment
    this.current = null;        // 当前正在讲的 Segment
    this.spokenFraction = 0;    // 当前段已朗读进度 0..1
    this.anchor = null;         // 最近一次打断冻结的锚点
    this.pendingQuestion = null;
    this.lastAnswer = null;
    this.boardOps = [];         // 白板增量操作记录
    this.executedCells = [];    // 已执行的代码单元
    this.citedSources = [];     // 已引用来源
    this.transcript = [];       // 全量对话记录（含讲解、插话、回答）
    this.events = [];           // 事件日志（SSE 回放用）
    this.listeners = new Set();
    this.startedAt = null;
    this.finishedAt = null;
  }

  // ---------------------------------------------------------------- 事件

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type, payload = {}) {
    const event = { type, at: this.now(), state: this.state, ...payload };
    this.events.push(event);
    for (const fn of this.listeners) {
      try { fn(event); } catch (err) { /* 订阅者异常不影响引擎 */ void err; }
    }
    return event;
  }

  _transcribe(role, text, extra = {}) {
    const entry = { role, text, at: this.now(), ...extra };
    this.transcript.push(entry);
    if (this.transcript.length > 200) this.transcript.shift();
    return entry;
  }

  // ---------------------------------------------------------------- 生命周期

  /** 根据主题规划讲稿大纲；此时不生成任何讲解内容。 */
  async start(topic = this.topic) {
    if (this.state !== TutorState.IDLE) {
      throw new TutorError('ALREADY_STARTED', `当前状态 ${this.state} 不能 start()`);
    }
    this.topic = topic;
    this.startedAt = this.now();
    // 先锁定状态，避免并发 start() 重复规划或覆盖已生成的队列
    this.state = TutorState.PLANNED;
    const specs = await this.provider.plan(topic);
    if (!Array.isArray(specs) || specs.length === 0) {
      this.state = TutorState.IDLE;
      throw new TutorError('EMPTY_PLAN', 'Provider 返回了空的大纲');
    }
    this.queue = specs.map((s) => new Segment({
      kind: s.kind ?? SegmentKind.EXPLAIN,
      title: s.title,
      interruptible: s.interruptible !== false,
      checkpoint: s.checkpoint ?? s.title,
      providerMeta: { ...(s.providerMeta ?? {}), ...(s.narrationIndex !== undefined ? { narrationIndex: s.narrationIndex } : {}) },
    }));
    this.emit('planned', { topic, segmentCount: this.queue.length, outline: this.queue.map((s) => ({ id: s.id, title: s.title, kind: s.kind })) });
    return this.outline();
  }

  outline() {
    return this.queue.map((s) => ({ id: s.id, title: s.title, kind: s.kind, status: s.status }));
  }

  /**
   * 推进到下一段（lazy 生成）。
   * 若当前段还没讲完，会先把它标记为 DONE —— 由调用方决定何时调用。
   */
  async advance({ fraction = 1 } = {}) {
    if (this.state === TutorState.FINISHED) return { finished: true, reason: 'already_finished' };
    if (this.state === TutorState.IDLE) {
      throw new TutorError('NOT_STARTED', '请先调用 start() 规划大纲');
    }
    if (![TutorState.PLANNED, TutorState.SPEAKING].includes(this.state)) {
      throw new TutorError('NOT_SPEAKING', `状态 ${this.state} 下不能 advance()，请先 resume()/continue()`);
    }

    // 结算上一段：标记完成、移出待讲队列、记入 transcript
    if (this.current) {
      this.current.status = SegmentStatus.DONE;
      this.completed.push(this.current);
      this._transcribe('tutor', this.current.narration, { segmentId: this.current.id, kind: this.current.kind });
      this.emit('segment_done', { segmentId: this.current.id, title: this.current.title });
      // queue[0] 就是刚讲完的段，必须出队，否则会反复生成同一段
      if (this.queue[0]?.id === this.current.id) this.queue.shift();
      this.current = null;
      this.spokenFraction = 0;
    }

    if (this.queue.length === 0) {
      this.state = TutorState.FINISHED;
      this.finishedAt = this.now();
      this.emit('finished', { completed: this.completed.length });
      return { finished: true, reason: 'queue_empty' };
    }

    const spec = this.queue[0];
    const anchor = this.anchor; // 上一条锚点（若刚被打断过）
    const generated = await this.provider.generateSegment({ ...spec.toJSON(), ...spec.providerMeta }, anchor);

    spec.narration = generated.narration ?? '';
    spec.artifacts = (generated.artifacts ?? []).map((a) => ({ ...a }));
    spec.status = SegmentStatus.GENERATED;
    spec.generatedAt = this.now();
    if (!spec.createdAt) spec.createdAt = spec.generatedAt;

    this.current = spec;
    this.spokenFraction = 0;
    this.state = TutorState.SPEAKING;
    this.emit('segment_generated', { segment: spec.toJSON(), anchorId: anchor?.id ?? null });

    // 处理这一段附带的产物：白板增量、来源引用、代码执行
    for (const artifact of spec.artifacts) this._applyArtifact(artifact, spec);

    this.emit('speaking', { segmentId: spec.id, narration: spec.narration, fraction: 0 });
    this.anchor = null; // 锚点已被消费一次，避免后续段落误用
    void fraction;
    return { finished: false, segment: spec.toJSON() };
  }

  _applyArtifact(artifact, segment) {
    if (artifact.type === ArtifactType.DIAGRAM) {
      const ops = (artifact.nodes ?? []).map((n) => `节点:${n.label}`)
        .concat((artifact.edges ?? []).map((e) => `连线:${e.from}->${e.to}`));
      this.boardOps.push(...ops);
      this.emit('board', { segmentId: segment.id, ops, diagram: artifact });
    } else if (artifact.type === ArtifactType.SOURCES) {
      const titles = (artifact.items ?? []).map((i) => i.title);
      this.citedSources.push(...titles);
      this.emit('sources', { segmentId: segment.id, items: artifact.items });
    } else if (artifact.type === ArtifactType.CODE) {
      this.emit('code', { segmentId: segment.id, language: artifact.language, source: artifact.source });
      if (this.options.executeCode) {
        const result = runCode(artifact.source, { maxOutput: this.options.maxCodeOutput });
        artifact.output = result.output;
        artifact.error = result.error;
        this.executedCells.push(`${segment.title}:${artifact.language}`);
        this.emit('code_result', { segmentId: segment.id, ...result });
      }
    } else if (artifact.type === ArtifactType.QUIZ) {
      this.emit('quiz', { segmentId: segment.id, quiz: artifact });
    }
  }

  /** 语音层回报朗读进度，供打断时计算锚点。 */
  setSpokenFraction(fraction) {
    if (typeof fraction !== 'number' || Number.isNaN(fraction)) {
      throw new TutorError('BAD_FRACTION', 'fraction 必须是数字');
    }
    this.spokenFraction = Math.max(0, Math.min(1, fraction));
    return this.spokenFraction;
  }

  // ---------------------------------------------------------------- 暂停

  pause() {
    if (this.state !== TutorState.SPEAKING) {
      throw new TutorError('NOT_SPEAKING', `状态 ${this.state} 下不能 pause()`);
    }
    this.state = TutorState.PAUSED;
    this.emit('paused', { segmentId: this.current?.id, fraction: this.spokenFraction });
    return this.snapshot();
  }

  resume() {
    if (this.state !== TutorState.PAUSED && this.state !== TutorState.INTERRUPTED) {
      throw new TutorError('NOT_PAUSED', `状态 ${this.state} 下不能 resume()`);
    }
    this.state = TutorState.SPEAKING;
    this.emit('resumed', { segmentId: this.current?.id, fraction: this.spokenFraction });
    return this.snapshot();
  }

  // ---------------------------------------------------------------- 打断 / 插话

  /**
   * Barge-in：用户开口。
   * 冻结锚点、记录插话，引擎停住等待 AI 回答。
   * 这一步刻意不调用 Provider —— 让宿主有机会先做 VAD、掐断 TTS、清空音频缓冲。
   */
  interrupt(question, { spokenFraction } = {}) {
    if (this.state !== TutorState.SPEAKING && this.state !== TutorState.PAUSED) {
      throw new TutorError('NOT_SPEAKING', `状态 ${this.state} 下不能 interrupt()`);
    }
    if (!question || !String(question).trim()) {
      throw new TutorError('EMPTY_QUESTION', '插话内容不能为空');
    }
    if (spokenFraction !== undefined) this.setSpokenFraction(spokenFraction);

    this.anchor = ContextAnchor.capture({
      segment: this.current,
      spokenFraction: this.spokenFraction,
      boardOps: this.boardOps,
      executedCells: this.executedCells,
      citedSources: this.citedSources,
      completedSegments: this.completed.map((s) => s.title),
      pendingTitles: this.queue.slice(1).map((s) => s.title),
      transcriptTail: this.transcript.slice(-6).map((t) => `${t.role}:${t.text.slice(0, 60)}`),
      now: this.now,
    });

    this.pendingQuestion = String(question).trim();
    this._transcribe('student', this.pendingQuestion, { kind: 'interruption' });
    this.state = TutorState.INTERRUPTED;
    this.emit('interrupted', {
      question: this.pendingQuestion,
      segmentId: this.current?.id,
      fraction: this.spokenFraction,
      anchor: this.anchor.toJSON(),
    });
    return this.anchor.toJSON();
  }

  /** AI 回答插话；问答产物同样可以带代码 / 图表 / 来源。 */
  async answerInterruption(question = this.pendingQuestion) {
    if (this.state !== TutorState.INTERRUPTED) {
      throw new TutorError('NOT_INTERRUPTED', `状态 ${this.state} 下不能 answerInterruption()`);
    }
    const q = String(question ?? '').trim();
    if (!q) throw new TutorError('EMPTY_QUESTION', '插话内容不能为空');
    this.state = TutorState.ANSWERING;
    this.emit('answering', { question: q });

    const result = await this.provider.answer(q, this.anchor);
    const narration = result.narration ?? '';
    const artifacts = (result.artifacts ?? []).map((a) => ({ ...a }));
    this.lastAnswer = { question: q, narration, artifacts };
    this._transcribe('tutor', narration, { kind: 'answer', anchorId: this.anchor?.id });
    this.emit('answer', { question: q, narration, artifacts });

    const answerSegment = new Segment({
      id: nextSegmentId('ans'),
      kind: SegmentKind.ANSWER,
      title: `答：${q.slice(0, 24)}`,
      narration,
      artifacts,
      status: SegmentStatus.DONE,
      origin: 'answer',
      interruptible: false,
    });
    answerSegment.createdAt = this.now();
    answerSegment.generatedAt = answerSegment.createdAt;
    for (const artifact of artifacts) this._applyArtifact(artifact, answerSegment);
    this.completed.push(answerSegment);

    this.state = TutorState.INTERRUPTED; // 等宿主决定怎么继续
    return this.lastAnswer;
  }

  /**
   * 回答之后如何继续。
   *   resume —— 保留队列，用锚点约束重讲当前段剩余部分（引擎会替换 narration）
   *   replan —— 丢弃未讲段，按插话主题重规划
   *   skip   —— 跳过当前段
   */
  async continueAfterInterruption(mode = ContinueMode.RESUME) {
    if (this.state !== TutorState.INTERRUPTED) {
      throw new TutorError('NOT_INTERRUPTED', `状态 ${this.state} 下不能 continue()`);
    }
    if (!Object.values(ContinueMode).includes(mode)) {
      throw new TutorError('BAD_MODE', `未知继续模式：${mode}`);
    }
    const anchor = this.anchor;
    const question = this.pendingQuestion;

    if (mode === ContinueMode.REPLAN) {
      const specs = await this.provider.replan(anchor, question);
      // 保留当前段（已生成，不重复生成），只替换后面未讲的
      const newPending = (specs ?? []).map((s) => new Segment({
        kind: s.kind ?? SegmentKind.EXPLAIN,
        title: s.title,
        origin: 'replan',
        interruptible: s.interruptible !== false,
      }));
      this.queue = this.current ? [this.current, ...newPending] : newPending;
      this.emit('replanned', { question, outline: this.outline() });
    } else if (mode === ContinueMode.SKIP) {
      if (this.current) {
        this.current.status = SegmentStatus.SKIPPED;
        this.completed.push(this.current);
        this.emit('segment_skipped', { segmentId: this.current.id });
      }
      this.queue.shift();
      this.current = null;
      this.spokenFraction = 0;
    } else {
      // RESUME：用锚点让 Provider 生成「续讲版」的当前段文本，避免重复已讲内容
      if (this.current && anchor?.spokenPrefix) {
        const regenerated = await this.provider.generateSegment({ ...this.current.toJSON(), ...this.current.providerMeta }, anchor);
        this.current.narration = regenerated.narration ?? this.current.narration;
        for (const a of (regenerated.artifacts ?? [])) this.current.artifacts.push({ ...a });
        this.emit('resegmented', { segmentId: this.current.id, narration: this.current.narration, anchorId: anchor.id });
      }
    }

    this.state = TutorState.SPEAKING;
    this.pendingQuestion = null;
    this.emit('continued', { mode, segmentId: this.current?.id, anchorPrompt: anchor?.toPrompt() ?? null });
    // 锚点已被 RESUME / REPLAN 消费，必须清空，否则下一段会误用旧锚点
    this.anchor = null;
    return this.snapshot();
  }

  // ---------------------------------------------------------------- 快照 / 恢复

  snapshot() {
    return {
      version: 1,
      topic: this.topic,
      state: this.state,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      current: this.current?.toJSON() ?? null,
      spokenFraction: this.spokenFraction,
      queue: this.queue.map((s) => s.toJSON()),
      completed: this.completed.map((s) => s.toJSON()),
      anchor: this.anchor?.toJSON() ?? null,
      pendingQuestion: this.pendingQuestion,
      lastAnswer: this.lastAnswer,
      boardOps: [...this.boardOps],
      executedCells: [...this.executedCells],
      citedSources: [...this.citedSources],
      transcript: [...this.transcript],
      outline: this.outline(),
    };
  }

  static fromSnapshot(snap, options = {}) {
    const tutor = new InterruptibleTutor({ ...options, topic: snap.topic });
    tutor.state = snap.state;
    tutor.startedAt = snap.startedAt;
    tutor.finishedAt = snap.finishedAt;
    tutor.spokenFraction = snap.spokenFraction ?? 0;
    tutor.queue = (snap.queue ?? []).map(Segment.fromJSON);
    tutor.completed = (snap.completed ?? []).map(Segment.fromJSON);
    tutor.current = snap.current ? Segment.fromJSON(snap.current) : null;
    tutor.anchor = snap.anchor ? ContextAnchor.fromJSON(snap.anchor) : null;
    tutor.pendingQuestion = snap.pendingQuestion ?? null;
    tutor.lastAnswer = snap.lastAnswer ?? null;
    tutor.boardOps = [...(snap.boardOps ?? [])];
    tutor.executedCells = [...(snap.executedCells ?? [])];
    tutor.citedSources = [...(snap.citedSources ?? [])];
    tutor.transcript = [...(snap.transcript ?? [])];
    return tutor;
  }
}

/**
 * 受限代码执行器。
 *
 * 说明：Node 的 vm 模块不是安全边界，这里只是「演示级隔离」——
 * 通过白名单屏蔽 process / require / import / fetch / fs 等，并限制输出与时长。
 * 生产环境请换成 E2B、gVisor、Firecracker 或独立容器（见 README 的安全章节）。
 */
export function runCode(source, { maxOutput = 4000, timeoutMs = 1000 } = {}) {
  const blocked = /\b(require|process|globalThis|eval|Function|fetch|XMLHttpRequest|WebSocket|import\s*\(|child_process|node:fs|fs\s*\.)/.test(source);
  if (blocked) return { ok: false, output: '', error: '代码包含被屏蔽的标识符（演示沙箱只允许纯计算）' };

  const logs = [];
  const sandboxConsole = {
    log: (...args) => logs.push(args.map(formatArg).join(' ')),
    warn: (...args) => logs.push(args.map(formatArg).join(' ')),
    error: (...args) => logs.push(args.map(formatArg).join(' ')),
    info: (...args) => logs.push(args.map(formatArg).join(' ')),
  };

  let output = '';
  try {
    // 用 Function 构造一个只能看到 console 与标准内置对象的函数体
    // eslint-disable-next-line no-new-func
    const fn = new Function('console', `"use strict";\n${source}`);
    const started = Date.now();
    fn(sandboxConsole);
    output = logs.join('\n').slice(0, maxOutput);
    if (Date.now() - started > timeoutMs) {
      return { ok: true, output, error: null, warning: `执行耗时超过 ${timeoutMs}ms（演示沙箱无硬超时）` };
    }
    return { ok: true, output, error: null };
  } catch (err) {
    return { ok: false, output: logs.join('\n').slice(0, maxOutput), error: String(err?.message ?? err) };
  }
}

function formatArg(a) {
  if (typeof a === 'string') return a;
  try { return JSON.stringify(a); } catch { return String(a); }
}

/** 测试辅助：重置全局序号，保证单测可重复。 */
export function __resetForTests() {
  resetSegmentIdCounter();
}

export { Segment, SegmentStatus, SegmentKind, ContextAnchor, MockProvider, createProvider };
