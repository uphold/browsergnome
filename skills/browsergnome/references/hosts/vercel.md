# vercel

**Detected via** (`doctor.mjs`'s `detectHost`): `vercel.json` or a `.vercel/` directory, checked
first (before Cloudflare/Node signals) since a repo can carry more than one host's config.

## Perf-relevant facts worth knowing

- **Edge vs Node.js runtime** — `export const runtime = 'edge'` vs the Node default is still the
  correct syntax for opting a route handler into the Edge runtime (restricted API surface, no full
  Node APIs, geographically distributed). **Standalone Edge Functions as a deployment target have
  been deprecated in favor of the Node.js runtime as the default** — the edge runtime today mainly
  still applies to Middleware, which runs on it by default. TTFB differences between two
  otherwise-similar routes can still trace back to which runtime each runs on; just don't assume a
  target repo is using standalone Edge Functions without checking, since that's no longer the
  default path for new routes.
- **ISR (Incremental Static Regeneration)** on Next.js deploys through Vercel's own CDN/cache layer —
  a `revalidate` value change affects *how often* the cache regenerates, not whether a given request
  is a cache hit; a cold ISR page still pays full render cost.
- **CI/preview-deploy noise:** if `first-load`/`interaction` measurements are ever run against a
  Vercel preview deployment rather than a stable production URL or local dev server, expect a wider
  noise band than this project's own local-machine characterization (`references/measurement.md`) —
  preview infrastructure has its own cold-start and regional-routing variance. Characterize on the
  actual measurement target, don't assume the local numbers transfer.

## Doesn't change

The loop, gate, and scanner never branch on host — Vercel-specific knowledge is diagnostic context
for reading `LCPBreakdown`'s TTFB phase, not a different measurement path.
