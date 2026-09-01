# node

**Detected via** (`doctor.mjs`'s `detectHost`): a `Dockerfile` or `server.js` at the repo root —
the catch-all signal for "this deploys as a long-running Node process," whether that's a plain
Express/Fastify server, a self-hosted Next.js `next start`, or a custom container.

## Perf-relevant facts worth knowing

- **No platform-managed edge/CDN layer by default** — unlike Vercel/Cloudflare, a self-hosted Node
  target's TTFB reflects a single origin server's actual response time plus whatever reverse
  proxy/CDN the target repo's own infra puts in front of it (which Doctor can't detect from the repo
  alone — it's infra outside the codebase). Don't assume geographic/edge distribution exists here
  unless the target repo's own deployment docs say so.
- **Process warm-up matters more here than on serverless hosts** — a long-running Node process's V8
  JIT and any in-process caches (module resolution, compiled templates) warm up over the process's
  lifetime, not per-request. `first-load`'s `warmupDiscard` protocol (see `references/measurement.md`)
  is about browser/CDN cache warmup, not server-process warmup — if the *server* was just restarted,
  its own warm-up is a separate confound worth ruling out before trusting an early measurement.
- **Clustering/worker-process count** affects how many concurrent requests the origin can serve
  without queueing — a TTFB regression under load (not visible in a single-request measurement) can
  trace back to this, outside what `first-load`'s single-request-at-a-time protocol would ever catch.

## Doesn't change

The loop, gate, and scanner never branch on host — this is diagnostic context for reading TTFB
regressions, not a different measurement path.
