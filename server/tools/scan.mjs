import fs from 'node:fs';
import path from 'node:path';
import { resolveInside } from '../config.mjs';
import { walk } from './fs.mjs';

/**
 * Static sink scan, no third-party engine.
 *
 * This is a candidate generator, not a verdict. Every hit is reported as
 * "candidate" with a reachability score derived from what surrounds the line.
 * The pipeline earns a "confirmed" only by running a harness under ASAN and
 * capturing a real crash — the label is the contract.
 */

const LANG_BY_EXT = {
  '.c': 'c', '.h': 'c',
  '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.m': 'objc', '.mm': 'objc',
  '.py': 'python', '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js',
  '.ts': 'js', '.tsx': 'js', '.php': 'php', '.rb': 'ruby', '.go': 'go', '.java': 'java',
  '.rs': 'rust', '.sh': 'shell', '.yml': 'yaml', '.yaml': 'yaml', '.json': 'json',
};

const CODE_EXTS = new Set(Object.keys(LANG_BY_EXT));

export function langOf(file) {
  return LANG_BY_EXT[path.extname(file).toLowerCase()] || 'other';
}

function stripComments(src, lang) {
  let out = src;
  if (['c', 'cpp', 'objc', 'js', 'go', 'java', 'rust', 'php'].includes(lang)) {
    out = out.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
    out = out.replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
  }
  if (['python', 'ruby', 'shell', 'yaml'].includes(lang)) {
    out = out.replace(/(^|\s)#[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
  }
  return out;
}

const RULES = [
  {
    id: 'unbounded-copy', cwe: 'CWE-120', severity: 'high', langs: ['c', 'cpp', 'objc'],
    re: /\b(strcpy|strcat|sprintf|vsprintf|gets|stpcpy)\s*\(/,
    unless: /\b(snprintf|strlcpy|strlcat|strncpy)\b/,
    why: 'Copies until NUL with no destination size. Any attacker-influenced source overruns the buffer.',
  },
  {
    id: 'memcpy-variable-length', cwe: 'CWE-787', severity: 'high', langs: ['c', 'cpp', 'objc'],
    re: /\b(memcpy|memmove|bcopy)\s*\(\s*[^,]+,\s*[^,]+,\s*(?!sizeof\b)([A-Za-z_][\w.>\-\[\]]*)\s*\)/,
    why: 'Length comes from a variable rather than a compile-time sizeof. Check the bound at the call site.',
  },
  {
    id: 'format-string', cwe: 'CWE-134', severity: 'high', langs: ['c', 'cpp', 'objc'],
    re: /\b(printf|fprintf|sprintf|snprintf|syslog|vprintf)\s*\(\s*(?!["'])[A-Za-z_][\w.\->\[\]]*\s*[,)]/,
    why: 'User data used as the format string, so %n/%s are attacker-controlled.',
  },
  {
    id: 'command-exec', cwe: 'CWE-78', severity: 'critical', langs: ['c', 'cpp', 'objc'],
    re: /\b(system|popen|execl|execlp|execle|execv|execvp|posix_spawn)\s*\(/,
    why: 'Process spawn. Trace the argument back to input; if any part is attacker-controlled this is RCE.',
  },
  {
    id: 'command-exec-js', cwe: 'CWE-78', severity: 'critical', langs: ['js'],
    re: /\b(child_process\.)?(exec|execSync|spawnSync)\s*\(\s*(`|["'][^"']*\$\{|[A-Za-z_][\w.]*\s*\+)/,
    why: 'Shell exec with interpolated input. spawn() with an argv array is the safe shape.',
  },
  {
    id: 'command-exec-py', cwe: 'CWE-78', severity: 'critical', langs: ['python'],
    re: /(os\.(system|popen)\s*\(|subprocess\.\w+\([^)]*shell\s*=\s*True)/,
    why: 'Shell invocation. String-concatenated arguments become command injection.',
  },
  {
    id: 'code-eval', cwe: 'CWE-94', severity: 'critical', langs: ['js', 'python', 'php', 'ruby'],
    re: /\b(eval|exec|compile|Function)\s*\(\s*(?!["'](?:return|function\s*\(\s*\)\s*\{))/,
    why: 'Dynamic code evaluation. If the string is not a constant, this is code injection.',
  },
  {
    id: 'deserialization', cwe: 'CWE-502', severity: 'critical', langs: ['python', 'php', 'ruby', 'java', 'js'],
    re: /(pickle\.loads?\s*\(|yaml\.load\s*\([^,)]*\)|unserialize\s*\(|Marshal\.load|ObjectInputStream|readObject\s*\(|JSON\.parse\s*\()/,
    why: 'Deserializing untrusted bytes. Pickle/PHP unserialize/Java readObject reach gadget chains directly.',
  },
  {
    id: 'sql-concat', cwe: 'CWE-89', severity: 'high', langs: ['python', 'js', 'php', 'java', 'ruby', 'go'],
    re: /(SELECT|INSERT|UPDATE|DELETE)[^;\n]{0,80}(\+\s*[A-Za-z_$]|\$\{|%s["']?\s*%|f"|\.format\()/i,
    why: 'Query built by concatenation/interpolation. Parameterized queries are the fix.',
  },
  {
    id: 'path-traversal', cwe: 'CWE-22', severity: 'high', langs: ['python', 'js', 'php', 'java', 'ruby', 'go'],
    re: /(readFile|readFileSync|sendFile|send_file|createReadStream|open|include|require|file_get_contents)\s*\(\s*(req\.|request\.|params\.|query\.|\$_(GET|POST|REQUEST))/,
    why: 'Request data reaching a file path. "..%2f" escapes the intended root without normalization.',
  },
  {
    id: 'ssrf', cwe: 'CWE-918', severity: 'high', langs: ['python', 'js', 'php', 'go', 'java'],
    re: /(requests\.(get|post)|axios\.(get|post)|fetch|http\.Get|urllib\.request\.urlopen)\s*\(\s*(req\.|request\.|params\.|query\.|\$_|f["'])/,
    why: 'Request data as a URL. Internal ranges and cloud metadata endpoints become reachable.',
  },
  {
    id: 'unchecked-malloc', cwe: 'CWE-476', severity: 'medium', langs: ['c', 'cpp'],
    re: /\b(malloc|calloc|realloc)\s*\([^;]*\)\s*;/,
    why: 'Allocation result not checked. A NULL return becomes a write through NULL under memory pressure.',
  },
  {
    id: 'size-multiply', cwe: 'CWE-190', severity: 'high', langs: ['c', 'cpp', 'objc'],
    re: /\b(malloc|calloc|alloca|new)\s*\(\s*[A-Za-z_][\w.\->]*\s*\*\s*[A-Za-z_][\w.\->]*/,
    why: 'count * size in one expression can wrap to a small allocation followed by a large copy.',
  },
  {
    id: 'stack-array', cwe: 'CWE-121', severity: 'medium', langs: ['c', 'cpp', 'objc'],
    re: /^\s*(char|wchar_t|unsigned char)\s+[A-Za-z_]\w*\s*\[\s*\d{1,4}\s*\]\s*;/,
    why: 'Small fixed stack buffer — the usual destination for the copy rules above.',
  },
  {
    id: 'alloca', cwe: 'CWE-770', severity: 'medium', langs: ['c', 'cpp'],
    re: /\balloca\s*\(/,
    why: 'Stack allocation with a runtime size; unbounded input grows the frame until the guard page.',
  },
  {
    id: 'temp-file-race', cwe: 'CWE-377', severity: 'medium', langs: ['c', 'cpp', 'python', 'php'],
    re: /\b(tmpnam|tempnam|mktemp)\s*\(/,
    why: 'Predictable temp name; a symlink planted between name and open wins the race.',
  },
  {
    id: 'yaml-unsafe', cwe: 'CWE-502', severity: 'high', langs: ['python'],
    re: /yaml\.load\s*\(\s*[^,)]+\)/,
    why: 'yaml.load without SafeLoader instantiates arbitrary Python objects.',
  },
  {
    id: 'tls-verify-off', cwe: 'CWE-295', severity: 'medium', langs: ['python', 'js'],
    re: /(verify\s*=\s*False|rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED)/,
    why: 'Certificate validation disabled; any MITM can present a valid chain.',
  },
  {
    id: 'jwt-no-verify', cwe: 'CWE-347', severity: 'high', langs: ['js', 'python', 'java'],
    re: /(jwt\.decode\s*\(\s*[^,)]+\)|verify_signature\s*:\s*False|algorithms\s*:\s*\[\s*["']none["'])/,
    why: 'Token decoded without signature verification — forge any identity.',
  },
  {
    id: 'debug-on', cwe: 'CWE-489', severity: 'medium', langs: ['python', 'js', 'php'],
    re: /(app\.run\([^)]*debug\s*=\s*True|DEBUG\s*=\s*True|display_errors\s*,\s*1)/,
    why: 'Debug mode in a reachable app leaks tracebacks, locals and, on Werkzeug, a console.',
  },
  {
    id: 'cors-star-creds', cwe: 'CWE-942', severity: 'medium', langs: ['js', 'python', 'go', 'java'],
    re: /(Access-Control-Allow-Origin["']?\s*[,:]\s*["']\*["'][\s\S]{0,200}Access-Control-Allow-Credentials|Access-Control-Allow-Credentials[\s\S]{0,200}Access-Control-Allow-Origin["']?\s*[,:]\s*["']\*["'])/,
    why: 'Wildcard origin with credentials lets any site read authenticated responses.',
  },
  {
    id: 'hardcoded-secret', cwe: 'CWE-798', severity: 'high', langs: ['c', 'cpp', 'js', 'python', 'php', 'ruby', 'go', 'java', 'json', 'yaml'],
    re: /(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["'][^"'\s]{8,}["']/i,
    why: 'Credential literal in source; it ships to every user and every clone.',
  },
  {
    id: 'eval-template', cwe: 'CWE-1336', severity: 'high', langs: ['js', 'python', 'php'],
    re: /(render_template_string|Template\s*\(\s*[A-Za-z_]|Handlebars\.compile\s*\(\s*[A-Za-z_]|ejs\.render\s*\(\s*[A-Za-z_])/,
    why: 'Template compiled from a variable; SSTI reaches object internals and often RCE.',
  },
  {
    id: 'race-open', cwe: 'CWE-367', severity: 'medium', langs: ['c', 'cpp', 'python', 'php'],
    re: /(access\s*\([^)]*\)\s*(&&|and)[^\n]{0,60}(open|fopen|unlink))|(os\.path\.exists[^\n]{0,60}open\()/,
    why: 'Check-then-use window; the object can be swapped between the two calls.',
  },
];

const DEFAULT_SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

function reachScore(file, lines, lineNo) {
  const window = lines.slice(Math.max(0, lineNo - 45), lineNo + 4).join('\n');
  const rel = file.replace(/^.*?workspace[\\/]/, '');
  let score = 10;
  if (/\b(main|handler|route|controller|api|server|view|endpoint)\b/i.test(rel)) score += 20;
  if (/(recv\s*\(|read\s*\(|fread\s*\(|scanf|gets|getenv|argv\[|req\.|request\.|params|body|query|\.args|sys\.stdin|cgi)/i.test(window)) score += 35;
  if (/(snprintf|strlcpy|strncpy|std::string|\.size\(\)|bounds|len\s*<|MIN\s*\(|clamp)/i.test(window)) score -= 15;
  if (/(^|[\\/])(test|tests|spec|specs|example|examples|sample|samples|mock|mocks)([\\/]|\\.|$)/i.test(rel)) score -= 30;
  if (/(argv|stdin|getenv|recv\s*\(|req\.|request\.)/i.test(lines.join('\n').slice(0, 200000))) score += 15;
  if (/\.(md|txt|rst)$/.test(rel)) score -= 40;
  return Math.max(0, Math.min(100, score));
}

const MAX_PER_RULE = 40;

export function scanSinks(cfg, { path: target = '.', maxFiles = 1500 } = {}) {
  const abs = resolveInside(cfg, target, { mustExist: true });
  const files = fs.statSync(abs).isDirectory()
    ? walk(abs, { depth: 10, maxFiles, filter: (f) => CODE_EXTS.has(path.extname(f).toLowerCase()) })
    : [abs];

  const hits = [];
  const perCode = new Map();
  const scanned = [];
  const skipped = [];

  for (const file of files) {
    const lang = langOf(file);
    if (lang === 'other') { skipped.push(file); continue; }
    let buf;
    try { buf = fs.readFileSync(file); } catch { continue; }
    if (buf.length > 1024 * 1024) { skipped.push(file); continue; }
    if (buf.subarray(0, 2048).includes(0)) { skipped.push(file); continue; }
    const raw = buf.toString('utf8');
    const lines = stripComments(raw, lang).split('\n');
    scanned.push(path.relative(cfg.workspace, file));

    for (const rule of RULES) {
      if (!rule.langs.includes(lang)) continue;
      const count = perCode.get(rule.id) || 0;
      if (count >= MAX_PER_RULE) continue;
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (line.length > 2000) continue;
        if (!rule.re.test(line)) continue;
        if (rule.unless && rule.unless.test(lines.slice(Math.max(0, i - 2), i + 3).join('\n'))) continue;
        const context = raw.split('\n').slice(Math.max(0, i - 1), i + 2).map((l) => l.trim()).join('\n');
        hits.push({
          id: `${rule.id}:${path.relative(cfg.workspace, file)}:${i + 1}`,
          rule: rule.id,
          title: rule.why,
          cwe: rule.cwe,
          severity: rule.severity,
          file: path.relative(cfg.workspace, file),
          abs,
          line: i + 1,
          snippet: context.slice(0, 400),
          reach: reachScore(path.relative(cfg.workspace, file), lines, i),
          status: 'candidate',
          lang,
        });
        perCode.set(rule.id, count + 1);
        break; // one hit per rule per file keeps the queue readable
      }
    }
  }

  hits.sort((a, b) => (DEFAULT_SEVERITY_ORDER[a.severity] - DEFAULT_SEVERITY_ORDER[b.severity]) || (b.reach - a.reach));
  return { hits, scanned: scanned.length, skipped: skipped.length };
}

const ENTRY_PATTERNS = [
  { re: /^\s*(?:int|void|auto)\s+(main)\s*\(/m, kind: 'process-entry', lang: 'c', detail: (m) => `${m[1]}()` },
  { re: /func\s+(main)\s*\(\s*\)/, kind: 'process-entry', lang: 'go', detail: (m) => `${m[1]}()` },
  { re: /if\s+__name__\s*==\s*['"]__main__['"]/, kind: 'process-entry', lang: 'python', detail: () => '__main__' },
  { re: /(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)/g, kind: 'http-route', lang: 'js', detail: (m) => `${m[1].toUpperCase()} ${m[2]}` },
  { re: /@(?:app|bp|router)\.(route|get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)/g, kind: 'http-route', lang: 'python', detail: (m) => `${m[1].toUpperCase()} ${m[2]}` },
  { re: /http\.HandleFunc\s*\(\s*"([^"]+)"/g, kind: 'http-route', lang: 'go', detail: (m) => m[1] },
  { re: /(scanf|gets|fgets|read)\s*\(\s*0\s*,/g, kind: 'stdin', lang: 'c', detail: (m) => m[1] },
  { re: /\b(listen|accept|recv|recvfrom|WSARecv)\s*\(/g, kind: 'network-read', lang: 'c', detail: (m) => m[1] },
  { re: /\b(sys\.argv|process\.argv|os\.Args)\b/g, kind: 'argv', lang: 'any', detail: (m) => m[1] },
];

const BUILD_FILES = [
  ['Makefile', 'make'], ['CMakeLists.txt', 'cmake'], ['package.json', 'node'], ['Cargo.toml', 'cargo'],
  ['go.mod', 'go'], ['pom.xml', 'maven'], ['build.gradle', 'gradle'], ['setup.py', 'python'],
  ['pyproject.toml', 'python'], ['meson.build', 'meson'], ['configure', 'autotools'], ['Dockerfile', 'docker'],
];

export function scanSurface(cfg, { path: target = '.' } = {}) {
  const abs = resolveInside(cfg, target, { mustExist: true });
  const files = fs.statSync(abs).isDirectory()
    ? walk(abs, { depth: 10, maxFiles: 5000, filter: (f) => CODE_EXTS.has(path.extname(f).toLowerCase()) })
    : [abs];

  const langs = new Map();
  const entries = [];
  let loc = 0;

  const seenEntries = new Set();
  for (const file of files) {
    const lang = langOf(file);
    langs.set(lang, (langs.get(lang) || 0) + 1);
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    loc += raw.split('\n').length;
    const rel = path.relative(cfg.workspace, file);
    for (const pat of ENTRY_PATTERNS) {
      pat.re.lastIndex = 0;
      let m;
      let found = 0;
      while ((m = pat.re.exec(raw)) !== null) {
        found += 1;
        const line = raw.slice(0, m.index).split('\n').length;
        const key = `${pat.kind}:${rel}:${line}`;
        if (!seenEntries.has(key)) {
          seenEntries.add(key);
          entries.push({
            kind: pat.kind,
            lang: pat.lang === 'any' ? lang : pat.lang,
            file: rel,
            line,
            detail: String(pat.detail ? pat.detail(m) : m[0]).trim().slice(0, 120),
          });
        }
        // non-global patterns match once; global ones stop after a few hits
        if (!pat.re.global || found >= 6) break;
      }
    }
  }

  const rootEntries = fs.statSync(abs).isDirectory() ? fs.readdirSync(abs) : [path.basename(abs)];
  const build = BUILD_FILES.filter(([name]) => rootEntries.includes(name)).map(([name, tool]) => ({ file: name, tool }));

  return {
    root: path.relative(cfg.workspace, abs) || '.',
    fileCount: files.length,
    loc,
    languages: [...langs.entries()].sort((a, b) => b[1] - a[1]).map(([lang, count]) => ({ lang, count })),
    entryPoints: entries.slice(0, 60),
    build,
  };
}

const CRASH_SIGNATURES = [
  { re: /AddressSanitizer: heap-buffer-overflow/i, kind: 'heap-buffer-overflow', cwe: 'CWE-122', severity: 'critical' },
  { re: /AddressSanitizer: stack-buffer-overflow/i, kind: 'stack-buffer-overflow', cwe: 'CWE-121', severity: 'critical' },
  { re: /AddressSanitizer: heap-use-after-free/i, kind: 'heap-use-after-free', cwe: 'CWE-416', severity: 'critical' },
  { re: /AddressSanitizer: global-buffer-overflow/i, kind: 'global-buffer-overflow', cwe: 'CWE-787', severity: 'high' },
  { re: /AddressSanitizer: SEGV on unknown address/i, kind: 'segv', cwe: 'CWE-476', severity: 'high' },
  { re: /AddressSanitizer: dynamic-stack-buffer-overflow/i, kind: 'dynamic-stack-overflow', cwe: 'CWE-121', severity: 'high' },
  { re: /AddressSanitizer: stack-overflow/i, kind: 'stack-exhaustion', cwe: 'CWE-674', severity: 'medium' },
  { re: /runtime error: (signed integer overflow|unsigned integer overflow)/i, kind: 'integer-overflow', cwe: 'CWE-190', severity: 'high' },
  { re: /runtime error: .*out of bounds/i, kind: 'index-out-of-bounds', cwe: 'CWE-125', severity: 'high' },
  { re: /stack smashing detected/i, kind: 'stack-smash', cwe: 'CWE-121', severity: 'critical' },
  { re: /double free or corruption/i, kind: 'double-free', cwe: 'CWE-415', severity: 'critical' },
  { re: /\bAbort trap: 6\b|\bSIGABRT\b/i, kind: 'abort', cwe: 'CWE-617', severity: 'medium' },
  { re: /\bSegmentation fault: 11\b|\bSIGSEGV\b/i, kind: 'sigsegv', cwe: 'CWE-476', severity: 'high' },
];

export function classifyCrash(output, exitCode) {
  if (!output) return { crashed: exitCode !== 0, kind: exitCode !== 0 ? 'nonzero-exit' : null };
  for (const sig of CRASH_SIGNATURES) {
    if (sig.re.test(output)) {
      const frames = [...output.matchAll(/^\s*#\d+\s+0x[0-9a-f]+\s+in\s+(\S+)\s+(.+)$/gm)].slice(0, 6)
        .map((m) => `${m[1]} ${m[2].trim()}`);
      const m = output.match(/located \d+ bytes? (?:to the )?(?:right|left) of (\d+)-byte region of type '([^']+)'/i)
        || output.match(/(\d+)-byte region of type '([^']+)' is located/i);
      return {
        crashed: true,
        kind: sig.kind,
        cwe: sig.cwe,
        severity: sig.severity,
        frames,
        region: m ? { size: Number(m[1]), type: m[2] } : null,
        evidence: output.split('\n').filter((l) => /Sanitizer|runtime error|SUMMARY|#[0-9]+\s|freed by|allocated by|is located/i.test(l)).slice(0, 14).join('\n'),
      };
    }
  }
  return { crashed: exitCode !== 0, kind: exitCode === 0 ? null : 'nonzero-exit', evidence: output.slice(-800) };
}

const SAN_FLAGS = '-g -O1 -fno-omit-frame-pointer -fsanitize=address,undefined';

export function detectBuild(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return { tool: 'none', build: null, run: null }; }
  const has = (n) => entries.includes(n);
  if (has('CMakeLists.txt')) {
    return {
      tool: 'cmake',
      build: `cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug -DCMAKE_C_FLAGS="${SAN_FLAGS}" -DCMAKE_CXX_FLAGS="${SAN_FLAGS}" >/dev/null && cmake --build build -j 4`,
      run: './build',
    };
  }
  if (has('Makefile')) {
    return { tool: 'make', build: `make CFLAGS="${SAN_FLAGS}" CXXFLAGS="${SAN_FLAGS}"`, run: './' };
  }
  if (has('Cargo.toml')) return { tool: 'cargo', build: 'cargo build', run: 'target/debug' };
  if (has('go.mod')) return { tool: 'go', build: 'go build ./...', run: '.' };
  if (has('package.json')) return { tool: 'node', build: 'npm install --silent', run: 'node' };
  if (has('pyproject.toml') || has('setup.py')) return { tool: 'python', build: 'pip3 install -e . --quiet', run: 'python3' };
  const cFiles = entries.filter((f) => /\.(c|cc|cpp)$/.test(f));
  if (cFiles.length === 1) {
    const f = cFiles[0];
    const compiler = f.endsWith('.c') ? 'clang' : 'clang++';
    return { tool: 'single-file', build: `${compiler} ${SAN_FLAGS} ${f} -o pocs/harness`, run: './pocs/harness' };
  }
  return { tool: 'none', build: null, run: null };
}
