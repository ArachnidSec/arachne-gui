---
name: Memory-corruption RCE
description: Turning a candidate sink into proven control-flow hijack, not just a crash.
agents: static, hunter, triage
tags: rce, cwe-121, cwe-122, cwe-416
---

# Memory-corruption RCE

A crash is a bug. RCE is a write you control landing somewhere that decides
execution. The distance between those two is the entire job.

## Attack surface

- argv, stdin, file parsers, network reads, environment variables
- destinations: fixed stack arrays, heap chunks, struct fields adjacent to
  function pointers, length-prefixed structures
- lengths: `strlen(argv[i])`, a header length field, `count * size`, a signed
  value that goes negative

## Methodology

1. Find the copy. Note the destination size and the exact expression used for
   the length.
2. Ask what the attacker controls: bytes only, or the length too. Length control
   is what turns an overflow into an arbitrary write.
3. Build the harness against the same door the real binary uses. Never patch the
   target's source.
4. Grow the input geometrically until the sanitizer reports. Record the offset
   between the start of the write and the red zone.
5. Classify the primitive: linear overflow, out-of-bounds index, use-after-free,
   double free, type confusion.

## Proving control, not just a crash

- A canary hit is not RCE. Say "stack overflow, canary reached, control not
  demonstrated".
- Check the build: stack canary, PIE/ASLR, NX, RELRO. On macOS `otool -hv` and
  `nm`; on Linux `readelf -h` and `readelf -l`.
- If a saved return address or a function pointer sits inside the overwrite
  distance, say so and give the byte offset.
- If a mitigation blocks it, name the mitigation and what a bypass would need.

## Validation

- Reproduce twice: same signature, same frames.
- A one-byte-past-the-boundary input is stronger evidence than 500 bytes — it
  shows the boundary rather than proving the program is fragile.
- The exact command goes into the finding. If it cannot be pasted and re-run, it
  is not a finding yet.
