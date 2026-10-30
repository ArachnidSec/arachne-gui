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
    this.projects = [];
    this.findings = [];
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.threadsPath, 'utf8'));
      for (const t of raw.threads || []) this.threads.set(t.id, t);
      this.projects = raw.projects || [];
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
    writeAtomic(this.threadsPath, { threads: [...this.threads.values()], projects: this.projects });
    writeAtomic(this.findingsPath, this.findings);
  }

  createProject({ name } = {}) {
    const project = {
      id: `prj_${uid()}`,
      name: String(name || 'Project').slice(0, 60),
      createdAt: Date.now(),
    };
    this.projects.unshift(project);
    this.flush();
    return project;
  }

  listProjects() {
    return this.projects.map((p) => ({
      ...p,
      threads: [...this.threads.values()].filter((t) => t.projectId === p.id).length,
    }));
  }

  deleteProject(id) {
    this.projects = this.projects.filter((p) => p.id !== id);
    for (const t of this.threads.values()) if (t.projectId === id) delete t.projectId;
    this.flush();
  }

  createThread({ title, members, kind = 'room', projectId = null, direct = false } = {}) {
    const thread = {
      id: uid(),
      title: title || 'untitled',
      kind,
      projectId: projectId || null,
      direct: Boolean(direct),
      pinned: false,
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

  updateThread(id, patch = {}) {
    const thread = this.threads.get(id);
    if (!thread) return null;
    if (typeof patch.title === 'string' && patch.title.trim()) thread.title = patch.title.trim().slice(0, 80);
    if (typeof patch.pinned === 'boolean') thread.pinned = patch.pinned;
    if (typeof patch.projectId === 'string' || patch.projectId === null) thread.projectId = patch.projectId;
    thread.updatedAt = Date.now();
    this.flush();
    return thread;
  }

  deleteThread(id) {
    const existed = this.threads.delete(id);
    this.flush();
    return existed;
  }

  renameProject(id, name) {
    const project = this.projects.find((p) => p.id === id);
    if (!project) return null;
    if (name && String(name).trim()) project.name = String(name).trim().slice(0, 60);
    this.flush();
    return project;
  }

  listThreads(kind) {
    return [...this.threads.values()]
      .filter((t) => !kind || (t.kind || 'room') === kind)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((t) => ({
        id: t.id,
        title: t.title,
        kind: t.kind || 'room',
        projectId: t.projectId || null,
        direct: Boolean(t.direct),
        pinned: Boolean(t.pinned),
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
