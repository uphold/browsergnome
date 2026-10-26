# Page Tools + React provider — design

**Date:** 2026-10-26 · **Status:** implemented on `feature/page-tools-react`

## 1. Intent

browsergnome measures web perf through `chrome-devtools-mcp`, which sees the DOM, network, and trace
events but not framework internals. Chrome DevTools for agents ships an experimental
**third-party developer tools** API: a page-side script registers tool groups, the agent discovers
them with `list_3p_developer_tools` and calls them with `execute_3p_developer_tool`.
`react-devtools-cdt-mcp` (React team, MIT) is the first provider built on it: component tree, props,
hooks, owner stacks, source locations, and commit-level render profiling.

This spec adds:

1. A framework-neutral **Page Tools** layer: inject a provider script into the target page with zero
   edits to the target repo, discover its tools, run a dev server for the pass and always tear it down.
2. A **React provider** on that layer, consumed by four features: INP blame, a new `re-renders` gate
   preset, Senior Audit runtime evidence, and a Perf Map render overlay.

**Success:** on any React target doctor detects, every feature above runs with no change to the
target repo's files, no dev server or local server left running afterwards, and the existing four
prod-build gates unchanged.

## 2. Decisions (settled)

| # | Decision |
|---|---|
| D1 | Addition, never a replacement. The prod-build gate (`first-load`, `bundle-size`, `interaction`, `layout-shift`) is untouched; React passes are a separate dev-server diagnostic pass. |
| D2 | Used by every feature it adds value to: INP blame, `re-renders` preset, Senior Audit, Perf Map. |
| D3 | Zero-touch injection via `navigate_page{initScript}` with a tiny loader, re-passed on every reload. |
| D4 | `--categoryExperimentalThirdParty` always on in `.mcp.json`. |
| D5 | `react-devtools-cdt-mcp` is a pinned (exact) runtime dependency of this plugin, installed by the `SessionStart` hook. Amends CLAUDE.md's "only `@babel/*`" rule. |
| D6 | `re-renders` gates on **total components rendered** (Σ `componentsChanged` across commits) for one fixed interaction. |
| D7 | The agent starts the target's dev server on demand for page-tools passes and **always** kills it (and the script server) afterwards, including on error/abort. |
| D8 | Auto-enabled when doctor detects a provider's trigger dependency; `pageTools` config key controls it. |
| D9 | Generic injection layer, React-specific semantics on top. No framework-neutral capability interface until a second provider exists. |
| D10 | Preset name stays `re-renders` (matches metrognome's RN preset); documented as requiring the React provider. |

## 3. Spike evidence (basis for D3/D6)

Run against a stock Vite React app (`create-vite --template react`, dev server), headless
`chrome-devtools-mcp@1.6.0 --categoryExperimentalThirdParty`, driven by an MCP stdio client:

| Check | Result |
|---|---|
| Inline `initScript` = full `dist/register.js` (trailing `export {…}` line stripped), 122 KB | 12 `react_*` tools discovered |
| `initScript` = 125-char sync-XHR loader → local CORS server → indirect `eval` | 12 tools discovered |
| No `initScript` (control) | no tools |
| `react_get_component_tree` / `find_components` / `get_component_by_uid{includeHooks}` | correct tree, names, `useState` hook value |
| `react_get_component_source` | `{fileName:"http://localhost:5199/src/App.jsx", line:11, column:28}` |
| Profiling around 3 trusted `click`s, repeated ×3 | 3 commits / 50 `componentsChanged` per commit — identical across all 3 runs |
| `navigate_page{type:"reload"}` without `initScript` | tools gone |
| `navigate_page{type:"reload", initScript}` | tools present |
| Prod build (`vite build && vite preview`) | tree works but names are minified; profiling records no commits |

Wire-format facts: `execute_3p_developer_tool` takes `{toolName, params}` where `params` is a
**JSON string**. `dist/register.js` is a self-contained file (no imports) whose only ESM syntax is the
final `export { buildToolGroup, register };` line; it installs `__REACT_DEVTOOLS_GLOBAL_HOOK__` and
listens for `devtoolstooldiscovery`.

## 4. Architecture

```
                       ┌──────────────── Page Tools layer (framework-neutral) ────────────────┐
 doctor.mjs ──detect──▶│ providers: { react: {pkg, trigger, script} }                         │
  (pageTools, dev cmd) │ page_tools.mjs serve  ── localhost:<free>, CORS, strips final export │
                       │ page_tools.mjs loader ── prints the initScript loader for <port>     │
                       │ agent: dev server up ─▶ navigate{initScript} ─▶ list_3p ─▶ … ─▶ teardown │
                       └──────────────────────────────────────────────────────────────────────┘
                                         │ execute_3p_developer_tool (react_*)
            ┌──────────────┬─────────────┴──────────┬───────────────────────┐
       INP blame      re-renders preset      Senior Audit evidence    Perf Map overlay
   (interaction)    (gate: Σ componentsChanged)  (render findings gated)   (graph.json merge)
```

### 4.1 `scripts/page_tools.mjs` (new, standalone, self-testing)

Zero deps beyond Node stdlib; resolves provider scripts under `$CLAUDE_PLUGIN_ROOT/node_modules`.
Follows the repo's script conventions: CLI gated on the `pathToFileURL(process.argv[1])` guard
(it is imported by `build_perf_map.mjs`), `selfTest()` behind `--self-test`.

**Exports (pure, self-tested):**

- `PROVIDERS` — `{ react: { pkg: 'react-devtools-cdt-mcp', trigger: ['react-dom'], script: 'dist/register.js' } }`.
- `detectProviders(pkgJsonText)` → `string[]` of provider ids whose trigger appears in
  `dependencies`/`devDependencies`.
- `toClassicScript(src)` → strips the trailing `export { … };` statement; **throws** if any other
  top-level `import`/`export` remains (fails loudly on an upstream format change, same spirit as the
  marker-injection convention).
- `loaderScript(port, providerId)` → the one-line sync-XHR + indirect-eval loader for
  `http://127.0.0.1:<port>/<providerId>.js`.
- `renderTotal(overview)` → Σ `componentsChanged` over a `react_get_trace_overview` result; throws on
  a non-array / missing field (fail loud on output-format churn).
- `normalizeSource(fileName, origin)` → repo-relative path from the provider's `fileName`
  (`http://host:port/src/App.jsx` → `src/App.jsx`; also `webpack-internal:///./…` and
  `/@fs/<abs>` forms); returns `null` for anything unmappable (node_modules, unknown schemes).

**CLI:**

- `node page_tools.mjs serve --providers react [--port 0]` — HTTP server on `127.0.0.1`, port `0` =
  OS-assigned; prints `{"port":N,"pid":P}` as the first stdout line; serves
  `/<id>.js` = `toClassicScript(read(script))` with `Access-Control-Allow-Origin: *` and
  `Content-Type: text/javascript`; 404 otherwise. Exits on SIGTERM/SIGINT.
- `node page_tools.mjs loader --port N --provider react` — prints `loaderScript(N, 'react')`.
- `node page_tools.mjs --self-test`.

Self-test fixtures: an inline export-stripping fixture (accept/reject cases), `detectProviders`
cases, `renderTotal` against the spike's overview shape, `normalizeSource` per URL form. No network.

### 4.2 Page-tools pass protocol (agent, documented in `references/page-tools.md`)

1. **Preconditions:** `config.pageTools` non-empty; `react-devtools-cdt-mcp` resolvable under the
   plugin root; target has a dev script (doctor-reported).
2. **Start script server:** `page_tools.mjs serve --providers <ids>` in the background; read port + pid.
3. **Start dev server** on a free port using the framework catalog's dev-port flag (see §4.6); wait
   until the URL returns 200 (reuse doctor's `parseUrlProbe`).
4. **Navigate:** `new_page{isolatedContext}` → `navigate_page{type:"url", url, initScript: <loader>}`.
   Every reload in the pass is `navigate_page{type:"reload", initScript: <loader>}`.
5. **Discover:** `list_3p_developer_tools`. A missing `react` group = pass unavailable: report the
   cause (CSP blocking `eval`/XHR, injection after React, non-dev build) and fall back to the feature's
   non-page-tools behavior. Never fabricate React findings.
6. **Use tools** via `execute_3p_developer_tool{toolName, params: JSON.stringify(args)}`. Uids are
   per-page-load — re-acquire after any reload.
7. **Teardown (always, also on error/abort):** kill the dev server's **process group** and the script
   server pid; then confirm both ports are free (`lsof -nP -iTCP:<port> -sTCP:LISTEN` empty). A port
   still bound is reported as a blocker, not ignored.

Any provider-registered tools the target app ships itself also appear in step 5's listing and are
usable as-is; `references/page-tools.md` documents this.

### 4.3 Feature: INP blame (`interaction` preset)

Runs after the prod-build `interaction` gate produced a baseline, as a diagnostic step before
proposing a fix (SKILL.md loop step "propose"):

1. Page-tools pass (§4.2) on the same route.
2. `react_start_profiling{traceName}` → the **same trusted `click`** the preset drives → `react_stop_profiling`.
3. `react_get_trace_overview` → pick the commit with max `renderDuration`;
   `react_get_commit_report` → top 5 components by `selfDuration`.
4. For each: `react_get_component_source` + `react_get_owner_stack` → `normalizeSource` → `file:line`.
5. Output: ranked blame list feeding the fix proposal. Dev-build durations are **ranking only**; the
   KEEP/REVERT decision stays on prod INP.

### 4.4 Feature: `re-renders` preset (new, React-only)

- **Trigger:** "too many re-renders", "this list re-renders on every keystroke", Senior Audit render
  findings, or an INP blame list dominated by repeated commits.
- **Build:** dev server (exception to measurement.md's prod-build rule, justified because the metric is
  a structural count, not a timing). Documented in `measurement.md`.
- **Drive (per capture):** page-tools navigate (fresh load) → `wait_for` target → `react_start_profiling`
  → fixed interaction script (trusted `click`/`type_text`, identical each capture) →
  `react_stop_profiling` → `react_get_trace_overview` → `renderTotal()`.
- **Determinism check:** 3 baseline captures. All identical → **deterministic shape**: one capture per
  side, `gate({minEffect: 0})` (pooled stddev 0), ledger `mode: n/a (deterministic count)`.
  Not identical → **noisy shape**: N-run interleaved protocol with `gate({minEffect: 0, k})` as
  `first-load` does. Same two-shape pattern as `layout-shift`.
- **Metric:** Σ `componentsChanged` (lower is better). Includes host components and StrictMode's dev
  behavior; both sides share it, so it cancels.
- **Reported alongside, never gated:** commit count, top components by render count.

### 4.5 Feature: Senior Audit runtime evidence

- `senior-audit.md` / `SKILL.md`: web now has **five** gate presets. Render-cost findings
  (referential instability, nested components, render cascades, over-memoization) map to `re-renders`
  when the React provider is active, instead of **advisory**.
- During the audit's Grounding step, for the top render-cost hypotheses, a page-tools pass profiles
  the finding's interaction and attaches measured evidence (commit count, Σ components, top
  components with `file:line`). Without the provider, the findings stay advisory, as today.
- `architectural-perf-catalog.md`: render-cost entries' "Gate preset" field updated to
  `re-renders (React provider)`.

### 4.6 Feature: Perf Map render overlay

- The agent writes `.bgn/render-profile.json` from a page-tools profiling pass:
  `[{ file, renders, selfMs }]` — `file` via `normalizeSource`, aggregated per file across commits.
- `page_tools.mjs` exports `mergeRenders(graph, profile)` (pure): sets `renders`/`renderSelfMs` on
  each `graph.json` node whose `id` (the repo-relative file path `perf_scan.mjs` emits) equals
  `profile[i].file`; returns the unmatched entries so the agent can report them.
- `build_perf_map.mjs` gains `--renders <file>`: imports `mergeRenders` and applies it **before** the
  existing `/*__GRAPH_DATA__*/` injection. No new template marker.
- `assets/perf-map.template.html`: node tooltip shows render count / self ms when present; nodes
  without data render unchanged.
- `perf_scan.mjs` and its `CONFIG` are **not** touched.

### 4.7 Doctor

- `detectProviders` (imported from `page_tools.mjs`) → reported as a new `pageTools` axis line.
- Dev-script check: `package.json` `scripts.dev` presence → reported; missing = page tools unavailable.
- Install check: `react-devtools-cdt-mcp` resolvable under the plugin root at the pinned version.
- 3p flag check: `.mcp.json` args include `--categoryExperimentalThirdParty`.
- `checkVersionPin` keeps working with the extra `.mcp.json` arg (self-test fixture updated).
- `DEFAULT_CONFIG` gains `pageTools: axes.pageTools` (detected list); `backfillConfig` covers
  existing `.bgn/` dirs.
- Framework catalogs (`references/frameworks/*.md`) each gain a **Dev server** line: command and
  port flag (`next dev -p`, `vite --port`, `remix vite:dev --port`, TanStack Start's dev command).

### 4.8 Wiring

| File | Change |
|---|---|
| `.mcp.json` | add `--categoryExperimentalThirdParty` to args |
| `package.json` | `"react-devtools-cdt-mcp": "0.1.0"` (exact) in `dependencies`; `page-tools:test` script; chained into `test` |
| `hooks/hooks.json` | `SessionStart` guard checks both `node_modules/@babel` and `node_modules/react-devtools-cdt-mcp` |
| `references/tools.md` | document the flag, `list_3p_developer_tools`, `execute_3p_developer_tool` (params = JSON string), the 12 `react_*` tools; pin line for `react-devtools-cdt-mcp@0.1.0` |
| `references/page-tools.md` (new) | §4.2 protocol, provider table, unavailability causes, app-registered tools |
| `references/presets.md` | `re-renders — built` entry (§4.4) |
| `references/measurement.md` | dev-build exception for `re-renders` with rationale; "Observed noise — `re-renders`" section from the determinism check |
| `SKILL.md` | menu/preset list (five presets), config schema table row for `pageTools`, INP blame step in the `interaction` section, reference index entries |
| `CLAUDE.md` | runtime-deps rule amended; pin invariant lists `react-devtools-cdt-mcp` (package.json ↔ tools.md); `pageTools` added to the `SKILL.md` schema ↔ `DEFAULT_CONFIG` invariant; pipeline diagram gains `page_tools.mjs`; the "one ESM import edge" note lists the two new edges (`doctor.mjs` → `page_tools.mjs`, `build_perf_map.mjs` → `page_tools.mjs`) |
| `README.md` | feature mention in the product voice |
| `.github/workflows/ci.yml` | `page-tools:test` via `npm test`; smoke step `build_perf_map.mjs <graph fixture> --renders <profile fixture>` |
| `assets/` | `graph.renders-sample.json` + `render-profile.sample.json` (small fixture pair for the smoke step) |

## 5. Error handling

| Failure | Behavior |
|---|---|
| Package missing / wrong version | doctor reports; page-tools features fall back (INP blame skipped, `re-renders` unavailable, audit findings stay advisory, overlay omitted) |
| `toClassicScript` finds unexpected ESM | `serve` exits non-zero with the reason; same fallback |
| `react` group not discovered | §4.2 step 5: report likely cause, fall back |
| Tool returns `{error}` / `renderTotal` shape mismatch | surface verbatim; no gate decision from that capture |
| Dev server never returns 200 | teardown, report, fall back |
| Teardown leaves a bound port | reported as a blocker |
| Uid invalid after reload | re-acquire via `find_components` / `get_component_tree` |

## 6. Testing

- `page_tools.mjs --self-test` (pure functions, inline fixtures).
- `doctor.mjs` self-test: `detectProviders` cases, updated `checkVersionPin` fixture with the 3p flag.
- `mergeRenders` covered in `page_tools.mjs`'s self-test (matched, unmatched, no-profile cases).
- CI smoke chain gains `build_perf_map.mjs` with `--renders` on an inline fixture pair in `assets/`.
- Real-target verification before the docs state numbers: one Vite SPA and one Next.js dev server —
  discovery, `get_component_source` path normalization, the `re-renders` determinism check (its result
  populates `measurement.md`'s noise section), teardown leaves no listeners.

## 7. Out of scope

- A framework-neutral capability interface (tree/source/profile/renders) — waits for a second provider.
- Non-React providers.
- React tooling on prod builds (no names, no profiling data).
- Gating on dev-build durations.
- `/bisect`.

## 8. Implementation notes (deviations found during real-target verification)

- **`locate` subcommand + `locateComponent()`.** The provider's `source.line` points into the dev
  server's transformed output (Vite: `Filter.jsx:20` for a component defined at line 5), and under
  Turbopack `fileName` is a bundled chunk URL that maps to no repo path. File:line for findings
  therefore comes from `page_tools.mjs locate --repo <dir> --name <Component> [--file <rel>]`, which
  finds the definition in the original source by name (searching the repo when no file is known).
- **Senior Audit evidence runs at Step 4 (signal-vs-noise), not Step 1 (Grounding).** Hypotheses
  don't exist yet during Grounding.
- **`check_invariants.mjs`** (on `master` since this spec was written) gained the
  `react-devtools-cdt-mcp` pin check, the 3p flag check, and `pageTools` in its mirrored-config-key
  check (`checkDepPulseKeys` → `checkConfigKeys`).
- Measured results (Vite 8, Next.js 16 webpack + Turbopack, React 19): `references/page-tools.md` and
  `references/measurement.md`'s "Observed noise — `re-renders`".

