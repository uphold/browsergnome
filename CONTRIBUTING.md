# Contributing

## Maintenance

No formal SLA. If a PR or issue goes unanswered, open a GitHub issue on this repo to flag it; if that
also goes unanswered, escalate to the `uphold` org owners.

## Setup

```bash
git clone https://github.com/xavi-999/browsergnome
cd browsergnome
npm install   # @babel/parser + @babel/traverse, used only by perf_scan.mjs
```

No build step. Node ≥ 18, ESM throughout.

## Running the tests

```bash
npm test                 # self-tests + the invariants check, chained
npm run stats:test       # a single self-test suite (also: playbook:test doctor:test trace:test
                          #   bundle:test lcp-attribution:test invariants:test)
npm run invariants       # the invariants check itself (not a self-test — asserts this repo's own
                          #   files agree; see "Cross-file invariants" below)
```

`ci.yml` runs this same `npm test` chain on Node 18 and 20 for every PR and push to `master` — the
per-script `selfTest()`s aren't an untested side-channel, they gate merges.

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

`npm run invariants` (part of `npm test`) mechanically checks four of these — the chrome-devtools-mcp
pin, the stack-catalog filenames, the `depPulse`/`depPulseAutoApply` config keys, and the Perf Map
calibration SHA — and fails the build on drift. Two invariants stay a manual review responsibility,
because a script can't meaningfully check them: the "one confident, unhedged voice" rule across
product docs is editorial, not mechanical; and the `Guidance:` ids resolve against the external
`modern-web-guidance` catalog, which isn't installed in CI.

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
