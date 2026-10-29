import fs from 'node:fs';
import path from 'node:path';

/**
 * The ledger: what has been tested, and what is still open.
 *
 * Two ideas meet here: a coverage record so agents stop re-testing the same
 * surface, and a fact model where a negative is an observation with a
 * confidence, not a verdict. Both say the same thing — an agent without memory
 * of its own work loops, and an agent that treats one probe as proof reports
 * fiction.
 *
 * confidence:
 *   observed — a command ran, a response came back, there is output
 *   inferred — read from code, deduced, not yet executed
 */

const uid = (n = 8) => Math.random().toString(36).slice(2, 2 + n);

export class Ledger {
  constructor(dataDir) {
    this.path = path.join(dataDir, 'ledger.json');
    this.entries = [];
    this.intents = [];
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      this.entries = raw.entries || [];
      this.intents = raw.intents || [];
    } catch {
      this.entries = [];
      this.intents = [];
    }
  }

  flush() {
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ entries: this.entries, intents: this.intents }, null, 2));
      fs.renameSync(tmp, this.path);
    } catch { /* a full disk should not take the turn down */ }
  }

  /** One surface+action pair is one fact; re-testing updates it. */
  addEntry({ surface, action, result, confidence = 'observed', note = '', target = '', engagement = null }) {
    if (!surface) throw new Error('surface required (file, route, host, function)');
    if (!action) throw new Error('action required (what you ran or read)');
    const id = `led_${uid()}`;
    const key = `${surface}::${action}`.toLowerCase();
    const existing = this.entries.find((e) => e.key === key);
    const stamp = { ts: Date.now(), result: String(result ?? '').slice(0, 800), confidence, note: String(note ?? '').slice(0, 400), target, engagement };
    if (existing) {
      Object.assign(existing, stamp, { repeats: (existing.repeats || 1) + 1 });
      this.flush();
      return existing;
    }
    const entry = { id, key, surface, action, ...stamp, repeats: 1 };
    this.entries.unshift(entry);
    this.entries = this.entries.slice(0, 600);
    this.flush();
    return entry;
  }

  /** Has this surface already been tested to the given confidence? */
  tested(surface) {
    const key = String(surface || '').toLowerCase();
    const hits = this.entries.filter((e) => e.surface.toLowerCase().includes(key));
    const observed = hits.filter((e) => e.confidence === 'observed');
    return { hits, observed: observed.length, inferred: hits.length - observed.length };
  }

  addIntent({ title, rationale = '', target = '', skill = '', by = 'planner', engagement = null }) {
    if (!title) throw new Error('title required');
    const clean = String(title).trim();
    const dup = this.intents.find((i) => i.title.toLowerCase() === clean.toLowerCase() && ['open', 'running'].includes(i.status));
    if (dup) return dup;
    const intent = {
      id: `int_${uid(6)}`,
      title: clean,
      rationale: String(rationale ?? '').slice(0, 500),
      target: String(target ?? '').slice(0, 200),
      skill: String(skill ?? ''),
      status: 'open',
      by,
      engagement,
      createdAt: Date.now(),
    };
    this.intents.unshift(intent);
    this.intents = this.intents.slice(0, 200);
    this.flush();
    return intent;
  }

  setIntentStatus(id, status) {
    const intent = this.intents.find((i) => i.id === id || i.title === id);
    if (!intent) return null;
    intent.status = ['open', 'running', 'done', 'blocked'].includes(status) ? status : intent.status;
    intent.updatedAt = Date.now();
    this.flush();
    return intent;
  }

  openIntents() {
    return this.intents.filter((i) => i.status === 'open' || i.status === 'running');
  }

  summary() {
    const observed = this.entries.filter((e) => e.confidence === 'observed').length;
    const intents = this.intents.reduce((acc, i) => {
      acc[i.status] = (acc[i.status] || 0) + 1;
      return acc;
    }, {});
    return {
      tested: this.entries.length,
      observed,
      inferred: this.entries.length - observed,
      intents,
      openIntents: this.openIntents().length,
    };
  }

  /** Compact text for a prompt — never dump the whole graph into context. */
  brief({ limit = 18 } = {}) {
    const entries = this.entries.slice(0, limit).map(
      (e) => `- [${e.confidence}] ${e.surface} — ${e.action} → ${String(e.result || '').split('\n')[0].slice(0, 120)}`,
    );
    const intents = this.openIntents().slice(0, 8).map((i) => `- ${i.id} ${i.title}`);
    return [
      `tested: ${this.entries.length} (${this.summary().observed} observed, ${this.summary().inferred} inferred)`,
      entries.length ? `recent facts:\n${entries.join('\n')}` : 'recent facts: none',
      intents.length ? `open intents:\n${intents.join('\n')}` : 'open intents: none',
    ].join('\n');
  }

  clear() {
    this.entries = [];
    this.intents = [];
    this.flush();
  }
}
