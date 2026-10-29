/**
 * A tiny OpenAI-compatible engine for smoke-testing the loop without a model.
 *   node server/mockengine.mjs 8099
 *
 * It exercises the paths that are easy to get wrong and hard to see:
 *   - SSE streaming with token-by-token deltas
 *   - structured tool_calls (OpenAI deltas)
 *   - text-embedded tool calls (LFM2 / Qwen style markers)
 *   - tool result -> final answer
 *
 * Ask it for "scan" and it calls scan_sinks. Ask for "marker" and it prints a
 * call inside the text instead. Anything else gets a short canned answer.
 */
import http from 'node:http';

const port = Number(process.argv[2] || 8099);

const TOOL_CALL_TEXT = '<|tool_call_start|>[{"name":"fs_list","arguments":{"path":".","depth":1}}]<|tool_call_end|>';

function chunk(delta, finish = null) {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-tool-9b',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stream(res, pieces, opts = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  if (opts.toolCall) {
    res.write(chunk({ role: 'assistant', content: null }));
    res.write(chunk({
      tool_calls: [{
        index: 0,
        id: 'call_mock_1',
        type: 'function',
        function: { name: opts.toolCall.name, arguments: JSON.stringify(opts.toolCall.args) },
      }],
    }));
    res.write(chunk({}, 'tool_calls'));
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  res.write(chunk({ role: 'assistant', content: '' }));
  for (const piece of pieces) {
    res.write(chunk({ content: piece }));
    await sleep(12);
  }
  res.write(chunk({}, 'stop'));
  res.write('data: [DONE]\n\n');
  res.end();
}

function lastUser(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return String(messages[i].content || '');
  }
  return '';
}

function toolSummary(messages) {
  const toolMsgs = messages.filter((m) => m.role === 'tool');
  if (!toolMsgs.length) return null;
  const last = toolMsgs[toolMsgs.length - 1];
  const lines = String(last.content || '').split('\n').filter(Boolean);
  return lines.slice(0, 6).join('\n');
}

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'mock-tool-9b', object: 'model', owned_by: 'arachne' }] }));
    return;
  }

  if (req.url.startsWith('/v1/chat/completions') && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(raw); } catch {}
      const messages = body.messages || [];
      const prompt = lastUser(messages);
      const summary = toolSummary(messages);

      if (summary) {
        await stream(res, [
          'Tool came back with:\n\n',
          summary,
          '\n\nThat is the whole result. Next: read the top candidate in full before trusting it.',
        ]);
        return;
      }
      if (/\bintent_write\b/i.test(prompt)) {
        await stream(res, [], {
          toolCall: {
            name: 'intent_write',
            args: {
              title: 'trace argv[1] into the strcpy at vuln.c:17',
              rationale: 'argv reaches a fixed 64-byte stack buffer with no bound',
              target: 'fixtures/vuln/vuln.c:17',
              skill: 'rce-memory-corruption',
            },
          },
        });
        return;
      }
      if (/\bverify_finding\b/i.test(prompt)) {
        const id = prompt.match(/([a-z0-9_-]+:[^\s]+:\d+)/i);
        if (id) {
          await stream(res, [], { toolCall: { name: 'verify_finding', args: { id: id[1], note: 'same command, same signature' } } });
          return;
        }
      }
      if (/\bmarker\b/i.test(prompt)) {
        await stream(res, ['Reading the directory first. ', TOOL_CALL_TEXT]);
        return;
      }
      if (/\bhandoff\b/i.test(prompt)) {
        await stream(res, ['@Rook this one is yours — the harness is the next step.']);
        return;
      }
      // room prompts always mention "nothing to add", so silence needs a sharper trigger
      if (/\bquiet\b/i.test(prompt)) {
        await stream(res, ['[[silent]]']);
        return;
      }
      if (/\b(scan|sink|surface|vuln)\b/i.test(prompt)) {
        await stream(res, [], {
          toolCall: { name: 'scan_sinks', args: { path: 'fixtures/vuln' } },
        });
        return;
      }
      await stream(res, [
        'I am the mock engine, so there is no model behind this answer. ',
        'The loop, the streaming and the tool channel are what is being tested here. ',
        'Route a real model in Settings → routing when you want analysis.',
      ]);
    });
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(port, '127.0.0.1', () => console.log(`mock engine → http://127.0.0.1:${port}/v1`));
