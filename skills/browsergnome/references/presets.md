# Presets

The five Autoresearch presets. Read the matching entry before running one. All five — `first-load`,
`bundle-size`, `interaction`, `layout-shift`, and `re-renders` — are built. `re-renders` requires the
React Page Tools provider (`references/page-tools.md`); the other four run on any web target.

Every browser-driven Drive sequence below ends with `close_page` — that's not optional cleanup, see
`references/measurement.md`'s "Browser instance hygiene" section for why an N-run loop that skips it
silently accumulates open tabs.

## first-load — built

**Trigger:** slow initial page load, poor LCP, "the homepage takes forever," cold-start performance.

**Metric:** LCP (lower is better). Secondary: TTFB, FCP — reported alongside but not gated on.

**`emulate` settings: read live from `.bgn/config.json`'s `emulate` block, every run** — never
hardcode a throttle value. Default (Doctor-bootstrapped): no CPU/network throttle, so a fresh run's
numbers land close to DevTools' Performance tab / Lighthouse rather than an artificially harsh
worst-case. What matters for the gate isn't *which* conditions, it's that every run in a comparison
uses the *same* ones — the gate compares distributions collected under identical conditions;
changing conditions mid-run invalidates the comparison. A user who wants worst-case/mobile-network
sensitivity (e.g. to catch a fix that only pays off under real network/CPU constraints) can set
`cpuThrottlingRate`/`networkConditions` in Configurations — that's a deliberate opt-in, not a
default any report should silently assume.

**Target URL must be a compressed production build, never a dev server.** An unbundled dev server
(Vite's `vite dev`, and similar unbundled-by-default dev servers) serves hundreds of individual
module requests instead of a few bundled chunks — under network throttling (if enabled) that
waterfall dominates LCP so completely the number stops measuring anything a real fix could move. The
same waterfall can also appear on a *production* build if it's locally re-served over HTTP/1.1 (many
first-party chunks, one connection cap) — see `lcp_attribution.mjs`'s `computeTransportProfile` /
the LCP Attribution Map's HTTP/1.1 banner, which flags that case directly. Build for production
first (`vite build` / the framework's equivalent) and point the preset at that output, served with
compression enabled — an uncompressed static server measures a payload real users never see, and can
flip the whole diagnosis. See `references/measurement.md`'s second `first-load` noise
characterization for the measured gap between dev-server, uncompressed-prod, and compressed-prod
numbers on the same app.

**Drive, each of the N runs:**
```
new_page { url: <target URL>, isolatedContext: "browsergnome-run-<n>" }
  → emulate <.bgn/config.json's emulate block>   (default: no throttle — see above)
  → performance_start_trace { reload: true, autoStop: true, filePath: <run-scoped path> }
  → trace_metrics.mjs <trace file>   (LCP/FCP/TTFB/CLS/TBT/scriptTimings)
  → close_page
  → stats.mjs (gate, once all N runs are in)
```

A fresh `isolatedContext` per run — cookies/storage/cache don't leak between measurements, which matters
for LCP specifically (a warm cache on run 3 that a cold cache on run 1 didn't have would bias the
distribution, not just add noise). Name it `<preset>-<run-n>` so a crashed run doesn't collide with a
retry.

**Measure:** `trace_metrics.mjs`'s `lcp` field, µs precision from the trace, reported in ms. See
`scripts/trace_metrics.mjs`'s file header for which trace-event shapes are verified against which
capture, and `references/measurement.md` for the N-run protocol.

**Gate:** `minEffect: 30` (ms), `k: 2` (config default). Noise band ~29-31ms (~3% of the ~942ms baseline
LCP it was measured against) — clears the 20%-improvement acceptance bar by ~6×; a 5% win (~47ms) is
only ~1.5× the noise band and marginal, not comfortably clear. `minEffect` was set to roughly match the
noise band rather than derived from an independent practical-significance judgment ("what LCP delta is
worth a commit"), so it's a conservative placeholder, redundant with `k·pooledStdDev` by construction.
**30ms is calibrated for one target's baseline LCP, not a universal constant** — a much faster target
could see the flat floor become the binding constraint over the statistical noise band; re-derive per
target repo (roughly "3% of baseline mean" as a shortcut) rather than trusting 30ms on a site with a very
different LCP. Full numbers and methodology: `references/measurement.md`'s "Observed noise" section.

**Guide:** `references/knowledge/lcp.md` (symptom → fix patterns) plus whichever `INDEX.md` entries
match the LCP breakdown's dominant phase (TTFB vs render delay vs resource load — `performance_
analyze_insight`'s `LCPBreakdown` insight names which one, use it to route to the right knowledge-base
leaf rather than guessing).

**Candidate fixes** (from the knowledge base, not exhaustive): preload/prioritize the LCP image,
critical CSS inlining, defer non-critical fonts, remove render-blocking scripts from `<head>`, reduce
TTFB-side server work. One atomic fix per iteration — never stack.

## layout-shift — built

**Trigger:** unexpected content jumps, "fix my CLS," images/ads/embeds without reserved space.

**Metric:** CLS (lower is better), via `computeCLS` in `trace_metrics.mjs`. Two page shapes need two
gate methods — pick based on what a static `imageNoDims`/CSS check plus a few pilot captures show:

- **Deterministic shape** (one element, fixed final size, shifts once when a late-loading resource
  arrives) — full float-precision identical CLS across repeated captures. Gateable today via plain
  `gate()`: zero variance collapses `noiseBand` to `minEffect`, same pattern as `bundle-size`.
- **Race-driven shape** (shift depends on whether a resource arrives before or after first paint) —
  genuinely bimodal, not noise around a mean. Use `gateOccurrence()` (below).

Full numbers and root cause for both shapes: `references/measurement.md`'s "Observed noise —
`layout-shift`" section.

**Gate — race-driven shape:** `stats.mjs`'s `gateOccurrence({baseline, candidate, alpha})` — Fisher's
exact test on baseline-vs-candidate shift-occurrence rate (0/1 per run), one-tailed, `alpha: 0.05`
default. Unit-tested against hand-verified exact p-values; worked example
(`references/measurement.md`'s "Worked example — race-driven CLS fix" section): baseline occurrence
8/10 (0.8) vs candidate 0/10 (0.0), p=0.0004, KEEP.

**Before running this preset on a real target, check its baseline occurrence rate first** — this is a
property of the target, not a tuning knob. A target's baseline shift-occurrence rate needs to be
roughly ≥40% before n=10 runs/arm can detect even a complete fix at α=0.05; most pages with an
occasional, low-rate shift can't be gated at the standard N at all. If a pilot capture run (a handful of
loads) shows an occurrence rate below that, say so and fall back to Perf Map 3D's static finding instead
of running the full loop on a target the gate can't discriminate for.

**Drive, each of the N runs:**
```
new_page { url: <target URL>, isolatedContext: "layout-shift-run-<n>" }
  → emulate <.bgn/config.json's emulate block>   (default: no throttle — see `first-load`'s entry)
  → performance_start_trace { reload: true, autoStop: false }
  → wait_for the load-completion signal (the suspect element's own `load`/`error` event, or a fixed
    settle window if no single element is the obvious cause — the default `autoStop:true` window is too
    short for a real network-timed shift and silently produces `cls:0` for the wrong reason)
  → performance_stop_trace
  → trace_metrics.mjs <trace file>   (cls field; 0 or nonzero is what gateOccurrence needs)
  → close_page
  → stats.mjs --mode occurrence (once all N runs are in, for the race-driven shape; plain gate() for
    the deterministic shape)
```

**Measure:** `trace_metrics.mjs`'s `cls` field. For `gateOccurrence()`, reduce each run to 0 (cls==0) or
1 (cls>0) before feeding `stats.mjs`.

## bundle-size — built

**Trigger:** bloated JS bundle, "shrink my bundle," a dependency swap/removal candidate.

**Metric:** shipped JS bytes for the built chunk(s) (lower is better). Build-time, no browser — the
candidate's `apply` step is "make the change, run the target's own build command," not a chrome-devtools-mcp
drive at all.

**Measure:** `scripts/bundle_stats.mjs <stats-file>` — parses build-time stats into
`{bundler, totalBytes, chunks:[{chunk, file, bytes, modules:[{module, bytes}]}]}`. Two formats
implemented — see the file's header and `selfTest()`'s fixture checks:
- **webpack** — `webpack --json > stats.json`. Handles ModuleConcatenationPlugin's merged-module entries
  and the orphaned-duplicate entry that comes with it, and multi-chunk code-splitting.
- **esbuild** — `esbuild --metafile=meta.json`. Flat, no concatenation quirk.

**Vite/Rollup and Turbopack are not implemented** — Vite's CLI doesn't emit a stats file without an
added target-repo dependency (`rollup-plugin-visualizer` or similar, not assumable), and Turbopack has no
stable public stats format. `bundle_stats.mjs`'s `detectFormat` returns `null` for either; **degrade to
"no bundler stats available," never guess a shape for an unsupported format** — this preset simply
isn't usable on those targets, say so plainly.

**Gate — no noise characterization needed, and that's not a shortcut:** given identical source, a build
is byte-for-byte deterministic (confirmed for both implemented bundlers — repeated esbuild and
production-mode webpack builds of the same source produced identical output every time).
`k·pooledStdDev` is therefore always 0, so the gate collapses to `improvement > minEffect` — `minEffect`
is the *entire* gate here, not a floor alongside a statistical term. That makes it purely a
practical-significance judgment ("is this many fewer bytes worth a commit"), not something an N-run
protocol could ever derive. Default `minEffect: 1024` (1KB) — small enough to catch a real dependency
swap, large enough to filter incidental churn (a renamed export, a shifted content hash). Reconsider per
target if the app's bundle is unusually small or the team's bar for "worth a commit" differs — this is a
starting point, not a derived constant.

**Candidate fixes** (from `references/knowledge/bundle.md`, not exhaustive): swap a heavy dependency for
a lighter one (`moment` → `date-fns`), dynamic `import()` for a route/component not needed on first load,
tree-shake an unused named export, drop a duplicate transitive dependency. One atomic fix per iteration —
never stack.

## interaction — built

**Trigger:** sluggish click/tap response, "my INP is bad," a form or filter that feels laggy.

**Metric:** INP (lower is better), gated directly — not the long-task-total fallback. Characterized
empirically (N=10, real trusted clicks) rather than assumed: INP's noise band clears the 20%
acceptance bar, long-task-total's doesn't (and measures the wrong thing besides — see
`references/measurement.md`'s "Observed noise — `interaction`" section for the full reasoning and
numbers).

**`emulate` settings:** same as `first-load` — read live from `.bgn/config.json`, default no throttle.

**Drive, each of the N runs:**
```
new_page { url: <target URL>, isolatedContext: "browsergnome-run-<n>" }
  → emulate <.bgn/config.json's emulate block>   (default: no throttle — see `first-load`'s entry)
  → performance_start_trace { reload: true, autoStop: false, filePath: <run-scoped path> }
  → wait_for { text: [<target element's visible text>] }
  → click { uid: <target element's uid from the wait_for/take_snapshot response> }
  → performance_stop_trace { filePath: <same path> }
  → trace_metrics.mjs <trace file>   (inp field)
  → close_page
  → stats.mjs (gate, once all N runs are in)
```

**The click must go through the `click` (or `type_text`) tool, never `evaluate_script`.** A
JS-dispatched `element.click()` is not a trusted, input-pipeline-originated event, so the Event
Timing API never records it — `computeINP` silently returns `null` on every measurement using that
path, with nothing to signal the mistake. Verified directly, not assumed: see
`trace_metrics.mjs`'s file header. Drive **exactly one interaction per capture** — `computeINP`
takes the max duration across all tracked interactions in the trace, so more than one makes that max
ambiguous.

**Gate:** `minEffect: 10` (ms), `k: 2`. Noise band ~10ms against a ~67ms baseline INP for the one
characterized interaction shape (a near-instant dialog dismiss) — clears the 20%-improvement
acceptance bar by only ~1.3×, a **marginal pass**, not comfortable like `first-load`'s ~6×. Treat any
candidate win under ~2× the noise band (≤20ms) as marginal and worth a second look, not an automatic
KEEP. **This is characterized for one interaction shape on one site — re-characterize on the actual
target before trusting these numbers**, especially for interactions with real handler-side work
(a search-filter recompute, a modal open with a heavy re-render), which will likely show both a
higher baseline INP and different noise. Full numbers and methodology:
`references/measurement.md`'s "Observed noise — `interaction`" section.

**Guide:** `references/knowledge/inp.md` plus whichever `INDEX.md` entries match
`performance_analyze_insight`'s `INPBreakdown` insight's dominant subpart (input delay vs
processing time vs presentation delay).

**Blame (React provider — runs before proposing a fix):** when `config.pageTools` includes `react`,
run a Page Tools pass (`references/page-tools.md`) on the same route and drive the **same trusted
interaction** inside a React profile:
```
react_start_profiling { traceName: "blame" }
  → click / type_text  (the identical interaction the gate drives)
  → react_stop_profiling
  → react_get_trace_overview { traceName: "blame" }      → the commit with max renderDuration
  → react_get_commit_report { traceName, commitIndex }   → top 5 non-host components by selfDuration
  → react_get_component_source + page_tools.mjs locate   → file:line in the original source
```
The ranked blame list (component, self ms, render count in the trace, `file:line`) is what the fix
proposal targets. Dev-build durations rank components only. KEEP/REVERT stays on the production
build's INP above. When the blame list is dominated by many commits or wide re-renders rather than
one expensive component, the fix is a `re-renders` candidate: gate it there as well.

**Candidate fixes** (from the knowledge base, not exhaustive): break up a long synchronous handler
with `requestIdleCallback`/`useTransition`, debounce or defer non-critical work triggered by the
interaction, remove unnecessary work from the event handler's critical path. One atomic fix per
iteration — never stack.

## re-renders — built (React provider)

**Trigger:** "too many re-renders", "this list re-renders on every keystroke", a render-cost Senior
Audit finding (referential instability, nested component definitions, render cascades,
over-memoization), or an `interaction` blame list dominated by repeated commits.

**Requires:** `react` in `config.pageTools`. Without it this preset is unavailable; say so, and fall
back to `interaction` for a timing-visible symptom.

**Metric:** total components rendered for one fixed interaction (lower is better). This is
Σ `componentsChanged` across every commit in a `react_get_trace_overview`, computed by `page_tools.mjs`'s
`renderTotal()`. It counts host components too, and includes StrictMode's development behavior. Both
sides share both, so they cancel. Reported alongside, never gated: commit count and the top
components by render count.

**Build:** the target's **dev server**, the one preset that doesn't measure the production build.
Which components render for an interaction is decided by the component tree and state flow, not by
build optimizations, and only a dev build reports it. See `measurement.md`'s
"Observed noise — `re-renders`".

**Drive, each capture** (inside a Page Tools pass, `references/page-tools.md` steps 1–6):
```
navigate_page { type: "url", url: <target route>, initScript: <loader> }   (fresh load per capture)
  → take_snapshot → wait_for the target element
  → react_start_profiling { traceName: "rr-<side>-<n>" }
  → the fixed interaction script: click / type_text with identical inputs every capture
  → react_stop_profiling
  → react_get_trace_overview { traceName } → renderTotal()
```
Use trusted input tools only (`click`, `type_text`, `press_key`), never `evaluate_script`. Same rule
and reason as `interaction`.

**Gate — two shapes, decided by a determinism check:** capture the baseline **3 times**.
- **All 3 identical → deterministic shape.** One capture per side from then on. `stats.mjs` with
  `minEffect: 0` (`k·pooledStdDev` is 0 and the rule is strict `>`, so a reduction of even one
  component keeps; equal or higher reverts). Ledger
  `mode: n/a (deterministic count)`. Same reasoning as `bundle-size`.
- **Not identical → noisy shape.** Data fetches, timers, or animation frames landing inside the
  capture window make the count vary. Run the N-run interleaved protocol (`config.runs`, ABABAB) and
  gate with `stats.mjs` `minEffect: 0`, `k: config.k`, same as `first-load`. Record the spread in the
  ledger.

**Guide:** `references/architectural-perf-catalog.md` entries 2, 5, 6, 9 and 10 (context shape,
referential instability, nested component definitions, over-memoization, render cascades). Match the
entry to the dominant cause in the commit report.

**Candidate fixes** (not exhaustive): stabilize a prop or context value (`useMemo`/`useCallback`, or
hoist it), move state down to the component that uses it, split a context so consumers subscribe to
less, hoist a component defined inside another component's body, `memo` a pure child that receives
stable props, drop a `memo`/`useMemo` whose inputs change every render. One atomic fix per
iteration — never stack. Teardown (page-tools step 9) after the last capture, every time.
