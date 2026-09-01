# vite

**Detected via** (`doctor.mjs`'s `detectBundler`): a `vite.config.*` file, or inferred from
`framework === 'vite-spa' | 'tanstack-start'` when no explicit config file is found (both frameworks
default to Vite).

## `bundle-size` — not implemented, degrade plainly

Vite's production build (Rollup under the hood) doesn't emit a `bundle_stats.mjs`-compatible stats
file out of the box. Getting one requires an added target-repo dependency —
`rollup-plugin-visualizer` (emits a treemap + optional JSON) is the common choice — which isn't
something Doctor or the loop should assume is present. `detectFormat` returns `null` for a stock
Vite build; `bundle-size` **isn't usable on this bundler until that's set up**. Say so plainly and
fall back to Perf Map 3D for bundle-weight diagnosis. This matters in practice more than it might
look: `vite-spa` and `tanstack-start` are two of the five detected frameworks, and Remix v2+/React
Router v7's default build path is Vite too (see `frameworks/remix.md`) — Vite is the *most* common
bundler this project will meet with `bundle-size` unusable out of the box, not an edge case.

## Perf-relevant facts worth knowing

- Vite's dev server uses native ESM + on-demand compilation (no bundling in dev); production builds
  go through Rollup, which is a genuinely different pipeline from dev — a `bundle-size` comparison
  must always be against production (`vite build`) output, never dev-server behavior (there's no
  dev-mode "bundle" to compare in the first place).
- Rollup's tree-shaking is generally considered strong; `barrelImport` findings are still worth
  flagging (barrel files can still defeat tree-shaking depending on how the barrel re-exports), but
  expect fewer false negatives here than on a naively-configured webpack setup.
