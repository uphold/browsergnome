# vite-spa

**Detected via** (`doctor.mjs`'s `detectFramework`): `vite.config.*` present, with none of
Next/Remix/TanStack Start's own signals matching first.

## Perf levers specific to this stack

- **No server-side rendering by default** — a plain Vite SPA ships an empty (or near-empty) initial
  HTML shell and renders everything client-side. LCP is almost always render-delay-dominated here,
  not TTFB-dominated (there's very little server work to be slow); `LCPBreakdown`'s TTFB phase should
  read small on this stack — if it doesn't, something unusual (a slow static host, a slow API call
  blocking initial paint) is worth a second look.
- **Route-level code splitting is manual** — `React.lazy()` + `<Suspense>` (or the equivalent for
  whatever router is in use: React Router, TanStack Router). No framework-level default splitting the
  way Next/Remix/TanStack Start provide, so `nonLazyRoute`/eager-import findings are more common and
  more load-bearing on this stack than on the SSR frameworks.
- **`index.html` is a real, editable file** — critical CSS inlining, font preloading, and
  render-blocking script placement are all directly in the developer's control in a way they aren't
  on frameworks that generate the HTML shell.
- **This is the stack `perf_scan.mjs`'s detector suite was calibrated against** (excalidraw, a real
  cloned Vite SPA — see `references/perf-map.md`'s calibration note). The generic detectors are the
  most battle-tested here of any framework axis; the Next-specific ones (`clientComponentInServerTree`,
  the Next-flavored `heavyEntryImport` cases, `syncScriptInHead`) simply don't apply and won't fire.

## `bundle-size` on this framework

Vite's CLI doesn't emit a `bundle_stats.mjs`-compatible stats file without an added dependency
(`rollup-plugin-visualizer` or similar) — see `bundlers/vite.md`. `bundle-size` isn't usable on a
stock Vite SPA until that's set up; degrade to Perf Map 3D for bundle-weight diagnosis until then.

## `first-load` / `interaction` on this framework

Framework-agnostic measurement — no Vite-SPA-specific driver changes needed. **One setup step matters
more here than on most stacks:** measure a production build (`vite build`), never `vite dev` — Vite's
dev server ships hundreds of unbundled ES module requests instead of a few bundled chunks, and under
`first-load`'s throttled `emulate` settings that waterfall alone can dominate LCP by two orders of
magnitude, measuring the dev server's request count rather than anything a real fix could move. (Serve
that production build compressed too — that part isn't Vite-specific, it's the universal requirement
`references/presets.md`'s `first-load` entry already states for every target.) See `references/
measurement.md`'s second `first-load` noise characterization (measured on this exact stack) for the
numbers.
