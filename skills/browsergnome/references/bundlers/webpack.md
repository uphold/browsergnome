# webpack

**Detected via** (`doctor.mjs`'s `detectBundler`): a `webpack.config.*` file, or inferred from
`framework === 'next-app-router' | 'next-pages'` when no `turbo` key is present in `next.config.*`
(Next's own default bundler).

## `bundle-size` — implemented and verified

`bundle_stats.mjs` parses raw `webpack --json > stats.json` output directly. Verified against real
builds (see the script's file header): a single-chunk production build, and a multi-chunk build with
real `import()` code-splitting. Two real quirks handled: `ModuleConcatenationPlugin` merges modules
into nested entries (scope hoisting), and the resulting orphaned duplicate module entry that comes
with it (an empty `chunks` array).

**Getting a `stats.json` out of a standalone webpack project:** `webpack --json > stats.json`
directly. **Out of a framework that owns its own webpack invocation** (Next.js, most notably — see
`frameworks/next-app-router.md` / `frameworks/next-pages.md`): that command doesn't work, because
there's no top-level `webpack.config.js` to point the CLI at. Use the framework's own
stats-emitting mechanism instead (`@next/bundle-analyzer`'s JSON output, or a custom
`webpack(config)` callback in `next.config.js`).

## Perf-relevant defaults worth knowing

- **Production mode** (`mode: 'production'`) enables `ModuleConcatenationPlugin`, minification, and
  tree-shaking — a `bundle-size` comparison against a dev-mode build is meaningless (dev builds are
  intentionally unminified and unconcatenated). Always compare production builds.
- **Determinism:** given identical source, a production webpack build is byte-for-byte deterministic
  (confirmed by repeated real builds — see `references/measurement.md`'s "Observed noise —
  `bundle-size`" section) — this is why `bundle-size` skips the N-run noise protocol entirely for
  this bundler.
