import { streamChat, LLMError } from './llm.mjs';
import { toolDefsFor, executeTool } from './tools/index.mjs';
import { systemPrompt, agentById } from './agents.mjs';
import { skillBlock } from './skills.mjs';

const key = (name, args) => `${name}:${JSON.stringify(args || {})}`;

const priceOf = (cfg, usage) => {
  const p = cfg.policy.costPerMTok || {};
  const inRate = Number(p.input || 0);
  const outRate = Number(p.output || 0);
  if (!inRate && !outRate) return 0;
  return ((usage.prompt / 1e6) * inRate) + ((usage.completion / 1e6) * outRate);
};

/**
 * One agent turn: model -> tool calls -> results -> model, until it stops
 * asking for tools or a budget runs out.
 *
 * Two budgets, because both fail differently: steps stop a model that loops,
 * tokens stop a model that is thorough in the wrong direction.
 */
export async function* runTurn({
  cfg,
  agent,
  engine,
  model,
  history = [],
  userText,
  runtime,
  emit,
  maxSteps = cfg.policy.maxSteps,
  signal,
  skills = [],
}) {
  const started = Date.now();
  const applicable = skills.filter((s) => !s.agents?.length || s.agents.includes(agent.id));
  const system = systemPrompt(cfg, agent) + skillBlock(applicable);
  const toolDefs = toolDefsFor(agent.tools);

  const messages = [
    { role: 'system', content: system },
    ...history,
    { role: 'user', content: userText },
  ];

  const tokenBudget = Number(cfg.policy.maxTokensPerTurn || 0);
  const spent = { prompt: 0, completion: 0 };
  let steps = 0;
  let full = '';
  let totalCalls = 0;
  const seen = new Map();

  yield { type: 'agent_start', agentId: agent.id, model, engine: engine.label, skills: applicable.map((s) => s.id) };

  for (let step = 0; step < maxSteps; step += 1) {
    steps = step + 1;
    const isLast = step === maxSteps - 1;
    let stepText = '';
    let calls = [];

    if (tokenBudget && spent.prompt + spent.completion >= tokenBudget) {
      yield {
        type: 'error',
        agentId: agent.id,
        message: `token budget reached (${spent.prompt + spent.completion}/${tokenBudget}). Raise policy.maxTokensPerTurn or narrow the task.`,
      };
      break;
    }

    try {
      for await (const ev of streamChat({
        engine,
        model,
        messages,
        tools: isLast ? [] : toolDefs,
        temperature: cfg.policy.temperature,
        signal,
      })) {
        if (ev.type === 'token') {
          stepText += ev.text;
          yield { type: 'token', agentId: agent.id, text: ev.text };
        } else if (ev.type === 'reasoning') {
          yield { type: 'reasoning', agentId: agent.id, text: ev.text };
        } else if (ev.type === 'replace') {
          stepText = ev.text;
          yield { type: 'replace', agentId: agent.id, text: ev.text };
        } else if (ev.type === 'tool_calls') {
          calls = ev.calls;
        } else if (ev.type === 'usage') {
          spent.prompt += Number(ev.usage?.prompt || 0);
          spent.completion += Number(ev.usage?.completion || 0);
          yield { type: 'usage', agentId: agent.id, spent: { ...spent } };
        }
      }
    } catch (err) {
      const message = err instanceof LLMError ? err.message : String(err?.message || err);
      const detail = err?.body ? `\n${String(err.body).slice(0, 400)}` : '';
      yield { type: 'error', agentId: agent.id, message: `${message}${detail}` };
      return;
    }

    // each step is a paragraph; a tool round-trip should not run sentences together
    if (stepText) full = full ? `${full}\n\n${stepText}` : stepText;

    if (!calls.length) break;

    messages.push({
      role: 'assistant',
      content: stepText,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
      })),
    });

    for (const call of calls) {
      totalCalls += 1;
      const fingerprint = key(call.name, call.args);
      const hits = (seen.get(fingerprint) || 0) + 1;
      seen.set(fingerprint, hits);

      yield { type: 'tool_call', agentId: agent.id, id: call.id, name: call.name, args: call.args };

      if (hits > 1) {
        const output = `duplicate call refused: you already ran ${call.name} with these arguments. Use the earlier result, or check the ledger with ledger_read.`;
        yield { type: 'tool_result', agentId: agent.id, id: call.id, name: call.name, ok: false, output, ms: 0 };
        messages.push({ role: 'tool', tool_call_id: call.id, tool_name: call.name, content: output });
        continue;
      }

      const result = await executeTool(cfg, call.name, call.args, {
        store: runtime.store,
        ledger: runtime.ledger,
        engagements: runtime.engagements,
        engagementId: runtime.engagements?.active?.()?.id || null,
        campaignId: runtime.campaigns?.active?.()?.id || null,
        emit: emit || (() => {}),
        resolve: (p) => cfg.workspace,
      });

      yield {
        type: 'tool_result',
        agentId: agent.id,
        id: call.id,
        name: call.name,
        ok: result.ok !== false,
        output: String(result.output ?? '').slice(0, 6000),
        ms: result.ms,
      };

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        tool_name: call.name,
        content: String(result.output ?? '').slice(0, cfg.policy.maxOutputChars || 12000),
      });
      if (signal?.aborted) return;
    }

    if (isLast) yield { type: 'step_limit', agentId: agent.id, steps };
  }

  const usage = { prompt: spent.prompt, completion: spent.completion, total: spent.prompt + spent.completion };
  yield {
    type: 'done',
    agentId: agent.id,
    text: full.trim(),
    steps,
    ms: Date.now() - started,
    usage,
    cost: priceOf(cfg, spent),
    toolCalls: totalCalls,
  };
}

const SILENT = /^\s*\[\[(silent|tapback|nothing)\]\].*$/is;

/**
 * The room turn. Members answer in order, each seeing what the ones before
 * said. A member with nothing to add sends a tapback instead of a bubble, and
 * a member who names a colleague hands that colleague the floor next.
 */
export async function* runRoom({
  cfg,
  thread,
  members,
  models,
  userText,
  runtime,
  signal,
  history = [],
  emit,
  skills = [],
}) {
  const queue = [...members];
  const said = [];
  const order = [];
  const maxTurns = Math.min(queue.length + 1, 6);

  for (let turn = 0; turn < maxTurns && queue.length; turn += 1) {
    const agentId = queue.shift();
    const agent = agentById(agentId);
    if (!agent) continue;
    const route = models[agentId] || models.chat;
    if (!route?.engine || !route?.model) {
      yield { type: 'error', agentId, message: `no model routed for ${agent.name} — open Engines and pick one` };
      continue;
    }
    order.push(agentId);

    const ledgerBrief = runtime.ledger ? runtime.ledger.brief({ limit: 10 }) : '';
    const prior = said.length
      ? `Earlier in this room:\n${said.map((s) => `[${s.name}] ${s.text}`).join('\n\n')}\n\n`
      : '';

    const prompt = `${prior}${ledgerBrief ? `LEDGER\n${ledgerBrief}\n\n` : ''}${userText}

Respond as ${agent.name} (${agent.role}). If you have nothing to add beyond what was already said, reply with exactly [[silent]]. If another member should own the next step, name them once with @ and say why.`;

    let text = '';
    let errored = false;
    for await (const ev of runTurn({
      cfg,
      agent,
      engine: route.engine,
      model: route.model,
      history,
      userText: prompt,
      runtime,
      signal,
      emit,
      skills,
    })) {
      if (ev.type === 'token') text += ev.text;
      else if (ev.type === 'replace') text = ev.text;
      else if (ev.type === 'error') errored = true;
      yield { ...ev, roomTurn: turn };
    }

    const trimmed = text.trim();
    if (!trimmed || errored) continue;

    if (SILENT.test(trimmed)) {
      yield { type: 'tapback', agentId, turn };
      continue;
    }

    said.push({ name: agent.name, text: trimmed });

    const named = members.find((id) => {
      const a = agentById(id);
      return a && a.id !== agentId && new RegExp(`@?\\b${a.name}\\b`, 'i').test(trimmed);
    });
    if (named && !order.includes(named)) {
      const idx = queue.indexOf(named);
      if (idx > 0) queue.splice(idx, 1);
      if (idx !== 0) queue.unshift(named);
      yield { type: 'handoff', from: agentId, to: named };
    }
  }

  yield { type: 'room_done', order, said: said.map((s) => s.name) };
}
