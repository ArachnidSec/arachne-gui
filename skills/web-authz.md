---
name: Authorization campaigns (IDOR / BOLA)
description: Proving that one identity can reach another identity's object, with a differential and a receipt.
agents: scout, static, hunter, triage, planner
tags: web, idor, bola, cwe-639
---

# Authorization campaigns

A 403 is not a finding and a 200 is not a finding. The finding is: **identity B
receives identity A's object**, and you can show both requests side by side.

## Setup: two identities, two sessions

Never test authorization with one account.

- Pick two accounts you control on the target, ideally same role (`alice`,
  `bob`).
- Log in each one into its own named session:
  `http_probe {url: "/login", method: "POST", body: "...", session: "alice"}`
  then the same for `bob`. A successful login sets a cookie; verify with a
  probe to a protected page in the same session.
- Write both sessions to the ledger. A fresh agent must be able to resume.

## Method

1. As `alice`, create or read an object you own. Note the identifier:
   `/orders/8412`, `?user=alice`, `{"accountId": "a_551"}`, an upload key.
2. As `bob`, request **the same identifier**, not your own. That is the whole
   test: B asking for A's object id.
3. Compare with `http_diff {expect: "same", a: {url: "/orders/8412", session: "alice"}, b: {url: "/orders/8412", session: "bob"}}`.
   `expect: "same"` is the BOLA shape: if bob receives alice's response
   verbatim, that is the leak. Use `expect: "different"` for a bypass where the
   control is a 403 and the test is a 200. Volatile tokens are stripped first,
   so a timestamp is not a finding and a real leak is.
4. Run it a second time. The second matching run promotes `reproduced` to
   `confirmed` — the same two-run rule the native harness uses.
5. Record the object ids and the two request lines in the finding.

## Variants worth trying

- **BOLA on writes**: `PUT /orders/8412` as bob. A 200 that mutates is worse
  than a read.
- **Horizontal → vertical**: same request with a low-privileged token against an
  admin route.
- **Id substitution**: numeric ids, uuids, base64 of the same, `?id[]=1&id[]=2`
  array injection.
- **Tenant header**: `X-Org`, `X-Tenant-Id`, subdomain.
- **Mass assignment**: send `role: "admin"` or `isAdmin: true` in a profile
  update and see whether it sticks.

## Negative control

Once per campaign, send a request that **should** be identical for both
identities (a public product page) with `expect: "same"` and check that it does
not become a finding. Then send one that should differ and confirm it does. If
the pair behaves the wrong way round, your sessions are mixing and every other
result is suspect.

## What to report

- the object id, the two identities, both request lines
- the exact field that leaked (name, email, address, token)
- whether the same request writes
- severity: read-only leak of non-sensitive fields is medium; another user's
  credentials, tokens, or write access is high to critical
