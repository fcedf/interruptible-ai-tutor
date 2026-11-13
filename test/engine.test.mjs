import test from 'node:test';
import assert from 'node:assert/strict';

import {
  InterruptibleTutor, ContinueMode, TutorState, TutorError,
  runCode, __resetForTests,
} from '../src/engine.mjs';
import { MockProvider } from '../src/providers.mjs';
import { Segment, SegmentStatus, SegmentKind } from '../src/segments.mjs';
import { ContextAnchor } from '../src/anchors.mjs';

const now = () => '2026-11-13T00:00:00.000Z';

function makeTutor(extra = {}) {
  __resetForTests();
  return new InterruptibleTutor({ provider: new MockProvider(), now, ...extra });
}

// ---------------------------------------------------------------- 分段模型

test('Segment 需要 title，且默认是可中断的 PENDING 段', () => {
  assert.throws(() => new Segment({}), TypeError);
  const s = new Segment({ title: '讲 RAG', kind: SegmentKind.EXPLAIN });
  assert.equal(s.status, SegmentStatus.PENDING);
  assert.equal(s.isGenerated, false);
  assert.equal(s.interruptible, true);
  assert.equal(s.kind, 'explain');
});

test('Segment 可 JSON 往返，保留 artifacts 与 timestamps', () => {
  const s = new Segment({ title: '代码段', kind: SegmentKind.CODE, artifacts: [{ type: 'code', source: '1+1' }] });
  s.status = SegmentStatus.DONE;
  s.createdAt = now();
  const restored = Segment.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
  assert.equal(restored.title, '代码段');
  assert.equal(restored.status, 'done');
  assert.equal(restored.artifacts[0].source, '1+1');
  assert.equal(restored.createdAt, now());
});

// ---------------------------------------------------------------- 锚点

test('ContextAnchor.capture 在句子边界截断，不会把半句话记为已讲', () => {
  const seg = new Segment({ title: 'A', kind: 'explain', narration: '第一句讲完了。第二句讲完了。第三句还没讲完。' });
  const a = ContextAnchor.capture({ segment: seg, spokenFraction: 0.55, now });
  // 0.55 * 27 ≈ 15 字符，应落在「第一句讲完了。」之后
  assert.ok(a.spokenPrefix.endsWith('。'));
  assert.ok(a.spokenPrefix.includes('第一句'));
  assert.ok(!a.spokenPrefix.includes('第三句'));
});

test('ContextAnchor.toPrompt 明确给出「不要重复」与白板/代码状态', () => {
  const seg = new Segment({ title: '检索流程', kind: 'diagram', narration: '先看整体流程。' });
  const a = ContextAnchor.capture({
    segment: seg, spokenFraction: 1,
    boardOps: ['节点:用户问题', '连线:q->emb'],
    executedCells: ['检索代码:javascript'],
    citedSources: ['RAG 论文'],
    completedSegments: ['导论'],
    now,
  });
  const p = a.toPrompt();
  assert.match(p, /不要重复/);
  assert.match(p, /白板上已经画了 2 步/);
  assert.match(p, /不要重复运行同一段/);
  assert.match(p, /已引用来源：RAG 论文/);
  assert.match(p, /已完成段落：导论/);
});

test('ContextAnchor JSON 往返无损', () => {
  const a = ContextAnchor.capture({ segment: new Segment({ title: 'X', narration: '你好。' }), spokenFraction: 0.5, now });
  const b = ContextAnchor.fromJSON(JSON.parse(JSON.stringify(a.toJSON())));
  assert.equal(b.id, a.id);
  assert.equal(b.spokenPrefix, a.spokenPrefix);
  assert.equal(b.capturedAt, now());
});

// ---------------------------------------------------------------- 生命周期

test('start() 只规划大纲，不生成任何讲解文本（lazy generation）', async () => {
  const t = makeTutor();
  const outline = await t.start('RAG');
  assert.equal(t.state, TutorState.PLANNED);
  assert.ok(outline.length >= 6);
  assert.ok(outline.every((s) => s.status === SegmentStatus.PENDING));
  assert.equal(t.provider.calls.filter((c) => c.name === 'generateSegment').length, 0,
    '规划阶段不应调用生成');
  assert.equal(t.events[0].type, 'planned');
});

test('advance() 一次只生成一个段，并推进状态到 speaking', async () => {
  const t = makeTutor();
  await t.start();
  const r = await t.advance();
  assert.equal(r.finished, false);
  assert.equal(t.state, TutorState.SPEAKING);
  assert.ok(r.segment.narration.length > 20);
  assert.equal(t.queue.length, 9, '队列长度不变，只是首段被生成');
  assert.equal(t.provider.calls.filter((c) => c.name === 'generateSegment').length, 1);
});

test('advance() 结算上一段并把它移入 completed', async () => {
  const t = makeTutor();
  await t.start();
  await t.advance();
  t.setSpokenFraction(1);
  await t.advance();
  assert.equal(t.completed.length, 1);
  assert.equal(t.completed[0].status, SegmentStatus.DONE);
  assert.equal(t.transcript[0].role, 'tutor');
});

test('连续 advance() 直到队列空会进入 finished，且不会越界', async () => {
  const t = makeTutor();
  await t.start();
  let guard = 0;
  let r;
  do {
    r = await t.advance();
    guard += 1;
  } while (!r.finished && guard < 30);
  assert.equal(t.state, TutorState.FINISHED);
  assert.equal(r.reason, 'queue_empty');
  assert.equal(t.completed.length, 9);
  const after = await t.advance();
  assert.equal(after.reason, 'already_finished');
});

test('重复 start() 抛 ALREADY_STARTED', async () => {
  const t = makeTutor();
  await t.start();
  await assert.rejects(() => t.start(), (e) => e instanceof TutorError && e.code === 'ALREADY_STARTED');
});

// ---------------------------------------------------------------- 产物：代码 / 图 / 来源

test('diagram 段会把节点与连线累加到白板，不会重画已有内容', async () => {
  const t = makeTutor();
  await t.start();
  for (let i = 0; i < 3; i += 1) await t.advance();
  assert.ok(t.boardOps.length >= 10, '流程图的节点+连线应进入白板');
  assert.ok(t.boardOps.some((o) => o.startsWith('节点:')));
  assert.ok(t.boardOps.some((o) => o.startsWith('连线:')));
  assert.ok(t.events.some((e) => e.type === 'board'));
});

test('code 段会真正执行代码并把输出写回 artifact', async () => {
  const t = makeTutor();
  await t.start();
  for (let i = 0; i < 5; i += 1) await t.advance();
  const codeSeg = t.current;
  assert.equal(codeSeg.kind, SegmentKind.CODE);
  const art = codeSeg.artifacts.find((a) => a.type === 'code');
  assert.ok(art, '应生成代码产物');
  assert.equal(art.error, null, `代码应无执行错误：${art.error}`);
  assert.match(art.output, /top-2/);
  assert.match(art.output, /结论/);
  assert.equal(t.executedCells.length, 1);
  assert.ok(t.events.some((e) => e.type === 'code_result' && e.ok === true));
});

test('sources 段记录引用来源', async () => {
  const t = makeTutor();
  await t.start();
  for (let i = 0; i < 6; i += 1) await t.advance();
  assert.ok(t.citedSources.length >= 2);
  assert.ok(t.citedSources.some((s) => s.includes('Lewis')));
});

// ---------------------------------------------------------------- 暂停 / 恢复

test('pause/resume 状态迁移，非法顺序抛错', async () => {
  const t = makeTutor();
  await t.start();
  assert.throws(() => t.pause(), (e) => e.code === 'NOT_SPEAKING');
  await t.advance();
  assert.equal(t.pause().state, TutorState.PAUSED);
  assert.equal(t.resume().state, TutorState.SPEAKING);
  assert.throws(() => t.resume(), (e) => e.code === 'NOT_PAUSED');
});

test('setSpokenFraction 夹紧到 [0,1]，非数字抛 BAD_FRACTION', async () => {
  const t = makeTutor();
  await t.start();
  await t.advance();
  assert.equal(t.setSpokenFraction(5), 1);
  assert.equal(t.setSpokenFraction(-3), 0);
  assert.throws(() => t.setSpokenFraction('abc'), (e) => e.code === 'BAD_FRACTION');
});

// ---------------------------------------------------------------- 打断 / 插话（核心）

test('interrupt() 冻结锚点，记录插话，状态变 interrupted', async () => {
  const t = makeTutor();
  await t.start();
  for (let i = 0; i < 3; i += 1) await t.advance();
  t.setSpokenFraction(0.45);
  const anchor = t.interrupt('混合检索怎么做？');
  assert.equal(t.state, TutorState.INTERRUPTED);
  assert.equal(anchor.segmentTitle, t.current.title);
  assert.equal(anchor.spokenFraction, 0.45);
  assert.equal(anchor.boardOps.length, t.boardOps.length, '锚点应包含白板状态');
  assert.equal(anchor.executedCells.length, 0);
  assert.equal(anchor.completedSegments.length, 2);
  assert.ok(anchor.pendingTitles.length > 0);
  assert.equal(t.transcript.filter((x) => x.kind === 'interruption').length, 1);
  assert.ok(t.events.some((e) => e.type === 'interrupted'));
});

test('interrupt() 时机不影响 Provider 调用次数（barge-in 不自动调 LLM）', async () => {
  const t = makeTutor();
  await t.start();
  await t.advance();
  const before = t.provider.calls.length;
  t.interrupt('等等');
  assert.equal(t.provider.calls.length, before, '打断本身不应触发模型调用');
});

test('空插话抛 EMPTY_QUESTION；非 speaking 状态打断抛 NOT_SPEAKING', async () => {
  const t = makeTutor();
  await t.start();
  assert.throws(() => t.interrupt(''), (e) => e.code === 'NOT_SPEAKING' || e.code === 'EMPTY_QUESTION');
  await t.advance();
  assert.throws(() => t.interrupt('   '), (e) => e.code === 'EMPTY_QUESTION');
});

test('answerInterruption() 回答插话，产物（图/代码/来源）也会进入白板与引用', async () => {
  const t = makeTutor();
  await t.start();
  await t.advance();
  t.interrupt('混合检索怎么做？BM25 呢？');
  const ans = await t.answerInterruption();
  assert.equal(t.state, TutorState.INTERRUPTED, '回答后仍等待宿主决定如何继续');
  assert.match(ans.narration, /混合检索|BM25/);
  assert.ok(ans.artifacts.length >= 1);
  assert.equal(ans.artifacts[0].type, 'diagram');
  assert.ok(t.boardOps.some((o) => o.includes('BM25')), '回答的图应增量画到白板');
  assert.equal(t.completed[t.completed.length - 1].origin, 'answer');
  assert.ok(t.transcript.some((x) => x.kind === 'answer'));
});

test('answerInterruption() 对「评估」类插话返回带出处的新资料', async () => {
  const t = makeTutor();
  await t.start();
  await t.advance();
  t.interrupt('RAG 怎么评估？有哪些指标');
  const ans = await t.answerInterruption();
  assert.match(ans.narration, /faithfulness|recall|评估/);
  assert.ok(ans.artifacts.some((a) => a.type === 'sources'));
  assert.ok(t.citedSources.some((s) => s.includes('RAGAS')));
});

test('answerInterruption() 对「跑段代码」插话会现场生成并执行代码', async () => {
  const t = makeTutor();
  await t.start();
  await t.advance();
  t.interrupt('能跑一下代码看看吗');
  const ans = await t.answerInterruption();
  const art = ans.artifacts.find((a) => a.type === 'code');
  assert.ok(art);
  assert.equal(art.error, null);
  assert.match(art.output, /重排后/);
});

test('不能在非 interrupted 状态回答或继续', async () => {
  const t = makeTutor();
  await t.start();
  await t.advance();
  await assert.rejects(() => t.answerInterruption(), (e) => e.code === 'NOT_INTERRUPTED');
  await assert.rejects(() => t.continueAfterInterruption(), (e) => e.code === 'NOT_INTERRUPTED');
});

// ---------------------------------------------------------------- 续讲三种模式

test('RESUME 用锚点重生成当前段文本，不重复已讲部分', async () => {
  const t = makeTutor();
  await t.start();
  await t.advance();
  t.setSpokenFraction(0.6);
  const anchor = t.interrupt('等等，什么是向量库');
  const original = t.current.narration;
  await t.answerInterruption();
  const snap = await t.continueAfterInterruption(ContinueMode.RESUME);
  assert.equal(snap.state, TutorState.SPEAKING);
  assert.notEqual(t.current.narration, original, '续讲文本应被锚点约束重写');
  assert.match(t.current.narration, /接着刚才的问题说回/);
  assert.equal(t.queue.length, 9, 'RESUME 保留原队列');
  const resegEvent = t.events.find((e) => e.type === 'resegmented');
  assert.equal(resegEvent.anchorId, anchor.id);
  assert.ok(t.provider.calls.some((c) => c.name === 'generateSegment' && c.args.anchorId === anchor.id));
});

test('REPLAN 丢弃未讲段，按插话主题重建后续大纲', async () => {
  const t = makeTutor();
  await t.start();
  await t.advance();
  t.interrupt('我想改讲混合检索');
  await t.answerInterruption();
  const snap = await t.continueAfterInterruption(ContinueMode.REPLAN);
  assert.equal(snap.state, TutorState.SPEAKING);
  assert.equal(t.queue.length, 5, '当前段 + 4 个重规划段');
  assert.ok(t.queue.slice(1).every((s) => s.origin === 'replan'));
  assert.ok(t.outline().some((s) => s.title.includes('展开')));
  assert.ok(t.events.some((e) => e.type === 'replanned'));
});

test('SKIP 跳过当前段并把它标记 SKIPPED', async () => {
  const t = makeTutor();
  await t.start();
  await t.advance();
  const skippedId = t.current.id;
  t.interrupt('这段我懂了，跳过');
  await t.answerInterruption();
  const snap = await t.continueAfterInterruption(ContinueMode.SKIP);
  assert.equal(snap.state, TutorState.SPEAKING);
  assert.equal(t.current, null);
  assert.ok(t.completed.some((s) => s.id === skippedId && s.status === SegmentStatus.SKIPPED));
  assert.ok(t.events.some((e) => e.type === 'segment_skipped'));
});

test('未知继续模式抛 BAD_MODE', async () => {
  const t = makeTutor();
  await t.start();
  await t.advance();
  t.interrupt('x');
  await t.answerInterruption();
  await assert.rejects(() => t.continueAfterInterruption('nonsense'), (e) => e.code === 'BAD_MODE');
});

test('锚点只被消费一次，后续段不会误用旧锚点', async () => {
  const t = makeTutor();
  await t.start();
  await t.advance();
  t.interrupt('问题');
  await t.answerInterruption();
  await t.continueAfterInterruption(ContinueMode.RESUME);
  const callsBefore = t.provider.calls.filter((c) => c.name === 'generateSegment').length;
  await t.advance();
  const nextCall = t.provider.calls.filter((c) => c.name === 'generateSegment').slice(-1)[0];
  assert.equal(nextCall.args.anchorId, null, '新段不应带着旧锚点生成');
  assert.equal(t.provider.calls.filter((c) => c.name === 'generateSegment').length, callsBefore + 1);
});

// ---------------------------------------------------------------- 快照 / 恢复

test('snapshot / fromSnapshot 完整往返，包括 queue、anchor、transcript、board', async () => {
  const t = makeTutor();
  await t.start();
  for (let i = 0; i < 3; i += 1) await t.advance();
  t.setSpokenFraction(0.4);
  t.interrupt('混合检索怎么做');
  await t.answerInterruption();
  const snap = JSON.parse(JSON.stringify(t.snapshot()));

  const restored = InterruptibleTutor.fromSnapshot(snap, { provider: new MockProvider(), now });
  assert.equal(restored.state, TutorState.INTERRUPTED);
  assert.equal(restored.topic, 'RAG');
  assert.equal(restored.queue.length, snap.queue.length);
  assert.equal(restored.completed.length, snap.completed.length);
  assert.equal(restored.boardOps.length, snap.boardOps.length);
  assert.equal(restored.anchor.id, snap.anchor.id);
  assert.equal(restored.transcript.length, snap.transcript.length);
  assert.equal(restored.outline().length, snap.outline.length);
  // 恢复后仍能继续
  const cont = await restored.continueAfterInterruption(ContinueMode.RESUME);
  assert.equal(cont.state, TutorState.SPEAKING);
});

test('snapshot 是深拷贝，外部修改不会污染引擎内部状态', async () => {
  const t = makeTutor();
  await t.start();
  await t.advance();
  const snap = t.snapshot();
  snap.boardOps.push('外部注入');
  snap.queue[0].title = '被改了';
  assert.equal(t.boardOps.includes('外部注入'), false);
  assert.notEqual(t.queue[0].title, '被改了');
});

// ---------------------------------------------------------------- 事件与订阅

test('subscribe 收到事件，unsubscribe 后不再收到', async () => {
  const t = makeTutor();
  await t.start();
  const seen = [];
  const unsub = t.subscribe((e) => seen.push(e.type));
  await t.advance();
  const count = seen.length;
  unsub();
  await t.advance();
  assert.equal(seen.length, count);
  assert.ok(count > 0);
});

test('订阅者抛异常不会中断引擎', async () => {
  const t = makeTutor();
  t.subscribe(() => { throw new Error('bad subscriber'); });
  await t.start();
  const r = await t.advance();
  assert.equal(r.finished, false);
});

// ---------------------------------------------------------------- 代码沙箱

test('runCode 执行纯计算代码并捕获 console 输出', () => {
  const r = runCode('console.log("hi", 1 + 1); console.log(JSON.stringify({a: 2}));');
  assert.equal(r.ok, true);
  assert.match(r.output, /hi 2/);
  assert.match(r.output, /"a":2/);
});

test('runCode 屏蔽 require / process / fetch 等危险标识符', () => {
  for (const src of [
    'require("fs").readFileSync("/etc/passwd")',
    'console.log(process.env)',
    'fetch("http://evil")',
    'import("node:child_process")',
    'console.log(eval("1+1"))',
  ]) {
    const r = runCode(src);
    assert.equal(r.ok, false, `应被屏蔽：${src}`);
    assert.match(r.error, /屏蔽/);
  }
});

test('runCode 捕获运行时异常并保留之前的输出', () => {
  const r = runCode('console.log("before"); throw new Error("boom");');
  assert.equal(r.ok, false);
  assert.match(r.output, /before/);
  assert.match(r.error, /boom/);
});

test('runCode 截断超长输出', () => {
  const r = runCode('console.log("x".repeat(20000));', { maxOutput: 50 });
  assert.equal(r.ok, true);
  assert.equal(r.output.length, 50);
});

// ---------------------------------------------------------------- 端到端场景（用户原始需求）

test('端到端：问 RAG → 逐步讲解 → 生成图与代码 → 中途插话 → 解答 → 续讲到底', async () => {
  const t = makeTutor();
  const events = [];
  t.subscribe((e) => events.push(e.type));

  await t.start('RAG');
  assert.equal(t.outline().length, 9);

  // 讲到流程图段
  for (let i = 0; i < 3; i += 1) await t.advance();
  assert.ok(t.boardOps.length > 0, '边讲边生成了图表');
  const boardBefore = t.boardOps.length;

  // 讲到 45% 时插话
  t.setSpokenFraction(0.45);
  const anchor = t.interrupt('那混合检索和重排到底怎么配合？顺便跑段代码看看');
  assert.equal(anchor.spokenFraction, 0.45);
  assert.equal(anchor.boardOps.length, boardBefore);

  const ans = await t.answerInterruption();
  assert.ok(ans.narration.length > 30);
  assert.ok(ans.artifacts.length >= 1);

  await t.continueAfterInterruption(ContinueMode.RESUME);

  // 继续讲完，其中会真实执行一段代码
  let guard = 0;
  let r;
  do { r = await t.advance(); t.setSpokenFraction(1); guard += 1; } while (!r.finished && guard < 30);

  assert.equal(t.state, TutorState.FINISHED);
  assert.ok(t.executedCells.length >= 1, '讲解过程中真的跑过代码');
  assert.ok(t.citedSources.length >= 2, '讲解过程中引用了资料');
  assert.ok(t.boardOps.length > boardBefore, '回答插话的白板内容是增量添加的');
  assert.ok(t.transcript.some((x) => x.kind === 'interruption'));
  assert.ok(t.transcript.some((x) => x.kind === 'answer'));
  for (const type of ['planned', 'segment_generated', 'interrupted', 'answer', 'continued', 'code_result', 'finished']) {
    assert.ok(events.includes(type), `缺少事件 ${type}`);
  }
});
