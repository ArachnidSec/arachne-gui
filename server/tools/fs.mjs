import fs from 'node:fs';
import path from 'node:path';
import { resolveInside } from '../config.mjs';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'target', '.next', '.cache',
  '__pycache__', '.venv', 'venv', 'vendor', '.idea', '.vscode', 'data',
]);

const MAX_READ_BYTES = 512 * 1024;

const isBinary = (buf) => buf.subarray(0, 4096).includes(0);

export function walk(dir, { depth = 6, maxFiles = 4000, filter = null } = {}) {
  const files = [];
  const stack = [{ dir, level: 0 }];
  let visited = 0;
  while (stack.length && files.length < maxFiles && visited < maxFiles * 4) {
    const { dir: current, level } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || level >= depth) continue;
        stack.push({ dir: full, level: level + 1 });
      } else if (entry.isFile()) {
        if (filter && !filter(full)) continue;
        files.push(full);
      }
      if (files.length >= maxFiles) break;
    }
  }
  return files;
}

export const fsRead = (cfg, { path: target, offset = 1, limit = 400 } = {}) => {
  const abs = resolveInside(cfg, target, { mustExist: true });
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    return fsList(cfg, { path: target, depth: 1 });
  }
  const buf = fs.readFileSync(abs);
  if (isBinary(buf)) {
    return { ok: true, output: `${target}: binary file, ${buf.length} bytes (use shell: file/strings/xxd)` };
  }
  if (buf.length > MAX_READ_BYTES) {
    return { ok: false, output: `file too large (${buf.length} bytes); read a slice with offset/limit or use grep` };
  }
  const lines = buf.toString('utf8').split('\n');
  const start = Math.max(1, Number(offset) || 1);
  const count = Math.max(1, Math.min(Number(limit) || 400, 2000));
  const slice = lines.slice(start - 1, start - 1 + count);
  const numbered = slice.map((line, i) => `${String(start + i).padStart(5)} | ${line}`).join('\n');
  const tail = start - 1 + count < lines.length ? `\n... (${lines.length - (start - 1 + count)} more lines)` : '';
  return { ok: true, output: `${path.relative(cfg.workspace, abs)} (${lines.length} lines)\n${numbered}${tail}` };
};

export const fsList = (cfg, { path: target = '.', depth = 2 } = {}) => {
  const abs = resolveInside(cfg, target, { mustExist: true });
  const maxDepth = Math.min(Number(depth) || 2, 8);
  const rows = [];
  const MAX = 600;

  const visit = (dir, level) => {
    if (rows.length >= MAX || level > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (rows.length >= MAX) return;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(cfg.workspace, full);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        rows.push(`${'—'.padStart(8)}  ${rel}/`);
        visit(full, level + 1);
      } else if (entry.isFile()) {
        let size = 0;
        try { size = fs.statSync(full).size; } catch {}
        rows.push(`${String(size).padStart(8)}  ${rel}`);
      }
    }
  };

  visit(abs, 1);
  if (!rows.length) return { ok: true, output: '(empty)' };
  return { ok: true, output: rows.join('\n') };
};

export const fsWrite = (cfg, { path: target, content = '' } = {}) => {
  if (!target) return { ok: false, output: 'path required' };
  const abs = resolveInside(cfg, target);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, String(content ?? ''));
  return { ok: true, output: `wrote ${String(content ?? '').length} bytes to ${path.relative(cfg.workspace, abs)}` };
};

export const fsEdit = (cfg, { path: target, find, replace = '' } = {}) => {
  const abs = resolveInside(cfg, target, { mustExist: true });
  const src = fs.readFileSync(abs, 'utf8');
  if (!find) return { ok: false, output: 'find string required' };
  const idx = src.indexOf(find);
  if (idx < 0) return { ok: false, output: 'find string not present' };
  const next = src.slice(0, idx) + replace + src.slice(idx + find.length);
  fs.writeFileSync(abs, next);
  const line = src.slice(0, idx).split('\n').length;
  return { ok: true, output: `patched ${path.relative(cfg.workspace, abs)}:${line}` };
};

export const fsGrep = (cfg, { pattern, path: target = '.', glob = '', maxResults = 80, ignoreCase = true } = {}) => {
  if (!pattern) return { ok: false, output: 'pattern required' };
  let re;
  try {
    re = new RegExp(pattern, ignoreCase ? 'i' : '');
  } catch (err) {
    return { ok: false, output: `bad regex: ${err.message}` };
  }
  const abs = resolveInside(cfg, target, { mustExist: true });
  const globRe = glob ? new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i') : null;
  const files = walk(abs, {
    depth: 8,
    maxFiles: 3000,
    filter: globRe ? (f) => globRe.test(path.basename(f)) : null,
  });
  const hits = [];
  for (const file of files) {
    if (hits.length >= maxResults) break;
    let buf;
    try { buf = fs.readFileSync(file); } catch { continue; }
    if (isBinary(buf) || buf.length > MAX_READ_BYTES) continue;
    const lines = buf.toString('utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      re.lastIndex = 0;
      if (re.test(lines[i])) {
        hits.push(`${path.relative(cfg.workspace, file)}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
        if (hits.length >= maxResults) break;
      }
    }
  }
  return { ok: true, output: hits.length ? hits.join('\n') : '(no matches)' };
};
