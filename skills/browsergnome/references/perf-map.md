# Perf Map 3D

Static, browser-free scan of a web repo → interactive 3D graph + Top-3 worst performance offenders.
Nodes = source modules; edges = imports. Node **size = perf debt**, **color = severity**. Pipeline:

```
perf_scan.mjs  <repo>  -> graph.json        (Babel AST + detectors + scoring)
build_perf_map.mjs  graph.json  -> perf-map.html   (vendored 3d-force-graph + data, inlined, offline)
```

`build_perf_map.mjs --open` opens it; click any node for the flaw + `file:line` + a `references/knowledge/` topic. All tuning is in `perf_scan.mjs`'s `CONFIG` block.

## The detectors

| Detector | Pattern | Severity | Preset |
|---|---|---|---|
| `nestedComponent` | a named component defined inside another component | HIGH | interaction |
| `effectNoCleanup` | `useEffect` adds a listener/timer/observer, returns no cleanup | HIGH | interaction |
| `indexAsKey` | `key={index}` where `index` is the `.map()` callback's own index param | HIGH | interaction |
| `heavyEntryImport` | full-package import of a heavy lib at an app-entry file | HIGH | first-load |
| `imageNoDims` | `<img>`/`<Image>` with no explicit width/height (and no `fill`) | HIGH | layout-shift |
| `clientComponentInServerTree` | `'use client'` directive at a high-fan-in module | HIGH | first-load |
| `syncScriptInHead` | raw `<script src>` with no `async`/`defer` | HIGH | first-load |
| `listRowNoMemo` | a list-row component used in a `.map()` but not `React.memo` | MEDIUM | interaction |
| `unvirtualizedLongList` | `.map()` renders JSX over a non-literal array with no virtualization lib imported | MEDIUM | interaction |
| `barrelImport` | named import that resolves to a re-export barrel file | MEDIUM* | bundle-size |
| `nonLazyRoute` | a file that imports a routing lib also statically imports local route components | MEDIUM | bundle-size |
| `fontNoDisplaySwap` | `next/font` call with an explicit non-`swap` `display` value | MEDIUM | layout-shift |
| `largeStaticImport` | JSON/SVG import over 8KB into a shared module | MEDIUM | bundle-size |
| `inlinePropLiteral` | inline arrow / object literal as a JSX prop | LOW | interaction |

`*` `barrelImport`'s severity **label** is MEDIUM (real shipped-byte cost), but its scoring weight is
overridden lower and it's scored as cosmetic (no centrality amplification) — see the calibration note
below. Its tooltip/priority still reads MEDIUM.

`listRowNoMemo` and `inlinePropLiteral` are suppressed entirely when React Compiler is detected
(`babel-plugin-react-compiler` in a babel config, or `experimental.reactCompiler`/`reactCompiler: true`
in `next.config.*`) — on a compiler-enabled repo they're dead findings that would flood the map. Force
detection off with `--no-compiler-detect` for calibration.

## Scoring — and why signal beats noise

**Signal vs noise** is the core design invariant: web static heuristics (inline props, barrel
re-exports) fire constantly in healthy, well-tree-shaken code. Four mechanisms keep the map honest:

1. **Severity weights.** CRITICAL 10 · HIGH 5 · MEDIUM 1.5 · LOW 0.4, with a per-detector
   `weightOverride` escape hatch for the one case where a detector's severity *label* and its scoring
   *weight* need to diverge (see calibration note).
2. **Per-detector diminishing returns.** Past `diminishAfter` (3) hits of the same detector per file,
   extra hits add only `log2`.
3. **Structural-only centrality.** `debt = structuralRaw · centralityMult + cosmeticRaw`, where
   `centralityMult = 1 + k·log2(1+fanIn) + (hasList ? listBonus : 0)`. Fan-in amplifies MEDIUM+ debt,
   not LOW noise.
4. **Combined gate.** Hotspot iff `debt ≥ hotspotDebt (6)` **OR** any HIGH/CRITICAL finding.

### Calibration note — `barrelImport` needed a carve-out (excalidraw)

Promoting `barrelImport` from LOW to MEDIUM (it costs real shipped bytes, unlike RN where it was purely
cosmetic) initially broke the noise invariant: on a real-app calibration run (excalidraw,
`4872083c`, 527 modules), it drove **29 of 69 hotspots alone** — 3-4 barrel imports in one file, common
import hygiene in a well-structured repo, crossed the hotspot gate by itself via centrality
amplification. Root cause: unlike a re-render bug or a leak, barrel-import cost is a flat per-barrel
bundler tax that doesn't compound with a file's fan-in — it shouldn't get the structural-only
centrality boost at all. Fix, in two parts:

- `barrelImport` is bucketed as **cosmetic** (no centrality amplification) despite its MEDIUM severity
  label — the structural/cosmetic split is now keyed off detector identity, not severity tier, for this
  one case.
- Its scoring weight is overridden to `0.6` (`CONFIG.weightOverride`) — between LOW and MEDIUM — so it
  still counts meaningfully when combined with real structural findings but can't manufacture a hotspot
  alone at any realistic occurrence count in one file.

Result: 69 → 33 → **16 hotspots**, zero of them driven by a single detector acting alone. Target for a
legible map is ~15-25 hotspots on a real app; re-tune `weightOverride`/`hotspotDebt` if a different real
target lands outside that band, but don't touch this by reasoning alone — verify against a real repo (see
the calibration rule below).

> If a scan lights up too much, raise `hotspotDebt`, lower a severity, or add a `weightOverride` entry.
> Tune against the real target repo, never a fixture — a fixture is circular by construction (it
> contains exactly what the detectors hunt), proving detectors *fire*, not that they're selective.

## Display filter & search

Only nodes with `debt ≥ displayMinDebt` (default **2**) render — dropping near-zero noise while keeping
structural and accumulated debt. Adjustable live via the `min debt` control. Non-hotspot nodes with
debt 2-6 render grey. `window.__perfmap` exposes `focusNode`, `applyThreshold`, and `rankMatches` for
automated verification.

## Import resolution (correctness, not cosmetics)

Real web apps import almost everything through **path aliases** (`@/…`, `#/…`) or workspace packages
(`@scope/pkg`), not `../`. `perf_scan.mjs` reads `tsconfig.json`/`jsconfig.json` `compilerOptions.paths`
from the scan root up — confirmed working on excalidraw's workspace-package aliases (13 aliases
resolved, 2504 edges across 527 modules). Without this the graph is a disconnected cloud and centrality
is meaningless.

## Attribution confidence (LCP Attribution Map)

The static Perf Map above scores *heuristic* debt. The LCP Attribution Map is a different, stricter
surface: node size there is a **measured millisecond**, not a heuristic score, and the map must visually
distinguish measured nodes (network resources, chunks) from apportioned ones (source modules, split from
chunk cost by byte share). `scripts/lcp_attribution.mjs` is that data layer — three tiers, each tagged
`confidence: 'measured'` or `'apportioned'`, real fixture-verified (25 self-test assertions):

| Class | `ms` from | Confidence | Source |
|---|---|---|---|
| **Network resources** | raw `ResourceSendRequest`/`ResourceReceiveResponse`/`ResourceFinish` trace events, render-blocking + started-before-LCP, clipped to the LCP window | **measured** | `attributeNetworkTier` |
| **Chunks** | `trace_metrics.mjs`'s `computeScriptTimings` (compile+evaluate ms per script URL) | **measured** | `attributeChunkTier` |
| **Source modules** | `chunk_ms × (module_bytes ÷ SUM of that chunk's own module bytes)` — deliberately NOT `÷ chunk.bytes` (the chunk's shipped asset size), which is a different, larger number and would under-attribute every module; see the file's header comment for the real numbers that caught this | **apportioned** | `apportionModuleMs` |

Two facts about this data layer, not assumptions — full detail in `scripts/lcp_attribution.mjs`'s file
header: (1) `performance_analyze_insight`'s RenderBlocking/LCPBreakdown/DocumentLatency insights return
semi-structured text, not JSON, so the network tier reads raw trace events instead — matches the
insight tool's own reported durations on a real nextjs.org capture to ~1ms agreement on all 6
render-blocking requests; (2) the module-apportionment ratio divides by the chunk's own module-byte sum,
not the shipped asset size — asset bytes 11886 vs. module-byte sum 7546 for the same chunk, a materially
different denominator that would have under-attributed every module.

The trace-URL ↔ bundle-stats-chunk matching glue (`matchChunkToUrl`) is a filename suffix match: a
trace script URL is always `<origin>/<path>/<file>`, and a bundle-stats chunk record carries just
`<file>`, so `url.endsWith('/' + chunk.file)` is the correct match, not equality.

### Rendering pass — `build_lcp_map.mjs`, built

```
lcp_attribution.mjs  <trace> [bundle-stats]  -> attribution.json
build_lcp_map.mjs  attribution.json  -> lcp-map.html   (vendored 3d-force-graph + data, inlined, offline)
```

Mirrors `build_perf_map.mjs`'s marker-based split/join exactly (`/*__FORCE_GRAPH_LIB__*/` and
`/*__LCP_DATA__*/`, standalone HTML, `--out`/`--open`). Since `lcp_attribution.mjs` is data-layer only
(no render hints), `build_lcp_map.mjs` adds the one small `val`/`color` step itself — the same job
`perf_scan.mjs` does before `build_perf_map.mjs` ever runs.

First-pass scope: nodes sized by `ms` (sqrt-scaled), force-laid-out, colored by class (network/chunk/
module — kept off the page's single brand accent so the two don't collide), measured vs apportioned
distinguished by opacity (solid vs translucent, explained in the legend and on click), a click panel
with bytes/ms/confidence/attribution method. The degraded chunk-only path (no bundle stats) renders as
first-class — a red banner, module count 0, everything else unchanged — since Vite and Turbopack targets
hit it routinely (see `references/bundlers/vite.md` / `turbopack.md`).

Standalone: every `http(s)://` string in the merged output outside the injected data blob belongs to the
vendored 3d-force-graph library's own internal comments (a GitHub credit, W3C namespace URIs, shader
attribution) — nothing the page actually requests.

**Explicitly deferred:** Z-axis elevation by execution order, the red LCP plane,
click-to-collapse causal chains, node-shrink-on-KEEP animation. The causal-chain feature needs
edge/initiator data (`ResourceSendRequest.args.data.initiator`) that `buildAttributionData` doesn't
currently emit — a data-layer change, not a rendering one, and belongs in a follow-up to
`lcp_attribution.mjs`.

Dark canvas (`#0b0e14`, never pure black), one accent under 80% saturation (violet, chrome/brand only —
kept out of the network/chunk/module palette), monospace numbers, `prefers-reduced-motion` respected.
`perf-map.template.html` stays light-themed — its own header comment already noted the dark-canvas
treatment would land with this map, and it has.

## Top-3 emission

`graph.json` includes a `top3` array (also printed by `perf_scan.mjs`) of ready-to-paste Autoresearch
commands. Present them verbatim:

```
1. [debt 34.56] /browsergnome layout-shift --target ExampleApp
     Image without explicit dimensions (img) at examples/with-script-in-browser/components/ExampleApp.tsx:543
```

`--target` is the component/route name (for `index.*` files, the parent folder); the preset comes from
the dominant finding. Pasting one into Autoresearch closes the diagnose→fix loop.
