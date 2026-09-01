# Contributing

browsergnome is a single-maintainer project. Response times on issues and PRs vary — bear with it.

## Setup

```bash
git clone https://github.com/xavi-999/browsergnome
cd browsergnome
npm install   # @babel/parser + @babel/traverse, used only by perf_scan.mjs
```

No build step. Node ≥ 18, ESM throughout.

## Running the tests

```bash
npm test                 # all six self-tests, chained
npm run stats:test       # a single suite (also: playbook:test doctor:test trace:test
                          #   bundle:test lcp-attribution:test)
```

Each testable script carries its own `selfTest()` behind `--self-test`, with a local pass/fail-tally
helper (`check()` in most; `build_playbook.mjs` names it `ok()`) and `process.exit(fail ? 1 : 0)` — no
shared assert module. Adding a test means extending the relevant `selfTest()`, not adding a file.
`trace_metrics.mjs`, `bundle_stats.mjs`, and `lcp_attribution.mjs` assert against real gzipped captures
in `skills/browsergnome/assets/`; `stats.mjs`, `doctor.mjs`, and `build_playbook.mjs` test pure
functions with inline fixtures.

Also run before opening a PR that touches `.claude-plugin/`, hooks, or command wiring:

```bash
claude plugin validate . --strict
```

## Code style

Match the surrounding code. Keep comments minimal — write code whose structure and naming carry the
meaning; comment only where the *why* isn't otherwise recoverable (a non-obvious constraint, a
verified-against-a-real-capture provenance note, a deliberate simplification). See any script under
`skills/browsergnome/scripts/` for the house style.

Read `CLAUDE.md` before changing runtime behavior — it documents the cross-file invariants (the
chrome-devtools-mcp version pin, the stack-catalog filenames, the perf-map calibration numbers) that
have no other single source of truth and silently drift if only one side of an edit lands.

## Proposing a change

1. Branch off `master`.
2. Make the change. If it touches a script in `skills/browsergnome/scripts/`, extend that script's
   `selfTest()` to cover it.
3. `npm test` must pass. If you touched plugin wiring, `claude plugin validate . --strict` must pass too.
4. Open a PR against `master` describing what changed and why.

Keep `package.json`'s `test` script in sync if you add a new `*:test` entry.

## Reporting a bug

Include: what preset/command you ran, the repo/framework you ran it against, and the actual vs.
expected output. For a gate or measurement issue, include the raw numbers (`stats.mjs`'s output), not
just the KEEP/REVERT decision.
