/**
 * Named HTTP sessions: cookie jar, default headers, request history.
 *
 * Authentication is not a prompt problem. If a harness leaves session handling
 * to the model, every finding behind a login turns into a 302 and a shrug.
 * Session state belongs to the harness. A browser is one answer; a cookie jar is
 * the cheaper one for a CLI-shaped agent.
 */

export class Sessions {
  constructor() {
    this.map = new Map();
  }

  get(name = 'default') {
    const id = String(name || 'default');
    if (!this.map.has(id)) {
      this.map.set(id, { id, headers: {}, cookies: new Map(), history: [] });
    }
    return this.map.get(id);
  }

  list() {
    return [...this.map.values()].map((s) => ({
      id: s.id,
      cookies: [...s.cookies.keys()],
      headers: Object.keys(s.headers),
      requests: s.history.length,
    }));
  }

  cookieHeader(name) {
    const session = this.get(name);
    if (!session.cookies.size) return '';
    return [...session.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /** Absorb Set-Cookie from a fetch Headers object (one or many). */
  absorb(name, headers) {
    const session = this.get(name);
    const raw = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    const list = raw.length ? raw : [headers.get('set-cookie')].filter(Boolean);
    for (const line of list) {
      const first = String(line).split(';')[0];
      const idx = first.indexOf('=');
      if (idx <= 0) continue;
      const key = first.slice(0, idx).trim();
      const value = first.slice(idx + 1).trim();
      if (/^(deleted|)$/i.test(value) || /max-age=0/i.test(String(line))) session.cookies.delete(key);
      else session.cookies.set(key, value);
    }
    return session;
  }

  record(name, entry) {
    const session = this.get(name);
    session.history.unshift({ n: session.history.length + 1, ts: Date.now(), ...entry });
    session.history = session.history.slice(0, 100);
    return session.history[0];
  }

  history(name, limit = 12) {
    return this.get(name).history.slice(0, limit);
  }

  clear(name) {
    if (name) this.map.delete(String(name));
    else this.map.clear();
  }
}

export const sessions = new Sessions();
