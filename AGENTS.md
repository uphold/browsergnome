# AGENTS.md

Vendor-neutral instructions for coding agents working in this repo. Claude Code should read
`CLAUDE.md` instead — it has the same facts plus Claude-specific wiring (skills, hooks, MCP setup).

## What this repo is

browsergnome is a **Claude Code plugin**, not an application. Most of its behavior is Markdown read at
runtime by an LLM agent; the `.mjs` files are the deterministic, offline half.

- `skills/browsergnome/SKILL.md` — the orchestrator spec: menu, propose→measure→keep/revert loop, gate
  math, presets, `.bgn/config.json` defaults, reference index.
- `skills/browsergnome/references/` — read-on-demand context: `tools.md`, `presets.md`,
  `measurement.md`, `perf-map.md`, `senior-audit.md`, `what-if.md`, `knowledge/`, and three stack-axis
  catalogs (`frameworks/`, `bundlers/`, `hosts/`).
- `skills/browsergnome/scripts/*.mjs` — pure, offline, self-testing tools. No framework, no runtime
  browser dependency, no shared util module. Each script is standalone except one ESM import edge
  (`lcp_attribution.mjs` imports parser functions from `trace_metrics.mjs`/`bundle_stats.mjs`, guarded
  by a `pathToFileURL(process.argv[1])` check so importing doesn't also fire the CLI).
- `commands/`, `hooks/hooks.json`, `.mcp.json`, `.claude-plugin/` — Claude Code plugin wiring; not
  relevant to a non-Claude agent working on the `.mjs` scripts or docs.
- `templates/ci/` — GitHub Actions templates for running Autoresearch unattended in a *target* repo.

**Two-repo model.** At runtime the working directory is the *target* web repo being optimized, not
this one. Scripts resolve against `$CLAUDE_PLUGIN_ROOT`, and `.bgn/` (config, ledger, perf-memory,
playbook) is written into the **target** repo, never this one.

## Commands

No build step, no linter, no test framework beyond the scripts' own self-tests.

```bash
npm install          # @babel/parser + @babel/traverse, needed only by perf_scan.mjs
npm test             # all six self-tests, chained
node skills/browsergnome/scripts/stats.mjs --self-test   # a single self-test, directly
```

CI (`.github/workflows/ci.yml`) runs `npm test` plus an offline smoke chain (`lcp_attribution.mjs` →
`build_lcp_map.mjs`, `build_run_report.mjs`) and `claude plugin validate . --strict`.

## Cross-file invariants

These have no single source of truth; an edit to one side silently breaks the other.

- **chrome-devtools-mcp pin** appears in `.mcp.json`, `references/tools.md`, and `doctor.mjs`'s
  self-test fixtures. Bump all three together; never use `@latest`.
- **Stack-catalog filenames** under `references/frameworks|bundlers|hosts/` must match
  `doctor.mjs`'s detector return strings verbatim.
- **All product-facing docs** (`README.md`, `docs/pages/`, `SKILL.md`, `references/`) read as one
  confident, unhedged voice — no validation-status narration, no dev-diary voice, no local-machine
  specifics. Facts stay accurate; nothing editorializes about whether something was confirmed to work.
- **Perf Map calibration** — `.github/workflows/pages.yml`'s `EXCALIDRAW_SHA` is pinned to the commit
  `references/perf-map.md`'s calibration note (527 modules / 16 hotspots) was measured against.

## Project rules

- **Don't claim something works that doesn't.** `/bisect` is not built — say so plainly, don't guess
  its behavior. State what's built and what isn't as plain fact, same unhedged voice as the docs.
- **Never tune `perf_scan.mjs`'s `CONFIG` against a fixture** — it's circular by construction. Use a
  real cloned OSS app.
- **Never use `lighthouse_audit` for the gate** — it excludes performance. Route measurement through
  `performance_start_trace`.
- **Never `git add -A`** in the propose→measure→gate loop; stage only the touched paths.
- **Knowledge-base status tiers** (`proven` / `documented` / `ungated hypothesis` / `dead end`) in
  `references/knowledge/` require a real measured before/after to upgrade. A citation is not a
  measurement.
- Node ≥ 18, ESM throughout. The only runtime deps are `@babel/parser` + `@babel/traverse`.

## Full detail

`CLAUDE.md` in this same directory carries everything above plus the script pipeline diagram and
Claude-Code-specific wiring (skills, hooks, MCP). Read it for anything this file doesn't cover.
