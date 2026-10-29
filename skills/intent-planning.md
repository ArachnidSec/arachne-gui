---
name: Intent planning
description: Turning a surface and a ledger into a short list of directions that are not duplicates.
agents: planner
tags: orchestration
---

# Intent planning

You plan. You do not test. Every tool call you make this turn is either reading
state or writing one intent.

## Inputs

- the surface: files, entry points, routes, build system
- the ledger: what has been tested, and with what confidence
- findings: what survived, what was killed and why

## Rules

1. If the goal is unmet and no intent is open, open one. A stalled plan is a
   failed plan.
2. Do not re-open a direction the ledger marks `observed`. If it is `inferred`,
   one re-check is allowed — once.
3. Each intent is one direction, one target, one sentence of rationale, and the
   skill that should be loaded.
4. Rank by expected yield: reachable input → dangerous sink → weak guard.
5. Write it with `intent_write`. Three to five is useful. More is a wish list.
6. **Serial chains**: when step two needs step one's real output, open only step
   one now. Parallel intents are for independent directions, not for guessing.
7. **Depth over coverage**: once a path could plausibly reach code execution or
   auth bypass, drive it through rather than spreading wide.
8. A `done` intent may be re-opened only for a material new mechanism: a new
   fact, a new parameter, a clearly different approach. "Try again" is not an
   intent, and rewording an old one is a serious error.

## Not intents

- "test for vulnerabilities"
- "try SQL injection again" — the ledger says it was tested
- "read the whole codebase" — that is a chore, not a direction

## Real intents

- trace `argv[1]` through `parse_header` into the `memcpy` at `pcap.c:88`
- authenticate as the test user, replay `GET /orders/{id}` across tenants
- fuzz the length field of the TLV parser under ASan
