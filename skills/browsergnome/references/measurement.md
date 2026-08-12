# Measurement protocol

The gate exists because a single measurement lies. This file is the N-run protocol, the interleaved
A/B design, and the gate math that decide KEEP vs REVERT. Read this before running any preset, and
read it again before touching `k`, `minEffect`, or the interleave/sequential fallback rule.

## The N-run protocol

1. Run the preset's measurement **N times** (`.bgn/config.json`'s `runs`, default 5).
2. **Discard the first `warmupDiscard` runs** (default 1) — cold caches, cold V8 compile caches, and
   cold CDN edges make the first load of any session measurably slower and noisier than the rest. See
   "Why warmup discard exists" below for a measured example.
3. Compute **mean ± stddev** over the remaining runs with `scripts/stats.mjs`.
4. Repeat for the candidate (post-fix) measurement, same N and warmup discard.
5. Decide with the gate (below).

## Browser instance hygiene — one live page at a time, not N

A 5-10-run loop that opens a fresh `isolatedContext` page per run and never closes the previous one
accumulates that many open browser tabs by the end of a single Autoresearch iteration — worse across
a whole multi-iteration run. This is real overhead (memory, and eventually a browser that's slow for
reasons that have nothing to do with the page under test), and it's silent — nothing fails loudly
when it happens, the loop just gets slower and noisier run over run.

**The rule: close each run's page before starting the next one.** `close_page` is already the last
step of every preset's Drive sequence (`references/presets.md`) for exactly this reason — treat it
as load-bearing, not cleanup-if-convenient. Concretely:

- **Fresh `isolatedContext` per run is still correct and necessary** — it's what gives each
  measurement a cold, unpolluted cookie/cache/storage state (see `first-load`'s and `interaction`'s
  entries in `references/presets.md`). The fix is closing each one immediately after its trace is
  captured, not avoiding isolation.
- **Never let more than one measurement page exist at once.** `new_page` for run *n+1* only after
  `close_page` for run *n* has completed — don't batch-open pages ahead of measuring them.
- **For anything that doesn't need fresh isolation** (a quick exploratory check, re-reading the same
  page's state, a paste-hint/UI smoke check) — reuse the existing page with `navigate_page {type:
  "reload"}` rather than opening a new `isolatedContext`. Isolation is for measurement runs whose
  distributions get compared; it's not the default for every browser interaction.
- **If a run is resumed after an interruption** (a crashed step, a retried loop), call `list_pages`
  first and close anything left over from the previous attempt before opening a new one — don't
  assume a clean slate. A stray page from an earlier failed run is exactly the kind of silent
  accumulation this rule exists to prevent.

This is freedom with control, not a ban on `new_page`: open what a measurement genuinely needs,
close it the moment it's superseded, and never carry more than the current run's page forward.

## Why warmup discard exists — a measured example

Three consecutive `first-load` LCP samples against the same unchanged page (nextjs.org, via
`performance_start_trace` → `trace_metrics.mjs`), first load included:

| Run | LCP |
|---|---|
| 1 (cold cache) | 289.3 ms |
| 2 | 183.5 ms |
| 3 | 187.6 ms |

All three: mean 220.2 ms, **stddev 59.9 ms** (27% of the mean — a noise band wide enough to swallow most
real fixes). Discarding run 1 as warmup: mean 185.6 ms, **stddev 2.9 ms** — a ~20× tighter noise band
from discarding a single sample. That's the justification for `warmupDiscard: 1` defaulting to on rather
than off. (Figures use `stats.mjs`'s own sample-stddev formula, `n-1` denominator — run
`node scripts/stats.mjs --baseline "289.3,183.5,187.6" --candidate "289.3,183.5,187.6" --min-effect 0`
to reproduce; check the printed `baseline.std`.)

This is a 3-sample illustration, not the full noise characterization — see "Observed noise" below for
that. Treat the numbers above as "this is why the knob exists," not as the calibrated `minEffect`/`k`.

## The gate

`scripts/stats.mjs`'s `gate()`:

```
keep ⇔ improvement > max(minEffect, k · pooledStdDev)
```

`k` defaults to 2 (`.bgn/config.json`). `direction` is `lower` for LCP/TTFB/bytes/CLS/TBT, `higher` for
anything where bigger is better (none of the current presets need `higher`, but the flag exists — see
`stats.mjs --self-test` for both directions). `minEffect` is an absolute floor **per preset**, not a
global config key — see "Observed noise" below for `first-load`'s (30ms). The other presets have no
calibrated `minEffect` yet; don't invent one before they're built.

**Standing ship rule:** a preset ships gated only if its noise band would accept a real 20% improvement
— check this fresh for every preset when it's built. If a preset's noise band is too wide for that,
**change the metric, never loosen `k`** to force a pass — widening `k` doesn't make a noisy metric less
noisy, it just hides the noise from the gate.

```bash
node scripts/stats.mjs --baseline "185.6,183.5,187.6" --candidate "142.1,138.9,140.2" \
  --min-effect 20 --k 2 --direction lower --unit ms
```

## Interleaved A/B measurement

Sequential measurement (`AAAA` then `BBBB`) lets any drift in host load across the run — a noisy CI
runner, a laptop that starts thermal-throttling, a flaky network — leak straight into the delta,
because everything the baseline arm saw happened at a different time than everything the candidate arm
saw. **Interleaving (`ABABAB`)** — stash the candidate diff, measure A; apply it, measure B; repeat —
means both arms experience the same drift, which cancels in the paired difference instead of biasing
the result. This is standard blocked experimental design; no web perf tool does it by default.

`.bgn/config.json`'s `interleaved` key defaults to `true`. `stats.mjs` needs **no change** for this — it
receives two distributions either way; interleaving only changes how they were collected in time, not
their shape.

### When to fall back to sequential — mechanical, not judgment

`ABABAB` means N apply/revert cycles instead of 2. That's free for a config or import-line edit but
costly when the candidate diff triggers a **rebuild** — a rebuild can take minutes, and N of them
defeats the point of measuring quickly. The loop checks the touched paths against this list
**before** starting measurement, not by guessing from the diff's "feel":

**Forces sequential** (any touched path matches):
- `next.config.*`, `vite.config.*`, `remix.config.*`, `webpack.config.*`, `rspack.config.*` — any
  bundler/framework config file
- `package.json` (a dependency added/removed/swapped — e.g. `moment` → `date-fns`)
- anything under a directory the bundler treats as build-time config (`.babelrc*`, `postcss.config.*`,
  `tailwind.config.*`)

**Stays interleaved** (everything else): component/route source edits, prop/import changes, JSX
changes, CSS-in-JS, most `first-load`/`layout-shift` fixes.

This is a fixed list, not a heuristic the agent re-derives per run — extend it here if a new
rebuild-triggering path type shows up, don't infer it ad hoc mid-loop.

**Record which mode ran.** Every Ledger entry gets a `mode: interleaved | sequential` field. Any
comparison of what interleaving bought, or later debugging of a surprising result, is only meaningful
if this was recorded at measurement time, not reconstructed after the fact from the diff.

## Observed noise — `first-load` / LCP

N=10 run against nextjs.org (unchanged, real site), under `first-load`'s fixed `emulate` settings
(`cpuThrottlingRate:4`, `Slow 4G`, `1280x720x1`) with a fresh `isolatedContext` per run, per
`presets.md`'s Drive sequence.

Raw LCP (ms), in capture order: `933.807, 956.956, 945.004, 936.825, 949.663, 940.443, 937.415, 913.840,
942.273, 968.126`. Overall: **mean 942.4 ms, stddev 14.5 ms (1.5% of the mean)**.

That's tighter than expected — under *throttled* conditions on a stable local machine, LCP came out
closer to "near-deterministic" than "moderately noisy." Throttling dominates over the network/cache
jitter that made the unthrottled 3-sample illustration above so much wider (27% relative stddev there
vs 1.5% here) — on one machine; a CI runner may behave differently (see below).

**Scope note on "sequential vs. interleaved":** rather than capturing 20 independent samples, this
reuses the same 10 captures under two partitions — first-5-vs-last-5 (approximates a sequential
`AAAA`→`BBBB` block) and odd-vs-even (approximates `ABABAB`). Since both "arms" are the same unchanged
page, the only question either partition can answer is "does temporal proximity change the read" —
which doesn't need two independently-collected datasets to test. A full independent 20-sample run is
future work if this needs re-confirming at higher power.

| Split | Baseline mean | Candidate mean | Pooled stddev | Noise band (k·pooledStdDev, k=2) |
|---|---|---|---|---|
| Sequential (samples 1-5 vs 6-10) | 944.5 ms | 940.4 ms | 15.17 ms | 30.35 ms |
| Interleaved (odd vs even) | 941.6 ms | 943.2 ms | 15.31 ms | 30.63 ms |

**Finding — a null result, not a negative one:** 30.35ms vs 30.63ms is not evidence that interleaving
doesn't help. Both partitions are drawn from the *same* 10 numbers; splitting any 10 similar numbers
into two groups of 5 two different ways produces near-identical pooled stddev almost by construction,
regardless of interleaving. Interleaving's actual claim is narrower: **if** drift occurs during a run,
temporally-paired samples (interleaved) show a smaller paired-difference variance than block-separated
samples (sequential), because both members of a close-in-time pair experience roughly the same drift.
These 10 captures happened within ~5 stable minutes on one local machine — there was no drift to cancel,
so this comparison had nothing to detect. **The question "does interleaving help" is unanswered here,
not answered-negatively.** A substrate with real drift (a shared CI runner, a longer loop, a laptop that
starts thermal-throttling mid-run) is needed to actually test the claim; `interleaved: true` stays the
default on the strength of the underlying argument (§ above) and the fact that interleaving costs
nothing when there's no drift to cancel, not on the strength of this experiment.
**Re-characterize on the actual CI runner** before treating `interleaved`'s value there as demonstrated
— the noise band measured here is a laptop's, on a stable local network, over ~5 minutes; a shared CI
runner's noise band is a separate unknown and must be measured there, not assumed to match.

All ten runs used a fresh `isolatedContext` (no shared cache/storage between runs), so `warmupDiscard`'s
cold-cache effect (see above) doesn't apply here the way it does to a same-session repeated-load
protocol — there's no warm run to discard from, every run starts equally cold.

**Acceptance check:** 20% of the observed mean (942ms) is ~188ms. The observed noise band (~29-31ms) is
roughly 6× tighter than that — a real 20% improvement is clearly distinguishable from noise. A 5% one
(~47ms) is only ~1.5× the noise band and re-estimated fresh every run — a noisier session (pooled stddev
above ~24ms) would flip it to REVERT, so call that one marginal, not clearly distinguishable.
**`first-load` ships as a gated preset.**

**`minEffect` set to 30ms for one target (nextjs.org, ~942ms LCP under these `emulate` settings) — not a
universal constant, and not a real practical-significance threshold either.** `stats.mjs` treats
`minEffect` as the floor for "worth shipping even if the stats say it's real" — a judgment call about
what magnitude of win matters, independent of noise. 30ms was set to roughly match the observed noise
band (~29-31ms) instead, because no independent judgment call about "what LCP delta is worth a commit"
was made — so on this target the floor is redundant with `k·pooledStdDev` by construction, not doing
separate work. Treat 30ms as a placeholder that happens to be conservative, not a derived
practical-significance value; a real one should come from product judgment, not from the noise
measurement. **Re-derive `minEffect` per target repo** (a quick N=5-10 run against the actual target
before the first real Autoresearch loop, same protocol as above) rather than trusting 30ms on a site
with a very different baseline LCP; treat it as roughly "3% of your target's baseline mean" if a quick
re-derivation isn't practical. Written into `references/presets.md` with this same caveat.

## Observed noise — `first-load` / LCP, second target — excalidraw/excalidraw (Vite SPA)

N=6 run (1 warmup discarded, per `.bgn/config.json`'s default — applied as protocol, not because a
strong cold-start effect showed up here: the discarded run was ~31ms above the kept mean, under 1.2×
the arm's own stddev. A fresh browser profile removes browser-side cache/cookie coldness the way a
fresh `isolatedContext` does, per the "Browser instance hygiene" section above — but unlike that
section's isolatedContext case, the local static server itself stays warm across all runs in a
session, so its own OS-file-cache coldness isn't ruled out the same way; kept the default discard
rather than assuming it away) against a local production build of `excalidraw-app`
(`excalidraw/excalidraw`, a Vite SPA), under `first-load`'s fixed `emulate` settings
(`cpuThrottlingRate:4`, `Slow 4G`, `1280x720x1`), fresh throwaway browser profile per run. **Driven
via direct CDP rather than `performance_start_trace`** (a load-event-fired signal plus a fixed 3s
settle window standing in for `autoStop`'s network-idle heuristic) — noted for comparability with
other targets in this section, which use the standard MCP drive path.

Raw LCP (ms), in capture order after warmup: `7153.001, 7174.164, 7209.791, 7188.435, 7217.740`.
Overall: **mean 7188.63ms, stddev 26.33ms (0.37% of the mean)** — tighter, in relative terms, than
nextjs.org's 1.5% (above). 3% of the baseline mean (`presets.md`'s per-target re-derivation
shortcut) gives `minEffect ≈ 216ms` for this target — well above the statistical noise band
(k·pooledStdDev ≈ 53ms at k=2), so **on this target the practical-significance floor is the binding
constraint, not the statistical term** — exactly the case `presets.md`'s `first-load` entry flags as
possible on a target with a very different baseline LCP than the one 30ms was calibrated against.

**Two measurement-setup requirements this run established:**

- **Measure the production build, never a dev server that ships unbundled modules.** Scoped to what
  was actually measured — this is specifically about Vite-style dev servers that serve hundreds of
  individual ES module requests rather than a few bundled chunks; a first attempt measured `vite dev`
  under the same throttled settings and produced LCP 141,055ms, almost entirely that dev-mode module
  waterfall against the browser's 6-connections-per-origin limit, not anything a first-load fix could
  plausibly move. A framework whose dev server already bundles (webpack/Turbopack dev mode) is a
  separate, unmeasured question — likely still unrepresentative (no minification, dev-only checks),
  but not necessarily by two orders of magnitude. Building for production first and measuring that
  output is the safe default regardless of framework.
- **Serve the production build compressed — universal, nothing framework-specific here.** The same
  Excalidraw build served uncompressed measured LCP 18,964ms; pre-gzipping the output and serving
  with gzip enabled brought it to the 7188ms baseline above. This is a pure static-file-serving fact
  that applies to any target measured via a local server, any framework: real CDNs compress by
  default, a plain local static server usually doesn't, and the gap is large enough to produce a
  fundamentally different (and wrong) diagnosis.

**Real propose→measure→gate cycle, two atomic hypotheses, both correctly rejected — including one
regression the gate caught.** Both hypotheses edited `excalidraw-app/vite.config.mts`, on this
section's own **forces-sequential** list ("any bundler/framework config file") — both ran `mode:
sequential`, each candidate rebuilt before its N=5 (of 6 captured) re-measurement, gate arithmetic on
arm means:

```
H1 (defer entry <link rel=stylesheet> to preload+swap): improvement -23ms  → REVERT (noise)
H2 (drop eager modulepreload of a lazy, non-critical chunk): improvement -580.05ms (-8.07%) → REVERT (regression)
  baseline mean 7188.63ms (n=5) → H2 candidate mean 7768.68ms (n=5)
```

H2 is the more interesting result: the removed chunk was a real, source-verified dynamic `import()`
target that looked like pure dead weight competing with the entry chunk for bandwidth — removing its
eager preload did make the entry chunk itself finish faster (confirming the bandwidth-contention
theory), but serialized two previously-parallel fetches and regressed LCP by 8%. Network-resource
timeline, from one extra one-off debug capture per arm (outside the N=5/arm the −580.05ms gate figure
above is computed from — these two numbers are the load-bearing evidence for the *mechanism*, not a
second LCP measurement; the gate arithmetic is the −580.05ms figure above, not anything derived from
this table):

| | entry chunk finishes | deferred chunk finishes |
|---|---|---|
| Baseline (both eager, parallel) | 6524ms | 3778ms (well clear of LCP) |
| H2 candidate (deferred chunk no longer eager) | 5563ms (−961ms, confirms bandwidth contention) | 7095ms (this capture's own LCP lands shortly after — consistent with, not separately re-verified against, the arm mean above) |

See `references/knowledge/lcp.md`'s dead-end entry for the generalized pattern this is evidence for.
A run's full Ledger entry (per-hypothesis gate arithmetic, in `assets/ledger.template.md`'s shape)
lives in the target repo's own `.bgn/ledger/`, per the two-repo model — not reproduced here since
that clone doesn't persist past the run that produced it.

## Observed noise — `bundle-size` / shipped bytes

**No N-run characterization was done, deliberately — an N-run protocol can't measure noise that isn't
there.** Confirmed for both implemented bundlers, not just one: the same source, built 3 times with
esbuild, produced byte-identical output every time; the same source, built 3 times with webpack
(production mode, minified, with real code-splitting via `import()`), produced byte-identical asset
sizes for both chunks every time too. Given identical source, a build is deterministic — there is no
`k·pooledStdDev` to compute (it's always 0), so running 10 identical builds would just be 10 identical
numbers dressed up to look like a real noise table. The gate for `bundle-size` collapses to
`improvement > minEffect`, and `minEffect` (default 1024 bytes) is a genuine practical-significance
judgment, not a value an N-run protocol could ever derive — see `references/presets.md`'s `bundle-size`
entry for the reasoning and the caveat that 1KB is a starting point, not a derived constant.

## Observed noise — `layout-shift` / CLS — bimodal, two gate methods

**Single-shift target:** a local page serving one real remote image (`picsum.photos`, real network
jitter, no explicit width/height so it causes one discrete layout shift when it loads) captured 3 times
via `performance_start_trace` under `first-load`'s throttled `emulate` settings. All 3 runs produced the
exact same CLS value to full floating-point precision (`0.01528342692057292`, 1 shift event each time)
— not just the same rounded score, the same raw `weighted_score_delta`. For this shape (one element,
fixed final size, shifts once when it loads), CLS is deterministic the same way `bundle-size` is: the
shift's *magnitude* comes from layout math, not from anything network- or timing-sensitive.

**Second, multi-shift target: 5 runs, real bimodal variance.** A local page with
3 independent images (different sizes, different byte-cache-busted seeds per run so each run is a real,
uncached network fetch), same throttled `emulate` settings, `performance_start_trace{autoStop:false}` +
a load-completion marker so the trace only stops once all 3 images have actually loaded (the same
`autoStop` gotcha as `interaction` — the default `autoStop:true` window is too short for real network
image loads and silently produces `cls:0` for the wrong reason, missing the shifts entirely rather than
observing that none occurred).

Result across 5 runs: `0.101, 0, 0, 0, 0` — not noise around a mean, a **zero-inflated bimodal
distribution**. Root cause, confirmed by comparing each image's `ResourceReceiveResponse` timestamp to
the page's LCP timestamp: when all 3 images resolve before first paint, they render in their final place
from frame one — nothing was ever visible then moved, so CLS is genuinely (not just measured-as) zero.
When even one image resolves after first paint, its arrival visibly shifts already-painted content,
producing a real nonzero score. Which case happens is a race between real network arrival time and paint
timing, not a fixed property of the page.

**This breaks `max(minEffect, k·pooledStdDev)` structurally, not just numerically.** That formula
assumes a roughly continuous noise distribution around a true value; a mix of "almost always exactly
zero" and "occasionally a real nonzero shift" isn't noise around a mean; a handful of samples landing on
either side of the race changes both the mean and the stddev by a large relative amount, and `k` was
never meant to characterize a two-population mixture. Don't retrofit `stats.mjs`'s existing `gate()`
formula onto CLS by reasoning alone — that's exactly the kind of unverified gate this project's own
discipline exists to prevent.

### Resolution: two page shapes, two gate methods (one needs no new code)

**Deterministic shape (single-shift target above) — gateable today, no new code.** With zero variance
across runs, `pooledStdDev` is 0, so `gate()`'s existing `noiseBand = max(minEffect, k·pooled)`
collapses to `improvement > minEffect` — exactly `bundle-size`'s pattern. `stats.mjs`'s self-test pins
this using the real captured constant (`0.01528342692057292` × 3) as a regression test.

**Race-driven shape (multi-shift target above) — needs `gateOccurrence()`.** A paired sign test on
magnitude differences degenerates here, because most pairs are `(0, 0)` → tied → dropped by
construction, and what survives reduces to exactly the occurrence-rate question; pairing run *i* of
baseline against run *i* of candidate also isn't true pairing (no shared source of variance — each run
is an independent network race), so it buys little even where it applies. `stats.mjs` exports
`gateOccurrence({ baseline, candidate, alpha })`: treat "did a shift happen at all" as a binary 0/1 per
run, compare baseline vs candidate occurrence rates with Fisher's exact test on the 2×2 table,
one-tailed (also reachable via the CLI: `--mode occurrence`).

**The real constraint is the target's baseline occurrence rate, not sample size alone.** Exact
Fisher one-tailed p-values, n=10 runs per arm, candidate = complete elimination of shifts (0/10):

```
baseline 1/10 nonzero -> p = 0.500   (not significant)
baseline 2/10 nonzero -> p = 0.237   (not significant)
baseline 3/10 nonzero -> p = 0.105   (not significant)
baseline 4/10 nonzero -> p = 0.043   significant
baseline 5/10 nonzero -> p = 0.016   significant
baseline 8/10 nonzero -> p = 0.0004  significant
```

The multi-shift target captured above had a ~20% baseline occurrence rate (1/5). At that rate, **even a
perfect fix cannot clear a Fisher-exact gate at n=10, α=0.05.** A target needs a baseline occurrence
rate of roughly ≥40% before n=10 runs/arm can detect a complete fix at all, and partial improvements
need considerably more. This is a property of the target page, not a tuning knob — don't raise `alpha`
or shrink `n` to force a pass; per the standing ship rule above, change the target or accept the target
can't be gated at this N, never loosen the test to hide the constraint.

### Worked example — race-driven CLS fix

A minimal static page (one hero `<img>`, no reserved space, text below it) served by a tiny local Node
HTTP server whose response for that image is delayed by a randomly-drawn amount (3-8ms window) each
request produces a genuine race between network arrival and the browser's actual first-paint timing —
the fix removes the race by reserving space, not by removing a random branch. `perf_scan.mjs`'s
`imageNoDims` detector flags this exact markup.

Drive: fresh browser context per run, `performance_start_trace {autoStop:false}` + a load-completion
marker (the image's `load`/`error` event flips a visible text node), `wait_for` that marker, then stop
the trace — same shape as the other presets. Full propose→apply→re-measure→gate→commit cycle (loop
steps 4/5/6, snapshot-and-restore isolation, `git add <path>` not `-A`), N=10 runs/arm:

```
baseline (unfixed <img>, no width/height):  0,1,1,1,0,1,1,1,1,1   — 8/10 occurrence (0.8)
candidate (width="600" height="400" added): 0,0,0,0,0,0,0,0,0,0   — 0/10 occurrence (0.0)
```

```bash
node scripts/stats.mjs --baseline "0,1,1,1,0,1,1,1,1,1" --candidate "0,0,0,0,0,0,0,0,0,0" --mode occurrence
# pValue 0.0004 < alpha 0.05 -> KEEP
```

`gateOccurrence()` returns KEEP on this real, measured, race-driven CLS fix.

## Observed noise — `interaction` / INP

N=10 real captures against nextjs.org (unchanged), one trusted click per capture (dismissing the
real cookie-consent dialog via chrome-devtools-mcp's `click` tool — the only interaction present on
a cold load of that page), under the same throttled `emulate` settings as `first-load`, fresh
`isolatedContext` per run.

**The drive sequence matters and is easy to get silently wrong.** `performance_start_trace`'s
defaults (`reload: true, autoStop: true`) stop the trace when load settles, before any click — zero
`EventTiming` interactions. The working sequence: `new_page{isolatedContext}` → `emulate` →
`performance_start_trace {reload: true, autoStop: false}` → `wait_for` the target element →
`click` → `performance_stop_trace` → `trace_metrics.mjs`. **The click must go through the `click`
(or `type_text`) tool, never `evaluate_script`.** Verified directly: an `evaluate_script` call that
ran `element.click()` produced a trace with no `INP:` line at all in chrome-devtools-mcp's own
insight summary — the Event Timing API only tracks trusted, input-pipeline-originated events, and a
JS-dispatched `.click()` isn't one. `computeINP` would silently return `null` on every measurement
using that path, with no error to signal it. Drive **exactly one interaction per capture**, so
`computeINP`'s "max duration" is unambiguously that one interaction, not an approximation across
several.

Raw INP (ms), in capture order: `72.954, 64.199, 64.899, 69.923, 69.173, 64.954, 66.524, 71.317,
73.138, 57.667`. Overall: **mean 67.47 ms, stddev 4.79 ms (7.1% of the mean)** — noisier in relative
terms than `first-load`'s LCP (1.5%), but still tight in absolute terms because this specific
interaction (a consent-dialog dismiss) does very little work of its own; most of its ~65-70ms
duration is browser input-pipeline/event-dispatch overhead, not app code. Every `computeINP` value
was cross-checked against chrome-devtools-mcp's own `performance_analyze_insight` reading for the
same capture and matched to within ~1ms on all 10 runs.

Same-run TBT (long-task total across the whole trace, `computeLongTasksAndTBT`): `581.955, 513.114,
549.506, 544.481, 512.254, 520.542, 539.792, 564.548, 445.706, 410.495`ms — mean 518.24ms, stddev
53.0ms (10.2% of the mean). **This number does not measure the interaction's own cost** —
`computeLongTasksAndTBT` sums long tasks over the *entire* post-navigation trace (a stated,
documented limitation of that function, not new here), and an interaction capture's trace spans the
full page load plus the later click. On this fixture all 13 long tasks are page-load janks from
nextjs.org's own scripts; none are attributable to the one-line consent-dialog handler. **The
pre-agreed long-task-total fallback is a worse proxy for interaction cost here, not a better one** —
it's dominated by an unrelated quantity (page-load jank) that has nothing to do with what
`interaction` is trying to measure.

Split into two groups of 5 (`stats.mjs`, k=2): INP noise band **10.02ms** (pooled stddev 5.01ms);
TBT noise band **101.05ms** (pooled stddev 50.53ms).

**Acceptance check:** 20% of the observed INP mean (67.47ms) is ~13.5ms. The INP noise band
(~10ms) clears that — a real 20% improvement is distinguishable from noise, but only by roughly
**1.3×**, not the ~6× margin `first-load` had. This is a **marginal pass, not a comfortable one**:
call any win under ~2× the noise band (≤20ms) marginal, and re-characterize before trusting a thin
result. TBT's 20% mark (~103.6ms) sits almost exactly at its own noise band (~101ms) — it does not
clearly clear the bar either, on top of being the wrong quantity (above). **`interaction` ships
gated on INP directly, not the long-task-total fallback** — INP is both the metric that actually
maps to the interaction under test and the one whose noise band verifiably clears the acceptance
bar; the plan's pre-agreed fallback would have been both noisier here and measuring the wrong thing.

**`minEffect` set to 10ms** — matching the noise band, same conservative-placeholder logic as
`first-load`'s 30ms (redundant with `k·pooledStdDev` by construction, not an independently derived
practical-significance judgment). **This characterization covers exactly one interaction shape** (a
near-instant dialog-dismiss with almost no handler-side work) **on one site** — a target app's real
interactions (a search-filter recompute, a modal open with a heavy re-render) will very likely have
both a higher INP mean and different noise characteristics. Re-characterize on the actual target
before trusting 67ms/10ms as anything but the shape of the result, not its value. If a target's INP
noise band doesn't clear its own 20% bar, the long-task-total fallback remains available in
principle but needs its own scoping fix first (clip to a window around the interaction, not the
whole trace) — that's a `trace_metrics.mjs` change, not something to invent ad hoc mid-run.
