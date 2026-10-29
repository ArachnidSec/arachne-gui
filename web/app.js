const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  agents: [],
  tools: [],
  roomThreads: [],
  chatThreads: [],
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

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed) {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Blobby agent face, deterministic per agent. */
function avatarSvg(agent, size = 'md') {
  const r = rng(hash(agent.id));
  const n = 9;
  const pts = [];
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    let rad = 0.67 + r() * 0.29;
    if (agent.shape === 'tall') rad *= 0.94;
    if (agent.shape === 'wide') rad *= 1.02;
    pts.push([32 + Math.cos(a) * 27 * rad, 32 + Math.sin(a) * 27 * rad]);
  }
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let d = `M ${mid(pts[0], pts[1]).join(' ')}`;
  for (let i = 1; i <= n; i += 1) {
    const cur = pts[i % n];
    const next = pts[(i + 1) % n];
    d += ` Q ${cur.join(' ')} ${mid(cur, next).join(' ')}`;
  }
  const gap = agent.shape === 'wide' ? 8.5 : 7;
  const ey = agent.shape === 'tall' ? 29 : 31;
  const er = agent.shape === 'wide' ? 2.1 : 2.4;
  return `<svg class="avatar ${size}" viewBox="0 0 64 64" aria-hidden="true">
    <path d="${d}" fill="${agent.color}" opacity="0.9"/>
    <circle cx="${32 - gap}" cy="${ey}" r="${er}" fill="#14100d"/>
    <circle cx="${32 + gap}" cy="${ey}" r="${er}" fill="#14100d"/>
    <path d="M ${32 - 3.5} ${ey + 6} Q 32 ${ey + 8.5} ${32 + 3.5} ${ey + 6}" stroke="#14100d" stroke-width="1.4" fill="none" stroke-linecap="round" opacity=".55"/>
  </svg>`;
}

const agentOf = (id) => state.agents.find((a) => a.id === id) || { id: id || 'x', name: id || 'agent', role: '', color: '#8b8f9a', shape: 'round' };

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

async function* sse(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
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
    const deep = location.hash.match(/^#agent\/([\w-]+)$/);
    if (deep) openAgentModal(deep[1]);

    if (state.roomThreads.length) {
      await openThread(state.roomThreads[0].id, 'room');
    } else {
      renderEmpty('room');
    }
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
  sel.innerHTML = `<option value="">the room — all members</option>` +
    state.agents.filter((a) => a.id !== 'chat').map((a) => `<option value="${a.id}">${escapeHtml(a.name)} — ${escapeHtml(a.role.toLowerCase())}</option>`).join('');
  sel.onchange = updateComposerHint;
  updateComposerHint();
}

function renderThreadList(selector, list, activeId, kind, emptyText) {
  const box = $(selector);
  if (!box) return;
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = `<div class="tiny" style="padding:0 10px">${emptyText}</div>`;
    return;
  }
  for (const t of list) {
    const b = el('button', `thread${t.id === activeId ? ' on' : ''}`);
    b.innerHTML = `${escapeHtml(t.title)}${t.preview ? `<span class="t-preview">${escapeHtml(t.preview)}</span>` : ''}`;
    b.onclick = () => openThread(t.id, kind);
    box.appendChild(b);
  }
}

function renderThreads() {
  renderThreadList('#threads', state.roomThreads, state.roomThreadId, 'room', 'no rooms yet');
  renderThreadList('#chats', state.chatThreads, state.chatThreadId, 'chat', 'no chats yet');
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
    const text = el('span', '', `${escapeHtml(skill.name)}<span class="sk-d">${escapeHtml(skill.description || '')}</span>`);
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
    const { entries, intents, summary } = await api('/api/ledger');
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
  } catch { /* server older than ui */ }
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
      </div>`;
    card.title = f.evidence || '';
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
  if (state.mode === 'chat') hint.textContent = 'Wren · one generalist · no tools · separate from your rooms';
  else if (state.mode === 'hunt') hint.textContent = 'deterministic surface → scan → agent trace → harness → report';
  else if ($('#agent-select').value) hint.textContent = 'single specialist answers';
  else hint.textContent = 'room protocol: fan-out · tapback · handoff';
  $('#agent-select').style.display = state.mode === 'hunt' || state.mode === 'chat' ? 'none' : '';
}

/* ------------------------------------------------------------------ transcript */

function renderEmpty(kind = 'room') {
  $('#transcript').innerHTML = `<div class="transcript-inner"><div class="empty-state">
    <div class="big">a quiet room</div>
    <div class="sub">Point the room at something. Mira maps the surface, Ivo traces the dataflow,
    Rook builds the harness, Sable calls the crash, Juniper writes it up.<br><br>
    Try: <em>“map ./workspace/fixtures/vuln and tell me what is reachable”</em></div>
  </div></div>`;
  $('#thread-title').textContent = 'new room';
  $('#thread-meta').textContent = 'room · not started';
}

function showChatEmpty() {
  $('#transcript').innerHTML = `<div class="transcript-inner"><div class="empty-state">
    <div class="big">ask Wren anything</div>
    <div class="sub">A plain chat with one generalist. No tools, no agents, no room protocol —
    for “what does this parse do”, “explain this stack trace”, “is this worth a second look”.<br><br>
    Chats live in their own place. Nothing said here is handed to the specialists.</div>
  </div></div>`;
  $('#thread-title').textContent = 'chat';
  $('#thread-meta').textContent = 'Wren · generalist · no tools';
}

function clearTranscript() {
  $('#transcript').innerHTML = '';
  const inner = el('div', 'transcript-inner');
  inner.id = 'transcript-inner';
  $('#transcript').appendChild(inner);
  state.live.clear();
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
    <div class="head">
      ${avatarSvg(agent, 'md')}
      <span class="nm">${escapeHtml(agent.name)}</span>
      <span class="rl">${escapeHtml(agent.role)}</span>
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
    <div class="head">
      ${avatarSvg(agent, 'md')}
      <span class="nm">${escapeHtml(agent.name)}</span>
      <span class="rl">${escapeHtml(agent.role)}</span>
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
  $('#thread-meta').textContent = k === 'chat'
    ? `chat · ${thread.title === 'new chat' ? 'Wren' : 'Wren · generalist'}`
    : `room · ${thread.members.map((m) => agentOf(m).name).join(' · ')}`;
  clearTranscript();
  for (const m of thread.messages) {
    if (m.role === 'user') addUserMessage(m.text);
    else addAgentMessage(m);
  }
  if (!thread.messages.length) (k === 'chat' ? showChatEmpty : renderEmpty)('room');
  renderThreads();
  scrollDown(true);
  // fonts and blobs settle after first paint; pin to the real bottom
  setTimeout(() => scrollDown(true), 80);
}

async function newRoom() {
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
}

async function newChat() {
  const { thread } = await api('/api/threads', { method: 'POST', body: { kind: 'chat' } });
  state.chatThreads.unshift({ id: thread.id, title: thread.title, preview: '', kind: 'chat', members: ['chat'] });
  state.chatThreadId = thread.id;
  state.thread = thread;
  state.mode = 'chat';
  syncModeUI();
  $('#thread-title').textContent = thread.title;
  $('#thread-meta').textContent = 'chat · Wren · generalist';
  renderThreads();
  showChatEmpty();
  $('#input').focus();
}

/* ------------------------------------------------------------------ send */

function setBusy(busy) {
  state.streaming = busy;
  $('#send').disabled = busy;
  $('#hunt-run').disabled = busy;
  $('#input').disabled = busy;
  $('#input').placeholder = busy
    ? (state.mode === 'chat' ? 'thinking…' : 'the room is talking…')
    : (state.mode === 'chat' ? 'ask a question…' : 'ask the room…');
}

async function send() {
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

  try {
    for await (const ev of sse('/api/send', body)) {
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
    addError(err.message);
  } finally {
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

  try {
    for await (const ev of sse('/api/hunt', { target })) {
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
    addError(err.message);
  } finally {
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
  $$('#view-switch button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  $('#hunt-btn').classList.toggle('on', state.mode === 'hunt');
  $('#huntbar').classList.toggle('hidden', state.mode !== 'hunt');
  $('#composer').style.display = state.mode === 'hunt' ? 'none' : '';
  $('#input').placeholder = state.mode === 'chat' ? 'ask a question…' : 'ask the room…';
  updateComposerHint();
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
  $('#new-room').onclick = newRoom;
  $('#new-chat').onclick = newChat;
  $('#hunt-run').onclick = runHunt;
  $('#hunt-target').addEventListener('keydown', (e) => { if (e.key === 'Enter') runHunt(); });

  $$('#view-switch button').forEach((b) => {
    b.onclick = () => setMode(b.dataset.view === 'chat' ? 'chat' : 'room');
  });

  $('#hunt-btn').onclick = () => setMode(state.mode === 'hunt' ? 'room' : 'hunt');

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
