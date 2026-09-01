# cloudflare

**Detected via** (`doctor.mjs`'s `detectHost`): `wrangler.toml` or a `_headers` file (the latter is
Cloudflare Pages' own static-header-config convention, not exclusive to Cloudflare in principle, but
treated as a strong signal here since it's rare outside that platform).

## Perf-relevant facts worth knowing

- **Workers run at the edge, globally distributed by default** — there's no separate "edge vs
  regional" runtime choice the way Vercel has; a Cloudflare Worker/Pages Function is edge by
  construction. TTFB variance here is more likely to trace back to what the Worker itself does
  (a slow upstream `fetch`, KV/D1 read latency) than to a runtime-tier choice.
- **`_headers` / `_redirects`** are static config files, not code — a caching-header regression
  (missing `Cache-Control`, an overly short TTL) is often a one-line fix here worth checking before
  assuming a code-level cause for a repeat-visit performance complaint.
- **KV is eventually consistent, D1/R2 are not the same latency profile as a traditional origin
  DB/object store** — a data-fetch-side TTFB regression on this host is worth diagnosing with that
  distinction in mind (which storage primitive is in the request path) rather than treating all
  "slow fetch" findings the same way a single-origin-DB host would.

## Doesn't change

The loop, gate, and scanner never branch on host — this is diagnostic context for reading TTFB
regressions, not a different measurement path.
