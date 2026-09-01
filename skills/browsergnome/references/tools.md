# chrome-devtools-mcp tool surface — pinned version

**Pinned: `chrome-devtools-mcp@1.6.0`.** `.mcp.json` in this repo pins the exact version — never
`@latest`. Determined 2026-08-08 by inspecting the actually-running server process
(`ps aux | grep chrome-devtools-mcp` → `--app-version=1.6.0`), not the plugin cache directory
(`~/.claude/plugins/cache/chrome-devtools-plugins/chrome-devtools-mcp/0.26.0` — stale, unpinned
`@latest` resolves past it) and not `npm view` (reports today's latest, not what actually resolved at
pin time).

Re-pin whenever a tool call returns an unexpected shape mid-run — that's the live-drift signal. Doctor
only checks that `.mcp.json`'s pin agrees with this file's documented one (a static consistency check);
it has no way to verify the live tool surface itself (see doctor.mjs's file header for why).

## Confirmed live, this version — exact parameters

- `emulate` → `cpuThrottlingRate` (1–20) · `networkConditions` (`Offline`/`Slow 3G`/`Fast 3G`/`Slow 4G`/`Fast 4G`)
  · `viewport` (`<w>x<h>x<dpr>[,mobile][,touch][,landscape]`) · `colorScheme` · `userAgent` ·
  `extraHttpHeaders` · `geolocation`
- `performance_start_trace` → `filePath` · `reload` (default true) · `autoStop` (default true)
- `performance_stop_trace` · `performance_analyze_insight` (`insightSetId` + `insightName`)
- `new_page` → `url` · `background` · `isolatedContext` (name a fresh one per measurement run — pages
  sharing a context share cookies/storage; different contexts are fully isolated) · `close_page` →
  `pageId` (from `list_pages`; the last open page can't be closed). Both confirmed directly in the
  `chrome-devtools-mcp@1.6.0` package source (`npm pack`'d and read locally, not just a live schema
  fetch) — category `NAVIGATION`, not gated behind any experimental flag.
- `list_network_requests` · `get_network_request` · `evaluate_script` · `take_snapshot` · `click` ·
  `type_text` · `hover` · `fill` · `fill_form` · `navigate_page` · `wait_for` · `lighthouse_audit`
- `take_heapsnapshot` (`filePath` **required**).

## Memory tools — present in the package, disabled by this repo's launch config

`compare_heapsnapshots`, `get_heapsnapshot_retainers`/`dominators`/`retaining_paths`/
`duplicate_strings`/`class_nodes`/`summary`/`edges`/`details` all exist in `chrome-devtools-mcp@1.6.0`'s
source (verified by reading `npm pack chrome-devtools-mcp@1.6.0`'s actual `build/src/tools/memory.js`
locally — primary source, not a live schema fetch). They're
gated behind `conditions: ['memoryDebugging']`, wired to the CLI's `--memoryDebugging`/
`--experimentalMemory` flag — which this repo's `.mcp.json` does **not** pass, so they're genuinely
absent from what the agent can call *today*, just not for the reason previously documented (API
instability/not-yet-shipped) — they're one flag away. `take_heapsnapshot` is the only memory tool this
repo's `.mcp.json` currently exposes.

**Consequence:** the `memory-leaks` preset stays deferred post-v1 per the design decision (a scope
call, not purely a tool-availability one) — but whoever picks it up later should know it's now a
`.mcp.json` flag change plus real work, not blocked on chrome-devtools-mcp shipping something it
doesn't have. No preset-disabling mechanism exists in `doctor.mjs` — there's no
`memory-leaks` entry in `references/presets.md` to disable; if a future pin ever drops a tool an
*implemented* preset depends on, that's the point at which a disable mechanism becomes worth building,
not before.

**Do not use `lighthouse_audit` for the gate** — it explicitly excludes performance; route perf to
`performance_start_trace`.
