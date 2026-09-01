# turbopack

**Detected via** (`doctor.mjs`'s `detectBundler`): a `turbo` key in `next.config.*` (regex-matched,
not executed — see `checkVersionPin`-style string matching elsewhere in `doctor.mjs` for the same
pattern), only when `framework` is `next-app-router` or `next-pages`. Turbopack is Next.js-only in
this project's detection scope — there's no standalone Turbopack config file the way webpack/vite
have.

**Config-key caveat:** the key moved from `experimental.turbo` (Next.js 13-15.x) to a top-level
`turbopack` key (Next.js 16+) — a `next-experimental-turbo-to-turbopack` codemod exists for
migrating a config file between the two. `doctor.mjs`'s regex checks for a bare `turbo` substring,
which matches either shape, but confirm which key format a target repo actually uses (and hence its
rough Next.js major version) before assuming the newer top-level shape.

## `bundle-size` — not implemented, degrade plainly

Turbopack has no stable public stats-file format `bundle_stats.mjs` can parse. `detectFormat`
returns `null` for a Turbopack build; `bundle-size` isn't usable on this bundler. **Don't guess a
shape for an unsupported format** — say so plainly and fall back to Perf Map 3D for bundle-weight
diagnosis. This is the same honest-degradation rule `vite.md`/`rspack.md` apply for their own
missing-format cases.

## Perf-relevant facts worth knowing

- Turbopack is Rust-based and incremental-by-design — its performance story is almost entirely about
  **dev-server/build-time speed**, not shipped-bundle size. Switching to Turbopack is not, by
  itself, a `bundle-size` fix; it changes how fast the *build* runs, not what ships.
- Production-build support matured after dev-mode support and the opt-in mechanism has moved more
  than once — `next build --turbopack` was a beta opt-in flag in Next.js 15.4-15.5, and Turbopack
  became the stable default for both `next dev` and `next build` in Next.js 16 (no flag needed).
  On an older repo (15.x or earlier), confirm whether Turbopack is actually in the production-build
  path at all, or dev-only, before treating a production `bundle-size` finding as Turbopack-related.
