# next-pages

**Detected via** (`doctor.mjs`'s `detectFramework`): `next.config.*` present + a `pages/` directory
(and no `app/` directory — if both exist, `detectFramework` resolves to `next-app-router`, since App
Router takes precedence in a hybrid repo).

## Perf levers specific to this stack

- **No RSC** — everything ships to the client. `clientComponentInServerTree` never fires here (there's
  no server/client boundary to violate); the relevant weight-reduction levers are the generic ones —
  `heavyEntryImport`, `barrelImport`, dynamic `import()` for route-level code splitting via
  `next/dynamic`.
- **Data fetching** is `getStaticProps`/`getServerSideProps`/`getInitialProps`, not `await` in the
  component body. A slow `getServerSideProps` shows up as TTFB-dominated LCP, not render-delay — the
  same `LCPBreakdown` routing rule as `next-app-router` applies, just with a different fetch API on
  the server side of that split.
- **`next/image`** and **`next/font`** behave the same as on App Router (same underlying packages).
- **`experimental.optimizeCss`** targets this router (unlike App Router, where it's a documented
  no-op) — it's Pages Router's own critical-CSS extraction path. **Treat it as effectively
  deprecated, not a live lever:** it depends on the unmaintained `critters` library, and reports as
  of Next.js 15.3+ describe it as not reliably working even here. Don't propose enabling it as a new
  fix without first confirming it does something on the target's specific Next.js version.

## `bundle-size` on this framework

Same constraint as `next-app-router`: Next owns the webpack invocation, so `webpack --json` doesn't
work directly against `next build`. Use `@next/bundle-analyzer`'s emitted JSON or a custom
`webpack(config)` stats-dump callback in `next.config.js`.

## `first-load` / `interaction` on this framework

Framework-agnostic measurement, same as `next-app-router`. `getServerSideProps` running expensive
work on every request is the most common Pages-Router-specific TTFB regression — cheap to spot by
reading the function, not something a static detector can see (no AST signal distinguishes "slow
DB query" from "fast one").
