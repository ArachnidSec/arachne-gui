import fs from 'node:fs';
import path from 'node:path';

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/**
 * Conversation and finding state, on disk, in plain JSON.
 * The host owns the room: closing the app loses nothing.
 */
export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.threadsPath = path.join(dataDir, 'threads.json');
    this.findingsPath = path.join(dataDir, 'findings.json');
    this.threads = new Map();
    this.findings = [];
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.threadsPath, 'utf8'));
      for (const t of raw.threads || []) this.threads.set(t.id, t);
    } catch { /* fresh */ }
    try {
      this.findings = JSON.parse(fs.readFileSync(this.findingsPath, 'utf8'));
    } catch {
      this.findings = [];
    }
  }

  flush() {
    const dir = path.dirname(this.threadsPath);
    fs.mkdirSync(dir, { recursive: true });
    const writeAtomic = (file, data) => {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, file);
    };
    writeAtomic(this.threadsPath, { threads: [...this.threads.values()] });
    writeAtomic(this.findingsPath, this.findings);
  }

  createThread({ title, members, kind = 'room' } = {}) {
    const thread = {
      id: uid(),
      title: title || 'untitled',
      kind,
      members: members || ['scout', 'static', 'hunter', 'triage', 'scribe'],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    this.threads.set(thread.id, thread);
    this.flush();
    return thread;
  }

  getThread(id) {
    return this.threads.get(id) || null;
  }

  listThreads(kind) {
    return [...this.threads.values()]
      .filter((t) => !kind || (t.kind || 'room') === kind)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((t) => ({
        id: t.id,
        title: t.title,
        kind: t.kind || 'room',
        members: t.members,
        updatedAt: t.updatedAt,
        messageCount: t.messages.length,
        preview: t.messages.filter((m) => m.text).slice(-1)[0]?.text?.slice(0, 120) || '',
      }));
  }

  appendMessage(threadId, message) {
    const thread = this.threads.get(threadId);
    if (!thread) return null;
    const msg = { id: uid(), ts: Date.now(), ...message };
    thread.messages.push(msg);
    thread.updatedAt = Date.now();
    this.flush();
    return msg;
  }

  addFinding(finding) {
    const normalized = {
      id: finding.id && finding.id.includes(':') ? finding.id : `f-${uid()}`,
      ts: Date.now(),
      status: 'candidate',
      ...finding,
    };
    const dup = this.findings.find(
      (f) => f.id === normalized.id || (f.title === normalized.title && f.file === normalized.file && f.line === normalized.line),
    );
    if (dup) {
      Object.assign(dup, { ...normalized, ts: dup.ts, status: normalized.status === 'candidate' ? dup.status : normalized.status });
      this.flush();
      return dup;
    }
    this.findings.unshift(normalized);
    this.findings = this.findings.slice(0, 500);
    this.flush();
    return normalized;
  }

  updateFinding(id, patch) {
    const finding = this.findings.find((f) => f.id === id) || this.findings.find((f) => f && f.title === id);
    if (!finding) return null;
    Object.assign(finding, patch, { updatedAt: Date.now() });
    this.flush();
    return finding;
  }

  listFindings() {
    return this.findings;
  }

  clearFindings() {
    this.findings = [];
    this.flush();
  }
}
