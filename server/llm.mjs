/**
 * One streaming chat client, two wire protocols, four tool-call dialects.
 *
 * Local models are the wild west: Ollama hands back structured tool_calls,
 * llama.cpp usually does, and the small tool-tuned checkpoints (LFM2, Qwen,
 * Qwen) sometimes just *print* a call inside their answer using their own
 * markers. All of those land as the same normalized event here, so the agent
 * loop never has to care which runtime is behind the model.
 */

const TOOL_MARKERS = [
  /<\|tool_call_start\|>([\s\S]*?)<\|tool_call_end\|>/g,
  /<tool_call>([\s\S]*?)<\/tool_call>/g,
  /<function_call>([\s\S]*?)<\/function_call>/g,
  /\[TOOL_CALLS\]\s*(\[[\s\S]*?\])/g,
];

export class LLMError extends Error {
  constructor(message, { engine, status, body } = {}) {
    super(message);
    this.name = 'LLMError';
    this.engine = engine;
    this.status = status;
    this.body = body;
  }
}

const timeout = (ms) => AbortSignal.timeout(ms);

export async function listModels(engine, { timeoutMs = 4000 } = {}) {
  const base = engine.base.replace(/\/+$/, '');
  if (engine.kind === 'ollama') {
    const res = await fetch(`${base}/api/tags`, { signal: timeout(timeoutMs) });
    if (!res.ok) throw new LLMError(`ollama tags ${res.status}`, { status: res.status });
    const body = await res.json();
    return (body.models || []).map((m) => ({
      id: m.name,
      tools: (m.capabilities || []).includes('tools'),
      caps: m.capabilities || [],
      size: m.details?.parameter_size || '',
      family: m.details?.family || '',
    }));
  }
  const res = await fetch(`${base}/models`, { signal: timeout(timeoutMs) });
  if (!res.ok) throw new LLMError(`models ${res.status}`, { status: res.status });
  const body = await res.json();
  return (body.data || []).map((m) => ({
    id: m.id,
    tools: true,
    caps: [],
    size: '',
    family: m.owned_by || '',
  }));
}

/** "qwen3.8:27b" -> 27, "LFM2-24B-A2B" -> 24, "ornith-1.5-35b-a3b" -> 35 */
export function paramBillions(id = '') {
  const m = String(id).match(/(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/i);
  return m ? parseFloat(m[1]) : 0;
}

/**
 * Pick a model for a role. Bigger model -> deeper reasoning role, smaller ->
 * cheap fan-out. Only models advertising tool support are eligible when the
 * role needs tools.
 */
export function rankModels(models, { needsTools = true, prefer = 'large' } = {}) {
  const pool = models.filter((m) => (needsTools ? m.tools : true));
  if (!pool.length) return null;
  const scored = pool
    .map((m) => ({ ...m, b: paramBillions(m.id) }))
    .sort((a, b) => (prefer === 'small' ? a.b - b.b : b.b - a.b));
  return scored[0];
}

async function* readSSELines(res, signal) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (signal?.aborted) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
    }
    if (buf.trim()) yield buf.trim();
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

async function* readJSONLines(res, signal) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (signal?.aborted) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) yield line;
      }
    }
    if (buf.trim()) yield buf.trim();
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function normalizeArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  const text = String(raw).trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    // small models love trailing commas and unquoted keys
    try {
      return JSON.parse(text.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return { _raw: text };
    }
  }
}

function normCall(call, i, fallbackId) {
  const fn = call.function || call;
  const name = fn.name || fn.tool || fn.tool_name;
  if (!name) return null;
  const args = normalizeArgs(fn.arguments ?? fn.args ?? fn.parameters ?? fn.input);
  return {
    id: call.id || `${fallbackId}_${i}`,
    name: String(name),
    args: args && typeof args === 'object' ? args : {},
  };
}

/** Pull tool calls out of plain text for runtimes with no tool channel. */
export function extractTextToolCalls(text) {
  if (!text) return { calls: [], cleaned: text };
  const calls = [];
  let cleaned = text;
  for (const re of TOOL_MARKERS) {
    cleaned = cleaned.replace(re, (whole, inner) => {
      const parsed = tryParseCalls(inner);
      if (parsed.length) {
        calls.push(...parsed);
        return '';
      }
      return whole;
    });
  }
  // fenced json block shaped like a call
  cleaned = cleaned.replace(/```(?:json)?\s*([\s\S]*?)```/g, (whole, inner) => {
    const parsed = tryParseCalls(inner);
    const looksLikeCall = parsed.length && parsed.every((c) => c.name && c.args && !Array.isArray(c.args));
    if (looksLikeCall) {
      calls.push(...parsed);
      return '';
    }
    return whole;
  });
  return { calls, cleaned: cleaned.trim() };
}

function tryParseCalls(inner) {
  const attempts = [inner.trim()];
  const arr = inner.trim();
  if (!arr.startsWith('[')) attempts.push(`[${arr}]`);
  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt.replace(/,\s*([}\]])/g, '$1'));
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list
        .map((c) => {
          const fn = c.function || c;
          const name = fn?.name || fn?.tool;
          if (!name) return null;
          return { id: '', name: String(name), args: normalizeArgs(fn.arguments ?? fn.args ?? fn.parameters ?? {}) };
        })
        .filter(Boolean);
    } catch {
      /* next */
    }
  }
  return [];
}

function toOllamaMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      return {
        role: 'assistant',
        content: m.content || '',
        tool_calls: m.tool_calls.map((c) => ({
          function: { name: c.function.name, arguments: normalizeArgs(c.function.arguments) },
        })),
      };
    }
    if (m.role === 'tool') {
      return { role: 'tool', content: String(m.content ?? ''), tool_name: m.tool_name || '' };
    }
    return { role: m.role, content: m.content ?? '' };
  });
}

/**
 * Async generator. Yields:
 *   {type:'token', text} {type:'reasoning', text} {type:'tool_calls', calls}
 *   {type:'usage', usage} {type:'done'}
 */
export async function* streamChat({
  engine,
  model,
  messages,
  tools = [],
  temperature = 0.3,
  maxTokens,
  signal,
  timeoutMs = 180000,
}) {
  if (!model) throw new LLMError('no model selected');
  const base = String(engine.base || '').replace(/\/+$/, '');
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const callId = Math.random().toString(36).slice(2, 8);

  try {
    if (engine.kind === 'ollama') {
      const body = {
        model,
        messages: toOllamaMessages(messages),
        stream: true,
        options: { temperature, ...(maxTokens ? { num_predict: maxTokens } : {}) },
      };
      if (tools.length) body.tools = tools;
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      if (!res.ok) {
        throw new LLMError(`ollama ${res.status}`, { engine: engine.label, status: res.status, body: (await res.text()).slice(0, 800) });
      }
      const collected = [];
      let content = '';
      let usage = null;
      for await (const line of readJSONLines(res, abort.signal)) {
        let chunk;
        try { chunk = JSON.parse(line); } catch { continue; }
        const msg = chunk.message || {};
        if (msg.thinking) yield { type: 'reasoning', text: msg.thinking };
        if (msg.content) {
          content += msg.content;
          yield { type: 'token', text: msg.content };
        }
        if (Array.isArray(msg.tool_calls)) {
          for (const [i, c] of msg.tool_calls.entries()) {
            const call = normCall(c, collected.length + i, callId);
            if (call) collected.push(call);
          }
        }
        if (chunk.done) usage = { prompt: chunk.prompt_eval_count, completion: chunk.eval_count };
        if (chunk.error) throw new LLMError(chunk.error, { engine: engine.label });
      }
      let calls = dedupeCalls(collected);
      if (!calls.length) {
        const extracted = extractTextToolCalls(content);
        if (extracted.calls.length) {
          calls = dedupeCalls(extracted.calls);
          yield { type: 'replace', text: extracted.cleaned };
        }
      }
      if (calls.length) yield { type: 'tool_calls', calls };
      if (usage) yield { type: 'usage', usage };
      yield { type: 'done' };
      return;
    }

    // ---- OpenAI-compatible ----
    const body = {
      model,
      messages,
      stream: true,
      temperature,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    };
    if (tools.length) body.tools = tools;
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
    if (!res.ok) {
      throw new LLMError(`${engine.label} ${res.status}`, {
        engine: engine.label,
        status: res.status,
        body: (await res.text()).slice(0, 800),
      });
    }
    let content = '';
    const partial = [];
    let usage = null;
    for await (const data of readSSELines(res, abort.signal)) {
      if (!data || data === '[DONE]') continue;
      let chunk;
      try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk.error) throw new LLMError(chunk.error.message || String(chunk.error), { engine: engine.label });
      const choice = chunk.choices?.[0];
      if (chunk.usage) usage = { prompt: chunk.usage.prompt_tokens, completion: chunk.usage.completion_tokens };
      if (!choice) continue;
      const d = choice.delta || {};
      const reasoning = d.reasoning_content || d.reasoning;
      if (reasoning) yield { type: 'reasoning', text: reasoning };
      if (d.content) {
        content += d.content;
        yield { type: 'token', text: d.content };
      }
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const idx = tc.index ?? partial.length;
          partial[idx] = partial[idx] || { id: tc.id, name: '', argsText: '' };
          if (tc.id) partial[idx].id = tc.id;
          if (tc.function?.name) partial[idx].name += tc.function.name;
          if (tc.function?.arguments) partial[idx].argsText += tc.function.arguments;
        }
      }
    }
    let calls = partial
      .filter(Boolean)
      .map((p, i) => ({ id: p.id || `${callId}_${i}`, name: p.name, args: normalizeArgs(p.argsText) }))
      .filter((c) => c.name);
    if (!calls.length) {
      const extracted = extractTextToolCalls(content);
      if (extracted.calls.length) {
        calls = dedupeCalls(extracted.calls);
        yield { type: 'replace', text: extracted.cleaned };
      }
    }
    if (calls.length) yield { type: 'tool_calls', calls };
    if (usage) yield { type: 'usage', usage };
    yield { type: 'done' };
  } catch (err) {
    if (err instanceof LLMError) throw err;
    if (err?.name === 'AbortError') throw new LLMError(`timed out or cancelled after ${Math.round(timeoutMs / 1000)}s`, { engine: engine.label });
    throw new LLMError(err?.message || String(err), { engine: engine.label });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function dedupeCalls(calls) {
  const seen = new Set();
  const out = [];
  for (const c of calls) {
    const key = `${c.name}:${JSON.stringify(c.args)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/** Non-streaming convenience used by the triage/report stages. */
export async function complete({ engine, model, messages, temperature = 0.2, maxTokens = 1200, timeoutMs = 180000 }) {
  let text = '';
  let calls = [];
  for await (const ev of streamChat({ engine, model, messages, temperature, maxTokens, timeoutMs })) {
    if (ev.type === 'token') text += ev.text;
    else if (ev.type === 'replace') text = ev.text;
    else if (ev.type === 'tool_calls') calls = ev.calls;
  }
  return { text: text.trim(), calls };
}
