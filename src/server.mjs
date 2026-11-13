#!/usr/bin/env node
/**
 * REST + SSE 服务 —— 让 AI agent 通过 HTTP 操控讲解引擎，并提供浏览器演示页。
 *
 * 零依赖，只用 node:http。启动：npm start（默认 http://127.0.0.1:8787）
 *
 * 端点：
 *   GET  /                          浏览器演示页
 *   GET  /api/state                 当前快照
 *   GET  /api/events                SSE 实时事件流
 *   GET  /api/events?replay=1      先回放历史事件再持续推送
 *   POST /api/start     {topic?}
 *   POST /api/next
 *   POST /api/pause
 *   POST /api/resume
 *   POST /api/spoken    {fraction}
 *   POST /api/interrupt {question, spokenFraction?}
 *   POST /api/answer    {question?}
 *   POST /api/continue  {mode: resume|replan|skip}
 *   POST /api/reset
 *   GET  /api/skill                 返回 SKILL.md（给 agent 自取）
 *
 * 安全：默认只监听 127.0.0.1，不接收外部连接；没有鉴权，不要直接暴露到公网。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InterruptibleTutor, ContinueMode } from './engine.mjs';
import { createProvider } from './providers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.TUTOR_PORT ?? 8787);
const HOST = process.env.TUTOR_HOST ?? '127.0.0.1';

let tutor = new InterruptibleTutor({ provider: createProvider({ mock: true }) });
const sseClients = new Set();

// 引擎事件广播给所有 SSE 客户端
function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try { res.write(line); } catch { sseClients.delete(res); }
  }
}
tutor.subscribe(broadcast);

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return {}; }
}

function serveStatic(res, file, contentType) {
  try {
    const buf = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache' });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    return res.end();
  }

  // ---- SSE
  if (req.method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    res.write(': connected\n\n');
    if (url.searchParams.get('replay') === '1') {
      for (const e of tutor.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
    }
    sseClients.add(res);
    const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 20000);
    req.on('close', () => { clearInterval(keepAlive); sseClients.delete(res); });
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    return serveStatic(res, path.join(ROOT, 'web', 'index.html'), 'text/html; charset=utf-8');
  }
  if (pathname === '/app.js') {
    return serveStatic(res, path.join(ROOT, 'web', 'app.js'), 'text/javascript; charset=utf-8');
  }
  if (pathname === '/style.css') {
    return serveStatic(res, path.join(ROOT, 'web', 'style.css'), 'text/css; charset=utf-8');
  }
  if (pathname === '/SKILL.md' || pathname === '/api/skill') {
    return serveStatic(res, path.join(ROOT, 'SKILL.md'), 'text/markdown; charset=utf-8');
  }

  if (pathname === '/api/state' && req.method === 'GET') return json(res, 200, tutor.snapshot());

  if (req.method !== 'POST' || !pathname.startsWith('/api/')) {
    return json(res, 404, { ok: false, error: 'not found' });
  }

  const body = await readBody(req);
  try {
    let result;
    switch (pathname) {
      case '/api/start': {
        if (tutor.state !== 'idle') { result = { ok: false, error: `already ${tutor.state}; POST /api/reset first` }; break; }
        result = { ok: true, outline: await tutor.start(body.topic ?? 'RAG') };
        break;
      }
      case '/api/next': {
        const r = await tutor.advance();
        result = { ok: true, finished: r.finished, segment: r.segment ?? null, state: tutor.state };
        break;
      }
      case '/api/pause': result = { ok: true, state: tutor.pause().state }; break;
      case '/api/resume': result = { ok: true, state: tutor.resume().state }; break;
      case '/api/spoken': {
        const f = Number(body.fraction);
        result = { ok: true, fraction: tutor.setSpokenFraction(f) };
        break;
      }
      case '/api/interrupt': {
        const anchor = tutor.interrupt(body.question ?? '', { spokenFraction: body.spokenFraction });
        result = { ok: true, anchor, state: tutor.state };
        break;
      }
      case '/api/answer': {
        const answer = await tutor.answerInterruption(body.question);
        result = { ok: true, answer, state: tutor.state };
        break;
      }
      case '/api/continue': {
        const mode = body.mode ?? ContinueMode.RESUME;
        const snap = await tutor.continueAfterInterruption(mode);
        result = { ok: true, mode, state: snap.state, outline: snap.outline };
        break;
      }
      case '/api/reset': {
        tutor = new InterruptibleTutor({ provider: createProvider({ mock: true }) });
        tutor.subscribe(broadcast);
        broadcast({ type: 'reset', at: new Date().toISOString(), state: 'idle' });
        result = { ok: true, state: 'idle' };
        break;
      }
      default: result = { ok: false, error: `unknown endpoint ${pathname}` };
    }
    return json(res, result.ok === false ? 400 : 200, result);
  } catch (err) {
    return json(res, 400, { ok: false, error: err?.code ?? 'ENGINE_ERROR', message: String(err?.message ?? err) });
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`interruptible-ai-tutor listening on http://${HOST}:${PORT}\n`);
  process.stdout.write(`  browser demo : http://${HOST}:${PORT}/\n`);
  process.stdout.write(`  agent skill  : http://${HOST}:${PORT}/SKILL.md\n`);
  process.stdout.write(`  SSE stream   : http://${HOST}:${PORT}/api/events?replay=1\n`);
});
