---
name: Authenticated web sessions
description: Keeping a login alive while probing, so a finding is not just a 302.
agents: scout, hunter, triage
tags: web, auth, idor
---

# Authenticated web sessions

The interesting bugs live behind a login. A probe that returns `302 -> /login`
tells you nothing about the app.

## First contact

- Probe `/` and one protected path unauthenticated. Record both.
- Find the login surface: form action, `/api/login`, `/auth`, `/session`.
- Send one login with the credentials in scope.
- If the response sets a cookie, every later probe must carry that session.

## Keeping it alive

- Use a named session in `http_probe` (`session: "acme"`). It keeps cookies and
  headers across calls.
- On 401, 403, or a redirect to the login page, re-authenticate once, then retry.
  Never loop on it.
- CSRF: read the token out of the form and send it in the body with the same
  cookie.
- Write the session name into the ledger so a fresh agent can resume.

## What to test once authenticated

- IDOR: swap object ids between two accounts, not just one
- Privilege: the same request as a lower-privileged user
- Write paths: anything that reaches a file, a command, a template, a
  deserializer

## Validation

A finding needs the authenticated request *and* the difference from the
unauthenticated one. Both, side by side.
