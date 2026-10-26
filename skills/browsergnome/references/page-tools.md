# Page Tools — framework internals through chrome-devtools-mcp

chrome-devtools-mcp sees the DOM, network, and trace events. It does not see which component rendered
a node, what state it holds, or why a commit was expensive. Its **third-party developer tools** API
(enabled by `--categoryExperimentalThirdParty`, which this repo's `.mcp.json` passes) closes that gap: a
script running in the page registers tool groups, the agent lists them with `list_3p_developer_tools`
and calls them with `execute_3p_developer_tool`.

Page Tools is browsergnome's layer for getting such a provider script into the target page with **zero
edits to the target repo**, discovering its tools, and tearing everything down afterwards. It is
framework-neutral; each framework is a provider entry in `scripts/page_tools.mjs`'s `PROVIDERS`.

| Provider | Package (pinned dependency of this plugin) | Enabled when the target depends on | Tool group |
|---|---|---|---|
| `react` | `react-devtools-cdt-mcp` | `react-dom` | `react` — 12 `react_*` tools, see `tools.md` |

Doctor detects providers and writes them to `.bgn/config.json`'s `pageTools` (`[]` disables every
Page Tools feature).

## What uses it

| Feature | Where | What the React provider adds |
|---|---|---|
| INP blame | `presets.md` → `interaction` | Which components rendered in the slow interaction, ranked by self time, with `file:line` |
| `re-renders` preset | `presets.md` → `re-renders` | A deterministic gate on total components rendered for one interaction |
| Senior Audit evidence | `senior-audit.md` | Render-cost findings gated through `re-renders` instead of staying advisory |
| Perf Map render overlay | `perf-map.md` | Render count and self time on each module node |

## Why a dev server, and why it never touches the gate

Provider data needs a **development** build: in a production build component names are minified and
React records no profiling data. The four existing gates measure the production build
(`measurement.md`), so Page Tools runs as its own pass against the target's dev server. Dev-build
durations rank components; they never decide KEEP/REVERT. The one gate that runs on the dev server,
`re-renders`, gates on a structural count, not a timing.

## Protocol

All paths below are relative to `$BG/skills/browsergnome/scripts/`.

1. **Preconditions.** `config.pageTools` is non-empty; doctor reports the provider package installed,
   a `dev` script in the target's `package.json`, and the `--categoryExperimentalThirdParty` flag.
2. **Script server.** Start `node page_tools.mjs serve --providers <ids>` in the background. Its first
   stdout line is `{"port":N,"pid":P}`. It serves each provider's page script on `127.0.0.1:N` with
   CORS.
3. **Dev server.** Start the target's dev server on a free port with the framework catalog's dev-port
   flag (`frameworks/<framework>.md` → **Dev server**), as its own process group. Poll the URL until it
   answers 200.
4. **Loader.** `node page_tools.mjs loader --port N --provider react` prints a one-line `initScript`.
   It synchronously fetches the provider from the script server and evaluates it before any page
   script runs, which is the provider's own requirement ("load before React").
5. **Navigate.** `new_page { url, isolatedContext }` → `navigate_page { type: "url", url, initScript: <loader> }`.
   **Every** reload in the pass is `navigate_page { type: "reload", initScript: <loader> }`.
   `initScript` applies to one navigation; a reload without it loses the tools.
6. **Discover.** `list_3p_developer_tools`. No `react` group means the pass is unavailable. Report the
   cause and fall back to the feature's non-Page-Tools behavior:
   - a Content-Security-Policy on the dev server blocking `eval` or the request to `127.0.0.1`
   - a production build being served
   - a stale page that predates step 5 (`select_page` the injected one)
7. **Call tools.** `execute_3p_developer_tool { toolName, params }`, where **`params` is a
   JSON-stringified object**, not an object. Component uids (`"r5"`) are stable across tools and
   re-renders but reset on reload: re-acquire them with `react_find_components` /
   `react_get_component_tree` after any navigation. A uid from a commit report can belong to a
   component that has since unmounted; its source lookup then returns nothing, so skip it.
8. **Locate source.** Map each component to the target repo's original source:
   1. `react_get_component_source { uid }` → `source.fileName`.
   2. `page_tools.mjs`'s `normalizeSource(fileName, repoRoot)` turns dev-server URLs, Vite
      `/@fs/`, `webpack-internal:///`, Turbopack `[project]/`, and `file://` forms into a repo-relative
      path, or `null`.
   3. `node page_tools.mjs locate --repo <target> --name <Component> [--file <path from (2)>]` returns
      `[{file, line}]` for the component's definition in the original source.

   Always take the line from `locate`. The provider's `line` points into the dev server's transformed
   output, and under Turbopack `fileName` is a bundled chunk URL that `normalizeSource` maps to `null`.
   In that case `locate` without `--file` searches the repo by name. More than one hit is reported as
   candidates, never silently picked.
9. **Teardown — always, including on error or abort.**
   1. Kill the dev server's process group (`kill -TERM -<pgid>`) and the script server pid.
   2. Confirm both ports are free: `lsof -nP -iTCP:<port> -sTCP:LISTEN` prints nothing.
   3. Close the page (`close_page`).

   A port still bound after teardown is a blocker to report, not something to leave behind.

## Tools the app registers itself

Any third-party tool group the target app registers on its own (store state, feature flags, a
design-system inspector) appears in step 6's `list_3p_developer_tools` listing alongside the provider's.
Those tools are usable as-is, through the same `execute_3p_developer_tool` call.

## Measured on real dev servers

End-to-end runs through `chrome-devtools-mcp@1.6.0 --categoryExperimentalThirdParty` with the real
`page_tools.mjs serve` + loader, on three targets each rendering a 200-row filter list. Each run made
3 fresh-load captures, each of one `click` plus typing 3 characters:

| Target | Tools discovered | `fileName` → `normalizeSource` | Σ components rendered (3 captures) | Re-discovered after reload | Ports free after teardown |
|---|---|---|---|---|---|
| Vite 8 dev (`vite`), React 19 | yes | `http://localhost:<port>/src/Filter.jsx` → `src/Filter.jsx` | 803 / 803 / 803 | yes | yes |
| Next.js 16 dev, webpack (`next dev --webpack`), React 19 | yes | `webpack-internal:///(app-pages-browser)/./app/Filter.tsx` → `app/Filter.tsx` | 728 / 728 / 728 | yes | yes |
| Next.js 16 dev, Turbopack (`next dev`), React 19 | yes | bundled chunk URL → `null` (located by name) | 734 / 734 / 734 | yes | yes |

`locate` returned the definition line in the original file on all three (`Filter.tsx:5`, `Row` at
`Filter.tsx:4`).
