---
name: Counterevidence
description: Killing your own findings before someone else does.
agents: static, triage, scribe, planner
tags: quality, false-positives
---

# Counterevidence

The default failure mode of an LLM tester is a confident finding that dies on
contact. Run this list before you write "confirmed".

## Kill list

- Is the source actually attacker-controlled, or a constant or compile-time
  string?
- Is there a check between source and sink: `snprintf`, `strncpy`, a length
  clamp, a regex, framework escaping, a parameterized query?
- Is the code reachable? Dead branch, `#if 0`, test-only file, debug route behind
  `if (DEBUG)`.
- Does the sink run with privileges that matter, or inside a sandbox?
- Is the crash in target code, or in the harness that wraps it? Check the frame.

## Severity calibration

- Crash in a debug build with no demonstrated control: low or medium, and say so.
- Controlled write to a return address or function pointer: critical, with the
  offset.
- Auth bypass demonstrated with two accounts: high. The same request replayed
  with one account proves nothing.
- Never raise severity to make a finding feel worth reporting.

## Writing the negative

A killed candidate is a result. Record what you tested, what you expected, what
actually stopped it, and at which line. That saves the next agent the same hour.
