import fs from 'node:fs';
import path from 'node:path';

/**
 * Engagements: the authorization record, and the folder everything lands in.
 *
 * A generated id, artifacts under `engagements/<id>`, authorized targets kept
 * as metadata — and the rule that capability is not permission. A bare scope
 * list is a setting; an engagement is something you can hand to a client.
 */

const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

function hostOf(target) {
  const raw = String(target || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    return url.hostname.toLowerCase();
  } catch {
    return raw.split('/')[0].toLowerCase();
  }
}

export class Engagements {
  constructor(cfg, dataDir) {
    this.cfg = cfg;
    this.root = path.join(cfg.workspace, 'engagements');
    this.statePath = path.join(dataDir, 'active-engagement.json');
    this.activeId = null;
    try {
      this.activeId = JSON.parse(fs.readFileSync(this.statePath, 'utf8')).id || null;
    } catch {
      this.activeId = null;
    }
    fs.mkdirSync(this.root, { recursive: true });
  }

  create({ name, targets = [], client = '' }) {
    if (!name) throw new Error('engagement name required');
    const list = (Array.isArray(targets) ? targets : String(targets).split(/[\n,]/))
      .map((t) => String(t).trim())
      .filter(Boolean);
    if (!list.length) throw new Error('at least one authorized target required');

    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const id = `eng_${stamp}_${hex(12)}`;
    const dir = path.join(this.root, id);
    for (const sub of ['pocs', 'reports', 'artifacts']) {
      fs.mkdirSync(path.join(dir, sub), { recursive: true });
    }

    const hosts = [...new Set(list.map(hostOf).filter(Boolean))];
    const engagement = {
      id,
      name: String(name).trim(),
      client: String(client || '').trim(),
      targets: list,
      hosts,
      createdAt: now.toISOString(),
      dir: path.relative(this.cfg.workspace, dir),
    };

    fs.writeFileSync(path.join(dir, 'engagement.json'), JSON.stringify(engagement, null, 2));

    // the engagement is the authorization: hosts replace the scope, never widen it silently
    this.cfg.policy.scopeHosts = hosts;
    const scoped = new Set(this.cfg.policy.scopePaths || []);
    scoped.add(dir);
    this.cfg.policy.scopePaths = [...scoped];

    this.setActive(id);
    return engagement;
  }

  list() {
    let entries = [];
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('eng_')) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(this.root, entry.name, 'engagement.json'), 'utf8'));
        meta.active = meta.id === this.activeId;
        out.push(meta);
      } catch { /* half-written dir */ }
    }
    return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  get(id) {
    return this.list().find((e) => e.id === id) || null;
  }

  active() {
    return this.activeId ? this.get(this.activeId) : null;
  }

  setActive(id) {
    this.activeId = id;
    try {
      fs.writeFileSync(this.statePath, JSON.stringify({ id }, null, 2));
    } catch { /* non-fatal */ }
    return this.active();
  }

  /** Where a given artifact kind goes: inside the engagement when one is active. */
  dirFor(kind = 'artifacts') {
    const active = this.active();
    return active ? path.join(active.dir, kind) : kind === 'reports' ? 'reports' : 'pocs';
  }
}

export { hostOf };
