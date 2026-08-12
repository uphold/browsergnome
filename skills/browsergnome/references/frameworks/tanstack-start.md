# tanstack-start

**Detected via** (`doctor.mjs`'s `detectFramework`): `@tanstack/start` as a `package.json` dependency
— there's no dedicated config-file signal the way Next/Remix/Vite have, so this is the one framework
axis detected purely from `package.json`, not a config file.

**Package-name caveat:** the project split into framework-specific packages —
`@tanstack/react-start` is the actively maintained one for React, `@tanstack/solid-start` for Solid;
the original unscoped `@tanstack/start` is effectively stale (its last publish predates the split by
roughly a year). **Check `package.json` for `@tanstack/react-start` specifically**, not the bare
`@tanstack/start` name — `doctor.mjs`'s detection should be read/extended with that in mind if it's
still only matching the old name.

## Perf levers specific to this stack

- **Built on Vite + TanStack Router** — route-level code splitting is file-based and largely
  automatic via the router's lazy-loading conventions (`.lazy.tsx` route files). A route file that
  isn't split as `.lazy.tsx` when it doesn't need to be in the initial bundle is the most common
  under-splitting mistake here.
- **Server functions** (`createServerFn`) are the mutation/data primitive, conceptually similar to
  Remix loaders/Next Server Actions — same TTFB-vs-render-delay reasoning applies to a slow one.
- **TanStack Query integration** is common in this stack for client-side caching; a query with no
  `staleTime` refetching on every navigation is a client-side waterfall pattern worth checking for,
  though it's not something `perf_scan.mjs` detects mechanically (it's a runtime behavior, not a
  static AST pattern).

## `bundle-size` on this framework

Vite-based — see `bundlers/vite.md`. `bundle_stats.mjs` doesn't implement Vite/Rollup parsing;
`bundle-size` isn't usable here without the target repo adding a stats-emitting plugin
(`rollup-plugin-visualizer` or similar). Degrade to Perf Map 3D for bundle-weight diagnosis on this
stack until that's set up.

## `first-load` / `interaction` on this framework

Framework-agnostic measurement — no TanStack Start-specific driver changes needed. **Measure a
production build, not the dev server** — this stack is Vite-based (above), and a Vite dev server
ships hundreds of unbundled ES module requests instead of a few bundled chunks; under `first-load`'s
throttled `emulate` settings that can dominate LCP by orders of magnitude, measuring the dev server's
request count rather than anything a real fix could move. Not independently measured on this exact
stack — see `references/frameworks/vite-spa.md` and `references/measurement.md` for the numbers this
is based on (measured on a Vite SPA, not TanStack Start specifically) — but the mechanism is the same
Vite dev server underneath, so treat it as the same requirement until proven otherwise.
