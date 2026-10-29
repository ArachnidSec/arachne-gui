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

## What we currently measure poorly

- **Web authorization** is provable (`http_diff`) but not yet scored — there is
  no bundled target with two accounts and an object graph.
- **Post-exploitation** is out of scope: the room reads code and builds
  harnesses; it does not pivot between hosts.
- **Cost and time per finding** are tracked per turn but not per campaign.

Those are the three numbers worth adding before quoting any success rate.
