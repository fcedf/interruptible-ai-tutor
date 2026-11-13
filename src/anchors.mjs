/**
 * Barge-in 上下文锚点。
 *
 * 这是「可暂停并插话」真正难的部分：停掉 TTS 只是第一步，
 * 更难的是回答完插话之后，AI 得知道「刚才讲到哪、白板画到哪、代码跑到哪、引用了哪些资料」，
 * 否则续讲会重复、跳步，或者把已经画过的图再画一遍。
 *
 * ContextAnchor 把这些信息冻结成一个可序列化的快照，并提供 toPrompt()，
 * 在续讲 / 重规划时作为硬约束注入给 LLM。
 */

let anchorSeq = 0;

export class ContextAnchor {
  constructor({
    id,
    segmentId,
    segmentTitle,
    segmentKind,
    spokenPrefix,
    spokenFraction,
    boardOps = [],
    executedCells = [],
    citedSources = [],
    completedSegments = [],
    pendingTitles = [],
    transcriptTail = [],
    capturedAt,
  }) {
    this.id = id;
    this.segmentId = segmentId;
    this.segmentTitle = segmentTitle;
    this.segmentKind = segmentKind;
    this.spokenPrefix = spokenPrefix;
    this.spokenFraction = spokenFraction;
    this.boardOps = boardOps;
    this.executedCells = executedCells;
    this.citedSources = citedSources;
    this.completedSegments = completedSegments;
    this.pendingTitles = pendingTitles;
    this.transcriptTail = transcriptTail;
    this.capturedAt = capturedAt;
  }

  static capture({
    segment,
    spokenFraction = 0,
    boardOps = [],
    executedCells = [],
    citedSources = [],
    completedSegments = [],
    pendingTitles = [],
    transcriptTail = [],
    now = () => new Date().toISOString(),
  }) {
    anchorSeq += 1;
    const narration = segment?.narration ?? '';
    const cut = Math.max(0, Math.min(narration.length, Math.floor(narration.length * spokenFraction)));
    // 尽量在句子边界截断，避免把半句话当成「已讲过」
    let prefix = narration.slice(0, cut);
    // 回退到最近一个句末标点，保证「已讲过」永远是完整句子；
    // 只有 narration 本身还没到句末（例如只有一句且被打断在一半）时，才保留原文前缀。
    const lastStop = Math.max(
      prefix.lastIndexOf('。'),
      prefix.lastIndexOf('！'),
      prefix.lastIndexOf('？'),
      prefix.lastIndexOf('. '),
    );
    if (lastStop >= 0) prefix = prefix.slice(0, lastStop + 1);
    else if (prefix.length < narration.length) prefix = '';

    return new ContextAnchor({
      id: `anchor-${String(anchorSeq).padStart(3, '0')}`,
      segmentId: segment?.id ?? null,
      segmentTitle: segment?.title ?? '',
      segmentKind: segment?.kind ?? null,
      spokenPrefix: prefix,
      spokenFraction,
      boardOps: [...boardOps],
      executedCells: [...executedCells],
      citedSources: [...citedSources],
      completedSegments: [...completedSegments],
      pendingTitles: [...pendingTitles],
      transcriptTail: [...transcriptTail],
      capturedAt: now(),
    });
  }

  /** 生成续讲约束：明确告诉模型不要重复、从哪里接、白板上已有什么。 */
  toPrompt() {
    const lines = [
      '[续讲约束 / CONTEXT ANCHOR]',
      `打断发生在段「${this.segmentTitle}」(${this.segmentKind ?? 'unknown'})。`,
    ];
    if (this.spokenPrefix) {
      lines.push(`已经讲过的内容（不要重复，也不要推翻）：「${this.spokenPrefix}」`);
    } else {
      lines.push('这一段还没开始讲，可以从头讲。');
    }
    if (this.completedSegments.length) {
      lines.push(`已完成段落：${this.completedSegments.join(' / ')}。`);
    }
    if (this.boardOps.length) {
      lines.push(`白板上已经画了 ${this.boardOps.length} 步：${this.boardOps.join(' / ')}；只增量添加，不要重画。`);
    } else {
      lines.push('白板目前是空的。');
    }
    if (this.executedCells.length) {
      lines.push(`已经执行并展示过的代码：${this.executedCells.join(' / ')}；不要重复运行同一段。`);
    }
    if (this.citedSources.length) {
      lines.push(`已引用来源：${this.citedSources.join(' / ')}；引用新来源时再补充说明。`);
    }
    lines.push('续讲时先一句话回应用户刚才的插话，然后自然接回原主线。');
    return lines.join('\n');
  }

  toJSON() {
    return {
      id: this.id,
      segmentId: this.segmentId,
      segmentTitle: this.segmentTitle,
      segmentKind: this.segmentKind,
      spokenPrefix: this.spokenPrefix,
      spokenFraction: this.spokenFraction,
      boardOps: this.boardOps,
      executedCells: this.executedCells,
      citedSources: this.citedSources,
      completedSegments: this.completedSegments,
      pendingTitles: this.pendingTitles,
      transcriptTail: this.transcriptTail,
      capturedAt: this.capturedAt,
    };
  }

  static fromJSON(json) {
    const a = new ContextAnchor({ ...json });
    return a;
  }
}
