# Engineering notes

Why the harness is shaped the way it is. Not a tutorial — the invariants, and the
failure each one exists to prevent.

## The harness is the product

A model produces text. Everything that turns that text into work — executing a
tool, refusing an unsafe command, remembering what was tested, deciding whether a
crash means anything — is code in this repository. Two consequences:

1. Anything the harness can enforce belongs in the harness, not in a prompt.
   Prompts drift under context pressure; code does not.
2. Anything that is knowledge rather than enforcement belongs in `skills/`, so it
   can be replaced without a patch.

## Coverage is a fact log, not a checklist

`ledger.mjs` stores one entry per surface+action pair, with a confidence:

- `observed` — a command ran and there is output
- `inferred` — read out of the code, not yet executed

The distinction is the entire point. A negative result from a single probe is an
observation, not a verdict. The planner may re-check an `inferred` entry once and
may never re-open an `observed` one. Without this, an agent either loops on the
same dead end or closes a direction on one weak data point.

Duplicate entries collapse and repeats are counted, so "how many times did we look
at this" is answerable.

## Direction is separate from work

`intent_write` records a direction: target, rationale, skill. The planner opens
three to five per hunt and executes nothing. Three rules keep it honest:

- if the goal is unmet and nothing is open, the planner must open something
- a serial chain is dispatched one step at a time, because step two cannot use
  output that does not exist yet
- a `done` intent reopens only for a material new mechanism, never for "try again"

The split exists because a single turn that both chooses and executes chooses
shallowly. Planning is cheap; a bad plan is what costs money.

## Labels are earned

| status | set by | meaning |
|---|---|---|
| `candidate` | `scan_sinks` | a rule matched a line |
| `reproduced` | `run_harness` | a process crashed under ASan/UBSan |
| `confirmed` | `verify_finding` | the recorded command was re-run and matched |

`run_harness` cannot produce a confirmed finding. It records the exact command and
the crash kind; `verify_finding` re-executes that command, re-classifies the
output, hashes it into `ev_<sha256>`, and demotes the finding on a mismatch. This
is the difference between review evidence and a bug, and it is worth a whole extra
stage to keep them apart.

Two heuristics support it: `reachScore` ranks candidates by what surrounds the
line (input reads nearby, bounds checks nearby, test paths), and the
`counterevidence` skill gives triage a checklist to kill its own findings.

## Authorization is a first-class object

Scope is not a settings field. An engagement is an id, a set of authorized
targets, and a directory:

```
engagements/<eng_id>/{engagement.json,pocs,reports,artifacts}
```

Creating one rewrites the host scope from those targets. Probes refuse any host
that is not listed, and there is no wildcard. Capability is not permission — the
tool can do it, the engagement is what says you may.

## Session state belongs to the harness

If authentication is left to the model, every finding behind a login collapses
into a 302 and a shrug. `sessions.mjs` owns the cookie jar, the default headers and
a request history. `http_probe` takes a session name; `http_history` shows the
replay trail. A browser would be more faithful and is deliberately not a
dependency here.

## Chat is not a room

Chat threads and room threads are different namespaces, enforced on the server:
`/api/send` checks the thread's `kind` against the requested mode and creates a
fresh thread on a mismatch rather than reusing the wrong one. Chat is one
generalist with no tools; a room is a set of agents with toolbelts. Keeping them
apart means a question can never consume a hunt's context, and a hunt can never
inherit a conversation.

## Budgets are visible

`maxSteps` stops a model that loops. `maxTokensPerTurn` stops one that is thorough
in the wrong direction. `costPerMTok` prices the turn when you point it at
something metered. All three surface rather than silently enforce.

## Deterministic stages first

Inventory and the sink scan never call a model. They are exact, cheap, and they
give the model something to reason over instead of asking it to guess at a
codebase. When every engine is offline the pipeline still produces a report and
says which stages it skipped. A wrong answer is worse than an honest gap.

## Deliberately absent

- **A browser.** The right tool for authenticated UI testing; also a Chromium
  dependency in a zero-dependency app. The cookie jar covers most of it.
- **A container.** The correct trust boundary for hostile tooling. The allowlist
  is the same idea, enforced in-process, at a fraction of the weight.
- **A live agent graph with heartbeats.** A file-backed ledger plus one planner
  turn per hunt captures most of the benefit for far less machinery.
