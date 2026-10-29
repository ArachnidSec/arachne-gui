import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { allowedRoots, resolveInside } from '../config.mjs';

/**
 * A shell that a model can hold without burning the house down.
 *
 * Two independent brakes, both cheap:
 *   1. every pipeline segment's argv[0] must be on the allowlist
 *   2. every path-looking argument must resolve inside scope
 *
 * Pentest work needs pipes, redirects, compilers and sanitizer runs. It does
 * not need sudo, dd, or a curl-to-shell. Those are refused by name.
 */

const ALLOW = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr', 'diff', 'patch',
  'grep', 'egrep', 'fgrep', 'sed', 'awk', 'find', 'xargs', 'file', 'stat', 'du', 'df',
  'echo', 'printf', 'tee', 'touch', 'mkdir', 'cp', 'mv', 'ln', 'chmod',
  'clang', 'clang++', 'gcc', 'g++', 'cc', 'make', 'cmake', 'ninja', 'meson', 'pkg-config',
  'ar', 'ranlib', 'strip', 'ld', 'llvm-symbolizer', 'dsymutil', 'install_name_tool',
  'nm', 'objdump', 'otool', 'readelf', 'strings', 'xxd', 'hexdump', 'shasum', 'shasum256', 'md5',
  'python3', 'python', 'pip3', 'pip', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'deno', 'bun',
  'go', 'cargo', 'rustc', 'java', 'javac', 'javap', 'mvn', 'gradle',
  'git', 'jq', 'yq', 'timeout', 'env', 'which', 'command', 'basename', 'dirname', 'realpath',
  'curl', 'wget', 'nc', 'ncat', 'nmap', 'masscan', 'ffuf', 'gobuster', 'sqlmap', 'nuclei',
  'lsof', 'ps', 'uname', 'whoami', 'id', 'pwd', 'date', 'open', 'codesign',
  'ruby', 'php', 'perl', 'lua', 'swift', 'dotnet', 'mcs', 'mono',
  'valgrind', 'gdb', 'lldb', 'ltrace', 'strace', 'perf', 'hyperfine',
]);

const DENY = new Set([
  'sudo', 'doas', 'su', 'shutdown', 'reboot', 'halt', 'poweroff', 'diskutil', 'launchctl',
  'mkfs', 'mkfs.ext4', 'fdisk', 'parted', 'dd', 'killall', 'kill', 'osascript', 'defaults',
  'csrutil', 'nvram', 'systemsetup', 'spctl', 'chown', 'chroot', 'mount', 'umount',
  'apt', 'apt-get', 'brew', 'yum', 'dnf', 'pacman', 'systemctl', 'service',
]);

const OPERATORS = /(\|\||&&|[|;\n])/;

function segments(command) {
  return command
    .split(OPERATORS)
    .filter((s) => s && !OPERATORS.test(s))
    .map((s) => s.trim())
    .filter(Boolean);
}

function firstWord(segment) {
  const cleaned = segment.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '');
  return cleaned.split(/\s+/)[0] || '';
}

function insideAny(abs, roots) {
  return roots.some((r) => abs === r || abs.startsWith(r + path.sep));
}

function looksPathish(token) {
  if (!token || token.startsWith('-')) return false;
  return token.startsWith('/') || token.startsWith('~') || token.startsWith('./') || token.startsWith('../');
}

/** Pull $(...) and `...` bodies out so they can be validated on their own. */
function extractSubs(cmd) {
  const subs = [];
  let scrubbed = '';
  let i = 0;
  while (i < cmd.length) {
    if (cmd[i] === '$' && cmd[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      while (j < cmd.length && depth > 0) {
        if (cmd[j] === '(') depth += 1;
        else if (cmd[j] === ')') depth -= 1;
        if (depth > 0) j += 1;
      }
      if (depth !== 0) return { error: 'unbalanced $( in command' };
      subs.push(cmd.slice(i + 2, j));
      scrubbed += 'SUB';
      i = j + 1;
      continue;
    }
    if (cmd[i] === '`') {
      const j = cmd.indexOf('`', i + 1);
      if (j < 0) return { error: 'unbalanced backtick in command' };
      subs.push(cmd.slice(i + 1, j));
      scrubbed += 'SUB';
      i = j + 1;
      continue;
    }
    scrubbed += cmd[i];
    i += 1;
  }
  return { subs, scrubbed };
}

export function validateCommand(cfg, command, depth = 0) {
  const roots = allowedRoots(cfg);
  const permissive = cfg.policy.shell === 'any' || cfg.policy.allowUnsafe;
  const problems = [];

  if (typeof command !== 'string' || !command.trim()) return { ok: false, reason: 'empty command' };
  if (command.length > 8000) return { ok: false, reason: 'command too long' };
  if (depth > 2) return { ok: false, reason: 'command substitution nested too deep' };

  // substitution is allowed only when the inner command passes the same checks
  if (!permissive) {
    const { subs, scrubbed, error } = extractSubs(command);
    if (error) return { ok: false, reason: error };
    for (const inner of subs) {
      const verdict = validateCommand(cfg, inner, depth + 1);
      if (!verdict.ok) return { ok: false, reason: `inside $( ): ${verdict.reason}` };
    }
    command = scrubbed;
  }

  for (const seg of segments(command)) {
    const rawBin = firstWord(seg);
    const bin = path.basename(rawBin);
    if (!bin) continue;
    const localExec = /^\.{1,2}\//.test(rawBin) || rawBin.startsWith('/');
    if (DENY.has(bin)) {
      problems.push(`refused by name: ${bin}`);
    } else if (localExec) {
      const resolved = path.resolve(cfg.workspace, rawBin);
      if (!insideAny(resolved, roots)) problems.push(`executable outside scope: ${rawBin}`);
    } else if (!permissive && !ALLOW.has(bin)) {
      problems.push(`not on the shell allowlist: ${bin}`);
    }

    const tokens = seg.split(/\s+/).slice(1);
    for (const tok of tokens) {
      const bare = tok.replace(/^['"]|['"]$/g, '');
      if (looksPathish(bare)) {
        const resolved = path.resolve(cfg.workspace, bare.replace(/^~.*/, '~'));
        if (bare.startsWith('~')) {
          problems.push(`home-relative paths are not allowed: ${bare}`);
        } else if (!insideAny(resolved, roots)) {
          problems.push(`path outside scope: ${bare}`);
        }
      }
      if (bin === 'rm' && bare.startsWith('-')) continue;
    }

    if (bin === 'rm') {
      const targets = tokens.filter((t) => !t.startsWith('-'));
      if (!targets.length) problems.push('rm without a workspace path');
      for (const t of targets) {
        const resolved = path.resolve(cfg.workspace, t);
        if (!insideAny(resolved, roots)) problems.push(`rm outside scope: ${t}`);
      }
    }
    if (bin === 'chmod' && /-R/.test(seg) && /777|666/.test(seg)) problems.push('refusing recursive world-writable chmod');
  }

  const redirects = command.match(/>>?\s*([^\s|;&]+)/g) || [];
  for (const r of redirects) {
    const target = r.replace(/>>?\s*/, '').replace(/^['"]|['"]$/g, '');
    if (target === '/dev/null' || target === '&1' || target === '&2') continue;
    const resolved = path.resolve(cfg.workspace, target);
    if (!insideAny(resolved, roots)) problems.push(`redirect outside scope: ${target}`);
  }

  if (problems.length) return { ok: false, reason: [...new Set(problems)].join('; ') };
  return { ok: true };
}

const truncate = (cfg, text) => {
  const max = cfg.policy.maxOutputChars || 12000;
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.7));
  const tail = text.slice(-Math.floor(max * 0.25));
  return `${head}\n... [${text.length - head.length - tail.length} chars elided] ...\n${tail}`;
};

export function runShell(cfg, { command, cwd, timeoutMs } = {}) {
  const started = Date.now();
  const check = validateCommand(cfg, command);
  if (!check.ok) {
    return Promise.resolve({
      ok: false,
      output: `command refused: ${check.reason}`,
      meta: { refused: true, ms: 0 },
    });
  }

  let workdir;
  try {
    workdir = resolveInside(cfg, cwd || '.');
  } catch (err) {
    return Promise.resolve({ ok: false, output: `bad cwd: ${err.message}`, meta: { refused: true, ms: 0 } });
  }
  if (!fs.existsSync(workdir)) fs.mkdirSync(workdir, { recursive: true });

  const limit = Math.min(timeoutMs || cfg.policy.toolTimeoutMs || 30000, 600000);

  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: workdir,
      env: {
        ...process.env,
        ASAN_OPTIONS: process.env.ASAN_OPTIONS || 'detect_leaks=0:symbolize=1:abort_on_error=0',
        UBSAN_OPTIONS: 'print_stacktrace=1',
        PWD: workdir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, limit);

    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      const combined = `${out}${err ? `\n--- stderr ---\n${err}` : ''}`.trim();
      resolve({
        ok: code === 0 && !killed,
        output: truncate(cfg, combined || '(no output)'),
        meta: { code, signal, ms, killed, cwd: workdir, command },
      });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `spawn failed: ${e.message}`, meta: { ms: Date.now() - started } });
    });
  });
}
