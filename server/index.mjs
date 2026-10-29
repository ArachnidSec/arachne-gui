import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { ROOT, loadConfig, saveConfig, describe } from './config.mjs';
import { Store } from './store.mjs';
import { publicRoster, agentById } from './agents.mjs';
import { listModels, rankModels } from './llm.mjs';
import { runTurn, runRoom } from './loop.mjs';
import { runHunt } from './hunt.mjs';
import { executeTool, TOOLS } from './tools/index.mjs';
import { Ledger } from './ledger.mjs';
import { Engagements } from './engagements.mjs';
import { loadSkills, selectSkills, publicSkills } from './skills.mjs';

const cfg = loadConfig();
const store = new Store(cfg.dataDir);
const ledger = new Ledger(cfg.dataDir);
const engagements = new Engagements(cfg, cfg.dataDir);
const skills = loadSkills(path.join(ROOT, 'skills'));
const runtime = { store, ledger, engagements, skills };
const WEB = path.join(ROOT, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
};

const SIZE_PREF = {
  scout: 'small', static: 'large', hunter: 'large', triage: 'large', scribe: 'small', chat: 'large',
};

// ---------------------------------------------------------------- model routing

let routeCache = { at: 0, engines: [], roles: {} };

async function probeEngines() {
  const entries = Object.entries(cfg.engines);
  const probed = await Promise.all(
    entries.map(async ([key, def]) => {
      const base = { key, label: def.label || key, kind: def.kind, base: def.base };
      try {
        const models = await listModels(def, { timeoutMs: 2500 });
        return { ...base, ok: true, models };
      } catch (err) {
        return { ...base, ok: false, models: [], error: err.message };
      }
    }),
  );
  return probed;
}

async function resolveRoutes({ force = false } = {}) {
  if (!force && Date.now() - routeCache.at < 20000 && routeCache.engines.length) return routeCache;
  const engines = await probeEngines();
  const live = engines.filter((e) => e.ok && e.models.length);
  const fallbackPool = live.flatMap((e) => e.models.map((m) => ({ ...m, engine: e })));

  const roles = {};
  for (const [role, pref] of Object.entries(cfg.roles)) {
    const needsTools = role !== 'chat';
    let engine = engines.find((e) => e.key === pref.engine && e.ok);
    let pool = engine?.models || [];
    let chosen = null;

    if (pref.model && pool.some((m) => m.id === pref.model)) {
      chosen = pool.find((m) => m.id === pref.model);
    } else if (pool.length) {
      chosen = rankModels(pool, { needsTools, prefer: SIZE_PREF[role] || 'large' });
    }

    if (!chosen && fallbackPool.length) {
      const ranked = rankModels(
        fallbackPool.filter((m) => (needsTools ? m.tools : true)),
        { needsTools, prefer: SIZE_PREF[role] || 'large' },
      );
      if (ranked) {
        engine = ranked.engine;
        chosen = ranked;
      }
    }

    roles[role] = engine && chosen
      ? { engine, model: chosen.id, label: `${engine.label} · ${chosen.id}`, tools: !!chosen.tools }
      : { engine: engine ? { ...engine, ok: false } : null, model: '', label: 'no model', tools: false };
  }

  routeCache = { at: Date.now(), engines, roles };
  return routeCache;
}

// ---------------------------------------------------------------- helpers

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`invalid json: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.socket?.setNoDelay(true);
  res.flushHeaders?.();
  const send = (obj) => {
    if (res.writableEnded) return;
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch { /* client gone */ }
  };
  const end = (obj) => {
    if (obj) send(obj);
    if (!res.writableEnded) res.end();
  };
  return { send, end };
}

function historyFrom(thread, max = 10) {
  const msgs = thread.messages.filter((m) => m.text).slice(-max);
  return msgs.map((m) => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.role === 'user' ? m.text : `${agentById(m.agentId)?.name || 'Agent'}: ${m.text}`,
  }));
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const abs = path.join(WEB, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!abs.startsWith(WEB)) {
    json(res, 403, { error: 'forbidden' });
    return;
  }
  fs.readFile(abs, (err, data) => {
    if (err) {
      json(res, 404, { error: 'not found', path: rel });
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------- routes

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const route = url.pathname;

  try {
    if (route === '/api/health') {
      const force = url.searchParams.get('refresh') === '1';
      const routes = await resolveRoutes({ force });
      json(res, 200, {
        ok: true,
        host: describe(),
        workspace: cfg.workspace,
        engines: routes.engines,
        roles: routes.roles,
        policy: {
          shell: cfg.policy.shell,
          allowUnsafe: cfg.policy.allowUnsafe,
          scopeHosts: cfg.policy.scopeHosts,
          scopePaths: cfg.policy.scopePaths,
          maxSteps: cfg.policy.maxSteps,
        },
        findings: store.listFindings().length,
        engagement: engagements.active(),
        ledger: ledger.summary(),
        skills: publicSkills(skills),
      });
      return;
    }

    if (route === '/api/roster') {
      json(res, 200, { agents: publicRoster(), tools: Object.keys(TOOLS) });
      return;
    }

    if (route === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.engines) cfg.engines = { ...cfg.engines, ...body.engines };
      if (body.roles) cfg.roles = { ...cfg.roles, ...body.roles };
      if (body.policy) cfg.policy = { ...cfg.policy, ...body.policy };
      saveConfig(cfg);
      const routes = await resolveRoutes({ force: true });
      json(res, 200, { ok: true, roles: routes.roles, policy: cfg.policy });
      return;
    }

    if (route === '/api/threads' && req.method === 'GET') {
      const kind = url.searchParams.get('kind');
      json(res, 200, { threads: store.listThreads(kind) });
      return;
    }

    if (route === '/api/threads' && req.method === 'POST') {
      const body = await readBody(req);
      const kind = body.kind === 'chat' ? 'chat' : 'room';
      const thread = store.createThread({
        title: body.title || (kind === 'chat' ? 'new chat' : 'new room'),
        kind,
        members: kind === 'chat' ? ['chat'] : (body.members?.length ? body.members : ['scout', 'static', 'hunter']),
      });
      json(res, 200, { thread });
      return;
    }

    if (route.startsWith('/api/threads/') && !route.includes('/send')) {
      const id = route.split('/')[3];
      const thread = store.getThread(id);
      if (!thread) {
        json(res, 404, { error: 'no such thread' });
        return;
      }
      json(res, 200, { thread });
      return;
    }

    if (route === '/api/findings' && req.method === 'GET') {
      json(res, 200, { findings: store.listFindings() });
      return;
    }

    if (route === '/api/findings' && req.method === 'DELETE') {
      store.clearFindings();
      json(res, 200, { ok: true });
      return;
    }

    if (route === '/api/file') {
      const target = url.searchParams.get('path');
      const body = await new Promise((resolve, reject) => {
        const abs = path.resolve(cfg.workspace, target || '');
        if (!abs.startsWith(cfg.workspace)) {
          reject(new Error('outside workspace'));
          return;
        }
        fs.readFile(abs, 'utf8', (err, data) => (err ? reject(err) : resolve(data)));
      }).catch((err) => ({ error: err.message }));
      if (body?.error) {
        json(res, 400, body);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(body);
      return;
    }

    if (route === '/api/tool' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await executeTool(cfg, body.name, body.args || {}, {
        store,
        emit: () => {},
        resolve: () => cfg.workspace,
      });
      json(res, 200, { ok: result.ok !== false, output: result.output, meta: result.meta, ms: result.ms });
      return;
    }

    if (route === '/api/hunt' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.target) {
        json(res, 400, { error: 'target required' });
        return;
      }
      const { send, end } = sse(res);
      const controller = new AbortController();
      res.on('close', () => controller.abort());
      const routes = await resolveRoutes();
      const models = {};
      for (const [role, r] of Object.entries(routes.roles)) {
        if (r.engine && r.model) models[role] = { engine: r.engine, model: r.model };
      }
      try {
        for await (const ev of runHunt({
          cfg,
          store,
          target: body.target,
          models,
          signal: controller.signal,
          runtime,
        })) {
          send(ev);
        }
      } catch (err) {
        send({ type: 'error', message: err.message });
      }
      end({ type: 'end' });
      return;
    }

    if (route === '/api/send' && req.method === 'POST') {
      const body = await readBody(req);
      const mode = body.mode || 'room';
      const text = String(body.text || '').trim();
      if (!text) {
        json(res, 400, { error: 'text required' });
        return;
      }

      // chat and room are separate namespaces: a chat thread is never handed to
      // the agents, and an agent room is never reused for a chat question
      const wantKind = mode === 'chat' ? 'chat' : 'room';
      let thread = body.threadId ? store.getThread(body.threadId) : null;
      if (thread && (thread.kind || 'room') !== wantKind) thread = null;
      if (!thread) {
        thread = store.createThread({
          title: text.slice(0, 60),
          kind: wantKind,
          members: wantKind === 'chat' ? ['chat'] : (body.members?.length ? body.members : ['scout', 'static', 'hunter']),
        });
      }

      if (!thread.messages.length && (!thread.title || thread.title.startsWith('new '))) {
        thread.title = text.slice(0, 60);
      }
      store.appendMessage(thread.id, { role: 'user', text });
      const { send, end } = sse(res);
      send({ type: 'thread', threadId: thread.id, kind: thread.kind });

      const controller = new AbortController();
      res.on('close', () => controller.abort());

      const routes = await resolveRoutes();
      const models = {};
      for (const [role, r] of Object.entries(routes.roles)) {
        if (r.engine && r.model) models[role] = { engine: r.engine, model: r.model };
      }

      const wanted = Array.isArray(body.skills) ? body.skills : [];
      const selectedSkills = selectSkills(skills, wanted);
      const history = historyFrom(thread);
      const collected = new Map();
      const note = (agentId, patch) => {
        const prev = collected.get(agentId) || { text: '', tools: [], errors: 0 };
        collected.set(agentId, { ...prev, ...patch });
      };

      try {
        if (mode === 'room') {
          for await (const ev of runRoom({
            cfg,
            thread,
            members: thread.members,
            models,
            userText: text,
            runtime,
            skills: selectedSkills,
            signal: controller.signal,
            history,
            emit: send,
          })) {
            if (ev.type === 'token') note(ev.agentId, { text: (collected.get(ev.agentId)?.text || '') + ev.text });
            if (ev.type === 'replace') note(ev.agentId, { text: ev.text });
            if (ev.type === 'done') {
              note(ev.agentId, { text: ev.text, done: true });
              const silent = /^\s*\[\[(silent|tapback|nothing)\]\]/i.test(ev.text || '');
              if (silent) {
                send(ev);
                continue;
              }
              const msg = store.appendMessage(thread.id, {
                role: 'agent',
                agentId: ev.agentId,
                text: ev.text,
                tools: collected.get(ev.agentId)?.tools || [],
                ms: ev.ms,
                steps: ev.steps,
                usage: ev.usage,
                skills: (ev.agentId && skills.filter((sk) => wanted.includes(sk.id)).map((sk) => sk.id)) || [],
              });
              send({ ...ev, messageId: msg?.id });
              continue;
            }
            if (ev.type === 'tool_result') {
              const prev = collected.get(ev.agentId) || { tools: [] };
              note(ev.agentId, { tools: [...(prev.tools || []), { name: ev.name, ok: ev.ok, ms: ev.ms }] });
            }
            if (ev.type === 'error') note(ev.agentId, { errors: (collected.get(ev.agentId)?.errors || 0) + 1 });
            send(ev);
          }
        } else {
          // chat is deliberately one generalist with no tools
          const agentId = mode === 'chat' ? 'chat' : (body.agentId || 'scout');
          const agent = agentById(agentId);
          const route = models[agentId] || models.chat;
          if (!agent || !route) {
            send({ type: 'error', message: `no model routed for ${agentId}. Open Engines.` });
            end({ type: 'end' });
            return;
          }
          let text2 = '';
          for await (const ev of runTurn({
            cfg,
            agent,
            engine: route.engine,
            model: route.model,
            history,
            userText: text,
            runtime,
            skills: selectedSkills,
            signal: controller.signal,
            emit: send,
          })) {
            if (ev.type === 'token') text2 += ev.text;
            if (ev.type === 'replace') text2 = ev.text;
            if (ev.type === 'tool_result') {
              const prev = collected.get(agentId) || { tools: [] };
              note(agentId, { tools: [...(prev.tools || []), { name: ev.name, ok: ev.ok, ms: ev.ms }] });
            }
            if (ev.type === 'done') {
              const msg = store.appendMessage(thread.id, {
                role: 'agent',
                agentId,
                text: ev.text,
                tools: collected.get(agentId)?.tools || [],
                ms: ev.ms,
                steps: ev.steps,
                usage: ev.usage,
              });
              send({ ...ev, messageId: msg?.id });
              continue;
            }
            send(ev);
          }
        }
      } catch (err) {
        send({ type: 'error', message: err.message });
      }
      end({ type: 'end' });
      return;
    }

    if (route === '/api/skills' && req.method === 'GET') {
      json(res, 200, { skills: publicSkills(skills) });
      return;
    }

    if (route === '/api/ledger' && req.method === 'GET') {
      json(res, 200, { entries: ledger.entries.slice(0, 200), intents: ledger.intents, summary: ledger.summary() });
      return;
    }

    if (route === '/api/ledger' && req.method === 'DELETE') {
      ledger.clear();
      json(res, 200, { ok: true });
      return;
    }

    if (route === '/api/engagements' && req.method === 'GET') {
      json(res, 200, { engagements: engagements.list(), active: engagements.active() });
      return;
    }

    if (route === '/api/engagements' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const engagement = engagements.create({ name: body.name, targets: body.targets, client: body.client });
        saveConfig(cfg);
        json(res, 200, { engagement, policy: cfg.policy });
      } catch (err) {
        json(res, 400, { error: err.message });
      }
      return;
    }

    if (route === '/api/engagements/activate' && req.method === 'POST') {
      const body = await readBody(req);
      const engagement = engagements.get(body.id);
      if (!engagement) {
        json(res, 404, { error: 'no such engagement' });
        return;
      }
      engagements.setActive(engagement.id);
      cfg.policy.scopeHosts = engagement.hosts;
      const scoped = new Set(cfg.policy.scopePaths || []);
      scoped.add(path.join(cfg.workspace, engagement.dir));
      cfg.policy.scopePaths = [...scoped];
      saveConfig(cfg);
      json(res, 200, { engagement: engagements.active(), policy: cfg.policy });
      return;
    }

    if (route.startsWith('/api/')) {
      json(res, 404, { error: 'no such endpoint', route });
      return;
    }

    if (req.method === 'GET') {
      serveStatic(res, route);
      return;
    }

    json(res, 405, { error: 'method not allowed' });
  } catch (err) {
    if (!res.headersSent) json(res, 500, { error: err.message });
    else try { res.end(); } catch {}
  }
});

const port = Number(process.env.PORT || cfg.port || 7777);
server.listen(port, '127.0.0.1', () => {
  const line = `arachne → http://127.0.0.1:${port}   workspace: ${cfg.workspace}`;
  console.log(line);
  resolveRoutes({ force: true })
    .then((r) => {
      for (const [role, v] of Object.entries(r.roles)) {
        console.log(`  ${role.padEnd(7)} ${v.label}`);
      }
      const down = r.engines.filter((e) => !e.ok).map((e) => e.label);
      if (down.length) console.log(`  offline: ${down.join(', ')}`);
    })
    .catch((err) => console.log(`  route probe failed: ${err.message}`));
});
