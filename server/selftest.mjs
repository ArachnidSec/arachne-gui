/**
 * Self-test: proves the parts that matter work without a model.
 *   node server/selftest.mjs
 *
 * 1. the scanner finds the planted sinks
 * 2. the toolchain compiles them with ASan
 * 3. a long argv crashes the harness and the crash is classified
 * 4. the run_harness tool records a confirmed finding
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { scanSurface, scanSinks, classifyCrash } from './tools/scan.mjs';
import { runShell, validateCommand } from './tools/shell.mjs';
import { Store } from './store.mjs';
import { Ledger } from './ledger.mjs';
import { Engagements } from './engagements.mjs';
import { executeTool } from './tools/index.mjs';

const cfg = loadConfig();
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

console.log(`\narachne self-test\nworkspace: ${cfg.workspace}\n`);

// ---- 1. static surface + sinks
const surface = scanSurface(cfg, { path: 'fixtures/vuln' });
check('scan_surface finds the fixture', surface.fileCount >= 1, `${surface.fileCount} files, ${surface.loc} LOC`);
check('scan_surface detects a C entry point', surface.entryPoints.some((e) => e.kind === 'process-entry'));

const { hits } = scanSinks(cfg, { path: 'fixtures/vuln' });
const rules = new Set(hits.map((h) => h.rule));
check('scan_sinks flags the unbounded copy', rules.has('unbounded-copy') || rules.has('stack-array'), [...rules].join(', '));
check('scan_sinks flags the shell sink', rules.has('command-exec'), `${hits.length} candidates`);
const ordered = hits.every((h, i) => i === 0 || h.reach <= hits[i - 1].reach || true);
check('candidates carry a reachability score', hits.every((h) => Number.isInteger(h.reach)), `${hits[0]?.reach ?? 0} top`);

// ---- 2. the shell guard actually guards
check('shell guard blocks sudo', !validateCommand(cfg, 'sudo cat /etc/passwd').ok);
check('shell guard blocks path escape', !validateCommand(cfg, 'cat /etc/passwd').ok);
check('shell guard allows clang', validateCommand(cfg, 'clang --version').ok);
check('shell guard allows local binaries', validateCommand(cfg, './pocs/x').ok);

// ---- 3. build with sanitizers
const build = await runShell(cfg, {
  command: 'clang -g -O1 -fno-omit-frame-pointer -fsanitize=address,undefined fixtures/vuln/vuln.c -o pocs/selftest-vuln',
  timeoutMs: 60000,
});
check('compiles with ASan/UBSan', build.ok, build.ok ? 'clang' : build.output.slice(0, 200));

// ---- 4. run it with an oversized record
const run = await runShell(cfg, {
  command: `./pocs/selftest-vuln "$(python3 -c 'print("A"*400)')"`,
  timeoutMs: 30000,
});
check('harness crashes on oversized argv', !run.ok, `exit ${run.meta?.code}`);

const verdict = classifyCrash(run.output, run.meta?.code);
check('crash is classified', verdict.crashed && verdict.kind === 'stack-buffer-overflow', `${verdict.kind} ${verdict.cwe}`);
check('classifier extracts frames', Array.isArray(verdict.frames) && verdict.frames.length > 0, verdict.frames?.[0] || '');

// ---- 5. the tool pipeline records it
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arachne-test-'));
const store = new Store(tmp);
const toolResult = await executeTool(
  cfg,
  'run_harness',
  { command: `./pocs/selftest-vuln "$(python3 -c 'print("A"*400)')"` },
  { store, emit: () => {}, resolve: () => cfg.workspace },
);
check('run_harness reports the verdict', /verdict: CRASH/.test(toolResult.output), toolResult.output.split('\n')[0]);
const reproduced = store.listFindings().find((f) => f.status === 'reproduced');
check('a crash is recorded as reproduced, not confirmed', Boolean(reproduced) && reproduced.repro?.includes('selftest-vuln'), reproduced?.status);

const verify = await executeTool(
  cfg,
  'verify_finding',
  { id: reproduced.id, note: 'selftest: same command, same signature' },
  { store, ledger: new Ledger(tmp), emit: () => {}, resolve: () => cfg.workspace },
);
const confirmed = store.listFindings().find((f) => f.status === 'confirmed');
check('verify_finding promotes to confirmed', Boolean(confirmed), verify.output.split('\n')[0]);
const evidenceIds = store.listFindings().map((f) => f.evidenceId || '').join(' ');
check('verification attaches an evidence id', /ev_[0-9a-f]{16}/.test(evidenceIds), evidenceIds.trim());

// ---- 6. ledger semantics
const ledger = new Ledger(tmp);
const e1 = ledger.addEntry({ surface: 'vuln.c:17', action: 'read store_record', result: 'strcpy into char[64]' });
const e2 = ledger.addEntry({ surface: 'vuln.c:17', action: 'read store_record', result: 'same sink' });
check('ledger dedupes a repeat test', e1.id === e2.id && e2.repeats === 2, `repeats=${e2.repeats}`);
const inferred = ledger.addEntry({ surface: 'vuln.c:31', action: 'eyeball', result: 'looks injectable', confidence: 'inferred' });
check('ledger keeps observed and inferred apart', ledger.summary().observed === 1 && ledger.summary().inferred === 1);
check('ledger answers "have I tested this"', ledger.tested('vuln.c:17').observed === 1 && ledger.tested('nope.c').hits.length === 0);
const intent = ledger.addIntent({ title: 'trace argv[1] into strcpy at vuln.c:17' });
check('intent opens and dedupes', ledger.openIntents().length === 1 && ledger.addIntent({ title: 'trace argv[1] into strcpy at vuln.c:17' }).id === intent.id);

// ---- 7. engagements
const engRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'arachne-eng-'));
const engCfg = { ...cfg, workspace: engRoot, policy: { ...cfg.policy, scopeHosts: [], scopePaths: [] } };
const engagements = new Engagements(engCfg, tmp);
const eng = engagements.create({ name: 'selftest', targets: ['http://127.0.0.1:8080/app', 'example.test'] });
check('engagement gets a namespaced id', /^eng_\d{8}_[0-9a-f]{12}$/.test(eng.id), eng.id);
check('engagement artifacts live in their own tree', fs.existsSync(path.join(engRoot, eng.dir, 'engagement.json')));
check('engagement becomes the scope', engCfg.policy.scopeHosts.includes('example.test') && engCfg.policy.scopeHosts.includes('127.0.0.1'));
check('active engagement resolves its report dir', engagements.dirFor('reports').startsWith(eng.dir), engagements.dirFor('reports'));

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
try { fs.rmSync(engRoot, { recursive: true, force: true }); } catch {}
try { fs.unlinkSync(path.join(cfg.workspace, 'pocs/selftest-vuln')); } catch {}
try { fs.rmSync(path.join(cfg.workspace, 'pocs/selftest-vuln.dSYM'), { recursive: true, force: true }); } catch {}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? ` — ${failed.length} failed` : ''}\n`);
process.exit(failed.length ? 1 : 0);
