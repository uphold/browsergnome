# rspack

**Detected via** (`doctor.mjs`'s `detectBundler`): an `rspack.config.*` file — checked **before**
`webpack.config.*` and before any framework-based inference, so a repo migrating from webpack to
Rspack that still has a leftover `webpack.config.*` still correctly detects as `rspack`.

## `bundle-size` — not implemented, degrade plainly

Rspack aims for webpack config/plugin compatibility, and its stats output is modeled closely on
webpack's `stats.toJson()` shape — but `bundle_stats.mjs` has not been run against a real Rspack
build, so `detectFormat` does not claim to handle it and the degradation path applies (`bundle-size`
isn't usable here, fall back to Perf Map 3D). **Don't assume webpack-format compatibility covers
this without verifying against a real Rspack `--json` output** — the shapes are similar by design,
not guaranteed identical; extending `bundle_stats.mjs` to Rspack is a real, scoped task for whoever
has a real Rspack build to verify against, not something to silently enable off the webpack parser.

## Perf-relevant facts worth knowing

- Rspack's pitch is webpack-compatible config with a Rust-based compiler for faster builds — same
  relationship to webpack that Turbopack has to itself: primarily a build-speed story, not a
  shipped-bundle-size one. Don't expect switching bundlers alone to move `bundle-size`'s numbers.
- Because it targets webpack plugin/loader compatibility, the same production-mode caveat as
  `webpack.md` applies: compare production builds only, never dev-mode output.
