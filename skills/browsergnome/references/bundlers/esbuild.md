# esbuild

**Detected via** (`doctor.mjs`'s `detectBundler`): a checked-for esbuild metafile
(`hasEsbuildMetafile`), only when no other bundler config or framework default matches first —
esbuild is the fallback-of-last-resort in the detection order, since it's more often used directly
(a custom build script) than as a named framework default.

## `bundle-size` — implemented and verified

`bundle_stats.mjs` parses `esbuild --metafile=meta.json` output directly. Flat structure, no
concatenation quirk to handle (unlike webpack's `ModuleConcatenationPlugin` merged-entry case) —
verified against a real esbuild build (see the script's file header).

**Getting a metafile:** `esbuild ... --metafile=meta.json` (or the `metafile: true` option via the
JS API, then write `result.metafile` to disk). Point `bundle_stats.mjs` at that file directly.

## Perf-relevant facts worth knowing

- **Determinism:** given identical source, an esbuild build is byte-for-byte deterministic (confirmed
  by repeated real builds — see `references/measurement.md`'s "Observed noise — `bundle-size`"
  section) — same reasoning as webpack, `bundle-size` skips the N-run noise protocol for this
  bundler too.
- esbuild does minimal tree-shaking optimization compared to Rollup/webpack in production
  mode — a `barrelImport` finding is more likely to translate into a real shipped-byte cost here than
  on a bundler with more aggressive dead-code elimination; don't assume esbuild "handles it."
- No code-splitting by default unless explicitly configured (`splitting: true`, ESM output only) —
  a large single-chunk output on this bundler is expected unless the target repo opted in.
