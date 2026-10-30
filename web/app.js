import { BLOUB } from './bloub.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  agents: [],
  tools: [],
  roomThreads: [],
  chatThreads: [],
  projects: [],
  roomThreadId: null,
  chatThreadId: null,
  thread: null,
  mode: 'room',
  streaming: false,
  findings: [],
  health: null,
  live: new Map(),
  skills: [],
  selectedSkills: new Set(),
  engagement: null,
  ledger: null,
  intents: [],
};

/* ------------------------------------------------------------------ text */

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(t) {
  return escapeHtml(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

/** Deliberately small markdown: fences, headings, lists, inline code, links. */
function md(text) {
  const blocks = [];
  const src = String(text ?? '').replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_m, code) => {
    blocks.push(code.replace(/\n$/, ''));
    return `\n\u0000CB${blocks.length - 1}\u0000\n`;
  });

  const out = [];
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map(inline).join('<br>')}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`);
      list = null;
    }
  };

  for (const raw of src.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const t = line.trim();
    if (!t) { flushPara(); flushList(); continue; }
    let m;
    if ((m = t.match(/^\u0000CB(\d+)\u0000$/))) {
      flushPara(); flushList();
      out.push(`<pre><code>${escapeHtml(blocks[Number(m[1])])}</code></pre>`);
      continue;
    }
    if ((m = t.match(/^#{1,4}\s+(.*)$/))) { flushPara(); flushList(); out.push(`<h3>${inline(m[1])}</h3>`); continue; }
    if ((m = t.match(/^[-*•]\s+(.*)$/))) { flushPara(); (list = list || []).push(m[1]); continue; }
    if ((m = t.match(/^\d+[.)]\s+(.*)$/))) { flushPara(); (list = list || []).push(m[1]); continue; }
    if (/^([-*_])\1{2,}$/.test(t)) { flushPara(); flushList(); out.push('<hr>'); continue; }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return out.join('');
}

/* ------------------------------------------------------------------ avatars */

let blobSeq = 0;

const CHAT_GLYPH = `<svg viewBox="0 0 16 16" width="16" height="16"><path d="M3 4.2A1.7 1.7 0 0 1 4.7 2.5h6.6A1.7 1.7 0 0 1 13 4.2v4.6a1.7 1.7 0 0 1-1.7 1.7H7.2L4.3 12.6V10.4h-.6A1.7 1.7 0 0 1 3 8.7V4.2z" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>`;

/** The product mark: eight rounded petals, used where a chat has no agent face. */
function brandMark() {
  const petals = Array.from({ length: 8 }, (_, i) =>
    `<rect x="17" y="1.5" width="6" height="15" rx="3" fill="currentColor" transform="rotate(${i * 45} 20 20)"/>`).join('');
  return `<svg viewBox="0 0 40 40" width="34" height="34" aria-hidden="true">${petals}</svg>`;
}

/**
 * The face an agent wears: a body path painted in paper cream, then the agent's
 * colour painted over it through a mask with the eyes cut out — so the eyes read
 * as paper, not paint.
 */
function avatarSvg(agent, size = 'md') {
  const key = BLOUB[agent.shape] ? agent.shape : 'cercle';
  const frame = BLOUB[key];
  const id = `blb${(blobSeq += 1)}`;
  const vb = frame.viewBox;
  const eyes = frame.eyes
    .map((e) => `<path d="${e.d}" transform="${e.m}" opacity="${e.a}" fill="#000"/>`)
    .join('');
  return `<svg class="avatar ${size}" viewBox="${-vb} ${-vb} ${vb * 2} ${vb * 2}" aria-hidden="true">
    <defs><mask id="${id}" maskUnits="userSpaceOnUse" x="${-vb}" y="${-vb}" width="${vb * 2}" height="${vb * 2}">
      <path d="${frame.body}" fill="#fff"/>${eyes}
    </mask></defs>
    <path d="${frame.body}" fill="#f6f3e9"/>
    <g mask="url(#${id})"><rect x="${-vb}" y="${-vb}" width="${vb * 2}" height="${vb * 2}" fill="${agent.color || '#9a9aa2'}"/></g>
  </svg>`;
}

const agentOf = (id) => state.agents.find((a) => a.id === id) || { id: id || 'x', name: id || 'agent', role: '', color: '#9a9aa2', shape: 'cercle' };

/* ------------------------------------------------------------------ misc ui */

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2200);
}

function el(tag, cls, html) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (html != null) node.innerHTML = html;
  return node;
}

function nearBottom() {
  const t = $('#transcript');
  return t.scrollHeight - t.scrollTop - t.clientHeight < 140;
}

function scrollDown(force = false) {
  const t = $('#transcript');
  if (force || nearBottom()) t.scrollTop = t.scrollHeight;
}

function autogrow() {
  const ta = $('#input');
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
}

/* ------------------------------------------------------------------ api */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch {}
    throw new Error(`${res.status} ${detail}`);
  }
  return res.json();
}

async function* sse(path, body, signal) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try { yield JSON.parse(line.slice(5).trim()); } catch { /* partial */ }
      }
    }
  }
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  try {
    const [roster, health, threads] = await Promise.all([
      api('/api/roster'),
      api('/api/health'),
      api('/api/threads'),
    ]);
    state.agents = roster.agents;
    state.tools = roster.tools;
    state.health = health;
    state.findings = await api('/api/findings').then((r) => r.findings).catch(() => []);
    state.roomThreads = threads.threads.filter((t) => (t.kind || 'room') !== 'chat');
    state.chatThreads = threads.threads.filter((t) => t.kind === 'chat');
    state.projects = await api('/api/projects').then((r) => r.projects).catch(() => []);
    state.skills = health.skills || [];
    try {
      const saved = JSON.parse(localStorage.getItem('arachne.skills') || '[]');
      state.selectedSkills = new Set(saved.filter((id) => state.skills.some((sk) => sk.id === id)));
    } catch { /* private mode */ }
    state.engagement = health.engagement || null;
    state.ledger = health.ledger || null;
    renderRoster();
    renderThreads();
    renderHealth();
    renderFindings();
    renderConsoleTools();
    loadScope(health.policy);
    renderSkills();
    renderEngagement();
    await loadLedger();
    if (state.roomThreads.length) {
      await openThread(state.roomThreads[0].id, 'room');
    } else {
      renderEmpty('room');
    }

    const deep = location.hash.match(/^#agent\/([\w-]+)$/);
    if (deep) openAgentModal(deep[1]);
    if (location.hash === '#chat') setMode('chat');
    if (location.hash === '#collapsed' && state.setCollapsed) state.setCollapsed(true);
    if (location.hash === '#setup' && window.openPanel) window.openPanel('settings');
    if (location.hash === '#evidence' && window.openPanel) window.openPanel('evidence');
    const create = location.hash.match(/^#new=(project|thread|room|direct)$/);
    if (create) openCreate(create[1]);
  } catch (err) {
    $('#transcript').innerHTML = `<div class="empty-state"><div class="big">server is not answering</div><div class="sub">${escapeHtml(err.message)}</div></div>`;
  }
}

/* ------------------------------------------------------------------ render: chrome */

function renderRoster() {
  const box = $('#roster');
  box.innerHTML = '';
  for (const agent of state.agents.filter((a) => a.id !== 'chat')) {
    const row = el('button', 'agent-row');
    row.innerHTML = `${avatarSvg(agent, 'sm')}<span class="who"><span class="n">${escapeHtml(agent.name)}</span><span class="r">${escapeHtml(agent.role)}</span></span>`;
    row.title = `${agent.tagline}\ntools: ${agent.tools.join(', ') || 'none'}`;
    row.onclick = () => openAgentModal(agent.id);
    box.appendChild(row);
  }

  const sel = $('#agent-select');
  sel.innerHTML = `<option value="">the room</option>` +
    state.agents.filter((a) => a.id !== 'chat').map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
  sel.onchange = updateComposerHint;
  updateComposerHint();
}

const relTime = (ts) => {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60000) return 'Now';
  const dt = new Date(ts);
  if (d < 86400000) return dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d < 604800000) return dt.toLocaleDateString([], { weekday: 'short' });
  return dt.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

const modelName = () => state.health?.roles?.chat?.model || 'no model';

const openProjects = new Set();
let creating = null; // in-flight thread creation, so a fast send waits for it
const PLUS = '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const DOTS = '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="3.5" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="12.5" cy="8" r="1.3" fill="currentColor"/></svg>';

/* ---------------------------------------------------------------- row menus */

function closeMenus() {
  document.querySelectorAll('.menu').forEach((n) => n.remove());
}

function openRowMenu(anchor, items) {
  closeMenus();
  const menu = el('div', 'menu');
  for (const item of items) {
    const b = el('button', item.danger ? 'danger' : '');
    b.textContent = item.label;
    b.onclick = () => { closeMenus(); item.onClick(); };
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(r.right - 150, window.innerWidth - 190))}px`;
  menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 12)}px`;
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.menu') && !e.target.closest('.dots')) closeMenus();
});

/* ---------------------------------------------------------------- sections */

function sectionHead(label, onCreate) {
  const head = el('div', 'section-head');
  head.innerHTML = `<span class="label">${escapeHtml(label)}</span>`;
  if (onCreate) {
    const add = el('button', 'add');
    add.innerHTML = PLUS;
    add.title = `new ${label.toLowerCase().replace(/s$/, '')}`;
    add.onclick = (e) => { e.stopPropagation(); onCreate(); };
    head.appendChild(add);
  }
  return head;
}

function makeDraggable(node, payload) {
  node.draggable = true;
  node.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', JSON.stringify(payload));
    e.dataTransfer.effectAllowed = 'move';
    node.classList.add('dragging');
  });
  node.addEventListener('dragend', () => node.classList.remove('dragging'));
}

function makeDropTarget(node, accept, onDrop) {
  node.addEventListener('dragover', (e) => { e.preventDefault(); node.classList.add('drop'); });
  node.addEventListener('dragleave', () => node.classList.remove('drop'));
  node.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    node.classList.remove('drop');
    let payload = null;
    try { payload = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
    if (payload && accept(payload)) onDrop(payload);
  });
}

function withMenu(row, items) {
  const dots = el('button', 'dots');
  dots.innerHTML = DOTS;
  dots.onclick = (e) => { e.stopPropagation(); openRowMenu(dots, items); };
  row.appendChild(dots);
  return row;
}

function threadRow(t, { child = false, active = false } = {}) {
  const row = el('div', `row${child ? ' child' : ''}${active ? ' on' : ''}`);
  row.innerHTML = `
    <div class="row-avatar glyph">${t.kind === 'chat' ? CHAT_GLYPH : ''}</div>
    <div class="row-main">
      <div class="row-top"><span class="row-name">${escapeHtml(t.title)}</span><span class="row-time">${relTime(t.updatedAt)}</span></div>
      <div class="row-preview">${escapeHtml(t.preview || '')}</div>
    </div>`;
  row.onclick = () => openThread(t.id, t.kind || 'chat');
  makeDraggable(row, { kind: 'thread', id: t.id });
  return withMenu(row, [
    { label: t.pinned ? 'Unpin' : 'Pin', onClick: () => patchThread(t.id, { pinned: !t.pinned }) },
    { label: 'Rename', onClick: () => openCreate('rename', { target: 'thread', item: t }) },
    { label: 'Delete', danger: true, onClick: () => removeThread(t.id) },
  ]);
}

function roomRow(t, { active = false } = {}) {
  const row = el('div', `row${active ? ' on' : ''}`);
  row.innerHTML = `
    <div class="row-avatar"><div class="stack">${(t.members || []).slice(0, 3).map((id) => avatarSvg(agentOf(id))).join('')}</div></div>
    <div class="row-main">
      <div class="row-top"><span class="row-name">${escapeHtml(t.title)}</span><span class="row-time">${relTime(t.updatedAt)}</span></div>
      <div class="row-preview">${escapeHtml(t.preview || '')}</div>
    </div>`;
  row.onclick = () => openThread(t.id, 'room');
  makeDropTarget(row, (p) => p.kind === 'agent', (p) => addMember(t.id, p.id));
  return withMenu(row, [
    { label: t.pinned ? 'Unpin' : 'Pin', onClick: () => patchThread(t.id, { pinned: !t.pinned }) },
    { label: 'Rename', onClick: () => openCreate('rename', { target: 'thread', item: t }) },
    { label: 'Delete', danger: true, onClick: () => removeThread(t.id) },
  ]);
}

function projectRow(project) {
  const open = openProjects.has(project.id);
  const row = el('div', `row proj${open ? ' open' : ''}`);
  row.innerHTML = `
    <span class="chev"><svg viewBox="0 0 12 12" width="10" height="10"><path d="M4 2.5 8 6l-4 3.5" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    <div class="row-avatar"><svg viewBox="0 0 16 16" width="15" height="15"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.2 1.5h5.2A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4.5z" stroke="currentColor" stroke-width="1.2" fill="none"/></svg></div>
    <div class="row-main">
      <div class="row-top"><span class="row-name">${escapeHtml(project.name)}</span><span class="row-time">${project.threads || ''}</span></div>
    </div>`;
  row.onclick = () => {
    if (open) openProjects.delete(project.id); else openProjects.add(project.id);
    renderThreads();
  };
  makeDropTarget(row, (p) => p.kind === 'thread', (p) => moveToProject(p.id, project.id));
  const add = el('button', 'dots');
  add.innerHTML = PLUS;
  add.style.right = '26px';
  add.title = 'new thread in this project';
  add.onclick = (e) => { e.stopPropagation(); openCreate('thread', { projectId: project.id }); };
  row.appendChild(add);
  return withMenu(row, [
    { label: 'New thread here', onClick: () => openCreate('thread', { projectId: project.id }) },
    { label: 'Rename', onClick: () => openCreate('rename', { target: 'project', item: project }) },
    { label: 'Delete', danger: true, onClick: () => removeProject(project.id) },
  ]);
}

function agentRow(agent) {
  const direct = state.roomThreads.find((t) => t.direct && (t.members || [])[0] === agent.id);
  const row = el('div', `row${direct && direct.id === state.roomThreadId ? ' on' : ''}`);
  row.innerHTML = `
    <div class="row-avatar">${avatarSvg(agent)}</div>
    <div class="row-main">
      <div class="row-top"><span class="row-name">${escapeHtml(agent.name)}</span><span class="row-time">${direct ? relTime(direct.updatedAt) : ''}</span></div>
      <div class="row-preview">${escapeHtml(direct ? (direct.preview || agent.role) : `start a chat · ${agent.role.toLowerCase()}`)}</div>
    </div>`;
  row.onclick = () => startDirect(agent.id);
  makeDraggable(row, { kind: 'agent', id: agent.id });
  if (direct) {
    withMenu(row, [
      { label: 'Rename', onClick: () => openCreate('rename', { target: 'thread', item: direct }) },
      { label: 'Delete', danger: true, onClick: () => removeThread(direct.id) },
    ]);
  }
  return row;
}

/* ---------------------------------------------------------------- list */

function renderThreads() {
  const box = $('#threads');
  if (!box) return;
  const q = ($('#search')?.value || '').trim().toLowerCase();
  const isChat = state.mode === 'chat';
  const all = isChat ? state.chatThreads : state.roomThreads.filter((t) => !t.direct);
  const list = all.filter((t) => !q || `${t.title} ${t.preview || ''}`.toLowerCase().includes(q));
  const pinned = list.filter((t) => t.pinned);
  const rest = list.filter((t) => !t.pinned);

  box.innerHTML = '';

  if (!q) {
    const fresh = el('div', 'row new');
    fresh.innerHTML = `
      <div class="row-avatar">${PLUS}</div>
      <div class="row-main"><span class="row-name">${isChat ? 'New thread' : 'New room'}</span></div>`;
    fresh.onclick = newConversation;
    box.appendChild(fresh);
  }

  if (pinned.length) {
    box.appendChild(sectionHead('Pinned', null));
    for (const t of pinned) box.appendChild(isChat ? threadRow(t, { active: t.id === state.chatThreadId }) : roomRow(t, { active: t.id === state.roomThreadId }));
  }

  if (isChat) {
    const projects = (state.projects || []).filter((p) => !q || p.name.toLowerCase().includes(q));
    box.appendChild(sectionHead('Projects', () => openCreate('project')));
    for (const p of projects) {
      box.appendChild(projectRow(p));
      if (openProjects.has(p.id)) {
        const kids = rest.filter((t) => t.projectId === p.id);
        for (const t of kids) box.appendChild(threadRow(t, { child: true, active: t.id === state.chatThreadId }));
      }
    }

    const threadsHead = sectionHead('Threads', () => openCreate('thread'));
    makeDropTarget(threadsHead, (p) => p.kind === 'thread', (p) => moveToProject(p.id, null));
    box.appendChild(threadsHead);
    for (const t of rest.filter((t) => !t.projectId)) {
      box.appendChild(threadRow(t, { active: t.id === state.chatThreadId }));
    }
  } else {
    box.appendChild(sectionHead('Rooms', () => openCreate('room')));
    for (const t of rest) box.appendChild(roomRow(t, { active: t.id === state.roomThreadId }));

    box.appendChild(sectionHead('Agents', () => openCreate('direct')));
    for (const a of state.agents.filter((x) => x.id !== 'chat')) {
      if (q && !a.name.toLowerCase().includes(q) && !a.role.toLowerCase().includes(q)) continue;
      box.appendChild(agentRow(a));
    }
  }

  if (q && !box.querySelector('.row:not(.new)')) {
    box.insertAdjacentHTML('beforeend', '<div class="row-preview" style="padding:12px">nothing matches</div>');
  }
}

/* ---------------------------------------------------------------- actions */

async function moveToProject(threadId, projectId) {
  try {
    await api(`/api/threads/${threadId}`, { method: 'PATCH', body: { projectId } });
    if (projectId) openProjects.add(projectId);
    await refreshThreads();
    toast(projectId ? 'moved to project' : 'moved out of the project');
  } catch (err) { toast(err.message); }
}

async function addMember(threadId, agentId) {
  try {
    await api(`/api/threads/${threadId}`, { method: 'PATCH', body: { addMember: agentId } });
    await refreshThreads();
    toast(`${agentOf(agentId).name} added to the room`);
  } catch (err) { toast(err.message); }
}

async function startDirect(agentId) {
  const existing = state.roomThreads.find((t) => t.direct && (t.members || [])[0] === agentId);
  if (existing) return openThread(existing.id, 'room');
  const agent = agentOf(agentId);
  const { thread } = await api('/api/threads', {
    method: 'POST',
    body: { kind: 'room', title: agent.name, members: [agentId], direct: true },
  });
  await refreshThreads();
  openThread(thread.id, 'room');
}

async function patchThread(id, patch) {
  try {
    await api(`/api/threads/${id}`, { method: 'PATCH', body: patch });
    await refreshThreads();
  } catch (err) { toast(err.message); }
}

async function removeThread(id) {
  try {
    await api(`/api/threads/${id}`, { method: 'DELETE' });
    if (state.chatThreadId === id) { state.chatThreadId = null; showChatEmpty(); }
    if (state.roomThreadId === id) { state.roomThreadId = null; renderEmpty('room'); }
    await refreshThreads();
    toast('deleted');
  } catch (err) { toast(err.message); }
}

async function removeProject(id) {
  try {
    await api(`/api/projects/${id}`, { method: 'DELETE' });
    openProjects.delete(id);
    state.projects = state.projects.filter((p) => p.id !== id);
    renderThreads();
    toast('project deleted');
  } catch (err) { toast(err.message); }
}

let createCtx = null;

function openCreate(kind, prefill = {}) {
  createCtx = { kind, ...prefill };
  const cfg = {
    project: { title: 'Create New Project', nameLabel: 'Project Name', ph: 'Enter project name…', single: 'assistant', singleLabel: 'Assistant', run: 'Create' },
    thread: { title: 'New Thread', nameLabel: 'Thread Name', ph: 'Leave blank to name it from the first message', run: 'Create' },
    room: { title: 'Create New Room', nameLabel: 'Room Name', ph: 'e.g. acme-checkout', members: true, run: 'Create' },
    direct: { title: 'New Agent Chat', nameLabel: '', single: 'agent', singleLabel: 'Agent', run: 'Start' },
    rename: { title: 'Rename', nameLabel: 'Name', ph: '', run: 'Save' },
  }[kind];
  if (!cfg) return;

  $('#create-title').textContent = cfg.title;
  $('#create-name-label').textContent = cfg.nameLabel || '';
  const nameRow = $('#create-name').closest('.create-field');
  nameRow.classList.toggle('hidden', !cfg.nameLabel);
  $('#create-name').placeholder = cfg.ph || '';
  $('#create-name').value = kind === 'rename' ? (prefill.item?.name || prefill.item?.title || '') : '';

  const singleRow = $('#create-single-row');
  singleRow.classList.toggle('hidden', !cfg.single);
  if (cfg.single) {
    $('#create-single-label').textContent = cfg.singleLabel;
    const opts = cfg.single === 'agent'
      ? state.agents.filter((a) => a.id !== 'chat').map((a) => `<option value="${a.id}">${escapeHtml(a.name)} — ${escapeHtml(a.role.toLowerCase())}</option>`)
      : [`<option value="chat">Default assistant · ${escapeHtml(modelName())}</option>`];
    $('#create-single').innerHTML = opts.join('');
    if (prefill.agentId) $('#create-single').value = prefill.agentId;
  }

  const membersRow = $('#create-members-row');
  membersRow.classList.toggle('hidden', !cfg.members);
  if (cfg.members) {
    $('#create-members').innerHTML = state.agents.filter((a) => a.id !== 'chat').map((a) => `
      <label><input type="checkbox" value="${a.id}" ${['scout', 'static', 'hunter'].includes(a.id) ? 'checked' : ''} /> ${escapeHtml(a.name)} <span class="tiny">${escapeHtml(a.role.toLowerCase())}</span></label>`).join('');
  }

  $('#create-run').textContent = cfg.run;
  $('#create-modal').classList.remove('hidden');
  setTimeout(() => (cfg.nameLabel ? $('#create-name') : $('#create-single'))?.focus(), 30);
}

function closeCreate() {
  $('#create-modal').classList.add('hidden');
  createCtx = null;
}

async function runCreate() {
  if (!createCtx) return;
  const name = $('#create-name').value.trim();
  const single = $('#create-single').value;
  const members = [...document.querySelectorAll('#create-members input:checked')].map((i) => i.value);
  try {
    if (createCtx.kind === 'project') {
      const { project } = await api('/api/projects', { method: 'POST', body: { name: name || 'Project' } });
      state.projects.unshift({ ...project, threads: 0 });
      openProjects.add(project.id);
      closeCreate();
      renderThreads();
      toast(`project ${project.name}`);
      return;
    }
    if (createCtx.kind === 'thread') {
      const { thread } = await api('/api/threads', { method: 'POST', body: { kind: 'chat', title: name || undefined, projectId: createCtx.projectId || null } });
      state.chatThreads.unshift({ ...thread, preview: '' });
      closeCreate();
      await refreshThreads();
      openThread(thread.id, 'chat');
      $('#input').focus();
      return;
    }
    if (createCtx.kind === 'room') {
      const { thread } = await api('/api/threads', { method: 'POST', body: { kind: 'room', title: name || 'new room', members: members.length ? members : ['scout', 'static', 'hunter'] } });
      state.roomThreads.unshift({ ...thread, preview: '' });
      closeCreate();
      await refreshThreads();
      openThread(thread.id, 'room');
      $('#input').focus();
      return;
    }
    if (createCtx.kind === 'direct') {
      closeCreate();
      await startDirect(single);
      $('#input').focus();
      return;
    }
    if (createCtx.kind === 'rename') {
      const { target, item } = createCtx;
      if (target === 'project') {
        await api(`/api/projects/${item.id}`, { method: 'PATCH', body: { name } });
      } else {
        await api(`/api/threads/${item.id}`, { method: 'PATCH', body: { title: name } });
      }
      closeCreate();
      await refreshThreads();
      state.projects = await api('/api/projects').then((r) => r.projects).catch(() => state.projects);
      renderThreads();
      if (state.thread && state.thread.id === item.id) $('#thread-title').textContent = name;
    }
  } catch (err) {
    toast(err.message);
  }
}

function renderHealth() {
  const h = state.health;
  const dot = $('#engine-dot');
  if (!h) return;
  const live = h.engines.filter((e) => e.ok);
  const routed = Object.values(h.roles).filter((r) => r.model).length;
  dot.className = `dot ${live.length ? 'ok' : 'bad'}`;
  $('#engine-label').textContent = live.length
    ? `${live.map((e) => e.label).join(' · ')} — ${routed}/${Object.keys(h.roles).length} roles routed`
    : 'no engine reachable';

  const box = $('#routing');
  box.innerHTML = '';

  // every live model is a candidate for every role, not just the auto-pick
  const choices = [];
  for (const e of h.engines.filter((x) => x.ok)) {
    for (const m of e.models) {
      choices.push({ value: `${e.key}::${m.id}`, label: `${e.label} · ${m.id}`, tools: m.tools });
    }
  }

  for (const [role, r] of Object.entries(h.roles)) {
    const row = el('div', 'route-row');
    row.appendChild(el('span', 'role', role));
    const sel = document.createElement('select');
    sel.className = 'route-select';
    sel.title = r.label || '';
    sel.innerHTML = `<option value="">auto</option>` + choices
      .map((c) => `<option value="${escapeHtml(c.value)}">${escapeHtml(c.label)}${c.tools ? '' : ' (no tools)'}</option>`)
      .join('');
    const current = r.engine?.key && r.model ? `${r.engine.key}::${r.model}` : '';
    sel.value = choices.some((c) => c.value === current) ? current : '';
    sel.onchange = async () => {
      const [engineKey, ...rest] = sel.value.split('::');
      const model = rest.join('::');
      const target = engineKey || r.engine?.key || Object.keys(state.health.roles)[0];
      try {
        await api('/api/config', { method: 'POST', body: { roles: { [role]: { engine: target, model } } } });
        state.health = await api('/api/health?refresh=1');
        renderHealth();
        updateComposerHint();
        toast(`${role} → ${model || 'auto'}`);
      } catch (err) {
        toast(`route failed: ${err.message}`);
      }
    };
    row.appendChild(sel);
    box.appendChild(row);
  }
}

function renderSkills() {
  const box = $('#skills');
  if (!box) return;
  box.innerHTML = '';
  if (!state.skills.length) {
    box.innerHTML = '<div class="tiny">no skills in ./skills</div>';
    return;
  }
  for (const skill of state.skills) {
    const row = el('label', 'skill-row');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.selectedSkills.has(skill.id);
    cb.onchange = () => {
      if (cb.checked) state.selectedSkills.add(skill.id);
      else state.selectedSkills.delete(skill.id);
      try { localStorage.setItem('arachne.skills', JSON.stringify([...state.selectedSkills])); } catch {}
      renderSkills();
    };
    const text = el('span', '', `<span class="sk-n">${escapeHtml(skill.name)}</span><span class="sk-d">${escapeHtml(skill.description || '')}</span>`);
    row.append(cb, text);
    row.title = `agents: ${(skill.agents || []).join(', ') || 'all'}`;
    box.appendChild(row);
  }
  $('#skill-count').textContent = `${state.selectedSkills.size} of ${state.skills.length} loaded`;
}

function renderEngagement() {
  const state_ = $('#eng-state');
  const box = $('#eng-targets');
  document.querySelectorAll('.eng-chip').forEach((n) => n.remove());
  if (state.engagement) {
    state_.textContent = 'active';
    state_.style.color = 'var(--green)';
    const chip = el('div', 'eng-chip', `${escapeHtml(state.engagement.id)}<br>${escapeHtml((state.engagement.targets || []).join('  ·  '))}`);
    $('#eng-start').parentNode.insertBefore(chip, $('#eng-start'));
    $('#eng-name').value = state.engagement.name;
    $('#eng-targets').value = (state.engagement.targets || []).join('\n');
  } else {
    state_.textContent = 'none active';
    state_.style.color = '';
  }
}

async function loadLedger() {
  try {
    const { entries, intents, summary, entities } = await api('/api/ledger');
    state.ledger = summary;
    state.intents = intents || [];
    const s = summary;
    $('#cov-count').textContent = s.tested;
    $('#ledger-summary').innerHTML = `
      <div class="route-row"><span class="role">tested</span><span class="val">${s.tested} · ${s.observed} observed</span></div>
      <div class="route-row"><span class="role">inferred</span><span class="val">${s.inferred}</span></div>
      <div class="route-row"><span class="role">intents</span><span class="val">${s.openIntents} open</span></div>`;
    $('#intents').innerHTML = (intents || []).filter((i) => i.status !== 'done').slice(0, 6)
      .map((i) => `<div class="intent-row ${i.status}">${escapeHtml(i.title)}</div>`).join('');
    renderEntities(entities || []);
    renderCampaign();
  } catch { /* server older than ui */ }
}

async function renderCampaign() {
  const box = $('#campaign');
  if (!box) return;
  try {
    const { active } = await api('/api/campaigns');
    const text = $('#campaign-text');
    box.classList.toggle('on', Boolean(active));
    if (active) {
      const secs = Math.round(active.elapsedMs / 1000);
      const t = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      text.textContent = `${active.name} · ${active.turns} turns · ${active.tokens.total} tok · ${t} · ${active.findings.confirmed} confirmed`;
      $('#campaign-btn').textContent = 'stop';
      $('#campaign-btn').onclick = async () => {
        try { await api('/api/campaigns/stop', { method: 'POST' }); renderCampaign(); toast('campaign stopped'); }
        catch (err) { toast(err.message); }
      };
    } else {
      text.textContent = 'no campaign running';
      $('#campaign-btn').textContent = 'start';
      $('#campaign-btn').onclick = async () => {
        try {
          const r = await api('/api/campaigns', { method: 'POST', body: { name: $('#thread-title').textContent.slice(0, 60) } });
          renderCampaign();
          toast(`campaign ${r.campaign.id} started`);
        } catch (err) { toast(err.message); }
      };
    }
  } catch { /* older server */ }
}

function renderEntities(entities) {
  const box = $('#entities');
  if (!box) return;
  if (!entities.length) {
    box.innerHTML = '';
    return;
  }
  const groups = {};
  for (const e of entities) (groups[e.type] = groups[e.type] || []).push(e);
  const order = ['target', 'host', 'service', 'credential', 'access', 'path', 'note'];
  box.innerHTML = order.filter((t) => groups[t]?.length).map((t) => `
    <div class="ent-group">
      <span class="t">${t}</span>
      <span class="k">${groups[t].slice(0, 6).map((e) => `<span class="ent" title="${escapeHtml(JSON.stringify(e.attrs || {}))}">${escapeHtml(e.key)}</span>`).join('')}</span>
    </div>`).join('');
}

function renderFindings() {
  const box = $('#findings');
  $('#finding-count').textContent = state.findings.length;
  if (!state.findings.length) {
    box.innerHTML = '<div class="empty">no findings yet</div>';
    return;
  }
  box.innerHTML = '';
  for (const f of state.findings.slice(0, 40)) {
    const card = el('div', `finding ${f.severity || 'low'}`);
    card.innerHTML = `
      <div class="ft">${escapeHtml(f.title || '(untitled)')}</div>
      <div class="fm">
        <span class="chip">${escapeHtml(f.cwe || '—')}</span>
        <span class="chip ${f.status}">${escapeHtml(f.status || 'candidate')}</span>
        ${f.file ? `<span title="${escapeHtml(f.file)}">${escapeHtml(String(f.file).split('/').slice(-2).join('/'))}:${f.line || 0}</span>` : ''}
        ${f.reach != null ? `<span>reach ${f.reach}</span>` : ''}
      </div>
      ${f.evidence ? `<div class="evidence"><pre>${escapeHtml(String(f.evidence).slice(0, 1500))}</pre></div>` : ''}`;
    if (f.evidence) card.onclick = () => card.classList.toggle('open');
    box.appendChild(card);
  }
}

function renderConsoleTools() {
  const sel = $('#console-tool');
  sel.innerHTML = state.tools.map((t) => `<option>${t}</option>`).join('');
}

function loadScope(policy) {
  $('#scope-hosts').value = (policy?.scopeHosts || []).join('\n');
  $('#scope-paths').value = (policy?.scopePaths || []).join('\n');
}

function updateComposerHint() {
  const hint = $('#composer-hint');
  if (state.mode === 'chat') hint.textContent = 'chat · no tools · threads and projects only';
  else if (state.mode === 'hunt') hint.textContent = 'deterministic surface → scan → agent trace → harness → report';
  else if ($('#agent-select').value) hint.textContent = 'single specialist answers';
  else hint.textContent = 'room protocol: fan-out · tapback · handoff';
  $('#agent-select').style.display = state.mode === 'hunt' || state.mode === 'chat' ? 'none' : '';
}

/* ------------------------------------------------------------------ transcript */

function renderEmpty(kind = 'room', { keepHeader = false } = {}) {
  $('#transcript').innerHTML = `<div class="transcript-inner"><div class="empty">
    <div class="empty-orb">${avatarSvg(agentOf('scout'))}</div>
    <div class="big">a quiet room</div>
    <div class="sub">Point the room at something. Mira maps the surface, Ivo traces the dataflow,
    Rook builds the harness, Sable calls the crash, Juniper writes it up.</div>
    <div class="suggest">
      <button data-suggest="map fixtures/vuln and tell me what is reachable">map a target</button>
      <button data-suggest="read store_record and tell me whether the strcpy is reachable">trace a sink</button>
      <button data-suggest="build a harness for the top candidate and run it under ASan">build a harness</button>
    </div>
  </div></div>`;
  if (keepHeader) return;
  $('#peer-avatar').style.display = 'grid';
  $('#peer-avatar').style.placeItems = 'center';
  $('#peer-avatar').innerHTML = avatarSvg(agentOf('scout'));
  $('#thread-title').textContent = 'new room';
  $('#thread-meta').textContent = 'room · not started';
}

function clearTranscript() {
  $('#transcript').innerHTML = '';
  const wrap = el('div', 'transcript-inner');
  wrap.id = 'transcript-inner';
  $('#transcript').appendChild(wrap);
  state.live.clear();
}

function showChatEmpty({ keepHeader = false } = {}) {
  $('#transcript').innerHTML = `<div class="transcript-inner"><div class="empty">
    <div class="empty-orb mark">${brandMark()}</div>
    <div class="big">How can I help you today?</div>
    <div class="sub">Ask anything. Threads live here; projects group them. Nothing in this
    space touches the agent rooms.</div>
    <div class="suggest">
      <button data-suggest="what does CWE-121 mean, in one paragraph?">what is CWE-121</button>
      <button data-suggest="explain the difference between a crash and demonstrated control">crash vs control</button>
      <button data-suggest="summarise this stack trace and tell me what to look at first">read a stack trace</button>
    </div>
  </div></div>`;
  if (keepHeader) return;
  $('#peer-avatar').style.display = 'grid';
  $('#peer-avatar').style.placeItems = 'center';
  $('#peer-avatar').innerHTML = brandMark();
  $('#thread-title').textContent = 'New thread';
  $('#thread-meta').textContent = modelName();
}

const inner = () => $('#transcript-inner');

function addUserMessage(text) {
  if (!inner()) clearTranscript();
  inner().appendChild(el('div', 'msg user', `<div class="bubble">${escapeHtml(text)}</div>`));
  scrollDown(true);
}

function addAgentMessage(m) {
  if (!inner()) clearTranscript();
  const agent = agentOf(m.agentId);
  const wrap = el('div', 'msg agent');
  wrap.innerHTML = `
    <div class="who" style="--ac:${agent.color || '#8b8b8b'}">
      <span class="who-dot"></span>${escapeHtml(agent.name)}
      <span class="who-role">${escapeHtml(agent.role)}</span>
      ${m.ms ? `<span class="tag">${(m.ms / 1000).toFixed(1)}s${m.steps ? ` · ${m.steps} steps` : ''}${m.usage?.total ? ` · ${(m.usage.total / 1000).toFixed(1)}k tok` : ''}</span>` : ''}
    </div>
    <div class="body">${md(m.text || '')}</div>`;
  if (m.tools?.length) {
    const tools = el('div', 'tools');
    for (const t of m.tools) tools.appendChild(el('span', `tool ${t.ok ? 'ok' : 'fail'}`, `<span class="dot"></span>${escapeHtml(t.name)}`));
    wrap.appendChild(tools);
  }
  inner().appendChild(wrap);
  scrollDown(true);
}

/* live streaming block per agent */
function ensureLive(agentId) {
  if (!inner()) clearTranscript();
  if (state.live.has(agentId)) return state.live.get(agentId);
  const agent = agentOf(agentId);
  const wrap = el('div', 'msg agent');
  wrap.innerHTML = `
    <div class="who" style="--ac:${agent.color || '#8b8b8b'}">
      <span class="who-dot"></span>${escapeHtml(agent.name)}
      <span class="who-role">${escapeHtml(agent.role)}</span>
      <span class="tag" data-tag></span>
    </div>
    <div class="body" data-body></div>
    <div class="thinking" data-think><i></i><i></i><i></i></div>
    <div class="tools" data-tools></div>`;
  inner().appendChild(wrap);
  const entry = {
    wrap,
    body: wrap.querySelector('[data-body]'),
    tools: wrap.querySelector('[data-tools]'),
    think: wrap.querySelector('[data-think]'),
    tag: wrap.querySelector('[data-tag]'),
    text: '',
    pending: null,
    started: Date.now(),
  };
  state.live.set(agentId, entry);
  scrollDown();
  return entry;
}

function pushToken(agentId, text) {
  const entry = ensureLive(agentId);
  entry.text += text;
  entry.think.style.display = 'none';
  if (entry.pending) return;
  entry.pending = requestAnimationFrame(() => {
    entry.pending = null;
    entry.body.innerHTML = md(entry.text);
    scrollDown();
  });
}

function replaceText(agentId, text) {
  const entry = ensureLive(agentId);
  entry.text = text;
  entry.body.innerHTML = md(text);
  scrollDown();
}

function toolPill(agentId, name, state_ = 'run') {
  const entry = ensureLive(agentId);
  const pill = el('span', `tool ${state_}`, `<span class="dot"></span>${escapeHtml(name)}`);
  pill.dataset.name = name;
  pill.dataset.state = state_;
  entry.tools.appendChild(pill);
  scrollDown();
  return pill;
}

function resolvePill(agentId, name, ok, ms) {
  const entry = state.live.get(agentId);
  if (!entry) return;
  const pills = [...entry.tools.querySelectorAll('.tool')].filter((p) => p.dataset.name === name && p.dataset.state === 'run');
  const pill = pills[pills.length - 1];
  if (!pill) return;
  pill.dataset.state = ok ? 'ok' : 'fail';
  pill.className = `tool ${ok ? 'ok' : 'fail'}`;
  if (ms != null) pill.innerHTML += `<span style="opacity:.5">${(ms / 1000).toFixed(1)}s</span>`;
}

function finishLive(agentId, ev) {
  const entry = state.live.get(agentId);
  if (!entry) return;
  if (ev?.text) entry.text = ev.text;
  // a silent turn becomes a tapback, not an empty bubble
  if (/^\s*\[\[(silent|tapback|nothing)\]\]/i.test(entry.text || '')) {
    entry.wrap.remove();
    state.live.delete(agentId);
    return;
  }
  entry.body.innerHTML = md(entry.text);
  entry.think.style.display = 'none';
  if (ev?.ms) {
    const tok = ev?.usage?.total ? ` · ${(ev.usage.total / 1000).toFixed(1)}k tok` : '';
    entry.tag.textContent = `${(ev.ms / 1000).toFixed(1)}s${ev.steps ? ` · ${ev.steps} steps` : ''}${tok}`;
  }
  state.live.delete(agentId);
}

function addTapback(agentId) {
  const agent = agentOf(agentId);
  const row = el('div', 'tapback');
  row.innerHTML = `${avatarSvg(agent, 'sm')} ${escapeHtml(agent.name)} <span class="pill">👍 nothing to add</span>`;
  inner().appendChild(row);
  scrollDown();
}

function addHandoff(from, to) {
  const a = agentOf(from);
  const b = agentOf(to);
  inner().appendChild(el('div', 'handoff', `${escapeHtml(a.name)} hands the floor to ${escapeHtml(b.name)}`));
  scrollDown();
}

function addError(text) {
  if (!inner()) clearTranscript();
  inner().appendChild(el('div', 'err', escapeHtml(text)));
  scrollDown();
}

/* ------------------------------------------------------------------ thread */

async function openThread(id, kind = 'room') {
  const { thread } = await api(`/api/threads/${id}`);
  const k = thread.kind || kind || 'room';
  state.thread = thread;
  if (k === 'chat') state.chatThreadId = id; else state.roomThreadId = id;
  state.mode = k === 'chat' ? 'chat' : state.mode === 'hunt' ? 'hunt' : 'room';
  syncModeUI();
  $('#thread-title').textContent = thread.title;
  const project = state.projects.find((p) => p.id === thread.projectId);
  if (k === 'chat') {
    $('#peer-avatar').style.display = 'grid';
    $('#peer-avatar').style.placeItems = 'center';
    $('#peer-avatar').innerHTML = brandMark();
    $('#thread-title').textContent = thread.title === 'new chat' ? 'New thread' : thread.title;
    $('#thread-meta').textContent = [project ? project.name : 'thread', modelName()].filter(Boolean).join(' · ');
  } else {
    $('#peer-avatar').style.display = '';
    $('#thread-meta').textContent = `room · ${thread.members.map((m) => agentOf(m).name).join(' · ')}`;
    $('#peer-avatar').innerHTML = avatarSvg(agentOf((thread.members || ['scout'])[0]));
  }
  clearTranscript();
  for (const m of thread.messages) {
    if (m.role === 'user') addUserMessage(m.text);
    else addAgentMessage(m);
  }
  if (!thread.messages.length) {
    if (k === 'chat') showChatEmpty({ keepHeader: true });
    else renderEmpty('room', { keepHeader: true });
  }
  renderThreads();
  scrollDown(true);
  // fonts and blobs settle after first paint; pin to the real bottom
  setTimeout(() => scrollDown(true), 80);
}

/** One action, two outcomes: the mode decides what you get. */
function newConversation() {
  return state.mode === 'chat' ? newChat() : newRoom();
}

async function newRoom() {
  const done = Promise.withResolvers();
  creating = done.promise;
  const { thread } = await api('/api/threads', {
    method: 'POST',
    body: { kind: 'room', title: 'new room', members: ['scout', 'static', 'hunter'] },
  });
  state.roomThreads.unshift({ id: thread.id, title: thread.title, preview: '', kind: 'room', members: thread.members });
  state.roomThreadId = thread.id;
  state.thread = thread;
  state.mode = 'room';
  syncModeUI();
  $('#thread-title').textContent = thread.title;
  $('#thread-meta').textContent = `room · ${thread.members.map((m) => agentOf(m).name).join(' · ')}`;
  renderThreads();
  renderEmpty('room');
  $('#input').focus();
  done.resolve(); creating = null;
}

async function newChat(projectId = null) {
  const done = Promise.withResolvers();
  creating = done.promise;
  const { thread } = await api('/api/threads', { method: 'POST', body: { kind: 'chat', projectId } });
  state.chatThreads.unshift({ id: thread.id, title: thread.title, preview: '', kind: 'chat', projectId: thread.projectId || null, members: ['chat'] });
  state.chatThreadId = thread.id;
  state.thread = thread;
  state.mode = 'chat';
  syncModeUI();
  $('#thread-title').textContent = thread.title;
  $('#thread-meta').textContent = 'chat · Wren · generalist';
  renderThreads();
  showChatEmpty();
  $('#input').focus();
  done.resolve(); creating = null;
}

/* ------------------------------------------------------------------ send */

function setBusy(busy) {
  state.streaming = busy;
  $('#send').disabled = busy;
  $('#hunt-run').disabled = busy;
  $('#input').disabled = busy;
  $('#stop').classList.toggle('hidden', !busy);
  $('#input').placeholder = busy
    ? (state.mode === 'chat' ? 'thinking…' : 'the room is talking…')
    : (state.mode === 'chat' ? 'ask a question…' : 'ask the room…');
}

async function send() {
  if (creating) await creating;
  const text = $('#input').value.trim();
  if (!text || state.streaming) return;
  $('#input').value = '';
  autogrow();
  addUserMessage(text);
  setBusy(true);

  const chosen = $('#agent-select').value;
  const isChat = state.mode === 'chat';
  const mode = isChat ? 'chat' : chosen ? 'solo' : 'room';
  const body = {
    text,
    threadId: isChat ? state.chatThreadId : state.roomThreadId,
    mode,
    agentId: isChat ? 'chat' : (chosen || 'scout'),
    members: state.thread?.members || ['scout', 'static', 'hunter'],
    skills: [...state.selectedSkills],
  };

  const controller = new AbortController();
  state.abort = controller;
  try {
    for await (const ev of sse('/api/send', body, controller.signal)) {
      switch (ev.type) {
        case 'thread':
          if (ev.kind === 'chat') state.chatThreadId = ev.threadId;
          else state.roomThreadId = ev.threadId;
          break;
        case 'agent_start':
          ensureLive(ev.agentId);
          break;
        case 'token':
          pushToken(ev.agentId, ev.text);
          break;
        case 'replace':
          replaceText(ev.agentId, ev.text);
          break;
        case 'tool_call':
          toolPill(ev.agentId, ev.name, 'run');
          break;
        case 'tool_result':
          resolvePill(ev.agentId, ev.name, ev.ok, ev.ms);
          break;
        case 'tapback':
          addTapback(ev.agentId);
          break;
        case 'handoff':
          addHandoff(ev.from, ev.to);
          break;
        case 'finding':
          state.findings.unshift(ev.finding);
          renderFindings();
          break;
        case 'intent':
          state.intents.unshift(ev.intent);
          loadLedger();
          break;
        case 'error':
          finishLive(ev.agentId, {});
          addError(ev.message || 'model error');
          break;
        case 'done':
          finishLive(ev.agentId, ev);
          break;
        case 'step_limit':
          addError(`step budget reached (${ev.steps}) — the turn stopped before a final answer`);
          break;
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') toast('stopped');
    else addError(err.message);
  } finally {
    state.abort = null;
    setBusy(false);
    await refreshThreads();
    loadLedger();
    $('#input').focus();
  }
}

async function refreshThreads() {
  try {
    const { threads } = await api('/api/threads');
    state.roomThreads = threads.filter((t) => (t.kind || 'room') !== 'chat');
    state.chatThreads = threads.filter((t) => t.kind === 'chat');
    state.projects = await api('/api/projects').then((r) => r.projects).catch(() => state.projects);
    renderThreads();
    const activeId = state.mode === 'chat' ? state.chatThreadId : state.roomThreadId;
    const current = threads.find((t) => t.id === activeId);
    if (current) {
      $('#thread-title').textContent = current.title;
      if (current.title === 'new room' && current.preview) {
        const t = state.thread;
        if (t) { t.title = current.preview.slice(0, 60); $('#thread-title').textContent = t.title; }
      }
    }
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ hunt */

let huntCard = null;

function huntTimeline(target) {
  clearTranscript();
  huntCard = el('div', 'hunt-card');
  huntCard.innerHTML = `
    <h2>hunt — ${escapeHtml(target)}</h2>
    <div class="sub">scope → surface → trace → prove → report</div>
    <div data-phases></div>
    <div data-surface></div>`;
  inner().appendChild(huntCard);
}

function huntPhase(ev) {
  const box = huntCard?.querySelector('[data-phases]');
  if (!box) return;
  box.innerHTML = '';
  for (const s of ev.stages || []) {
    const row = el('div', `phase ${s.status}`);
    row.innerHTML = `<span class="pdot"></span><span>${escapeHtml(s.id)}</span><span class="pd">${escapeHtml(s.detail || '')}</span>`;
    box.appendChild(row);
  }
}

function huntSurface(surface) {
  const box = huntCard?.querySelector('[data-surface]');
  if (!box) return;
  box.innerHTML = `
    <div class="surface-grid">
      <div class="stat"><div class="k">files</div><div class="v">${surface.fileCount}</div></div>
      <div class="stat"><div class="k">loc</div><div class="v">${surface.loc}</div></div>
      <div class="stat"><div class="k">langs</div><div class="v">${escapeHtml(surface.languages.map((l) => l.lang).join(' ')) || '—'}</div></div>
      <div class="stat"><div class="k">entries</div><div class="v">${surface.entryPoints.length}</div></div>
      <div class="stat"><div class="k">build</div><div class="v">${escapeHtml(surface.build.map((b) => b.tool).join(' ') || 'none')}</div></div>
    </div>`;
}

async function runHunt() {
  const target = $('#hunt-target').value.trim();
  if (!target || state.streaming) return;
  setBusy(true);
  huntTimeline(target);

  const controller = new AbortController();
  state.abort = controller;
  try {
    for await (const ev of sse('/api/hunt', { target }, controller.signal)) {
      switch (ev.type) {
        case 'phase':
          huntPhase(ev);
          break;
        case 'surface':
          huntSurface(ev.surface);
          break;
        case 'finding':
          state.findings.unshift(ev.finding);
          renderFindings();
          break;
        case 'intent':
          state.intents.unshift(ev.intent);
          loadLedger();
          break;
        case 'agent_start':
          ensureLive(ev.agentId);
          break;
        case 'token':
          pushToken(ev.agentId, ev.text);
          break;
        case 'replace':
          replaceText(ev.agentId, ev.text);
          break;
        case 'tool_call':
          toolPill(ev.agentId, ev.name, 'run');
          break;
        case 'tool_result':
          resolvePill(ev.agentId, ev.name, ev.ok, ev.ms);
          break;
        case 'done':
          finishLive(ev.agentId, ev);
          break;
        case 'error':
          addError(ev.message);
          break;
        case 'hunt_done':
          toast(`report written: ${ev.report}`);
          loadLedger();
          break;
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') addError(err.message);
  } finally {
    state.abort = null;
    setBusy(false);
  }
}

/* ------------------------------------------------------------------ agent card */

function openAgentModal(id) {
  const agent = agentOf(id);
  const route = state.health?.roles?.[id];
  const applicable = state.skills.filter((s) => !s.agents?.length || s.agents.includes(id));
  const tools = agent.tools || [];
  $('#agent-card').innerHTML = `
    <div class="ac-head">
      ${avatarSvg(agent, 'md')}
      <div><div class="ac-name">${escapeHtml(agent.name)}</div><div class="ac-role">${escapeHtml(agent.role)}</div></div>
    </div>
    <p class="ac-tag">${escapeHtml(agent.tagline || '')}</p>
    <div class="ac-row"><span class="k">model</span><span class="v">${escapeHtml(route?.model || 'unrouted — open routing')}</span></div>
    <div class="ac-row"><span class="k">tools</span><span class="v chips">${tools.length
      ? tools.map((t) => `<span class="chip">${escapeHtml(t)}</span>`).join('')
      : '<span class="chip">none</span>'}</span></div>
    <div class="ac-row"><span class="k">skills</span><span class="v chips">${applicable.length
      ? applicable.map((sk) => `<span class="chip">${escapeHtml(sk.id)}</span>`).join('')
      : '<span class="chip">none</span>'}</span></div>
    <div class="ac-actions">
      <button class="primary" id="ac-talk">message ${escapeHtml(agent.name)}</button>
      <button class="ghost" data-close>close</button>
    </div>`;
  const modal = $('#agent-modal');
  modal.classList.remove('hidden');
  $('#ac-talk').onclick = () => {
    closeAgentModal();
    setMode('chat');
    $('#agent-select').value = id;
    updateComposerHint();
    $('#input').focus();
  };
  modal.querySelectorAll('[data-close]').forEach((n) => { n.onclick = closeAgentModal; });
}

function closeAgentModal() {
  $('#agent-modal').classList.add('hidden');
}

/* ------------------------------------------------------------------ events */

function syncModeUI() {
  const view = state.mode === 'chat' ? 'chat' : 'room';
  $$('#view-switch button').forEach((b) => {
    const on = b.dataset.view === view;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    // explicit paint: the pill state must match the mode, not the initial HTML
    b.style.background = on ? '#303030' : 'transparent';
    b.style.color = on ? 'var(--text)' : '';
  });
  $('#hunt-btn').classList.toggle('on', state.mode === 'hunt');
  $('#hunt-btn').style.display = state.mode === 'chat' ? 'none' : '';
  $('#huntbar').classList.toggle('hidden', state.mode !== 'hunt');
  $('#composer').style.display = state.mode === 'hunt' ? 'none' : 'flex';
  $('#input').placeholder = state.mode === 'chat' ? 'Ask anything…' : 'Message the room';
  updateComposerHint();
  renderThreads();
}

function setMode(mode) {
  state.mode = mode;
  syncModeUI();
  if (mode === 'chat') {
    if (state.chatThreadId) openThread(state.chatThreadId, 'chat');
    else showChatEmpty();
    renderThreads();
    return;
  }
  if (mode === 'room') {
    if (state.roomThreadId) openThread(state.roomThreadId, 'room');
    else renderEmpty('room');
    renderThreads();
  }
}

function wire() {
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    send();
  });
  $('#input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  $('#input').addEventListener('input', autogrow);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAgentModal();
  });
  $('#hunt-run').onclick = runHunt;
  $('#hunt-target').addEventListener('keydown', (e) => { if (e.key === 'Enter') runHunt(); });

  $$('#view-switch button').forEach((b) => {
    b.onclick = () => setMode(b.dataset.view === 'chat' ? 'chat' : 'room');
  });

  $('#hunt-btn').onclick = () => setMode(state.mode === 'hunt' ? 'room' : 'hunt');

  const setCollapsed = (on) => {
    state.collapsed = on;
    $('.app').classList.toggle('collapsed', on);
    // the switcher lives in the sidebar header; when it is hidden it moves up
    const slot = on ? $('#top-slot') : $('.side-head');
    slot.appendChild($('#view-switch'));
    $('#collapse-btn').title = on ? 'show sidebar' : 'hide sidebar';
    try { localStorage.setItem('arachne.collapsed', on ? '1' : '0'); } catch {}
  };
  state.setCollapsed = setCollapsed;
  $('#collapse-btn').onclick = () => setCollapsed(!state.collapsed);
  if (localStorage.getItem('arachne.collapsed') === '1') setCollapsed(true);

  const ENGINE_PRESETS = {
    openrouter: { label: 'openrouter', kind: 'openai', base: 'https://openrouter.ai/api/v1' },
    llamacpp: { label: 'llama.cpp', kind: 'openai', base: 'http://127.0.0.1:8080/v1' },
    ollama: { label: 'ollama-remote', kind: 'ollama', base: 'http://127.0.0.1:11434' },
    custom: { label: '', kind: 'openai', base: '' },
  };

  $('#eng-preset').onchange = () => {
    const preset = ENGINE_PRESETS[$('#eng-preset').value];
    if (!preset) return;
    $('#eng-label').value = preset.label;
    $('#eng-kind').value = preset.kind;
    $('#eng-base').value = preset.base;
  };

  $('#engine-add-toggle').onclick = () => {
    $('#engine-add').classList.toggle('hidden');
    if (!$('#engine-add').classList.contains('hidden')) $('#eng-label').focus();
  };

  $('#engine-add-run').onclick = async () => {
    const base = $('#eng-base').value.trim();
    if (!base) {
      toast('base url required');
      return;
    }
    try {
      const r = await api('/api/engines', {
        method: 'POST',
        body: {
          label: $('#eng-label').value.trim(),
          base,
          kind: $('#eng-kind').value,
          apiKey: $('#eng-key').value.trim(),
        },
      });
      state.health = await api('/api/health?refresh=1');
      renderHealth();
      toast(r.reachable
        ? `${r.key} · ${r.models.length} model${r.models.length === 1 ? '' : 's'}`
        : `${r.key} saved, unreachable (${r.error})`);
      if (r.reachable) {
        $('#engine-add').classList.add('hidden');
        ['#eng-label', '#eng-base', '#eng-key'].forEach((sel) => { $(sel).value = ''; });
        $('#eng-preset').value = '';
      }
    } catch (err) {
      toast(`engine failed: ${err.message}`);
    }
  };

  $('#stop').onclick = () => state.abort?.abort();
  $('#create-cancel').onclick = closeCreate;
  $('#create-run').onclick = runCreate;
  $$('#create-modal [data-close]').forEach((n) => { n.onclick = closeCreate; });
  $('#create-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runCreate(); } });

  function selectPanelTab(tab) {
    $$('#panel-tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === tab));
    $('#tab-evidence').classList.toggle('hidden', tab !== 'evidence');
    $('#tab-settings').classList.toggle('hidden', tab !== 'settings');
  }
  function openPanel(tab) {
    $('#panel').classList.remove('hidden');
    $('#scrim').classList.remove('hidden');
    selectPanelTab(tab);
  }
  function closePanel() {
    $('#panel').classList.add('hidden');
    $('#scrim').classList.add('hidden');
  }
  $('#evidence-btn').onclick = () => openPanel('evidence');
  $('#settings-btn').onclick = () => openPanel('settings');
  $('#panel-close').onclick = closePanel;
  $('#scrim').onclick = closePanel;
  $$('#panel-tabs button').forEach((b) => { b.onclick = () => selectPanelTab(b.dataset.tab); });
  $('#search').addEventListener('input', renderThreads);
  window.openPanel = openPanel;

  // suggestions fill the composer; a click on a code block copies it
  $('#transcript').addEventListener('click', async (e) => {
    const suggestion = e.target.closest('[data-suggest]');
    if (suggestion) {
      $('#input').value = suggestion.dataset.suggest;
      autogrow();
      $('#input').focus();
      return;
    }
    const pre = e.target.closest('pre');
    if (pre) {
      try {
        await navigator.clipboard.writeText(pre.innerText);
        toast('copied');
      } catch { toast('copy blocked by the browser'); }
    }
  });

  $('#engine-toggle').onclick = async () => {
    $('#engine-label').textContent = 'probing…';
    state.health = await api('/api/health?refresh=1');
    renderHealth();
    renderFindings();
    loadScope(state.health.policy);
  };
  $('#route-refresh').onclick = $('#engine-toggle').onclick;

  $('#scope-save').onclick = async () => {
    const scopeHosts = $('#scope-hosts').value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    const scopePaths = $('#scope-paths').value.split('\n').map((s) => s.trim()).filter(Boolean);
    try {
      await api('/api/config', { method: 'POST', body: { policy: { scopeHosts, scopePaths } } });
      toast('scope saved');
    } catch (err) {
      toast(`scope failed: ${err.message}`);
    }
  };

  $('#eng-start').onclick = async () => {
    const name = $('#eng-name').value.trim();
    const targets = $('#eng-targets').value.split(/[\n,]/).map((t) => t.trim()).filter(Boolean);
    if (!name || !targets.length) {
      toast('name and at least one authorized target');
      return;
    }
    try {
      const r = await api('/api/engagements', { method: 'POST', body: { name, targets } });
      state.engagement = r.engagement;
      state.health = await api('/api/health?refresh=1');
      renderEngagement();
      loadScope(r.policy);
      toast(`engagement ${r.engagement.id}`);
    } catch (err) {
      toast(`failed: ${err.message}`);
    }
  };

  $('#console-run').onclick = async () => {
    const name = $('#console-tool').value;
    let args = {};
    try { args = JSON.parse($('#console-args').value || '{}'); } catch { $('#console-out').textContent = 'args must be JSON'; return; }
    $('#console-out').textContent = 'running…';
    try {
      const r = await api('/api/tool', { method: 'POST', body: { name, args } });
      $('#console-out').textContent = `${r.ok ? 'ok' : 'failed'} (${r.ms ?? 0}ms)\n\n${r.output}`;
    } catch (err) {
      $('#console-out').textContent = err.message;
    }
  };
}

wire();
boot();
