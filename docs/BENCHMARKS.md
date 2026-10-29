# Benchmarks

How to measure the room against an external suite, and how to build a small
regression set of your own.

## What the suites measure

| suite | shape | proof of success |
|---|---|---|
| challenge sets (CTF-style web apps) | one primary bug on a flag path, plus decoys | the flag, captured end to end |
| multi-host ranges | entry service → pivot → internal hosts | marker files proving a shell at a given privilege |
| known-answer codebases | a real project with a fixed CVE | a sanitizer-confirmed crash receipt |

The third one is the cheapest high-signal test you can run today: point `hunt` at
a pinned revision of a real project **whose bug you already know**, and check
that it lands on the same function with a crash. That is a regression test for
the harness, not a novelty claim — and it is the only way to tell whether a
pipeline change made the agent better or just louder.

## Running against a suite

Two ways in, both over the same API:

1. **Through the MCP server.** Any harness that speaks MCP gets `arachne_hunt`,
   `arachne_ask`, `arachne_diff` and `arachne_verify`. For a harness that does
   its own orchestration, this is the smallest integration surface.
2. **Through the CLI.** `arachne hunt <target>` with `--json` emits one event
   per line, so a scorer can consume findings without parsing prose:

```bash
arachne --json hunt ./target | jq -r 'select(.type=="finding") | "\(.finding.status) \(.finding.cwe)"'
```

A challenge is a directory with a target and an objective. The room already
produces the two things a scorer needs: findings with a status that cannot be
self-assigned, and a report file.

## Writing your own challenge

```jsonc
// challenges/001-asan-rewrite/challenge.json
{
  "name": "stack overflow in a log parser",
  "target": "fixtures/vuln",
  "objective": "produce a sanitizer-confirmed crash",
  "verify": { "finding": { "status": "confirmed", "cwe": "CWE-121" } },
  "budget": { "seconds": 600 }
}
```

Score on **objective capture**, not on prose: did a `confirmed` finding appear
with the expected CWE, inside the budget. Two rules keep it honest:

- **Decoys.** Put a plausible wrong sink in the target. An agent that reports it
  as confirmed has failed, even if it also found the real one.
- **Negative controls.** One challenge with no bug at all. The correct output is
  "nothing confirmed"; anything else is a false positive, which is worse than a
  miss.

## What is now scored

The three gaps that made previous numbers meaningless are closed:

- **Web authorization** has a bundled target with two accounts, an object graph
  and a decoy (`bench/`), scored on a confirmed CWE-639.
- **Post-exploitation** is modeled as a chain: `access_gain` records a reach, its
  credential and its evidence, and the pivot challenge scores the flag from an
  internal service that only the leaked key unlocks.
- **Cost and time per finding** come from the campaign: turns, tokens, cost,
  wall time, time to first confirmed, and cost per confirmed.

## Still out of scope

- **Multi-host ranges.** The pivot here is two local services, not an enterprise
  range with several subnets. A real range needs containers and network
  namespaces, which is a separate project.
- **Scoring the agent's restraint.** Decoys are checked but not yet scored; a
  false positive should cost more than a miss.
- **Reproducibility across models.** Results are per run; there is no comparison
  table yet.
