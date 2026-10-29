# Engines

arachne talks to two wire protocols. Anything that speaks one of them can hold a role.

```jsonc
"engines": {
  "ollama":   { "kind": "ollama", "base": "http://127.0.0.1:11434", "label": "Ollama" },
  "llamacpp": { "kind": "openai", "base": "http://127.0.0.1:8080/v1", "label": "llama.cpp" },
  "lmstudio": { "kind": "openai", "base": "http://127.0.0.1:1234/v1", "label": "LM Studio" },
  "ornith":   { "kind": "openai", "base": "http://127.0.0.1:8081/v1", "label": "Ornith" },
  "lfm":      { "kind": "openai", "base": "http://127.0.0.1:8082/v1", "label": "LFM2" },
  "local":    { "kind": "openai", "base": "http://127.0.0.1:1337/v1", "label": "Local API" }
}
```

`kind: "openai"` means `POST <base>/chat/completions` and `GET <base>/models`. The base
must include `/v1` if your server wants it there. An engine may also carry an
`apiKey`, which is sent as `Authorization: Bearer …` and never returned to the
browser.

Add one from the UI with **+ engine** in the routing rail, or by API:

```bash
curl -X POST http://127.0.0.1:7777/api/engines \
  -H 'content-type: application/json' \
  -d '{"label":"openrouter","kind":"openai","base":"https://openrouter.ai/api/v1","apiKey":"sk-…"}'
```

Hosted routers work with the same shape — anything exposing an OpenAI-compatible
`/chat/completions` and `/models`. Point a role at a specific model with the
dropdowns, or `POST /api/config` with `{"roles":{"static":{"engine":"openrouter","model":"…"}}}`.

## Ollama

Already the default. Tool support comes from the model, not the runtime:

```bash
ollama list                                   # arachne reads capabilities from here
ollama run qwen3:8b
```

Ollama reports each model's capabilities; arachne only routes a tool-using role to a model
whose capabilities include `tools`. If a model cannot fit in memory, the error surfaces in
the room verbatim ("requires 16.9 GiB but only 11.3 GiB are available") — that is the
engine's message, not a bug in the room.

## llama.cpp

```bash
llama-server -m ./models/qwen3-8b-q4_k_m.gguf \
  --port 8081 --ctx-size 16384 --jinja --no-webui
```

`--jinja` is the flag that makes llama.cpp apply the model's chat template, which is what
gives you real tool calls instead of printed JSON. Without it you get the text-channel
fallback and a slower, dumber loop.

Then in `config.json`:

```jsonc
"ornith": { "kind": "openai", "base": "http://127.0.0.1:8081/v1", "label": "Ornith" }
```

## LM Studio

Load the model, open **Developer → Local Server**, start it on 1234. LM Studio exposes
`/v1/models` and `/v1/chat/completions`, and passes tool calls through when the model's
template supports them. Point `lmstudio` at it and you are done.

## MLX, on Apple silicon

`mlx_lm.server` speaks the OpenAI protocol and runs MLX quants much closer to the metal than
a generic GGUF path:

```bash
pip install mlx-lm
mlx_lm.server --model jedisct1/Ornith-1.0-35B-MLX-oQ8 --port 8081
```

Set the context high enough for tool schemas plus a room transcript — 16k is a floor, 32k
is comfortable when five agents share a conversation.

## Ornith

Ornith is a self-scaffolding agentic-coding family: it is trained to write its own tool
calls rather than wait for a scaffold, which is exactly the shape of this loop. Checkpoints
come in 9B and 35B-A3B variants, as MLX, NVFP4/FP8 and GGUF:

- `primitive-ai/Ornith-1.5-35B-A3B-agentic-NVFP4-FP8` — big, wants a lot of memory
- `yugeshkarunamurthy/Ornith-1.0-9B-oQe6` — the one that fits on a laptop
- `jedisct1/Ornith-1.0-35B-MLX-oQ8` — MLX, for `mlx_lm.server`

```jsonc
"roles": {
  "static": { "engine": "ornith", "model": "Ornith-1.5-35B-A3B" },
  "hunter": { "engine": "ornith", "model": "Ornith-1.5-35B-A3B" }
}
```

The 9B is the one to try first: the trace and prove stages need reasoning over a whole
function, and a 9B that fits beats a 35B that swaps.

## LFM2

Liquid AI's LFM2 line is built for tool calling on consumer hardware, and it prints its
calls with `<|tool_call_start|>…<|tool_call_end|>` markers when the runtime does not
extract them. arachne parses both forms.

```bash
llama-server -m ./models/LFM2-24B-A2B-Q4_K_M.gguf --port 8082 --ctx-size 16384 --jinja
```

```jsonc
"lfm": { "kind": "openai", "base": "http://127.0.0.1:8082/v1", "label": "LFM2" }
```

The small `LFM2-1.2B-Tool` is a good fit for the fan-out roles (`scout`, `scribe`), where
the job is short, structured, and repeated — not for `static` or `hunter`, where the model
has to hold a whole function in its head.

## A routing recipe

Mixed engines are the point. One plausible split on a 32 GB machine:

```jsonc
"roles": {
  "scout":  { "engine": "lfm",    "model": "LFM2-1.2B-Tool" },   // fast fan-out
  "static": { "engine": "ornith", "model": "Ornith-1.0-9B" },    // whole-function read
  "hunter": { "engine": "ornith", "model": "Ornith-1.0-9B" },    // harness authoring
  "triage": { "engine": "ollama", "model": "qwen3:8b" },         // crash reading
  "scribe": { "engine": "lfm",    "model": "LFM2-1.2B-Tool" },   // report shape
  "chat":   { "engine": "ollama", "model": "qwen3:8b" }
}
```

Empty `model` means auto-pick at boot: tool-capable only, sized by role. Re-probe with
**refresh** in the routing rail after starting a new engine.

## No model at all

The pipeline's first two stages are deterministic, and the mock engine exercises the rest:

```bash
node server/mockengine.mjs 8099
```

Point the `mock` engine at `http://127.0.0.1:8099/v1` and route roles to `mock-tool-9b`.
It streams tokens, emits structured tool calls (ask it to "scan"), prints a marker-style
call (ask for "marker"), goes silent (ask for "quiet") and hands off (ask for "handoff").
Useful for checking a UI change without waking a 27B model.
