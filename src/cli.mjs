#!/usr/bin/env node
/**
 * CLI 入口 —— 给 AI agent / 人用的最小操控面。
 *
 *   node src/cli.mjs --demo                     跑一段带打断的完整演示
 *   node src/cli.mjs start --topic "RAG"       规划大纲
 *   node src/cli.mjs next                      推进一段
 *   node src/cli.mjs interrupt "混合检索呢?"   打断并插话
 *   node src/cli.mjs answer                    回答插话
 *   node src/cli.mjs continue --mode replan    决定如何续讲
 *   node src/cli.mjs snapshot                  导出状态快照
 *
 * 会话状态默认保存在 .tutor-session.json，用 --session <path> 改。
 * 每条命令输出单行 JSON，方便 agent 用 jq / 解析器消费。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InterruptibleTutor, ContinueMode, __resetForTests } from './engine.mjs';
import { createProvider } from './providers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function out(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args[key] = next; i += 1; }
      else args[key] = true;
    } else args._.push(a);
  }
  return args;
}

function loadSession(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function saveSession(file, tutor) {
  fs.writeFileSync(file, `${JSON.stringify(tutor.snapshot(), null, 2)}\n`, 'utf8');
}

function buildTutor(args) {
  const provider = args['real-llm'] ? createProvider({ mock: false }) : createProvider({ mock: true });
  const snap = loadSession(args.session ?? path.join(ROOT, '.tutor-session.json'));
  return snap ? InterruptibleTutor.fromSnapshot(snap, { provider }) : new InterruptibleTutor({ provider });
}

async function runDemo() {
  __resetForTests();
  const tutor = new InterruptibleTutor({ provider: createProvider({ mock: true }), topic: 'RAG' });
  const log = [];
  tutor.subscribe((e) => log.push(e));

  process.stdout.write('=== 可打断讲解引擎演示（主题：RAG，全程 mock，无需 API key）===\n\n');
  await tutor.start('RAG');
  process.stdout.write(`大纲共 ${tutor.outline().length} 段：\n`);
  for (const [i, s] of tutor.outline().entries()) process.stdout.write(`  ${i + 1}. [${s.kind}] ${s.title}\n`);
  process.stdout.write('\n');

  // 先讲两段
  for (let i = 0; i < 2; i += 1) {
    const r = await tutor.advance();
    tutor.setSpokenFraction(1);
    process.stdout.write(`▶ 讲解段 ${i + 1}：${r.segment.title}\n`);
    process.stdout.write(`  ${r.segment.narration.slice(0, 90)}…\n`);
  }

  // 第三段：生成流程图
  const third = await tutor.advance();
  process.stdout.write(`▶ 讲解段 3：${third.segment.title}\n`);
  process.stdout.write(`  白板新增节点/连线：${tutor.boardOps.length} 项\n`);

  // 中途打断（讲到 45%）
  tutor.setSpokenFraction(0.45);
  const anchor = tutor.interrupt('混合检索怎么做？BM25 和向量检索怎么合并？');
  process.stdout.write(`\n⏸ 学生插话：「${anchor.segmentTitle}」讲到 45% 时打断\n`);
  process.stdout.write(`  锚点 ${anchor.id}：已讲「${anchor.spokenPrefix.slice(-40)}…」\n`);
  process.stdout.write(`  白板操作 ${anchor.boardOps.length} 项、已完成段 ${anchor.completedSegments.length} 个\n\n`);

  const ans = await tutor.answerInterruption();
  process.stdout.write(`💬 AI 回答：${ans.narration.slice(0, 110)}…\n`);
  process.stdout.write(`  回答顺带生成了 ${ans.artifacts.length} 个产物（${ans.artifacts.map((a) => a.type).join(', ')}）\n\n`);

  // 回答完必须先决定如何继续，才能再推进下一段
  const anchorPrompt = tutor.anchor?.toPrompt() ?? '';
  const cont = await tutor.continueAfterInterruption(ContinueMode.RESUME);
  process.stdout.write(`▶ 续讲决策：RESUME，状态回到 ${cont.state}\n`);
  process.stdout.write(`  注入给模型的锚点约束（节选）：\n${anchorPrompt.split('\n').slice(0, 4).map((l) => `    ${l}`).join('\n')}\n\n`);

  // 继续讲，直到遇到现场生成并运行代码的段
  let codeArtifact = null;
  let codeTitle = '';
  let guard = 0;
  while (!codeArtifact && guard < 20) {
    const r = await tutor.advance();
    if (r.finished) break;
    tutor.setSpokenFraction(1);
    const found = r.segment.artifacts.find((a) => a.type === 'code');
    if (found) { codeArtifact = found; codeTitle = r.segment.title; }
    guard += 1;
  }
  if (codeArtifact) {
    process.stdout.write(`▶ 讲解段：${codeTitle}\n`);
    process.stdout.write(`  代码真实执行输出（前 5 行）：\n`);
    for (const line of String(codeArtifact.output ?? '').split('\n').slice(0, 5)) process.stdout.write(`    ${line}\n`);
  }

  // 讲完剩下所有段
  while (cont.state !== 'finished' && guard < 30) {
    const r = await tutor.advance();
    if (r.finished) break;
    tutor.setSpokenFraction(1);
    guard += 1;
  }
  process.stdout.write(`\n=== 结束：状态 ${tutor.state}，完成 ${tutor.completed.length} 段，事件 ${log.length} 条 ===\n`);
  process.stdout.write('提示：用 `npm start` 开 REST/SSE 服务，或看 SKILL.md 让 AI agent 直接操控。\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = args._[0] ?? (args.demo ? 'demo' : 'help');
  const session = args.session ?? path.join(ROOT, '.tutor-session.json');

  if (cmd === 'demo') { await runDemo(); return; }

  if (cmd === 'help' || args.help) {
    out({
      usage: 'node src/cli.mjs <command> [--session path] [--real-llm]',
      commands: ['demo', 'start [--topic]', 'next', 'pause', 'resume', 'interrupt <question> [--spoken 0.45]', 'answer', 'continue [--mode resume|replan|skip]', 'snapshot', 'events', 'reset'],
      note: '每条命令输出单行 JSON；会话状态存于 .tutor-session.json。',
    });
    return;
  }

  if (cmd === 'reset') {
    if (fs.existsSync(session)) fs.unlinkSync(session);
    out({ ok: true, reset: true });
    return;
  }

  const tutor = buildTutor(args);
  let result;

  switch (cmd) {
    case 'start': {
      if (tutor.state !== 'idle') { result = { ok: false, error: 'already started; use reset first', state: tutor.state }; break; }
      // state 为 planned/speaking/... 时都视为已开始
      const topic = args.topic ?? (typeof args._[1] === 'string' ? args._[1] : 'RAG');
      result = { ok: true, topic, outline: await tutor.start(topic) };
      break;
    }
    case 'next': {
      const r = await tutor.advance();
      result = { ok: true, finished: r.finished, segment: r.segment ?? null, state: tutor.state };
      break;
    }
    case 'pause': result = { ok: true, state: tutor.pause().state }; break;
    case 'resume': result = { ok: true, state: tutor.resume().state }; break;
    case 'interrupt': {
      const question = args._.slice(1).join(' ');
      const spoken = args.spoken !== undefined ? Number(args.spoken) : undefined;
      const anchor = tutor.interrupt(question, { spokenFraction: spoken });
      result = { ok: true, anchor, state: tutor.state };
      break;
    }
    case 'answer': {
      const answer = await tutor.answerInterruption();
      result = { ok: true, answer, state: tutor.state };
      break;
    }
    case 'continue': {
      const mode = args.mode ?? 'resume';
      const snap = await tutor.continueAfterInterruption(mode);
      result = { ok: true, mode, state: snap.state, outline: snap.outline };
      break;
    }
    case 'snapshot': result = { ok: true, snapshot: tutor.snapshot() }; break;
    case 'events': result = { ok: true, events: tutor.events }; break;
    default: result = { ok: false, error: `unknown command: ${cmd}`, hint: 'node src/cli.mjs help' };
  }

  saveSession(session, tutor);
  out(result);
}

main().catch((err) => {
  out({ ok: false, error: err?.code ?? 'INTERNAL', message: String(err?.message ?? err) });
  process.exitCode = 1;
});
