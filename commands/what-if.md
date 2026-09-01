---
name: what-if
description: Measure a bounded, reversible "what if we changed X" experiment through the real gate — always reverts, produces a decision memo, never a commit. Distinct from Autoresearch (which keeps a fix on KEEP); use this to answer "is this worth doing at all" rather than "is this fix real".
argument-hint: "<bounded change to test> e.g. \"what if we deferred the Segment tag\" | \"what if we lazy-loaded the chart library\""
---

`/what-if` reuses browsergnome's whole measure→apply→re-measure→gate loop, with one difference:
it **always reverts**, KEEP or REVERT, and reports a decision memo instead of committing. Read `${CLAUDE_PLUGIN_ROOT}/skills/browsergnome/SKILL.md`'s Autoresearch section for the shared
measurement machinery, then `${CLAUDE_PLUGIN_ROOT}/skills/browsergnome/references/what-if.md` for
this command's specific protocol (scratch branch, always-revert guarantee, memo format, and the
framework-migration refusal rule) — read `what-if.md` in full before running, don't guess at the
protocol from the table above.

ARGUMENTS: $ARGUMENTS

Routing:
- **No arguments** → ask what bounded change to test. Don't guess a scenario unprompted.
- A scenario matching `what-if.md`'s buildable list (defer/remove a third-party script, toggle the
  React Compiler, make a route static, lazy-load a dependency, swap a dependency) → run the protocol
  in `what-if.md` directly.
- **A framework/bundler migration** (Next→Vite, webpack→Rspack, or similar) → refuse per
  `what-if.md`'s refusal rule and explain why, rather than attempting to estimate it.
- Anything else that's a genuinely bounded, reversible, one-file-scale change not on the buildable
  list → treat it the same way as a listed scenario (the list in `what-if.md` isn't exhaustive), but
  confirm with the user in one line what preset (`first-load`/`bundle-size`/`interaction`) the change
  should be measured through before starting.

Note: if running scripts outside a Claude session, run `npm install` in the plugin root first.
