/**
 * 浏览器演示前端（零依赖，原生 ES modules）。
 *
 * 语音部分用浏览器 Web Speech API：
 *   - SpeechSynthesis 朗读讲解文本；
 *   - SpeechRecognition 持续拾音，用户开口 → cancel() 掐断 TTS → POST /api/interrupt。
 * 这就是真实 barge-in 的最小实现：不需要 VAD 库，也不需要任何 API key。
 * 语音不可用时自动退化为手动输入 + 点击插话。
 */

const $ = (id) => document.getElementById(id);
const el = {
  status: $('status'), narration: $('narration'), progress: $('progress-bar'), meta: $('segment-meta'),
  btnStart: $('btn-start'), btnNext: $('btn-next'), btnPause: $('btn-pause'), btnResume: $('btn-resume'),
  question: $('question'), btnInterrupt: $('btn-interrupt'), voiceToggle: $('voice-toggle'),
  continueRow: $('continue-row'), transcript: $('transcript'), btnClear: $('btn-clear'),
  board: $('board'), boardList: $('board-list'), boardCount: $('board-count'),
  codeArea: $('code-area'), codeCount: $('code-count'), outline: $('outline'),
  events: $('events'), eventCount: $('event-count'),
};

const API = '';
let state = null;
let eventCount = 0;
let codeBlocks = 0;
let diagram = null;
let speaking = false;
let recognition = null;
let voiceEnabled = false;
let pendingInterrupt = false;
let spokenTimer = null;

async function api(path, body) {
  const opts = body === undefined
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(`${API}${path}`, opts);
  const data = await res.json();
  if (!data.ok && !res.ok) throw new Error(data.message || data.error || 'request failed');
  return data;
}

function setStatus(s) {
  el.status.textContent = ({
    idle: '未开始', planned: '大纲就绪', speaking: '讲解中', paused: '已暂停',
    interrupted: '被打断 · 等待回答', answering: '回答插话中', finished: '已结束',
  })[s] || s;
  el.status.className = `status ${s}`;
}

function addTranscript(role, text, kind) {
  const div = document.createElement('div');
  div.className = `msg ${role === 'student' ? 'student' : 'tutor'}`;
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = role === 'student' ? '学生 · 插话' : (kind === 'answer' ? 'AI 导师 · 回答插话' : 'AI 导师');
  const txt = document.createElement('span');
  txt.className = 'txt';
  txt.textContent = text;
  div.append(who, txt);
  el.transcript.append(div);
  el.transcript.scrollTop = el.transcript.scrollHeight;
}

function addEvent(type) {
  eventCount += 1;
  el.eventCount.textContent = String(eventCount);
  const div = document.createElement('div');
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] `;
  div.append(t, document.createTextNode(type));
  el.events.append(div);
  el.events.scrollTop = el.events.scrollHeight;
}

function renderOutline() {
  if (!state) return;
  el.outline.innerHTML = '';
  for (const s of state.outline) {
    const li = document.createElement('li');
    if (s.status === 'done' || s.status === 'skipped') li.className = 'done';
    if (state.current && s.id === state.current.id) li.className = 'current';
    const k = document.createElement('span');
    k.className = 'kind';
    k.textContent = s.kind;
    li.append(k, document.createTextNode(s.title));
    el.outline.append(li);
  }
}

/** 用 SVG 画结构化图（节点按层排布，边用直线 + 箭头）。 */
function renderBoard() {
  const svg = el.board;
  svg.innerHTML = '';
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  marker.setAttribute('id', 'arrow');
  marker.setAttribute('markerWidth', '8');
  marker.setAttribute('markerHeight', '8');
  marker.setAttribute('refX', '7');
  marker.setAttribute('refY', '3');
  marker.setAttribute('orient', 'auto');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M0,0 L0,6 L7,3 z');
  path.setAttribute('fill', '#5b6b82');
  marker.append(path);
  defs.append(marker);
  svg.append(defs);

  if (!diagram || !diagram.nodes?.length) {
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('x', '280'); t.setAttribute('y', '160');
    t.setAttribute('class', 'empty');
    t.textContent = '讲解到「流程图」段时，这里会逐步画出节点与连线';
    svg.append(t);
    return;
  }

  const nodes = diagram.nodes;
  const pos = new Map();
  const cols = Math.min(4, nodes.length);
  nodes.forEach((n, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = 80 + col * (400 / Math.max(1, cols - 1 || 1));
    const y = 60 + row * 105;
    pos.set(n.id, { x, y });
  });

  for (const e of diagram.edges ?? []) {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) continue;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', a.x); line.setAttribute('y1', a.y + 18);
    line.setAttribute('x2', b.x); line.setAttribute('y2', b.y - 18);
    line.setAttribute('class', `edge${e.dashed ? ' dashed' : ''}`);
    svg.append(line);
    if (e.label) {
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', (a.x + b.x) / 2);
      label.setAttribute('y', (a.y + b.y) / 2 - 4);
      label.setAttribute('class', 'edge-label');
      label.textContent = e.label;
      svg.append(label);
    }
  }

  for (const n of nodes) {
    const p = pos.get(n.id);
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', `node ${n.type ?? ''}`);
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    const w = Math.max(90, Math.min(150, String(n.label).length * 12));
    rect.setAttribute('x', p.x - w / 2); rect.setAttribute('y', p.y - 17);
    rect.setAttribute('width', w); rect.setAttribute('height', 34);
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', p.x); text.setAttribute('y', p.y);
    text.textContent = n.label;
    g.append(rect, text);
    svg.append(g);
  }
}

function addCode(language, source, output, error, title) {
  codeBlocks += 1;
  el.codeCount.textContent = `${codeBlocks} 段`;
  const wrap = document.createElement('div');
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = `▸ ${title || '生成的代码'} (${language})`;
  const pre = document.createElement('pre');
  pre.textContent = source;
  wrap.append(label, pre);
  if (output) {
    const outLabel = document.createElement('div');
    outLabel.className = 'label';
    outLabel.textContent = '真实执行输出：';
    const out = document.createElement('pre');
    out.className = 'out';
    out.textContent = output;
    wrap.append(outLabel, out);
  }
  if (error) {
    const errLabel = document.createElement('div');
    errLabel.className = 'label';
    errLabel.textContent = '执行错误：';
    const err = document.createElement('pre');
    err.className = 'err';
    err.textContent = error;
    wrap.append(errLabel, err);
  }
  el.codeArea.querySelector('em')?.remove();
  el.codeArea.append(wrap);
  el.codeArea.scrollTop = el.codeArea.scrollHeight;
}

function renderState(snap) {
  state = snap;
  setStatus(snap.state);
  renderOutline();
  el.boardCount.textContent = `${snap.boardOps.length} 项`;
  el.boardList.innerHTML = '';
  for (const op of snap.boardOps) {
    const span = document.createElement('span');
    span.textContent = op;
    el.boardList.append(span);
  }

  const canSpeak = ['speaking', 'interrupted'].includes(snap.state);
  el.btnNext.disabled = !['planned', 'speaking'].includes(snap.state);
  el.btnPause.disabled = snap.state !== 'speaking';
  el.btnResume.disabled = snap.state !== 'paused';
  el.question.disabled = !canSpeak;
  el.btnInterrupt.disabled = !canSpeak;
  el.continueRow.hidden = snap.state !== 'interrupted';
  el.btnStart.disabled = snap.state !== 'idle';

  if (snap.current) {
    el.meta.textContent = `第 ${snap.completed.length + 1} 段 · ${snap.current.kind} · ${snap.current.title}`;
    el.narration.textContent = snap.current.narration || '（等待生成）';
  } else if (snap.state === 'planned') {
    el.narration.textContent = '大纲已就绪，点击「下一段」开始讲解。';
    el.meta.textContent = `${snap.outline.length} 段待讲`;
  } else if (snap.state === 'finished') {
    el.narration.textContent = '这一节讲完了。可以刷新页面重新开始。';
    el.meta.textContent = `共完成 ${snap.completed.length} 段`;
  }
}

async function refresh() {
  const snap = await api('/api/state');
  renderState(snap);
  await renderArtifactsFromState(snap);
}

// ---------------------------------------------------------------- 语音

function stopSpeaking() {
  speaking = false;
  if (spokenTimer) { clearInterval(spokenTimer); spokenTimer = null; }
  if (window.speechSynthesis) window.speechSynthesis.cancel();
}

function speak(text) {
  if (!voiceEnabled || !window.speechSynthesis || !text) return;
  stopSpeaking();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN';
  u.rate = 1.05;
  speaking = true;
  // SpeechSynthesis 没有可靠的进度事件，这里用字数比例估算，供锚点计算 spokenFraction
  const total = Math.max(1, text.length);
  const charsPerTick = Math.max(1, Math.floor(total / 20));
  let idx = 0;
  spokenTimer = setInterval(() => {
    if (!speaking) return;
    idx = Math.min(total, idx + charsPerTick);
    const f = idx / total;
    el.progress.style.width = `${Math.round(f * 100)}%`;
    api('/api/spoken', { fraction: f }).catch(() => {});
    if (idx >= total) stopSpeaking();
  }, 450);
  u.onend = () => stopSpeaking();
  window.speechSynthesis.speak(u);
}

function startRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return false;
  recognition = new SR();
  recognition.lang = 'zh-CN';
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.onresult = (ev) => {
    const text = ev.results[ev.results.length - 1][0].transcript.trim();
    if (text && speaking && !pendingInterrupt) {
      pendingInterrupt = true;
      stopSpeaking();                     // barge-in：掐断 TTS
      el.question.value = text;
      el.progress.classList.add('interrupted');
      doInterrupt(text);                  // 引擎冻结锚点
    }
  };
  recognition.onend = () => { if (voiceEnabled) { try { recognition.start(); } catch { /* ignore */ } } };
  try { recognition.start(); } catch { /* 权限未授予时静默退化 */ }
  return true;
}

el.voiceToggle.addEventListener('change', (e) => {
  voiceEnabled = e.target.checked;
  if (voiceEnabled) {
    const ok = startRecognition();
    if (!ok) {
      el.voiceToggle.checked = false;
      voiceEnabled = false;
      addTranscript('tutor', '当前浏览器不支持 SpeechRecognition，已退化为手动输入插话。', 'note');
    }
  } else if (recognition) {
    recognition.onend = null;
    try { recognition.stop(); } catch { /* ignore */ }
    recognition = null;
    stopSpeaking();
  }
});

// ---------------------------------------------------------------- 动作

async function doStart() {
  stopSpeaking();
  const r = await api('/api/start', { topic: 'RAG' });
  el.codeArea.innerHTML = '<em>讲解到代码段时，这里会显示现场生成并真实执行的代码与输出。</em>';
  codeBlocks = 0; diagram = null;
  el.codeCount.textContent = '0 段';
  renderBoard();
  await refresh();
  addTranscript('tutor', `大纲已生成，共 ${r.outline.length} 段。点击「下一段」开始讲解。`, 'note');
}

async function doNext() {
  stopSpeaking();
  const r = await api('/api/next');
  await refresh();
  if (r.segment) {
    el.progress.style.width = '0%';
    el.progress.classList.remove('interrupted');
    addTranscript('tutor', r.segment.narration);
    speak(r.segment.narration);
    const art = r.segment.artifacts.find((a) => a.type === 'quiz');
    if (art) addTranscript('tutor', `随堂小测：${art.quiz.question}`, 'quiz');
  } else if (r.finished) {
    addTranscript('tutor', '这一节讲完了。', 'note');
  }
}

async function doInterrupt(question) {
  const r = await api('/api/interrupt', { question, spokenFraction: Number(el.progress.style.width.replace('%', '')) / 100 || 0.5 });
  addTranscript('student', question, 'interruption');
  addTranscript('tutor', `已冻结锚点 ${r.anchor.id}：讲到「${r.anchor.segmentTitle}」的 ${Math.round(r.anchor.spokenFraction * 100)}%。`, 'note');
  await refresh();
  // 自动回答，演示完整闭环（也可以让用户手动点，但本演示直接展示）
  await doAnswer();
}

async function doAnswer() {
  const r = await api('/api/answer', {});
  addTranscript('tutor', r.answer.narration, 'answer');
  el.narration.textContent = r.answer.narration;
  speak(r.answer.narration);
  await refresh();
}

async function doContinue(mode) {
  const r = await api('/api/continue', { mode });
  pendingInterrupt = false;
  el.progress.classList.remove('interrupted');
  await refresh();
  addTranscript('tutor', `续讲决策：${{ resume: '从锚点接着讲', replan: '按插话主题重规划', skip: '跳过本段' }[mode]}。`, 'note');
  void r;
}

el.btnStart.addEventListener('click', () => doStart().catch(showError));
el.btnNext.addEventListener('click', () => doNext().catch(showError));
el.btnPause.addEventListener('click', () => { stopSpeaking(); api('/api/pause').then(refresh).catch(showError); });
el.btnResume.addEventListener('click', () => api('/api/resume').then(refresh).catch(showError));
el.btnInterrupt.addEventListener('click', () => {
  const q = el.question.value.trim();
  if (!q) return;
  stopSpeaking();
  el.progress.classList.add('interrupted');
  doInterrupt(q).catch(showError);
  el.question.value = '';
});
el.question.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.btnInterrupt.click(); });
el.continueRow.addEventListener('click', (e) => {
  const mode = e.target.dataset?.mode;
  if (mode) doContinue(mode).catch(showError);
});
el.btnClear.addEventListener('click', () => { el.transcript.innerHTML = ''; el.events.innerHTML = ''; eventCount = 0; el.eventCount.textContent = '0'; });

function showError(err) {
  addTranscript('tutor', `出错：${err.message}`, 'note');
}

// ---------------------------------------------------------------- SSE

function connectSSE() {
  const es = new EventSource('/api/events?replay=1');
  es.onmessage = (ev) => {
    let e;
    try { e = JSON.parse(ev.data); } catch { return; }
    addEvent(e.type);
    if (e.type === 'board' && e.diagram) {
      diagram = e.diagram;
      renderBoard();
    }
    if (e.type === 'code_result') {
      // 代码本体由 /api/next 的返回渲染，这里补执行结果
      const last = el.codeArea.querySelector('pre:last-of-type');
      void last;
    }
    if (['segment_done', 'finished', 'continued', 'replanned', 'reset'].includes(e.type)) {
      refresh().catch(() => {});
    }
    if (e.type === 'reset') {
      diagram = null; renderBoard();
      el.codeArea.innerHTML = '<em>讲解到代码段时，这里会显示现场生成并真实执行的代码与输出。</em>';
      codeBlocks = 0; el.codeCount.textContent = '0 段';
      el.transcript.innerHTML = '';
    }
  };
  es.onerror = () => { /* EventSource 自动重连 */ };
}

// 每段的 code / diagram / sources 产物由 /api/next 返回直接渲染
async function renderArtifactsFromState(snap) {
  const seg = snap.current;
  if (!seg) return;
  for (const a of seg.artifacts) {
    if (a.type === 'diagram' && !diagram) { diagram = a; renderBoard(); }
    if (a.type === 'code' && !el.codeArea.querySelector(`[data-seg="${seg.id}"]`)) {
      addCode(a.language, a.source, a.output, a.error, a.title);
      el.codeArea.lastElementChild.dataset.seg = seg.id;
    }
  }
}

renderBoard();
connectSSE();
refresh().catch(showError);
