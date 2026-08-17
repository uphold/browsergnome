---
name: browsergnome
description: Autonomous, scientific web performance optimization via a propose -> measure -> keep/revert loop. Use this WHENEVER a web app is slow — poor LCP/CLS/INP, a bloated JS bundle, layout shift, or sluggish interactions — even if the user never says "browsergnome" or the word "performance". Also use it to build an interactive 3D Perf Map of a web repo (Next.js, Remix, Vite SPA, etc.) or surface the worst perf offenders. Scope is web only — for React Native / Expo, use metrognome instead.
---

# browsergnome

browsergnome is the web twin of `metrognome`: propose one fix → measure N times → keep only if the gain
beats the measurement noise, else revert. Git is the memory; per-iteration commits enable auto-revert.
It delegates measurement to `chrome-devtools-mcp` and owns the loop, gate, Ledger, Memory, Playbook, and
Perf Map that no measurement tool provides on its own.

Perf Map 3D, the LCP Attribution Map, the knowledge base, the seeded playbook, Doctor, Dep Pulse, and
all four Autoresearch presets (`first-load`, `bundle-size`, `interaction`, `layout-shift`) are usable
today.
`layout-shift`'s gate method (`stats.mjs`'s `gateOccurrence()`) runs a Fisher's-exact test on
shift-occurrence rate for the bimodal case where the plain gate doesn't apply — see
`references/presets.md`'s entry and `references/measurement.md`'s worked example for the numbers. See
"Autoresearch" below for what that means in practice. The LCP Attribution Map (`references/perf-map.md`'s
"Attribution confidence" section) has a data layer (`scripts/lcp_attribution.mjs`) and a rendering layer
(`scripts/build_lcp_map.mjs` + `assets/lcp-map.template.html`) — there is no menu item for it, it's
invoked directly (see "LCP Attribution Map" below), the same way Perf Map 3D's scripts are.
`/bisect` ("which of the last N commits regressed LCP") needs its own protocol (checkout-and-build per
bisection step, not the existing loop's file-snapshot-restore) and is not built.

## Scope & delegation (don't reinvent measurement)

This skill owns the menu, loop, gate, Ledger, Memory, and Perf Map. **Measurement is delegated** to one
MCP server, pinned in `.mcp.json` — never call it via `@latest`, and re-verify the pin if a tool call
comes back with an unexpected shape:

| Need | Tool |
|---|---|
| Throttle CPU/network, set viewport/UA/geolocation | `emulate` |
| Capture a performance trace (LCP/CLS/INP source events) | `performance_start_trace` / `performance_stop_trace` / `performance_analyze_insight` |
| Network requests, JS eval, page snapshot, navigation, form/click interaction | `list_network_requests`, `get_network_request`, `evaluate_script`, `take_snapshot`, `navigate_page`, `click`, `type_text`, `hover`, `fill`, `fill_form`, `wait_for` |
| JS heap snapshot | `take_heapsnapshot` (only memory primitive on the pinned version — no compare/retainers, so `memory-leaks` stays deferred) |

**Never use `lighthouse_audit` for the gate** — it explicitly excludes performance; route perf
measurement through `performance_start_trace`. Full current tool surface, exact params, and what's
confirmed absent: **`references/tools.md`** — read it before invoking any tool.

## The menu

**Rule:** if AskUserQuestion is available, use it; otherwise print a numbered Markdown menu and wait.

Bare invocation → present the top menu:

1. **Perf Map 3D** — static repo scan → interactive 3D map → Top-3 fixes. **Works today.**
2. **Autoresearch** — pick a preset, run the propose→measure→keep/revert loop. **`first-load`,
   `bundle-size`, `interaction`, and `layout-shift` work today** — offer all four. For `layout-shift`
   specifically, check the target's baseline shift-occurrence rate first (`references/presets.md`'s
   entry) — the gate needs roughly ≥40% before n=10 runs/arm can detect a fix; say so plainly and fall
   back to Perf Map 3D if a pilot capture shows the target is below that, rather than running a loop the
   gate can't discriminate for.
3. **Doctor** — verify the chrome-devtools-mcp pin, detect framework/bundler/host, check git state,
   bootstrap `.bgn/`. **Works today.**
4. **Configurations** — view/edit `.bgn/config.json`. **Works today** (Doctor bootstraps it).
5. **Senior Engineer Audit** — holistic scan for architectural debt (RSC boundary placement,
   provider nesting, waterfall data fetching, shared layout bloat) that mechanical detectors miss,
   then a choose-and-fix flow through the existing measure→gate loop. **Works today.**

**Skip the menu when intent is explicit.** A scan/map request ("build a perf map of this repo", "what
are the worst perf offenders here") → go straight to Perf Map 3D. "Fix my LCP" / "the homepage is slow
to load" → `first-load`. "Shrink my bundle" / "my JS is too big" → `bundle-size`. "My INP is bad" / "the
UI feels laggy when I click X" → `interaction`. "Fix my CLS" / "content keeps jumping" → `layout-shift`
(check the target's baseline shift-occurrence rate first, per `references/presets.md`'s entry — below
~40% at n=10, say so and offer Perf Map 3D instead). A holistic/architectural ask ("what's
architecturally wrong here", "do a senior-level review") → Senior Engineer Audit.

## Locating scripts

`$CLAUDE_PLUGIN_ROOT` is set inside a plugin session — resolve scripts against it, not against the
current working directory (the cwd is the *target* repo being scanned, not this plugin's repo):

```bash
BG="${CLAUDE_PLUGIN_ROOT:-.}"   # falls back to repo-root-relative for dev/test inside this repo itself
# e.g.  node "$BG/skills/browsergnome/scripts/perf_scan.mjs" <target-repo> --out graph.json
```

Not published to npm — there is no `npx browsergnome@latest` fallback; install as a Claude Code plugin.

**Dependencies:** `perf_scan.mjs` requires `@babel/parser`/`@babel/traverse`. The `SessionStart` hook
installs them automatically inside a Claude Code session; for by-hand use, `npm install` in
`$CLAUDE_PLUGIN_ROOT` first.

## Perf Map 3D (the diagnose→fix bridge — works today)

A static scan — no browser needed. Steps:

```bash
# 1. scan the target web repo -> graph.json (Babel AST + perf-debt scoring, 14 web detectors)
node "$BG/skills/browsergnome/scripts/perf_scan.mjs" <repo-or-src-path> --out graph.json

# 2. merge into a single standalone HTML (vendored 3d-force-graph + data inlined)
node "$BG/skills/browsergnome/scripts/build_perf_map.mjs" graph.json --out perf-map.html --open
```

Then open `perf-map.html` (`--open` does it; otherwise `open perf-map.html`). Node **size = perf debt**,
**color = severity** (red CRITICAL / orange HIGH / yellow MEDIUM / grey below-gate). A search box jumps
to any module by name; clicking a node shows the flaw, `file:line`, and the matching knowledge-base
entry. **Present `top3` (from graph.json or printed) as candidate fixes** — hand LCP-flavored ones to
`first-load` Autoresearch directly; for everything else, cite `references/knowledge/` for the fix
pattern until the matching preset exists.

The 14 detectors, scoring, and signal-vs-noise gating (why most nodes stay grey) are in
**`references/perf-map.md`** — including the `barrelImport` calibration carve-out; read that section
before touching `perf_scan.mjs`'s `CONFIG` block. **Never tune `CONFIG` against a fixture** — always a
real cloned OSS app; the fixture is circular by construction.

React Compiler suppression: `listRowNoMemo`/`inlinePropLiteral` are auto-suppressed when
`babel-plugin-react-compiler` or `experimental.reactCompiler`/`reactCompiler:true` is detected in config
(string-matched, never executed). `--no-compiler-detect` disables this for calibration.

## LCP Attribution Map (works today, no menu item)

A different, stricter surface than Perf Map 3D: node size is a **measured millisecond** from a real
trace, not a heuristic score. Needs a live capture, so it's invoked directly rather than through the
menu:

```bash
# 1. attribute a captured trace (+ optional bundle stats) -> attribution.json
node "$BG/skills/browsergnome/scripts/lcp_attribution.mjs" <trace.json[.gz]> [bundle-stats.json[.gz]] > attribution.json

# 2. merge into a standalone HTML (vendored 3d-force-graph + data inlined)
node "$BG/skills/browsergnome/scripts/build_lcp_map.mjs" attribution.json --out lcp-map.html --open
```

Node color = class (network/chunk/module); opacity = confidence (solid **measured**, translucent
**apportioned**) — both explained in the legend and on click. No bundle stats (Vite, Turbopack) degrades
to a chunk-only render, shown as a first-class banner, not an error. Full data-layer detail — confidence
tiers and the apportionment math — in `references/perf-map.md`'s "Attribution confidence" section.

## Knowledge base

`references/knowledge/INDEX.md` — symptom → file table, ~65 lines, always read first. Leaf topics
(`lcp.md`, `cls.md`, `inp.md`, `bundle.md`, `fonts.md`, `images-media.md`, `caching.md`,
`hydration-rsc.md`, `third-party.md`, `css.md`) are read **only** on a symptom match. Each entry is
`When` / `Do` / `Evidence` with a status tier: `proven` (measured before/after) / `documented`
(sourced, mechanism-verified, no measured delta) / `ungated hypothesis` (speculative) / `dead end`
(tried, didn't clear the gate), plus an optional `Guidance: <id>` line citing a `modern-web-guidance`
guide — see `INDEX.md`'s "Upstream guidance" section for the full contract (present/absent behavior,
Baseline-block use). A citation is not a measurement — don't upgrade an entry's tier without a real
before/after number.

## Seeded playbook

```bash
# .bgn must already exist (run Doctor first) — this is where playbook.md/playbook.json get written
node "$BG/skills/browsergnome/scripts/build_playbook.mjs" .bgn
```

Renders `assets/playbook.seed.json`'s 12 curated priors (5 proven wins, 4 dead ends, 3 ungated
hypotheses), each tagged `source: 'seeded'`, in visually separate sections from any `measured` (ledger-
derived) rows — so a hand-authored prior never masquerades as evidence from the user's own repo. Once a
`first-load` run has written to `.bgn/ledger/`, this same script merges both automatically.

## Doctor (menu item 3 — works today)

```bash
node "$BG/skills/browsergnome/scripts/doctor.mjs" --url <target-repo's dev/preview URL> --init
```

Reports (never crashes on a failed check — prints and continues): Node version, whether `.mcp.json`'s
chrome-devtools-mcp pin agrees with `references/tools.md`'s documented pin (a static config-consistency
check — it **cannot** verify the live tool surface, since that needs an actual MCP call; if a tool
returns an unexpected shape mid-run, that's the live-drift signal, not this check), git state (via
`parseGitState` — four states: `usable`/`no-repo`/`no-commits`/`detached`), the three stack axes (framework/bundler/host — unknown on any axis is fine, falls back to
the generic knowledge base), whether the `modern-web-guidance` plugin is installed (nudges
`/plugin install modern-web-guidance@googlechrome` if not — see the Knowledge base section above), and
target URL reachability if `--url` is given.

**Not implemented:** an exact-expected-tool-*list* assertion (only the version number is checked, not
which tools that version actually exposes) or a preset-disable mechanism keyed off it. None of the four
presets depend on anything version-fragile enough to need one yet — build this when a preset actually
depends on a tool that could disappear, not speculatively.

`--init` bootstraps `.bgn/` if missing: `perf-memory.md`, `config.json` (defaults below, pre-filled with
the detected stack axes), `ledger/`, `archive/`, `audit/` (Senior Engineer Audit reports — see below),
`what-if/` (`/what-if` decision memos — see below), `.gitignore` (excludes
`report.html`/`run-state.json`/`dep-pulse.json`).
Re-running without `--init` on an already-bootstrapped repo just reports status and fills in a missing
`config.json` if one was deleted.

## Autoresearch — `first-load` + `bundle-size` + `interaction` + `layout-shift` (all four work today)

Read `references/presets.md` for the preset's metric/drive/measure/guide, and
`references/measurement.md` for the full N-run + interleaved-A/B + gate protocol before running. The
loop, condensed:

1. **Preflight.** Run Doctor (above) if `.bgn/` isn't bootstrapped yet. Load `.bgn/perf-memory.md`
   (known hotspots, don't rediscover) and `.bgn/playbook.md` if present (proven fix priors). Verify git
   state is `usable` before any mutation (see `parseGitState` — never commit/reset otherwise). If
   `.bgn/config.json`'s `depPulse` is true and its cache is stale, dispatch the Dep Pulse subagent per
   `references/dep-pulse.md` and continue immediately — never await it. (For `interaction`, defer this
   dispatch until after the final capture, per `dep-pulse.md`'s CPU-contention rule.)
2. **Baseline.** Measure `first-load`'s LCP **N times** (`.bgn/config.json`'s `runs`, default 5) via
   `references/presets.md`'s Drive sequence — each run opens a **fresh `isolatedContext`**
   (`new_page {url, isolatedContext: "first-load-baseline-<n>"}`), so cookies/cache/storage don't leak
   across runs and bias later samples, then closes the page after capturing the trace. Discard
   `warmupDiscard` runs (default 1 — see `measurement.md`'s real measured example for why), compute
   mean±stddev with `stats.mjs`. Open a Ledger entry (`assets/ledger.template.md` →
   `.bgn/ledger/<timestamp>-first-load.md`).
3. **Diagnose.** Consult `references/knowledge/lcp.md` (routed by the trace's `LCPBreakdown` insight —
   TTFB-dominated vs render-delay-dominated point at different fixes). Pick the **single dominant**
   candidate fix — never stack fixes in one iteration. If it carries a `Guidance:` id, retrieve that
   `modern-web-guidance` guide (`npx modern-web-guidance@latest retrieve "<id>"`, or the plugin's
   equivalent skill call) when installed; otherwise proceed on the local entry and note
   `guidance <id> not installed` on the finding. See `references/knowledge/INDEX.md`'s "Upstream
   guidance" section for the full contract.
4. **Propose + apply.** One atomic change. Before applying, snapshot each file about to change.
   Check the touched paths against `measurement.md`'s rebuild-fallback list — interleaved (`ABABAB`)
   unless a bundler/framework config or `package.json` is touched, in which case sequential (`AAAA`→
   `BBBB`). Record which mode ran in the Ledger entry (`mode: interleaved | sequential`).
5. **Re-measure.** Identical N-run protocol for the candidate (fresh `isolatedContext` per run, same as
   Baseline — `"first-load-candidate-<n>"`).
6. **Gate.** `stats.mjs`'s `gate()` — `keep ⇔ improvement > max(minEffect, k·pooledStdDev)`. For
   `first-load`: `minEffect: 30` (ms), `k: 2` — calibrated from a real N=10 run, not guessed (see
   `references/measurement.md`'s "Observed noise" section).
   - **KEEP** (and `commitMode != no-commit`): `git add <touched paths>` (never `git add -A`) + commit
     with the measured delta in the message. This is the revert isolation mechanism.
   - **REVERT**: restore each touched file from its pre-fix snapshot.
   Record KEPT/REVERTED in the Ledger with **both distributions**.
7. **Loop.** Next hypothesis until `.bgn/config.json`'s `budget` is exhausted or nothing clears the gate.
8. **End-of-run commit transform.** Per `.bgn/config.json`'s `commitMode`:
   - `per-iteration` (default) — one commit per KEEP iteration, as already happened during the loop.
   - `one-commit` — `git reset --soft <baseline-sha>` + one summary commit at the end of the run.
   - `no-commit` — `git reset --soft <baseline-sha>`, leaving changes staged for the user to review.
9. **Report.** Distill each result into one line in `.bgn/perf-memory.md`. Run `build_playbook.mjs .bgn`
   to fold the new ledger entry into `.bgn/playbook.md`. Collect the Dep Pulse result (if dispatched)
   and present its findings per `references/dep-pulse.md`. If `.bgn/config.json`'s `budget` is already
   spent on internal hypotheses, researching a pulse finding requires its own explicit "continue?" —
   never silently exceed budget. Record `depPulse: dispatched | deferred | cached | off` in the Ledger
   entry.

The trace-parsing half (LCP/CLS/TTFB/scriptTimings extraction, the gate math) and the full step 2/5 drive
sequence (`new_page`+`isolatedContext` → `emulate` → `performance_start_trace` → `close_page`, throttled
to production `emulate` settings) are verified against real data — a real N=10 run against nextjs.org for
noise characterization (`references/measurement.md`'s "Observed noise" section). `minEffect: 30`/`k: 2`
for `first-load` are calibrated from that run.

### `bundle-size` — same gate, no browser, no N-run protocol

Build-time only — no `chrome-devtools-mcp` involved. The loop shape is the same 9 steps, but steps 2/5
(measure) and 6 (gate) differ:

- **Measure:** run the target repo's own build command (whatever Doctor's `detectBundler` axis found —
  `webpack`, `vite`, `esbuild`; if `unknown` or Vite/Turbopack, `bundle-size` isn't usable, say so and
  fall back to Perf Map 3D), then `node "$BG/skills/browsergnome/scripts/bundle_stats.mjs" <stats-file>`
  to get `{totalBytes, chunks:[...]}`. One build per side (baseline, candidate) — not N runs, because a
  build given identical source is deterministic (verified for both implemented bundlers: 3 identical
  esbuild builds and 3 identical production-mode webpack builds, both byte-identical across every
  chunk), so repeating it can't reveal noise that isn't there.
- **Gate:** `improvement > minEffect` — `k·pooledStdDev` is always 0 here, so `minEffect` (default 1024
  bytes) carries the entire decision. See `references/presets.md`'s `bundle-size` entry and
  `references/measurement.md`'s "Observed noise — `bundle-size`" section for why an N-run protocol was
  deliberately skipped rather than run to produce a table of identical numbers.
- **Ledger `mode` field:** record `n/a (deterministic build)` rather than `interleaved`/`sequential` —
  the ABABAB-vs-AAAA-BBBB question doesn't apply when there's no run-to-run variance to cancel.

`bundle_stats.mjs`'s parser is verified against three real builds (single-chunk webpack, code-split
multi-chunk webpack, esbuild — see the script's file header), and its determinism claim is verified for
both bundlers (3 identical esbuild builds, 3 identical webpack builds, byte-identical every time).

### `interaction` — same gate shape, driven by a real click, not a navigation

Steps 2/5 (measure) drive a real interaction before capturing: `new_page{isolatedContext}` →
`emulate` → `performance_start_trace {reload: true, autoStop: false}` → `wait_for` the target
element → **`click`** (never `evaluate_script` — see `references/presets.md`'s `interaction` entry
for why: a JS-dispatched `.click()` isn't a trusted event, so the Event Timing API never records it
and `trace_metrics.mjs`'s `inp` field silently comes back `null`) → `performance_stop_trace` →
`trace_metrics.mjs`. Drive exactly one interaction per capture.

**Gate:** `minEffect: 10` (ms), `k: 2` — gated on INP directly, not the long-task-total fallback the
plan pre-agreed as a hedge. Both were characterized (N=10, real captures): INP's noise band clears
the 20% acceptance bar (marginally — ~1.3×, not `first-load`'s ~6×); long-task-total's doesn't, and
it measures the wrong thing besides (it sums over the whole trace including page load, not just the
interaction). Full numbers: `references/measurement.md`'s "Observed noise — `interaction`" section.

The noise characterization covers exactly one interaction shape (a near-instant consent-dialog dismiss
with almost no handler-side work) on one site. A target's real interaction (a search filter, a modal
with a heavy re-render) will likely show a higher baseline INP and different noise — re-characterize
before trusting 67ms/10ms as more than the shape of the result.

### `layout-shift` — same gate shape as `bundle-size` when deterministic, occurrence-rate gate when not

Two page shapes, two gate methods — `references/presets.md`'s entry has the full Drive sequence and
the decision rule for which method a target needs. Steps 2/5 (measure) mirror `first-load`'s Drive but
stop the trace on the suspect element's own load-completion signal, not the default `autoStop:true`
window (too short for a real network-timed shift — silently produces `cls:0` for the wrong reason).

**Gate:** deterministic shape (zero variance across runs) uses plain `gate()`, same as `bundle-size`.
Race-driven shape (bimodal occurrence) uses `gateOccurrence()` — Fisher's exact test on shift-occurrence
rate, `alpha: 0.05` default. **Check the target's baseline occurrence rate before running the full
loop** — it needs to be roughly ≥40% before n=10 runs/arm can detect even a complete fix; below that,
say so and fall back to Perf Map 3D rather than running a loop the gate structurally can't discriminate
for. Full numbers: `references/measurement.md`'s "Observed noise — `layout-shift`" section.

`gateOccurrence()` runs the same propose→apply→re-measure→gate→commit cycle as every other preset: one
atomic fix (reserve the shifting element's box), N-run baseline and candidate, Fisher's exact test on
occurrence rate, commit on KEEP.

## Performance Memory (works today)

- **Read** `.bgn/perf-memory.md` at the start of any perf-related work in a `.bgn/`-tracked repo: known
  hotspots skip rediscovery, `fixed` entries are this repo's proven route, `reverted` entries are not
  retried.
- **Append** one line on discovery (`open`), on KEEP (`fixed`, with commit + measured delta), on REVERT
  (`reverted`, with Ledger ref). Format: `area/file · symptom · suspected cause · preset · status · ref`.
- **Compact** past ~50 lines: merge duplicates, archive resolved entries to `.bgn/archive/`.

## Configurations (menu item 4 — works today)

Display `.bgn/config.json`, let the user edit, write back. Bootstrapped by Doctor with these defaults:

| Key | Default | Notes |
|---|---|---|
| `commitMode` | `per-iteration` | `per-iteration` \| `one-commit` \| `no-commit` |
| `liveReport` | `false` | write `.bgn/report.html` after each iteration |
| `openReport` | `true` | only relevant when `liveReport` is `true` |
| `runs` | `5` | N measurement runs per iteration |
| `warmupDiscard` | `1` | see `measurement.md` for why this defaults on |
| `k` | `2` | gate noise multiplier |
| `budget` | `6` | max iterations per run (0 = until nothing clears the gate) |
| `interleaved` | `true` | ABABAB by default — see `measurement.md`'s fallback rule |
| `framework` / `bundler` / `host` | detected | written by Doctor, three independent axes, `unknown` is fine |
| `emulate` | `{cpuThrottlingRate:4, networkConditions:"Slow 4G", viewport:"1280x720x1"}` | fixed conditions for comparable runs |
| `depPulse` | `true` | does the Dep Pulse subagent run at all — see `references/dep-pulse.md` |
| `depPulseAutoApply` | `true` | may a benign patch bump skip the pre-install confirm (3-condition carve-out; 2 more conditions still gate KEEP) |

## Senior Engineer Audit (menu item 5 — works today)

A holistic, standalone scan — **no browser or chrome-devtools-mcp session needed for the scan
itself**. Reasons like a staff web performance engineer to find architectural debt mechanical
detectors miss: RSC boundary placement, provider nesting, waterfall data fetching, shared layout
bloat, plus generic React render-cost patterns (referential instability, nested components,
main-thread blocking, code-splitting, over-memoization, render cascades). Fix handoff reuses the
existing measure→gate loop.

**Core invariants:**
- **Hypotheses, never verdicts.** Every finding carries `file:line`, blast radius, expected cost,
  and a gate command (or an honest advisory note). Nothing enters `.bgn/perf-memory.md` as proven
  until the gate runs.
- **Root-cause, not surface area.** Rank by blast radius (fan-in × architectural role). One root fix
  beats fifty leaf fixes.
- **It fixes — it doesn't just file.** The audit ends in an AskUserQuestion menu; the user picks
  which findings browsergnome should fix and prove through the gate.
- **Honest gate mapping.** Web has four gate presets (`first-load`, `bundle-size`, `interaction`,
  `layout-shift` — see `references/presets.md`), not RN's `re-renders`/`listing`. A finding without a
  clean mapping is marked **advisory**, not force-fit to a gate that doesn't measure it.

The audit's own Step 1 (Grounding) also dispatches the Dep Pulse subagent (same condition as
Autoresearch's Preflight above), and Step 6 (Write Report + Present Menu) surfaces pulse findings
alongside architectural ones in the same report and chat summary — see `references/senior-audit.md`'s
Step 1 and Step 6 for the exact wiring. Dep Pulse is scoped to Autoresearch and Senior Engineer Audit
only, the two modes with a report step to surface findings into. See `references/dep-pulse.md`.

**Protocol:** read `references/senior-audit.md` before running (7-step: ground → substrate → reason
→ gate → emit → choose → fix & prove).

Full protocol + blast-radius formula + report schema: **`references/senior-audit.md`**.
Reasoning corpus (10 anti-pattern entries, 4 new for the web substrate — RSC boundaries, provider
nesting, waterfall data fetching, shared layout bloat): **`references/architectural-perf-catalog.md`**.

## `/what-if` (separate command — works today)

A distinct entrypoint (`commands/what-if.md`, not part of the menu above) that answers **"is this
worth doing at all?"** rather than Autoresearch's "is this fix real?" — reuses the whole
measure→apply→re-measure→gate loop but **always reverts, KEEP or REVERT**, and writes a decision
memo instead of a commit. Flagship scenario: the third-party script tax — block/remove one vendor
script, measure through `first-load`, report the real LCP cost. **Refuses framework/bundler
migrations** (measuring one means performing it first, which isn't what a bounded experiment is
for) — declines and explains why rather than guessing.

Full protocol, buildable scenarios, the always-revert verification steps, and the refusal rule:
**`references/what-if.md`**. Read it in full before running — the always-revert guarantee is
**verified, not just performed**: `git status` is checked against the pre-run snapshot before the
memo is written, not assumed clean because the revert steps ran.

## Reference index

- `references/tools.md` — chrome-devtools-mcp pinned version + exact tool surface. **Read before
  invoking any tool.**
- `references/perf-map.md` — detectors, scoring, signal-vs-noise gating, the `barrelImport` calibration
  note, Top-3 format.
- `references/frameworks/`, `references/bundlers/`, `references/hosts/` — the three-axis catalogs,
  filenames matching `doctor.mjs`'s `detectFramework`/`detectBundler`/`detectHost` return strings
  verbatim (`next-app-router.md`, `webpack.md`, `vercel.md`, etc.). Read the ones matching a target's
  detected stack (from `.bgn/config.json`) when diagnosing — stack-specific levers, known dead ends,
  and where a bundler's stats artifacts come from. **The loop, gate, scanner, and reports never
  branch on stack — stack awareness lives only in Doctor's detection and these files.** No
  `hosts/static-cdn.md` — `detectHost` never returns that value, so there's nothing for it to route
  to; add the file only if `detectHost` ever grows a matching branch.
- `references/presets.md` — the 4 presets: metric, drive, measure, guide, candidate fixes. All four are
  implemented; `layout-shift`'s `gateOccurrence()` runs a Fisher's-exact test on shift-occurrence rate.
- `references/measurement.md` — N-run protocol (with a real measured warmup-discard example),
  interleaved A/B design + the mechanical rebuild-fallback rule, gate math, and why `bundle-size`
  deliberately skips N-run characterization (deterministic builds, no noise to measure).
- `references/knowledge/` — the hypothesis-space brain (`INDEX.md` first, leaf files on match only),
  cross-referenced to `modern-web-guidance` guide ids via optional `Guidance:` lines — see `INDEX.md`'s
  "Upstream guidance" section for the presence/absence contract.
- `references/senior-audit.md` — Senior Engineer Audit protocol (menu item 5): grounding,
  blast-radius ranking, signal-vs-noise gate, report format, choose-and-fix flow.
- `references/architectural-perf-catalog.md` — the audit's reasoning corpus: 10 anti-pattern
  entries with symptom/cost/how-to-spot/gate-preset (or honest advisory note) each.
- `references/what-if.md` — the `/what-if` command's protocol: scratch branch, always-revert
  guarantee (verified, not assumed), memo format, buildable scenarios, migration-refusal rule.
- `references/dep-pulse.md` — the Dep Pulse subagent's protocol: perf-spine derivation, registry
  resolve + changelog read, signal-vs-noise, consent gate (and its benign-patch carve-out), acting on
  a chosen finding through the gate, revert mechanism, unattended/CI behavior.
- `assets/playbook.seed.json` — 12 seeded priors, `source: 'seeded'`.
- `assets/trace.sample.json.gz`, `assets/trace.cls-sample.json.gz`, `assets/trace.multi-lcp-sample.json.gz`,
  `assets/trace.eventtiming-sample.json.gz`, `assets/trace.interaction-sample.json.gz` — real captured
  traces (nextjs.org; a scripted mid-load-shift page; a scripted two-LCP-candidate page; a real capture
  carrying automation-noise `EventTiming` events; a real trusted-click capture with a genuine positive
  INP), trimmed. Ground truth for `trace_metrics.mjs`'s self-test — see that script's file header for
  exactly which fields were verified against which capture.
- `assets/bundle-stats.webpack-sample.json.gz`, `assets/bundle-stats.webpack-multichunk-sample.json.gz`,
  `assets/bundle-stats.esbuild-sample.json.gz` — real `webpack --json`/`esbuild --metafile` output
  (single-chunk, code-split multi-chunk, and esbuild), trimmed. Ground truth for `bundle_stats.mjs`'s
  self-test.
- `assets/trace.render-blocking-sample.json.gz` — a real nextjs.org capture carrying real
  `ResourceSendRequest`/`ResourceReceiveResponse`/`ResourceFinish` events (6 render-blocking CSS
  requests, cross-validated against `performance_analyze_insight`'s own reported durations), headers
  stripped. Ground truth for `lcp_attribution.mjs`'s self-test.
- `assets/ledger.template.md`, `assets/report.template.html`, `assets/run-state.sample.json` — the
  Ledger entry template, live report template, and its sample data, wired into the `first-load` loop.
- `scripts/doctor.mjs` — preflight + `.bgn/` bootstrap (`--self-test` covers the pure detection
  functions; run it for real too, self-tests don't replace running the thing).
- `scripts/trace_metrics.mjs` — trace.json[.gz] → `{lcp,fcp,ttfb,cls,inp,tbt,longTasks,scriptTimings}`.
  Pure function of a file, fully offline-testable.
- `scripts/bundle_stats.mjs` — webpack/esbuild stats → `{bundler, totalBytes, chunks:[{chunk, file,
  bytes, modules:[{module, bytes}]}]}`. Vite/Turbopack not implemented — see the file header. Pure
  function of a file, fully offline-testable.
- `scripts/lcp_attribution.mjs` — the LCP Attribution Map's data layer: trace + optional bundle stats →
  three-tier `{class: network|chunk|module, ms, confidence: measured|apportioned}` node list.
  Imports `trace_metrics.mjs`/`bundle_stats.mjs`'s exports directly (both have a CLI-guard so importing
  them doesn't also run their CLI). See its file header for the attribution methodology.
- `scripts/build_lcp_map.mjs` + `assets/lcp-map.template.html` — the LCP Attribution Map's rendering
  layer, mirroring `build_perf_map.mjs`'s marker-based merge. Dark canvas, degraded chunk-only path
  rendered as first-class (no bundle stats).
- `scripts/stats.mjs` — the gate arbiter (`--self-test` covers edge cases).
