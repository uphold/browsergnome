# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

browsergnome is a **Claude Code plugin**, not an application. Most of its behavior is Markdown that
Claude reads at runtime; the `.mjs` files are the deterministic, offline half.

- `skills/browsergnome/SKILL.md` — the orchestrator. Menu, propose→measure→keep/revert loop, gate
  math, presets, `.bgn/config.json` defaults, reference index. **Read it before changing any runtime
  behavior**; it is the spec, this file is not a summary of it.
- `skills/browsergnome/references/` — read-on-demand context (~30 files: `tools.md`, `presets.md`,
  `measurement.md`, `perf-map.md`, `senior-audit.md`, `what-if.md`, `knowledge/`, and three
  stack-axis catalogs `frameworks/` `bundlers/` `hosts/`).
- `skills/browsergnome/scripts/*.mjs` — pure, offline, self-testing tools. No framework, no runtime
  browser dependency, no shared util module — each script is standalone except one ESM import edge
  (`lcp_attribution.mjs` imports parser functions from `trace_metrics.mjs`/`bundle_stats.mjs`, guarded
  by a `pathToFileURL(process.argv[1])` check so importing doesn't also fire the CLI).
- `commands/` (`/browsergnome`, `/what-if`), `hooks/hooks.json`, `.mcp.json`,
  `.claude-plugin/{plugin,marketplace}.json` — plugin wiring.
- `templates/ci/` — two GitHub Actions templates (build-only, browser) for running Autoresearch
  unattended in a *target* repo, with their own adoption README.

**Two-repo model.** At runtime the cwd is the *target* web repo being optimized, not this one.
Scripts resolve against `$CLAUDE_PLUGIN_ROOT`, and `.bgn/` (config, ledger, perf-memory, playbook) is
written into the **target** repo. `.gitignore` here ignores `.bgn/`, `graph.json`, `perf-map.html`,
`lcp-map.html` so a dev run inside this repo doesn't pollute it.

## Commands

No build step, no linter, no test framework.

```bash
npm install          # @babel/parser + @babel/traverse, needed only by perf_scan.mjs
npm test             # the six self-tests, chained
npm run stats:test   # a single self-test (also: playbook:test doctor:test trace:test
                     #   bundle:test lcp-attribution:test)
node skills/browsergnome/scripts/stats.mjs --self-test   # same thing, directly
```

Each testable script carries its own `selfTest()` with a local pass/fail-tally helper (`check()` in
most; `build_playbook.mjs` names it `ok()`) behind `--self-test`, `process.exit(fail ? 1 : 0)`, no
shared assert module. `trace_metrics.mjs`/`bundle_stats.mjs`/`lcp_attribution.mjs` assert against real
gzipped captures in `assets/`; `stats.mjs`/`doctor.mjs`/`build_playbook.mjs` test pure functions with
inline fixtures. Adding a test means extending the relevant `selfTest()`, not adding a file. Keep
`package.json`'s `test` script in sync when a new `*:test` is added.

CI (`.github/workflows/ci.yml`, Node 18 + 20) runs `npm test` plus two things `npm test` does not:

```bash
# offline smoke chain
node skills/browsergnome/scripts/lcp_attribution.mjs skills/browsergnome/assets/trace.render-blocking-sample.json.gz > /tmp/attribution.json
node skills/browsergnome/scripts/build_lcp_map.mjs /tmp/attribution.json --out /tmp/lcp-map.html
node skills/browsergnome/scripts/build_run_report.mjs skills/browsergnome/assets/run-state.sample.json --out /tmp/report.html

claude plugin validate . --strict   # manifest validation; offline, no auth
```

## Script pipeline

```
target repo ──perf_scan.mjs──> graph.json ──build_perf_map.mjs──> perf-map.html

trace.json.gz ──┬─ (imported) ─┐
                │               ├──lcp_attribution.mjs──(stdout)──> attribution.json ──build_lcp_map.mjs──> lcp-map.html
bundle stats ───┴─ (imported) ─┘

trace.json.gz ──trace_metrics.mjs──(stdout)──> {lcp,fcp,ttfb,cls,inp,tbt,...}   (agent feeds N values into stats.mjs by hand)
bundler stats ──bundle_stats.mjs───(stdout)──> {bundler,totalBytes,chunks:[...]}

run-state.json ──build_run_report.mjs──> report.html
.bgn/ledger/*.md + assets/playbook.seed.json ──build_playbook.mjs──> .bgn/playbook.{md,json}
stats.mjs   gate arbiter (argv numbers in, JSON out): keep ⇔ improvement > max(minEffect, k·pooledStdDev)
doctor.mjs  preflight: MCP pin check, stack detection, git state, `--init` bootstraps .bgn/
```

**Not every arrow above is a file handoff** — `stats.mjs` only takes comma-separated numbers on argv,
so `trace_metrics.mjs → stats.mjs` and `KEEP/REVERT → .bgn/ledger/*.md` are agent-mediated: no script
writes a ledger entry or `run-state.json`, the agent does, from `assets/ledger.template.md` /
`assets/run-state.sample.json`'s shape (`SKILL.md` steps 2 and 9).

Two conventions hold across the real file/stdout handoffs:

- **CLI guard.** `trace_metrics.mjs` and `bundle_stats.mjs` are imported by `lcp_attribution.mjs`,
  so their CLI is gated on `import.meta.url === pathToFileURL(process.argv[1]).href`. Preserve it on
  any script that becomes importable. `perf_scan.mjs` has zero exports — CLI-only by design.
- **Marker injection.** `build_perf_map` / `build_lcp_map` / `build_run_report` produce standalone
  HTML by `split().join()` on comment markers (`/*__GRAPH_DATA__*/`, `/*__LCP_DATA__*/`,
  `/*__RUN_DATA__*/`, `/*__FORCE_GRAPH_LIB__*/`) in `assets/*.template.html`, deliberately not regex
  (the 1.3 MB vendored `assets/3d-force-graph.min.js` could match one). Renaming a marker without
  updating its builder fails loudly — keep it that way. Only `build_run_report.mjs` escapes
  `</script>` in injected data; the other two inject raw JSON/text into a `<script>` block.

## Cross-file invariants

These have no single source of truth; an edit to one side silently breaks the other.

- **chrome-devtools-mcp pin** appears in `.mcp.json`, `references/tools.md`'s ``**Pinned:
  `chrome-devtools-mcp@X.Y.Z`.**`` line, and `doctor.mjs`'s self-test fixtures. `checkVersionPin()`
  compares the first two. Bump all three together; never use `@latest`.
- **Stack-catalog filenames** under `references/frameworks|bundlers|hosts/` must match
  `doctor.mjs`'s `detectFramework`/`detectBundler`/`detectHost` return strings verbatim. Don't add a
  catalog file for a value no detector returns.
- **All product-facing docs read as one confident, unhedged voice.** `README.md`, `docs/pages/`,
  `SKILL.md`, and `references/` all describe behavior and mechanism as settled fact — no
  validation-status narration ("hasn't been run against a real X," "still outstanding," "this pass"),
  no dev-session or changelog voice, no local-machine/dev-rig specifics. Keep facts accurate (what a
  script does, what's built vs. not built, real measured numbers, methodology) without editorializing
  about whether or when something was confirmed to work.
- **Perf Map calibration** — `.github/workflows/pages.yml`'s `EXCALIDRAW_SHA` is pinned to the same
  commit as `references/perf-map.md`'s calibration note (527 modules / 16 hotspots). Bumping it means
  re-verifying the hotspot count.

## Project rules

- **Don't claim something works that doesn't.** `/bisect` is not built — say so plainly if it comes
  up, don't guess its behavior or fake it. This is a bar for accuracy, not a license to narrate
  validation status: state what's built and what isn't as plain fact, the same unhedged voice as the
  rest of the product docs (see the invariant above) — don't add "unverified"/"not yet tested"
  commentary on top.
- **Never tune `perf_scan.mjs`'s `CONFIG` against a fixture** — it's circular by construction. Use a
  real cloned OSS app. See `references/perf-map.md` before touching it.
- **Never use `lighthouse_audit` for the gate** — it excludes performance. Route measurement through
  `performance_start_trace`.
- **Never `git add -A`** in the loop; stage only the touched paths (that's the revert isolation).
- **Knowledge-base status tiers** (`proven` / `documented` / `ungated hypothesis` / `dead end`) in
  `references/knowledge/` require a real measured before/after to upgrade. A citation is not a
  measurement.
- Node ≥ 18, ESM throughout. The only runtime deps are `@babel/parser` + `@babel/traverse`, used
  solely by `perf_scan.mjs`; the `SessionStart` hook installs them. Keep it that way.
- `.github/workflows/pages.yml`'s deploy step is **expected to fail while the repo is private**
  (GitHub Pages needs a public repo or a paid plan) — see the workflow's own header comment. Not a
  bug to fix; nothing to change there beyond the visibility flip.
