import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { sessions } from '../sessions.mjs';
import { runShell, validateCommand } from './shell.mjs';
import { fsRead, fsList, fsWrite, fsEdit, fsGrep } from './fs.mjs';
import { httpProbe, tcpProbe } from './net.mjs';
import { scanSinks, scanSurface, classifyCrash, detectBuild } from './scan.mjs';

/**
 * The toolbox. Each entry is a JSON-Schema function definition for the model
 * plus the local implementation. Descriptions are written for small models:
 * short, imperative, with the failure modes spelled out.
 */

const trunc = (cfg, text) => {
  const max = cfg.policy.maxOutputChars || 12000;
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}\n... [truncated ${s.length - max} chars]` : s;
};

const def = (name, description, properties, required = []) => ({
  name,
  description,
  parameters: { type: 'object', properties, required, additionalProperties: false },
});

export const TOOLS = {
  fs_list: {
    ...def('fs_list', 'List files under a directory in the workspace, recursive, with sizes.', {
      path: { type: 'string', description: 'directory, relative to workspace (default ".")' },
      depth: { type: 'integer', description: 'levels to descend, 1-8' },
    }),
    run: (cfg, args) => fsList(cfg, args),
  },
  fs_read: {
    ...def('fs_read', 'Read a text file with line numbers. Use offset/limit for big files.', {
      path: { type: 'string', description: 'file path relative to workspace' },
      offset: { type: 'integer', description: 'first line, 1-based' },
      limit: { type: 'integer', description: 'how many lines' },
    }, ['path']),
    run: (cfg, args) => fsRead(cfg, args),
  },
  fs_grep: {
    ...def('fs_grep', 'Regex search across workspace files. Returns file:line: text.', {
      pattern: { type: 'string', description: 'JavaScript regex, case-insensitive' },
      path: { type: 'string', description: 'directory to search (default ".")' },
      glob: { type: 'string', description: 'basename filter, e.g. "*.c" or "*.js"' },
      maxResults: { type: 'integer' },
    }, ['pattern']),
    run: (cfg, args) => fsGrep(cfg, args),
  },
  fs_write: {
    ...def('fs_write', 'Create or overwrite a file inside the workspace. Use for harnesses and PoCs.', {
      path: { type: 'string' },
      content: { type: 'string' },
    }, ['path', 'content']),
    run: (cfg, args) => fsWrite(cfg, args),
  },
  fs_edit: {
    ...def('fs_edit', 'Replace the first exact occurrence of find with replace in a file.', {
      path: { type: 'string' },
      find: { type: 'string' },
      replace: { type: 'string' },
    }, ['path', 'find']),
    run: (cfg, args) => fsEdit(cfg, args),
  },
  shell: {
    ...def('shell', 'Run a shell command in the workspace. Allowlisted binaries only. Use for compilers, readelf, gc, curl to in-scope hosts.', {
      command: { type: 'string', description: 'full command line; pipes allowed' },
      cwd: { type: 'string', description: 'working dir relative to workspace' },
      timeoutMs: { type: 'integer' },
    }, ['command']),
    run: (cfg, args) => runShell(cfg, args),
  },
  scan_surface: {
    ...def('scan_surface', 'Inventory a target: languages, LOC, entry points (main, routes, stdin, argv), build system.', {
      path: { type: 'string', description: 'target directory or file, default "."' },
    }),
    run: (cfg, args, ctx) => {
      const surface = scanSurface(cfg, args);
      if (ctx.ledger) {
        ctx.ledger.upsertEntity({
          type: 'target',
          key: surface.root,
          attrs: { files: surface.fileCount, loc: surface.loc, languages: surface.languages.map((l) => l.lang) },
          confidence: 'observed',
          engagement: ctx.engagementId || null,
        });
      }
      const lines = [
        `target: ${surface.root}  (${surface.fileCount} files, ${surface.loc} LOC)`,
        `languages: ${surface.languages.map((l) => `${l.lang}=${l.count}`).join(', ') || 'none'}`,
        `build: ${surface.build.map((b) => `${b.file} (${b.tool})`).join(', ') || 'none detected'}`,
        `entry points (${surface.entryPoints.length}):`,
        ...surface.entryPoints.slice(0, 25).map((e) => `  ${e.kind.padEnd(14)} ${e.file}:${e.line}  ${e.detail}`),
      ];
      return { ok: true, output: lines.join('\n'), meta: { surface } };
    },
  },
  scan_sinks: {
    ...def('scan_sinks', 'Static scan for dangerous sinks (strcpy, system, pickle, SQL concat, path traversal...). Returns ranked candidates with CWE and a reachability score. Candidates are not confirmed bugs.', {
      path: { type: 'string', description: 'target directory or file, default "."' },
      maxFiles: { type: 'integer' },
    }),
    run: (cfg, args, ctx) => {
      const { hits, scanned, skipped } = scanSinks(cfg, args);
      if (!hits.length) return { ok: true, output: `scanned ${scanned} files, no sink candidates.`, meta: { hits: [] } };
      // a scan is a fact and a state change, not just output
      ctx.ledger?.addEntry?.({
        surface: String(args.path || '.'),
        action: 'scan_sinks static rules',
        result: `${hits.length} candidates in ${scanned} files${hits[0] ? `; top ${hits[0].cwe} ${hits[0].file}:${hits[0].line}` : ''}`,
        confidence: 'observed',
        engagement: ctx.engagementId || null,
      });
      ctx.ledger?.upsertEntity?.({
        type: 'target',
        key: String(args.path || '.'),
        attrs: { candidates: hits.length, files: scanned },
        confidence: 'observed',
        engagement: ctx.engagementId || null,
      });

      // candidates belong in the rail, and the id is stable so repeat scans dedupe
      for (const hit of hits.slice(0, 8)) {
        const finding = ctx.store?.addFinding({
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
          source: 'scan_sinks',
        });
        if (finding) ctx.emit?.({ type: 'finding', finding });
      }
      const rows = hits.slice(0, 40).map(
        (h) => `[${h.severity.toUpperCase()} ${h.cwe} reach=${h.reach}] ${h.file}:${h.line}  ${h.rule}\n    ${h.snippet.split('\n')[0].slice(0, 160)}`,
      );
      return {
        ok: true,
        output: `scanned ${scanned} files (${skipped} skipped) — ${hits.length} candidates, top ${Math.min(hits.length, 40)}:\n\n${rows.join('\n')}`,
        meta: { hits: hits.slice(0, 60) },
      };
    },
  },
  http_probe: {
    ...def('http_probe', 'Send one HTTP request to an in-scope host and return status, headers and body head. Host must be listed in scope. A successful probe records the host and service in engagement state.', {
      url: { type: 'string', description: 'full url, e.g. http://127.0.0.1:8080/login' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH'] },
      headers: { type: 'object', description: 'request headers' },
      body: { type: 'string' },
      session: { type: 'string', description: 'named session; keeps cookies and headers across probes' },
    }, ['url']),
    run: async (cfg, args, ctx) => {
      const result = await httpProbe(cfg, args);
      if (result.ok && ctx.ledger) {
        try {
          const u = new URL(result.meta?.url || args.url);
          const host = ctx.ledger.upsertEntity({
            type: 'host',
            key: u.hostname,
            attrs: { lastStatus: result.meta?.status, scheme: u.protocol.replace(':', '') },
            confidence: 'observed',
            engagement: ctx.engagementId || null,
          });
          const svc = ctx.ledger.upsertEntity({
            type: 'service',
            key: `${u.hostname}:${u.port || (u.protocol === 'https:' ? 443 : 80)}`,
            attrs: {
              status: result.meta?.status,
              path: u.pathname,
              server: (result.output.match(/^server: (.+)$/im) || [])[1] || '',
            },
            confidence: 'observed',
            engagement: ctx.engagementId || null,
          });
          ctx.ledger.link(host.id, svc.id, 'EXPOSES');
        } catch { /* state is best-effort, never blocks a probe */ }
      }
      return result;
    },
  },
  tcp_probe: {
    ...def('tcp_probe', 'TCP connect and grab a banner from an in-scope host.', {
      host: { type: 'string' },
      port: { type: 'integer' },
    }, ['host', 'port']),
    run: (cfg, args) => tcpProbe(cfg, args),
  },
  build_target: {
    ...def('build_target', 'Detect the build system and compile the target with AddressSanitizer/UBSan enabled.', {
      path: { type: 'string', description: 'target directory, default "."' },
    }),
    run: async (cfg, args, ctx) => {
      const abs = ctx.resolve(args.path || '.');
      const plan = detectBuild(abs);
      if (!plan.build) return { ok: false, output: 'no build system detected; write a harness with fs_write and compile it directly' };
      ctx.emit?.({ type: 'tool_note', text: `build (${plan.tool}): ${plan.build}` });
      const res = await runShell(cfg, { command: plan.build, cwd: path.relative(cfg.workspace, abs) || '.', timeoutMs: 240000 });
      return {
        ok: res.ok,
        output: `${res.ok ? 'build ok' : 'build failed'} (${plan.tool})\n${res.output}`,
        meta: { plan, ...res.meta },
      };
    },
  },
  run_harness: {
    ...def('run_harness', 'Run a command (usually a compiled PoC) and classify any sanitizer crash. Crashes become findings automatically.', {
      command: { type: 'string', description: 'e.g. ./pocs/harness $(python3 -c "print(\'A\'*200)")' },
      cwd: { type: 'string' },
      timeoutMs: { type: 'integer' },
    }, ['command']),
    run: async (cfg, args, ctx) => {
      const res = await runShell(cfg, { ...args, timeoutMs: args.timeoutMs || 30000 });
      const verdict = classifyCrash(res.output, res.meta?.code);
      const lines = [`verdict: ${verdict.crashed ? 'CRASH' : 'no crash'}${verdict.kind ? ` (${verdict.kind})` : ''}`];
      if (verdict.cwe) lines.push(`cwe: ${verdict.cwe}  severity: ${verdict.severity}`);
      if (verdict.region) lines.push(`region: ${verdict.region.size}-byte ${verdict.region.type}`);
      if (verdict.frames?.length) lines.push(`frames:\n${verdict.frames.map((f) => `  ${f}`).join('\n')}`);
      if (verdict.evidence) lines.push(`evidence:\n${verdict.evidence}`);
      lines.push(`--- raw ---\n${res.output}`);

      if (verdict.crashed && verdict.kind && verdict.kind !== 'nonzero-exit') {
        const binPath = String(args.command).trim().split(/\s+/)[0].replace(/^\.\//, '');
        const finding = ctx.store.addFinding({
          title: `${verdict.kind} in ${binPath.split('/').pop() || 'harness'}`,
          severity: verdict.severity || 'high',
          cwe: verdict.cwe,
          target: args.command,
          file: binPath,
          line: 0,
          evidence: verdict.evidence || res.output.slice(0, 1200),
          status: 'reproduced',
          repro: args.command,
          cwd: res.meta?.cwd || cfg.workspace,
          kind: verdict.kind,
          frames: verdict.frames || [],
          source: 'run_harness',
        });
        ctx.emit?.({ type: 'finding', finding });
        lines.push(`finding recorded: ${finding.id} (status: reproduced — run verify_finding to confirm)`);
      }
      return { ok: res.ok || verdict.crashed, output: trunc(cfg, lines.join('\n')), meta: { verdict } };
    },
  },
  finding_write: {
    ...def('finding_write', 'Record a finding. Only mark status "confirmed" when you have a crash or a reproduced response as evidence.', {
      title: { type: 'string' },
      severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
      cwe: { type: 'string', description: 'e.g. CWE-121' },
      file: { type: 'string' },
      line: { type: 'integer' },
      evidence: { type: 'string', description: 'the exact output / request / stack that proves it' },
      status: { type: 'string', enum: ['candidate', 'confirmed', 'dismissed'] },
      repro: { type: 'string', description: 'command or steps that reproduce' },
    }, ['title', 'severity', 'evidence']),
    run: (cfg, args, ctx) => {
      const finding = ctx.store.addFinding({ ...args, source: 'agent' });
      ctx.emit?.({ type: 'finding', finding });
      return { ok: true, output: `recorded ${finding.id}: [${finding.severity}] ${finding.title} (${finding.status})`, meta: { finding } };
    },
  },

  ledger_write: {
    ...def('ledger_write', 'Record what you tested and what came back. One entry per surface+action. Do this after every probe or code read — the room plans from this, not from memory.', {
      surface: { type: 'string', description: 'file:line, route, host:port, or function name' },
      action: { type: 'string', description: 'the command you ran or the code you read' },
      result: { type: 'string', description: 'what happened: status, output head, crash signature' },
      confidence: { type: 'string', enum: ['observed', 'inferred'], description: 'observed = a command ran; inferred = read from code' },
      note: { type: 'string' },
    }, ['surface', 'action', 'result']),
    run: (cfg, args, ctx) => {
      const entry = ctx.ledger.addEntry({ ...args, engagement: ctx.engagementId || null });
      return {
        ok: true,
        output: `ledger ${entry.id} [${entry.confidence}] ${entry.surface} — ${entry.repeats > 1 ? `updated, tested ${entry.repeats}x` : 'new'}`,
        meta: { entry },
      };
    },
  },
  ledger_read: {
    ...def('ledger_read', 'Read the coverage ledger and open intents. Call this before testing something so you do not repeat a dead end.', {
      surface: { type: 'string', description: 'optional: check one surface only' },
    }),
    run: (cfg, args, ctx) => {
      if (args.surface) {
        const t = ctx.ledger.tested(args.surface);
        if (!t.hits.length) return { ok: true, output: `not tested: ${args.surface}` };
        return {
          ok: true,
          output: `${args.surface}: ${t.observed} observed, ${t.inferred} inferred\n${t.hits.slice(0, 6).map((e) => `- [${e.confidence}] ${e.action} → ${String(e.result || '').slice(0, 140)}`).join('\n')}`,
        };
      }
      return { ok: true, output: ctx.ledger.brief() };
    },
  },
  intent_write: {
    ...def('intent_write', 'Open one direction of work. A direction, not a chore: target, rationale, and the skill it needs. Three to five is useful.', {
      title: { type: 'string', description: 'one line, specific' },
      rationale: { type: 'string', description: 'why this direction is likely to yield' },
      target: { type: 'string', description: 'file, route, or host' },
      skill: { type: 'string', description: 'skill id that should be loaded' },
    }, ['title']),
    run: (cfg, args, ctx) => {
      const intent = ctx.ledger.addIntent({ ...args, engagement: ctx.engagementId || null });
      ctx.emit?.({ type: 'intent', intent });
      return { ok: true, output: `intent ${intent.id} [${intent.status}] ${intent.title}`, meta: { intent } };
    },
  },
  intent_status: {
    ...def('intent_status', 'Close an intent: done, blocked, or running.', {
      id: { type: 'string' },
      status: { type: 'string', enum: ['running', 'done', 'blocked', 'open'] },
    }, ['id', 'status']),
    run: (cfg, args, ctx) => {
      const intent = ctx.ledger.setIntentStatus(args.id, args.status);
      if (!intent) return { ok: false, output: `no intent ${args.id}` };
      ctx.emit?.({ type: 'intent', intent });
      return { ok: true, output: `intent ${intent.id} → ${intent.status}` };
    },
  },
  http_history: {
    ...def('http_history', 'Requests recorded in a named session, newest first.', {
      session: { type: 'string' },
      limit: { type: 'integer' },
    }, ['session']),
    run: (cfg, args) => {
      const rows = sessions.history(args.session, Number(args.limit) || 12);
      if (!rows.length) return { ok: true, output: `no requests in session "${args.session}"` };
      return {
        ok: true,
        output: rows.map((r) => `#${r.n} ${r.method} ${r.url} → ${r.status} ${r.contentType || ''}`).join('\n'),
      };
    },
  },
  verify_finding: {
    ...def('verify_finding', 'Re-run a finding\'s recorded repro command and compare the crash signature. This is the ONLY step that promotes a finding to confirmed. Failing verification demotes it.', {
      id: { type: 'string', description: 'finding id, or enough of the title' },
      note: { type: 'string', description: 'what you checked for counterevidence' },
    }, ['id']),
    run: async (cfg, args, ctx) => {
      const findings = ctx.store.listFindings();
      const needle = String(args.id || '').toLowerCase();
      const finding = findings.find((f) => f.id === args.id)
        || findings.find((f) => String(f.title || '').toLowerCase().includes(needle))
        || findings.find((f) => String(f.cwe || '').toLowerCase() === needle);
      if (!finding) return { ok: false, output: `no finding matching "${args.id}". Known: ${findings.slice(0, 6).map((f) => f.id).join(', ') || 'none'}` };
      if (!finding.repro) {
        return { ok: false, output: `${finding.id} has no repro command. Re-run the harness so the command is recorded, then verify.` };
      }

      const run = await runShell(cfg, { command: finding.repro, cwd: finding.cwd, timeoutMs: 60000 });
      const verdict = classifyCrash(run.output, run.meta?.code);
      const digest = crypto.createHash('sha256').update(String(run.output)).digest('hex').slice(0, 16);
      const same = verdict.crashed && (!finding.kind || verdict.kind === finding.kind);

      const evidence = {
        at: Date.now(),
        command: finding.repro,
        digest,
        kind: verdict.kind || 'no-crash',
        frames: verdict.frames || [],
        matchesFirstRun: same,
      };

      const updated = ctx.store.updateFinding(finding.id, same
        ? {
            status: 'confirmed',
            verifiedAt: Date.now(),
            evidenceId: `ev_${digest}`,
            evidence2: evidence,
            counterevidence: args.note || finding.counterevidence || '',
          }
        : {
            lastAttemptAt: Date.now(),
            evidence2: evidence,
            counterevidence: `did not reproduce: ${verdict.kind || 'no crash'} (first run: ${finding.kind || 'unknown'})`,
          });

      ctx.emit?.({ type: 'finding', finding: updated });

      const lines = [
        `${finding.id} — ${same ? 'CONFIRMED' : 'NOT REPRODUCED'}`,
        `first run: ${finding.kind || 'unknown'}   this run: ${verdict.kind || 'no crash'}`,
        `evidence: ev_${digest}${verdict.frames?.length ? `  frame: ${verdict.frames[0]}` : ''}`,
      ];
      if (!same) lines.push('The finding stays a candidate. Do not describe it as confirmed.');
      return { ok: true, output: lines.join('\n'), meta: { finding: updated, verdict } };
    },
  },
  entity_upsert: {
    ...def('entity_upsert', 'Record what you know about a host, service, target, credential or path. Merged by type+key, so calling it twice updates rather than duplicates.', {
      type: { type: 'string', enum: ['host', 'service', 'target', 'credential', 'path', 'note'] },
      key: { type: 'string', description: 'stable identifier: hostname, host:port, file path, username@domain' },
      attrs: { type: 'object', description: 'what you learned: version, status, note, privilege' },
      confidence: { type: 'string', enum: ['observed', 'inferred'] },
    }, ['type', 'key']),
    run: (cfg, args, ctx) => {
      const entity = ctx.ledger.upsertEntity({
        type: args.type,
        key: args.key,
        attrs: args.attrs || {},
        confidence: args.confidence || 'observed',
        engagement: ctx.engagementId || null,
      });
      ctx.emit?.({ type: 'entity', entity });
      return {
        ok: true,
        output: `state ${entity.id} [${entity.type}] ${entity.key} — ${Object.entries(entity.attrs).map(([k, v]) => `${k}=${v}`).join(' ') || '(no attrs)'}`,
        meta: { entity },
      };
    },
  },
  entity_list: {
    ...def('entity_list', 'Read engagement state: known hosts, services, targets.', {
      type: { type: 'string', enum: ['host', 'service', 'target', 'credential', 'path', 'note'] },
    }),
    run: (cfg, args, ctx) => {
      const groups = ctx.ledger.entitiesByType();
      const types = args.type ? [args.type] : Object.keys(groups);
      if (!types.length) return { ok: true, output: 'state is empty' };
      return {
        ok: true,
        output: types.map((t) => `${t}:\n${(groups[t] || []).slice(0, 20).map((e) => `  ${e.key} ${JSON.stringify(e.attrs)} [${e.confidence}]`).join('\n') || '  (none)'}`).join('\n'),
      };
    },
  },

};

/** Tool defs a model sees, filtered by the agent's allowlist and the policy. */
export function toolDefsFor(names) {
  return names
    .map((n) => TOOLS[n])
    .filter(Boolean)
    .map(({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters } }));
}

export function makeContext(cfg, { store, ledger, engagements, emit, resolve }) {
  return { store, ledger, engagements, emit, resolve };
}

export async function executeTool(cfg, name, args, ctx) {
  const tool = TOOLS[name];
  if (!tool) {
    const available = Object.keys(TOOLS).join(', ');
    return { ok: false, output: `unknown tool "${name}". Available: ${available}` };
  }
  const started = Date.now();
  try {
    const result = await tool.run(cfg, args || {}, ctx);
    return { ...result, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, output: `tool error: ${err.message}`, ms: Date.now() - started };
  }
}

export { validateCommand, classifyCrash, detectBuild, scanSinks, scanSurface };
export { runShell };
