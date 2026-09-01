# Architectural Performance Catalog

Reasoning corpus for the **Senior Engineer Audit** (menu item 5). Each entry: **symptom · why it
costs · how to spot · gate preset (or advisory note if ungated)**. Four entries are web-substrate
specific (RSC boundaries, provider nesting, waterfall data fetching, shared layout bloat); the rest
are architectural React reasoning that applies regardless of runtime (state placement, referential
stability, code-splitting, render cascades).

---

## Diagnostic Thresholds — The Signal-vs-Noise Floor

| Signal | Threshold | Interpretation |
|---|---|---|
| **Render duration** | **> 16 ms** | Real problem — drops below 60fps frame budget |
| **Render duration** | 1–16 ms | Candidate — worth investigating if it recurs |
| **Render duration** | **< 1 ms** | Not your problem — do not report |
| **Long Task** | **≥ 50 ms** | Blocks user input; INP risk (`computeLongTasksAndTBT`'s own threshold) |
| **INP** | target **< 200 ms** | Interaction to Next Paint budget (Core Web Vital) |

**Rule:** never optimize without profiling. Reporting sub-1ms findings as hypotheses is noise.

**Gate presets available on web** (no render-count gate exists — see `references/presets.md`):
`first-load` (LCP) · `layout-shift` (CLS) · `bundle-size` (shipped bytes) · `interaction` (INP). A
finding without a clean mapping to one of these is **advisory** — say so plainly, don't invent gate
coverage that doesn't exist.

---

## Architectural Anti-Pattern Catalog

### 1. RSC Boundary Placement — `'use client'` Pushed Too High

**Symptom.** A `'use client'` directive sits at a high-fan-in node (a shared layout, a root
provider, a widely-imported component) rather than at the leaf that actually needs interactivity.
Everything below that boundary — including children that are themselves static — ships to the
client bundle and loses server-rendering's free-JS advantage.

**Why it costs.** React Server Components' entire value proposition is zero client JS for
non-interactive subtrees. A `'use client'` boundary one level too high silently converts an entire
subtree from "free" to "shipped, hydrated, and executed" — the cost scales with the subtree's size,
not the interactive part's.

**How to spot.** `perf_scan.mjs`'s `clientComponentInServerTree` detector flags this mechanically
(Perf Map territory) — the audit layer explains blast radius: read the boundary component, count how
many descendant components are genuinely static vs. actually need the client runtime. A `'use
client'` file that imports and re-exports several unrelated components is a common way this
happens by accident.

**Gate preset.** `bundle-size` (client-bundle bytes, before/after moving the boundary down) —
`first-load` also moves if the removed JS was on the LCP-critical path, but `bundle-size` is the
more direct, less noisy measurement for this specific fix.

---

### 2. Provider Nesting / Context Shape — Over-Broad or Merged Value+Setter

**Symptom.** A root-level Context Provider whose `value=` prop is an object literal
(`{ state, dispatch }`) or a merged-state object, at a high-fan-in point in the tree (often a root
layout). Any change to *any* slice of that object triggers a re-render in *every* consumer, even
ones reading a single unrelated field.

**Why it costs.** React compares Context values by reference. A new object literal on every render
is a new reference — every consumer re-renders regardless of which field it actually reads. A theme
or auth context wrapping the whole app re-renders the whole app on every state change if not split
or memoized.

**How to spot.** Find `createContext`/Provider usages, especially in root layouts (`app/layout.tsx`,
`_app.tsx`) or root providers. Flag object-literal or merged-state `value=` props. Count consumers
(`useContext(...)` call sites) to establish blast radius.

**Gate preset.** Advisory — none of the four web presets measures render count directly.
`interaction` may show a partial signal if the re-render cascade is heavy enough to affect INP on a
real interaction, but that's an indirect, noisier proxy — don't claim it as direct proof.

---

### 3. Waterfall Data Fetching — Sequential Where Parallel Would Do

**Symptom.** A route's data-loading phase (RSC `await` chains, Remix/TanStack Start loaders, `next
export const dynamic` fetches) resolves sequentially when the fetches have no logical dependency:
fetch user → then fetch posts → then fetch followers, when all three could start together.

**Why it costs.** Each waterfall step adds a full round-trip to TTFB/render-delay. On a 100ms-RTT
connection, three sequential fetches cost 300ms minimum where `Promise.all`-parallelized fetches
cost roughly the slowest single response. This shows up directly in `LCPBreakdown`'s render-delay
(App Router: server-side await chain) or TTFB (a slow single loader) phase — see the matching
`frameworks/*.md` entry for which phase a given framework's data-loading model maps to.

**How to spot.** Read the route's server-side data-loading code (RSC component body, `loader`
function, `getServerSideProps`). Flag sequential `await` calls with no data dependency between them.
Framework-specific parallel-fetch idioms exist (`Promise.all`, React Router's parallel loaders by
default — see `frameworks/remix.md`) — check whether the framework's own parallelism is being
defeated by an artificial dependency (e.g. awaiting a parent's data before a child fetch that
doesn't actually need it).

**Gate preset.** `first-load` (LCP, via `LCPBreakdown`'s TTFB or render-delay phase depending on the
framework — see the matching `frameworks/*.md` entry). Partial coverage: this catches the
LCP-visible effect of a waterfall, not every waterfall (one that resolves after LCP but before full
interactivity wouldn't move the LCP number).

---

### 4. Shared Layout Bloat

**Symptom.** A root or shared layout component (`app/layout.tsx`, a shared `<AppShell>`, a top-level
`_app.tsx`) eagerly imports providers, navigation components, or libraries that only a subset of
routes actually need — every route pays the cost of the layout's full import graph, even routes that
never touch the unused parts.

**Why it costs.** A shared layout sits above every route by definition — its import graph is the
floor for every page's bundle, not a ceiling any route can opt out of. A heavy analytics SDK, a
rarely-used modal library, or a large icon set imported at the layout level ships on every single
page load regardless of whether that page uses it.

**How to spot.** Read the root/shared layout file(s) directly. Cross-reference against
`graph.json`'s centrality data — a layout file is definitionally the highest-fan-in node in the
tree, so its own import list is the audit target, not its fan-in score (which will always be
maximal and uninformative on its own). Look for a heavy library import, a provider that's only
needed on a subset of routes, or a component imported eagerly that could be route-scoped instead.

**Gate preset.** `bundle-size` (shipped bytes for a route not actually using the moved import) +
`first-load` if the removed weight was blocking the LCP-critical path.

---

### 5. Referential Instability Defeating `memo`

**Symptom.** A component wrapped in `React.memo` still re-renders on every parent render because its
props include object/array literals or inline function definitions that create new references each
time.

**Why it costs.** `memo` compares props by reference. `style={{ color: 'red' }}` or an inline
`onClick={() => ...}` creates a new reference every render — the memo is installed but provides zero
benefit, and this is easy to miss because the fix (adding `memo`) *looks* present.

**How to spot.** `perf_scan.mjs`'s `inlinePropLiteral`/`listRowNoMemo` detectors flag this
mechanically (suppressed automatically when React Compiler is detected — see
`references/perf-map.md`). The audit layer explains blast radius when the affected component sits
under a high-render-frequency parent.

**Gate preset.** Advisory — no direct web render-count gate. If the component sits on the
interaction-critical path, `interaction` (INP) may show a partial signal.

---

### 6. Components Defined Inside Components — Silent Remounts

**Symptom.** A component function is declared inside the body of another component function. On
every parent render, React sees a *new* component type and unmounts/remounts the child — destroying
local state, tearing down and re-running effects, losing focus, resetting transitions.

**Why it costs.** A remount is orders of magnitude more expensive than a re-render: DOM node
destroy+recreate, full effect teardown/re-run, focus loss. This is invisible in a quick read of the
JSX — it only shows up when tracing where the inner function is *declared*, not where it's used.

**How to spot.** `perf_scan.mjs`'s `nestedComponent` detector flags this mechanically. The audit
layer explains why it's architecturally costly beyond the linter hint — a component-tree read is
still worth doing to confirm the child isn't trivially cheap to remount (a truly stateless leaf with
no effects pays little for this pattern; a form field or an animated element pays a lot).

**Gate preset.** Advisory — no direct web render-count gate to prove a remount count dropped to
zero. `interaction` may show a partial signal if the remount happens on the interaction path.

---

### 7. Main-Thread Blocking — Missing Concurrent Features

**Symptom.** A synchronous, expensive computation (filtering/sorting/reducing a large array,
computing derived state) runs in the render or event-handler path without `useTransition`,
`useDeferredValue`, or `startTransition`. A user interaction (typing, clicking a filter) freezes the
UI for >50ms while the computation completes.

**Why it costs.** JavaScript is single-threaded — any synchronous work over ~50ms is a Long Task
that blocks input processing, directly inflating INP. The fix is not necessarily "make the
computation faster" (though that helps) but to deprioritize it so the browser can paint the user's
input feedback first.

**How to spot.** Read event handlers and render-path computations feeding a visual list or
derived-data view: `.filter()`/`.sort()`/`.reduce()` on arrays that could realistically exceed ~100
items, not wrapped in a concurrent-rendering primitive.

**Gate preset.** **`interaction` (INP) — this is the one entry in this catalog with a direct,
non-advisory web gate.** Drive the actual interaction that triggers the computation, measure INP
before/after wrapping it in `useTransition`/`useDeferredValue`.

---

### 8. Loading Strategy — Over/Under Code-Splitting

**Symptom A (under-split / eager).** A root layout or router imports every route/screen's heavy
dependencies eagerly at the top level. Every added route grows every other route's first-load
bundle, silently.

**Symptom B (over-split / fragmented).** Granular lazy boundaries (`React.lazy`, `next/dynamic`)
around components that are always shown together, causing an unnecessary async-loading waterfall
with no real first-load benefit.

**Why it costs.** Under-splitting: every eager import adds parse+eval time before the first
interactive frame, and the cost is invisible per-change (each new import is small; the aggregate
isn't). Over-splitting: the async round-trip penalty exceeds the lazy-loading benefit for content
users always see immediately.

**How to spot.** `perf_scan.mjs`'s `nonLazyRoute` detector flags eager route-level imports
mechanically (see `references/perf-map.md` for exactly what it checks — real `<Route
element=.../component=...>` bindings and data-router `{ Component: X }` entries, not every import in
a file that happens to import a routing library). Read the root layout/router for eager imports of
route-scoped heavy dependencies; check for `React.lazy`/`next/dynamic` wrapping content that's
always immediately visible (over-split).

**Gate preset.** `bundle-size` (for under-split — bytes moved out of the shared/eager bundle) or
`first-load` (for the LCP-visible effect of either direction).

---

### 9. Over-Memoization Debt Under the React Compiler

**Symptom.** The codebase is dense with manual `useMemo`/`useCallback` that predate or ignore the
React Compiler. With the Compiler enabled, these wrappers are counterproductive — the Compiler
inserts optimal memoization itself, and manual wrappers add call overhead and can interfere with the
Compiler's own analysis. Alternatively: the Compiler isn't enabled at all, meaning all manual
memoization is the only option today (different remediation — enable the Compiler, don't strip the
wrappers first).

**Why it costs.** Every manual `useMemo`/`useCallback` adds a function call, a dependency-array
allocation, and a comparison on every render. In a codebase with hundreds of these, the aggregate
overhead is measurable and the code complexity is real debt either way.

**How to spot.** Count `useMemo`/`useCallback` call sites. Check for `babel-plugin-react-compiler` or
`experimental.reactCompiler`/`reactCompiler: true` in config (the same string-matched, never-executed
check `perf_scan.mjs`'s React Compiler suppression uses — see `references/perf-map.md`). If the
Compiler is absent on a React 19+ codebase, the fix is enabling it, not stripping wrappers first.

**Gate preset.** Advisory — no direct web render-count gate. `interaction` may show a partial signal
if the affected component sits on the interaction-critical path.

---

### 10. Render Cascades — Chained Effects and State Updates

**Symptom.** A state update in one component triggers a visible render chain through multiple
unrelated components before the user sees a response — often via chained `useEffect`s that each
trigger their own `setState`. Shows as sluggishness even when no single render is individually
expensive.

**Why it costs.** Cascades compound latency: each render in the chain adds its own scheduling
overhead and reconciler pass, synchronous by default. Four renders for one user action means four
times the scheduler overhead.

**How to spot.** Read the component tree for the affected interaction path. Identify `setState`
calls and `useEffect` triggers that fire sequentially in response to one user action. A chain of two
or more effects that each trigger a further state update is a cascade regardless of individual
render cost.

**Gate preset.** `interaction` if the cascade is triggered by a real user interaction (INP captures
the cumulative cost of the chain, not just the first render) — otherwise advisory.

---

To extend: copy an entry's shape.
