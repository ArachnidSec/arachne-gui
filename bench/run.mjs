#!/usr/bin/env node
/**
 * Challenge runner: start a target, drive it, score objective capture.
 *
 *   node bench/run.mjs --challenge 001-bola-profile
 *   node bench/run.mjs --all
 *   node bench/run.mjs --challenge 002-pivot-admin --agent room
 *
 * Two agent modes:
 *   reference  a scripted playbook from the challenge file. Proves the targets,
 *              the tools and the scorer agree — a regression test for the bench.
 *   room       the objective is handed to an agent, which has to get there
 *              itself. Needs a real model behind the room.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.ARACHNE_URL || 'http://127.0.0.1:7777';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const AGENT = flag('agent', 'reference');
const RUN_ALL = has('all');
const ONE = flag('challenge');

// ---------------------------------------------------------------- helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(BASE + pathname, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error(`cannot reach ${BASE} — start the room first (node server/index.mjs)`);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
  return json;
}

const running = new Set();
function startTarget(script, port) {
  const child = spawn(process.execPath, [path.join(ROOT, script), String(port)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  running.add(child);
  return child;
}

function stopTargets() {
  for (const child of running) {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
  running.clear();
}

async function waitReady(port, readyPath = '/') {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${readyPath}`, { signal: AbortSignal.timeout(1000) });
      if (res.status < 500) return true;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  return false;
}

function applyTemplate(value, captured) {
  let text = JSON.stringify(value);
  for (const [k, v] of Object.entries(captured)) {
    text = text.replaceAll(`{{${k}}}`, String(v).replace(/"/g, '\\"'));
  }
  return JSON.parse(text);
}

function extract(text, regex) {
  const m = String(text).match(new RegExp(regex));
  return m ? m[1] ?? m[0] : null;
}

// ---------------------------------------------------------------- scoring

async function verify(clauses, campaign) {
  const baseline = new Set(campaign?.baseline || []);
  const { findings: allFindings } = await api('/api/findings');
  const { entities: allEntities, entries: allEntries } = await api('/api/ledger');
  // only what this run produced counts: a stale finding from an earlier session
  // must not make a challenge pass
  const findings = allFindings.filter((f) => f.campaignId === campaign?.id || !baseline.has(f.id));
  const startedAt = campaign?.startedAt || 0;
  const entities = allEntities.filter((e) => (e.firstSeen || 0) >= startedAt);
  const entries = (allEntries || []).filter((e) => (e.ts || 0) >= startedAt);
  const bag = JSON.stringify({ findings, entities, entries });
  const results = [];

  for (const clause of clauses) {
    if (clause.type === 'finding') {
      const hit = findings.find((f) => (!clause.status || f.status === clause.status)
        && (!clause.cwe || f.cwe === clause.cwe));
      results.push({
        clause: `finding ${clause.status || '*'} ${clause.cwe || ''}`.trim(),
        ok: Boolean(hit),
        detail: hit ? `${hit.id} ${hit.title}` : 'no matching finding',
      });
    } else if (clause.type === 'flag') {
      const ok = bag.includes(clause.value);
      results.push({
        clause: `flag ${clause.value}`,
        ok,
        detail: ok ? 'found in evidence or state' : 'flag never appeared',
      });
    } else {
      results.push({ clause: JSON.stringify(clause), ok: false, detail: 'unknown clause type' });
    }
  }
  return results;
}

// ---------------------------------------------------------------- run

async function loadChallenge(name) {
  const dir = path.isAbsolute(name) ? name : path.join(ROOT, 'bench/challenges', name);
  return { dir, spec: JSON.parse(fs.readFileSync(path.join(dir, 'challenge.json'), 'utf8')) };
}

async function runChallenge(name) {
  const { dir, spec } = await loadChallenge(name);
  const started = Date.now();
  const log = [];

  console.log(`\n${spec.name}`);
  console.log(`  objective  ${spec.objective}`);
  console.log(`  agent      ${AGENT}`);

  for (const target of spec.targets || []) startTarget(target.script, target.port);
  for (const target of spec.targets || []) {
    const ok = await waitReady(target.port, target.readyPath);
    console.log(`  target     ${target.script} :${target.port} ${ok ? 'up' : 'UNREACHABLE'}`);
    if (!ok) throw new Error(`target ${target.script} did not start`);
  }

  // a campaign measures everything this run costs
  try { await api('/api/campaigns/stop', { method: 'POST' }); } catch { /* none running */ }
  const campaign = (await api('/api/campaigns', {
    method: 'POST',
    body: { name: spec.name, challenge: spec.name },
  })).campaign;

  const captured = {};
  let steps = 0;

  if (AGENT === 'reference') {
    for (const step of spec.reference || []) {
      const args = applyTemplate(step.args || {}, captured);
      const res = await api('/api/tool', { method: 'POST', body: { name: step.tool, args } });
      steps += 1;
      if (step.capture) {
        const value = extract(res.output || '', step.capture.regex);
        if (value) captured[step.capture.name] = value;
        log.push({ step: step.tool, captured: Boolean(value) });
      }
      console.log(`  step ${String(steps).padStart(2)}     ${step.tool}${res.ok ? '' : ' (failed)'}`);
    }
    // decoys are a property of the target: check them, do not score the agent on them
    for (const decoy of spec.decoys || []) {
      const res = await api('/api/tool', { method: 'POST', body: { name: decoy.tool, args: decoy.args } });
      const line = String(res.output || '').split('\n')[0];
      const behaves = decoy.expect === 'not-found' ? /→ 40[34]/.test(line) : true;
      console.log(`  decoy      ${decoy.why || decoy.tool} ${behaves ? 'as expected' : 'UNEXPECTED'}`);
      log.push({ decoy: decoy.tool, behaves });
    }
  } else {
    const objective = [
      `CAMPAIGN: ${spec.objective}`,
      `Authorized targets: ${(spec.targets || []).map((t) => `http://127.0.0.1:${t.port}`).join(', ')}`,
      spec.verify?.some((v) => v.type === 'flag')
        ? 'The goal is the internal flag. Prove access with evidence.'
        : 'The goal is a confirmed authorization finding with evidence.',
    ].join('\n');
    const res = await api('/api/send', { method: 'POST', body: { text: objective, mode: 'solo', agentId: 'scout', skills: ['web-authz'] } });
    steps = 1;
    console.log(`  agent      ${res ? 'answered' : 'no answer'}`);
  }

  const finished = (await api('/api/campaigns/stop', { method: 'POST' })).campaign;
  const checks = await verify(spec.verify || [], finished);
  const passed = checks.every((c) => c.ok);
  const elapsed = Date.now() - started;

  console.log('');
  for (const check of checks) {
    console.log(`  verify     ${check.ok ? '✓' : '✗'} ${check.clause} — ${check.detail}`);
  }
  if (finished) {
    const secs = (finished.elapsedMs / 1000).toFixed(1);
    const ttc = finished.timeToFirstConfirmedMs ? `${(finished.timeToFirstConfirmedMs / 1000).toFixed(1)}s` : '—';
    console.log(`  campaign   ${finished.turns} turns · ${finished.tokens.total} tok · ${secs}s wall · ${finished.findings.confirmed} confirmed · first at ${ttc}`);
    console.log(`  cost       $${finished.cost.toFixed(4)}${finished.costPerConfirmed ? ` · $${finished.costPerConfirmed}/confirmed` : ''}`);
  }
  console.log(`  result     ${passed ? 'PASS' : 'FAIL'} (${(elapsed / 1000).toFixed(1)}s)`);

  const record = {
    challenge: spec.name,
    agent: AGENT,
    passed,
    checks,
    campaign: finished,
    durationMs: elapsed,
    captured: Object.keys(captured),
    log,
    at: new Date().toISOString(),
  };
  fs.mkdirSync(path.join(ROOT, 'bench/results'), { recursive: true });
  const file = path.join(ROOT, 'bench/results', `${spec.name}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2));

  return record;
}

// ---------------------------------------------------------------- main

process.on('exit', stopTargets);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopTargets(); process.exit(1); });

try {
  const names = RUN_ALL ? fs.readdirSync(path.join(ROOT, 'bench/challenges')).filter((d) => !d.startsWith('.')) : [ONE];
  if (!names[0]) {
    console.error('usage: node bench/run.mjs --challenge <name> | --all  [--agent reference|room]');
    process.exit(1);
  }
  const results = [];
  for (const name of names) results.push(await runChallenge(name));
  stopTargets();

  const passed = results.filter((r) => r.passed).length;
  console.log(`\n${passed}/${results.length} challenges passed\n`);
  process.exit(passed === results.length ? 0 : 1);
} finally {
  stopTargets();
}
