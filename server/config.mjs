import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

/**
 * Every engine is one of two shapes:
 *   ollama  -> {base}            talking the native /api/chat protocol
 *   openai  -> {base} ending /v1 talking /chat/completions
 * That covers Ollama, llama.cpp's server, LM Studio, vLLM, and any
 * OpenAI-compatible wrapper people put around Ornith or LFM2 checkpoints.
 */
export const ENGINE_PRESETS = {
  ollama:   { kind: 'ollama', base: 'http://127.0.0.1:11434', label: 'Ollama' },
  llamacpp: { kind: 'openai', base: 'http://127.0.0.1:8080/v1', label: 'llama.cpp' },
  lmstudio: { kind: 'openai', base: 'http://127.0.0.1:1234/v1', label: 'LM Studio' },
  ornith:   { kind: 'openai', base: 'http://127.0.0.1:8081/v1', label: 'Ornith' },
  lfm:      { kind: 'openai', base: 'http://127.0.0.1:8082/v1', label: 'LFM2' },
  local:    { kind: 'openai', base: 'http://127.0.0.1:1337/v1', label: 'Local API' },
};

export const DEFAULT_CONFIG = {
  port: 7777,
  workspace: path.join(ROOT, 'workspace'),
  dataDir: path.join(ROOT, 'data'),
  engines: { ...ENGINE_PRESETS },
  /** engine+model per role; empty model means "auto-pick on boot" */
  roles: {
    scout:  { engine: 'ollama', model: '' },
    static: { engine: 'ollama', model: '' },
    hunter: { engine: 'ollama', model: '' },
    triage: { engine: 'ollama', model: '' },
    scribe: { engine: 'ollama', model: '' },
    planner: { engine: 'ollama', model: '' },
    chat:   { engine: 'ollama', model: '' },
  },
  policy: {
    /** allowlist | any */
    shell: 'allowlist',
    allowUnsafe: false,
    maxSteps: 12,
    toolTimeoutMs: 30000,
    maxOutputChars: 12000,
    maxTokensPerTurn: 80000,
    costPerMTok: { input: 0, output: 0 },
    /** nothing outside these paths is readable or writable */
    scopePaths: [],
    /** http/tcp probes require an explicit host here */
    scopeHosts: ['127.0.0.1', 'localhost'],
    temperature: 0.3,
  },
};

const deepMerge = (base, over) => {
  if (Array.isArray(over)) return over.slice();
  if (over && typeof over === 'object' && !Array.isArray(over)) {
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) {
      out[k] = k in base ? deepMerge(base[k], v) : v;
    }
    return out;
  }
  return over === undefined ? base : over;
};

export function loadConfig() {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    stored = {};
  }
  const cfg = deepMerge(DEFAULT_CONFIG, stored);
  cfg.workspace = path.resolve(cfg.workspace || DEFAULT_CONFIG.workspace);
  cfg.dataDir = path.resolve(cfg.dataDir || DEFAULT_CONFIG.dataDir);
  for (const dir of [cfg.workspace, cfg.dataDir, path.join(cfg.workspace, 'pocs')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return cfg;
}

export function saveConfig(cfg) {
  const plain = {
    port: cfg.port,
    workspace: cfg.workspace,
    engines: cfg.engines,
    roles: cfg.roles,
    policy: cfg.policy,
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(plain, null, 2));
  return plain;
}

/** Paths this process may touch: the workspace plus anything explicitly scoped. */
export function allowedRoots(cfg) {
  const roots = [cfg.workspace, cfg.dataDir, ROOT];
  for (const p of cfg.policy.scopePaths || []) {
    if (p) roots.push(path.resolve(p));
  }
  return roots.map((p) => path.resolve(p));
}

/** Resolve a client/tool path safely; throws if it escapes every allowed root. */
export function resolveInside(cfg, target, { mustExist = false } = {}) {
  const abs = path.resolve(cfg.workspace, target || '.');
  const roots = allowedRoots(cfg);
  const inside = roots.some((r) => abs === r || abs.startsWith(r + path.sep));
  if (!inside) {
    throw new Error(`path outside scope: ${abs}`);
  }
  if (mustExist && !fs.existsSync(abs)) {
    throw new Error(`not found: ${abs}`);
  }
  return abs;
}

export function describe() {
  return { host: os.hostname(), platform: process.platform, node: process.version };
}
