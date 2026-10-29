import path from 'node:path';
import fs from 'node:fs';
import { scanSurface, scanSinks } from './tools/scan.mjs';
import { runTurn } from './loop.mjs';
import { agentById } from './agents.mjs';
import { fsWrite } from './tools/fs.mjs';
import { selectSkills } from './skills.mjs';

/**
 * The hunt pipeline.
 *
 * Two stages are deterministic — inventory and the sink scan — because those
 * are cheap, exact, and should never depend on a model's mood. The rest are
 * agent turns, and two of them exist because of what the good harnesses do:
 *
 *   plan    Kestrel opens intents from the ledger, so the work has direction
 *           and the room does not re-test what it already knows.
 *   verify  Sable re-runs the repro and only then says "confirmed" — the gap
 *           between review evidence and a validated bug.
 *
 * With every engine offline the pipeline still produces a real report: the
 * stages that need judgment get skipped and flagged, never faked.
 */

const ymd = () => new Date().toISOString().slice(0, 10);

async function* stage(cfg, { agentId, models, runtime, prompt, signal, budget = 8, skillIds = [] }) {
  const agent = agentById(agentId);
  const route = models[agentId] || models.hunter || models.chat;
  if (!agent || !route?.model) {
    yield { type: 'stage_skipped', agentId, reason: 'no model routes to this role' };
    return '';
  }
  const skills = selectSkills(runtime.skills || [], skillIds);
  let text = '';
  for await (const ev of runTurn({
    cfg,
    agent,
    engine: route.engine,
    model: route.model,
    userText: prompt,
    runtime,
    signal,
    skills,
    maxSteps: budget,
  })) {
    if (ev.type === 'token') text += ev.text;
    else if (ev.type === 'replace') text = ev.text;
    else if (ev.type === 'done') text = ev.text || text;
    yield ev;
  }
  return text;
}

export async function* runHunt({ cfg, store, target, models, signal, runtime }) {
  const stages = [];
  const mark = (id, status, detail) => {
    const entry = { id, status, detail };
    const existing = stages.findIndex((s) => s.id === id);
    if (existing >= 0) stages[existing] = entry;
    else stages.push(entry);
    return { type: 'phase', ...entry, stages };
  };

  const engagement = runtime.engagements?.active?.() || null;
  const reportDir = runtime.engagements?.dirFor?.('reports') || 'reports';
  const pocDir = runtime.engagements?.dirFor?.('pocs') || 'pocs';

  yield mark('scope', 'running', target);
  let surface;
  try {
    surface = scanSurface(cfg, { path: target });
  } catch (err) {
    yield mark('scope', 'error', err.message);
    yield { type: 'error', message: `scope failed: ${err.message}` };
    return;
  }
  yield mark('scope', 'done', `${surface.fileCount} files · ${surface.loc} LOC · ${surface.languages.map((l) => l.lang).join('/') || '?'}`);
  yield { type: 'surface', surface, engagement };
  runtime.ledger?.addEntry?.({
    surface: surface.root,
    action: 'scan_surface inventory',
    result: `${surface.fileCount} files, ${surface.loc} LOC, ${surface.entryPoints.length} entry points`,
    confidence: 'observed',
    engagement: engagement?.id || null,
  });

  yield mark('surface', 'running', 'static sink scan');
  const { hits, scanned } = scanSinks(cfg, { path: target });
  const recorded = [];
  const seen = new Set();
  for (const hit of hits.slice(0, 10)) {
    const finding = store.addFinding({
      id: hit.id,
      title: hit.title,
      severity: hit.severity,
      cwe: hit.cwe,
      file: hit.file,
      line: hit.line,
      evidence: hit.snippet,
      status: 'candidate',
      reach: hit.reach,
      rule: hit.rule,
      engagement: engagement?.id || null,
      source: 'scan_sinks',
    });
    recorded.push(finding);
    seen.add(finding.id);
    yield { type: 'finding', finding };
  }
  yield mark('surface', 'done', `${hits.length} candidates in ${scanned} files`);
  runtime.ledger?.addEntry?.({
    surface: surface.root,
    action: 'scan_sinks static rules',
    result: `${hits.length} candidates in ${scanned} files${hits.length ? `; top: ${hits[0].rule} ${hits[0].file}:${hits[0].line}` : ''}`,
    confidence: 'observed',
    engagement: engagement?.id || null,
  });

  const shortlist = hits.slice(0, 8).map((h, i) => `${i + 1}. ${h.cwe} ${h.severity} reach=${h.reach} ${h.file}:${h.line} — ${h.rule}`);

  // ---- plan ----
  yield mark('plan', 'running', 'opening intents');
  const planText = yield* stage(cfg, {
    agentId: 'planner',
    models,
    runtime,
    signal,
    skillIds: ['intent-planning', 'counterevidence'],
    budget: 4,
    prompt: `Target: ${surface.root} (${surface.fileCount} files, ${surface.loc} LOC, build: ${surface.build.map((b) => b.tool).join('/') || 'none'}).
Entry points: ${surface.entryPoints.slice(0, 12).map((e) => `${e.file}:${e.line} ${e.kind}`).join('; ') || 'none found'}.

Candidates:
${shortlist.join('\n') || '(none)'}

Open three to five intents with intent_write, ranked by expected yield. Do not test anything yourself.`,
  });
  const intents = runtime.ledger?.openIntents?.() || [];
  for (const intent of intents) yield { type: 'intent', intent };
  yield mark('plan', 'done', `${intents.length} open intent${intents.length === 1 ? '' : 's'}`);

  // ---- trace ----
  yield mark('trace', 'running', 'dataflow over top candidates');
  const traceText = yield* stage(cfg, {
    agentId: 'static',
    models,
    runtime,
    signal,
    skillIds: ['rce-memory-corruption', 'counterevidence'],
    budget: 6,
    prompt: `Target: ${surface.root}.
Open intents:
${intents.map((i) => `- ${i.id} ${i.title}`).join('\n') || '(none)'}

Candidates:
${shortlist.join('\n') || '(none)'}

Take the top intent. Read the whole function, not the line. Either give the call chain from input to sink with file:line at each hop, or kill the candidate and say what stopped it. Record what you tested in the ledger, and real chains with finding_write as "candidate".`,
  });
  yield mark('trace', 'done', traceText ? 'shortlist produced' : 'no output');

  // ---- prove ----
  yield mark('prove', 'running', 'harness build + sanitizer run');
  const proveText = yield* stage(cfg, {
    agentId: 'hunter',
    models,
    runtime,
    signal,
    skillIds: ['rce-memory-corruption'],
    budget: 10,
    prompt: `Target: ${surface.root}. Build system: ${surface.build.map((b) => `${b.file} (${b.tool})`).join(', ') || 'none — single-file if there is one .c'}.
Write harnesses under ${pocDir}/.

Triage notes from Ivo:
${traceText || '(none — work from the candidate list yourself)'}

Candidates:
${shortlist.join('\n') || '(none)'}

Take the single most promising candidate. Write a standalone harness under ${pocDir}/, compile with ASan/UBSan, run it with an input that crosses the boundary. Record the command in the ledger. Do not edit the target's real source.`,
  });
  yield mark('prove', 'done', proveText ? 'harness attempt complete' : 'no output');
  const crashed = store.listFindings().filter((f) => f.status === 'reproduced' || f.status === 'confirmed');
  runtime.ledger?.addEntry?.({
    surface: target,
    action: 'harness run under ASan/UBSan',
    result: crashed.length ? `${crashed.length} finding(s) reproduced` : 'no crash recorded',
    confidence: 'observed',
    engagement: engagement?.id || null,
  });

  // anything the harness stage proved lands in the rail before verification runs
  for (const f of store.listFindings()) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    yield { type: 'finding', finding: f };
  }

  // ---- verify ----
  yield mark('verify', 'running', 're-run + counterevidence');
  const pending = store.listFindings().filter((f) => f.status === 'reproduced');
  const verifyText = yield* stage(cfg, {
    agentId: 'triage',
    models,
    runtime,
    signal,
    skillIds: ['counterevidence'],
    budget: 6,
    prompt: `Findings marked "reproduced" (a harness crashed, nothing is confirmed yet):
${pending.map((f) => `- ${f.id} ${f.kind || 'crash'} ${f.cwe || ''} "repro": ${f.repro || '(none recorded)'}`).join('\n') || '(none)'}

For each one: run verify_finding with its id. Before you accept it, walk the counterevidence list — is the source attacker-controlled, is there a guard, is the code reachable, is the crash in target code? Put what you checked in the note argument. Kill anything that does not hold up; a killed finding is a result.`,
  });
  for (const f of store.listFindings()) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    yield { type: 'finding', finding: f };
  }
  const confirmed = store.listFindings().filter((f) => f.status === 'confirmed').length;
  yield mark('verify', 'done', `${confirmed} confirmed of ${store.listFindings().length}`);
  runtime.ledger?.addEntry?.({
    surface: target,
    action: 'verification pass',
    result: `${confirmed} confirmed, ${store.listFindings().length} total findings`,
    confidence: 'observed',
    engagement: engagement?.id || null,
  });

  // ---- report ----
  yield mark('report', 'running', 'writing report');
  const findings = store.listFindings();
  const reportName = `${reportDir}/${path.basename(surface.root) || 'target'}-${ymd()}.md`;
  const reportText = yield* stage(cfg, {
    agentId: 'scribe',
    models,
    runtime,
    signal,
    skillIds: ['counterevidence'],
    budget: 5,
    prompt: `Write the report to ${reportName} with fs_write.

Surface: ${JSON.stringify(surface).slice(0, 1200)}
${engagement ? `Engagement: ${engagement.id} (${engagement.name}) — authorized targets: ${engagement.targets.join(', ')}` : 'No engagement is active.'}

Ledger:
${runtime.ledger?.brief?.({ limit: 20 }) || '(none)'}

Findings:
${findings.slice(0, 12).map((f) => `- [${f.status}] [${f.severity}] ${f.cwe || ''} ${f.title} — ${f.file || ''}:${f.line || 0}${f.repro ? ` · repro: ${f.repro}` : ''}`).join('\n') || '- none'}

Triage: ${(traceText || 'n/a').slice(0, 1200)}
Proof: ${(proveText || 'n/a').slice(0, 1200)}
Verification: ${(verifyText || 'n/a').slice(0, 1200)}

Heading, one-paragraph summary, confirmed findings with repro, candidates that survived, dead candidates with the reason, and the three next actions. Do not describe a candidate as confirmed.`,
  });

  const reportAbs = path.resolve(cfg.workspace, reportName);
  if (!reportText || !fs.existsSync(reportAbs)) {
    fsWrite(cfg, { path: reportName, content: renderFallbackReport(surface, findings, hits, runtime, engagement) });
    yield {
      type: 'note',
      text: reportText
        ? 'the writer answered without emitting the file; wrote the deterministic report instead'
        : 'no model for the report stage; wrote the deterministic report',
    };
  }
  yield mark('report', 'done', reportName);
  yield {
    type: 'hunt_done',
    report: reportName,
    candidates: hits.length,
    confirmed,
    intents: intents.length,
    staged: stages,
    engagement: engagement?.id || null,
  };
}

function renderFallbackReport(surface, findings, hits, runtime, engagement) {
  const confirmed = findings.filter((f) => f.status === 'confirmed');
  const reproduced = findings.filter((f) => f.status === 'reproduced');
  const candidates = findings.filter((f) => f.status === 'candidate');
  const lines = [
    `# ${surface.root} — hunt report`,
    '',
    `Generated ${new Date().toISOString()} by arachne.`,
    engagement ? `Engagement: ${engagement.id} — ${engagement.name}. Authorized targets: ${engagement.targets.join(', ')}.` : 'No engagement was active.',
    '',
    '## Surface',
    '',
    `- ${surface.fileCount} files, ${surface.loc} LOC`,
    `- languages: ${surface.languages.map((l) => `${l.lang} (${l.count})`).join(', ') || 'none'}`,
    `- build: ${surface.build.map((b) => `${b.file} → ${b.tool}`).join(', ') || 'none detected'}`,
    `- entry points: ${surface.entryPoints.length}`,
    '',
    '```',
    ...surface.entryPoints.slice(0, 20).map((e) => `${e.kind.padEnd(14)} ${e.file}:${e.line}  ${e.detail}`),
    '```',
    '',
    '## Confirmed',
    '',
    ...(confirmed.length
      ? confirmed.flatMap((f) => [`### ${f.title}`, '', `- severity: ${f.severity}`, `- cwe: ${f.cwe || 'n/a'}`, `- evidence: ${f.evidenceId || 'n/a'}`, `- repro: \`${f.repro || 'n/a'}\``, '', '```', String(f.evidence || '').slice(0, 1200), '```', ''])
      : ['None. Nothing survived verification.', '']),
    '',
    '## Reproduced but unverified',
    '',
    ...(reproduced.length
      ? reproduced.map((f) => `- ${f.cwe || ''} \`${f.file}:${f.line}\` — crashed, not yet re-run and cross-checked`)
      : ['- none']),
    '',
    '## Candidates',
    '',
    ...(candidates.length
      ? candidates.map((f) => `- [${f.severity}] ${f.cwe || ''} \`${f.file}:${f.line}\` reach=${f.reach ?? '?'} — ${f.rule || f.title}`)
      : [`- none of ${hits.length} scan hits were recorded`]),
    '',
    '## Intents',
    '',
    ...(runtime?.ledger?.openIntents?.() || []).map((i) => `- ${i.id} ${i.title}${i.rationale ? ` — ${i.rationale}` : ''}`),
    ...(!(runtime?.ledger?.openIntents?.() || []).length ? ['- none open'] : []),
    '',
    '## Next actions',
    '',
    '1. Read the top three candidates in full and confirm the source is attacker-controlled.',
    '2. Harness the highest-reach one with `fs_write` into `pocs/` and run it under ASan.',
    '3. Re-run with a model attached to get the plan, trace, verify and report stages narrated.',
    '',
  ];
  return lines.join('\n');
}
