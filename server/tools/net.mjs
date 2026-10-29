import net from 'node:net';
import { URL } from 'node:url';
import { sessions } from '../sessions.mjs';

/**
 * Network reach is the one thing an agent should never improvise. A probe runs
 * only when the host is named in policy.scopeHosts — no wildcards, no CIDR,
 * no "it's localhost so it's fine". The scope list is the authorization record.
 */

function hostAllowed(cfg, host) {
  const clean = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!clean) return false;
  return (cfg.policy.scopeHosts || []).map((h) => String(h).toLowerCase()).some((h) => h === clean);
}

function normalizeUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('url required');
  return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
}

const SENSITIVE_HEADERS = /^(authorization|cookie|set-cookie|x-api-key|proxy-authorization)$/i;

export async function httpProbe(cfg, { url, method = 'GET', headers = {}, body = null, timeoutMs = 8000, maxBody = 3000, session = '' } = {}) {
  let parsed;
  try {
    parsed = normalizeUrl(url);
  } catch (err) {
    return { ok: false, output: `bad url: ${err.message}` };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, output: `protocol not allowed: ${parsed.protocol}` };
  }
  if (!hostAllowed(cfg, parsed.hostname)) {
    return {
      ok: false,
      output: `host not in scope: ${parsed.hostname}\nAdd it to policy.scopeHosts (Settings → Scope) and retry. In-scope now: ${(cfg.policy.scopeHosts || []).join(', ') || '(none)'}`,
    };
  }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(Number(timeoutMs) || 8000, 60000));
  const sess = session ? sessions.get(session) : null;
  const cookie = sess ? sessions.cookieHeader(session) : '';
  const sentHeaders = {
    'user-agent': 'arachne/1.0 (authorized-testing)',
    ...(sess ? sess.headers : {}),
    ...headers,
    ...(cookie ? { cookie } : {}),
  };
  try {
    const res = await fetch(parsed, {
      method: String(method || 'GET').toUpperCase(),
      headers: sentHeaders,
      body: body && !['GET', 'HEAD'].includes(String(method).toUpperCase()) ? String(body) : undefined,
      redirect: 'manual',
      signal: controller.signal,
    });
    if (sess) {
      sessions.absorb(session, res.headers);
      sessions.record(session, {
        method: String(method || 'GET').toUpperCase(),
        url: parsed.toString(),
        status: res.status,
        contentType: res.headers.get('content-type') || '',
      });
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    const shown = text.length > maxBody ? `${text.slice(0, maxBody)}\n... (${buf.length} bytes total)` : text;
    const headerLines = [...res.headers.entries()]
      .map(([k, v]) => `${k}: ${SENSITIVE_HEADERS.test(k) ? '<redacted>' : v}`)
      .join('\n');
    const ms = Date.now() - started;
    const server = res.headers.get('server') || '';
    const powered = res.headers.get('x-powered-by') || '';
    const cookieNote = sess && sessions.get(session).cookies.size
      ? `session ${session}: ${[...sessions.get(session).cookies.keys()].join(', ')}`
      : '';
    return {
      ok: true,
      output: [
        `${String(method).toUpperCase()} ${parsed.toString()} → ${res.status} ${res.statusText}  (${ms}ms, ${buf.length} bytes)`,
        cookieNote,
        server || powered ? `stack hint: ${[server, powered].filter(Boolean).join(' | ')}` : '',
        `--- headers ---`,
        headerLines,
        `--- body ---`,
        shown || '(empty)',
      ].filter(Boolean).join('\n'),
      meta: { status: res.status, ms, bytes: buf.length, url: parsed.toString() },
    };
  } catch (err) {
    return {
      ok: false,
      output: err?.name === 'AbortError' ? `probe timed out after ${timeoutMs}ms` : `probe failed: ${err.message}`,
      meta: { ms: Date.now() - started },
    };
  } finally {
    clearTimeout(timer);
  }
}

export function tcpProbe(cfg, { host, port, timeoutMs = 4000 } = {}) {
  if (!hostAllowed(cfg, host)) {
    return Promise.resolve({ ok: false, output: `host not in scope: ${host}` });
  }
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    return Promise.resolve({ ok: false, output: 'port must be 1-65535' });
  }
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let banner = '';
    let settled = false;
    const finish = (ok, output) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, output, meta: { ms: Date.now() - started, host, port: p } });
    };
    socket.setTimeout(Math.min(Number(timeoutMs) || 4000, 30000));
    socket.once('connect', () => {
      socket.write('\r\n');
    });
    socket.on('data', (d) => {
      banner += d.toString('utf8').slice(0, 512);
      if (banner.length > 24) finish(true, `${host}:${p} open — banner: ${JSON.stringify(banner.slice(0, 200))}`);
    });
    socket.once('timeout', () => finish(banner.length > 0, banner ? `${host}:${p} open, quiet — banner: ${JSON.stringify(banner.slice(0, 200))}` : `${host}:${p} timeout`));
    socket.once('error', (err) => finish(false, `${host}:${p} ${err.code || err.message}`));
    socket.once('close', () => {
      if (!settled) finish(true, `${host}:${p} open (closed with no banner)`);
    });
    socket.connect(p, host);
    setTimeout(() => {
      if (!settled) finish(true, `${host}:${p} open (no banner within ${timeoutMs}ms)`);
    }, Math.min(Number(timeoutMs) || 4000, 30000)).unref?.();
  });
}
