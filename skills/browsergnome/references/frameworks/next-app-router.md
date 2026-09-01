# next-app-router

**Detected via** (`doctor.mjs`'s `detectFramework`): `next.config.*` present + an `app/` directory
(or `next.config.*` with neither `app/` nor `pages/` — App Router is the default for a bare
`next.config` with no route directory yet).

## Perf levers specific to this stack

- **RSC boundary placement.** Everything is a Server Component unless it (or an ancestor) has
  `'use client'`. A `'use client'` directive at a high-fan-in node drags its whole subtree into the
  client bundle even for children that don't need interactivity — this is exactly what
  `perf_scan.mjs`'s `clientComponentInServerTree` detector flags. Push `'use client'` as far down
  the tree as the interactive part actually requires.
- **Streaming + `Suspense`.** `loading.tsx` / nested `<Suspense>` boundaries let the shell paint
  before slow data resolves — the App Router's answer to `first-load`'s render-delay-dominated LCP
  case. A page with one top-level `await` and no Suspense boundaries serializes the whole tree
  behind that one fetch.
- **`next/image`** — automatic `width`/`height` (fixes `imageNoDims`/CLS by construction),
  `priority` on the LCP image. **`next/font`** — self-hosted, `display: 'swap'` by default; the
  knowledge base's `fontNoDisplaySwap` finding shouldn't fire on `next/font` usage — if it does,
  check for a raw `<link>`/`@font-face` bypassing it.
- **Server Actions** replace API-route-plus-fetch round trips for mutations — fewer client-side
  waterfalls, but a Server Action still runs on every invocation the same as any other server code;
  it isn't a caching mechanism by itself.
- **Route segment config** (`export const dynamic`, `revalidate`) controls whether a route is
  static, ISR, or fully dynamic. `headers()`/`cookies()`/`searchParams` used in a root layout forces
  every page below it dynamic — a real regression pattern the seeded playbook documents (a
  `reverted` entry: "no dynamic APIs in the root layout" moved prerendered pages 9→31 when fixed).

## Known dead ends (don't re-propose these as new hypotheses)

- `experimental.optimizeCss` is a **Pages Router-only no-op** on App Router — it targets a build
  path this router doesn't use. As of Next.js 15+ it's effectively deprecated everywhere (it relies
  on the unmaintained `critters` library and doesn't reliably work even on Pages Router — see
  `frameworks/next-pages.md`); don't propose enabling it on either router. App Router has its own
  experimental inline-CSS mechanism if critical-CSS inlining is genuinely the goal — check current
  Next.js docs for the target's specific version before proposing it, this area has moved more than
  once.
- `<link rel=preload as=image>` for the LCP image was lab-neutral on a localhost target in this
  project's own measurements — real but small effect, easily lost in noise on a fast local server;
  don't expect it to clear the gate on a similarly fast target without re-measuring first.

## `bundle-size` on this framework

Next.js's webpack build is internal — running `webpack --json` directly against `next build` doesn't
work, because Next owns the webpack invocation. To get `bundle_stats.mjs`-compatible output, either:
add `@next/bundle-analyzer` (emits its own JSON alongside its HTML report — point `bundle_stats.mjs`
at that JSON, not the report) or add a `webpack(config, {})` callback in `next.config.js` that calls
`compiler.hooks.done.tap` and writes `stats.toJson()` to disk. Neither is a `bundle-size` preset
change — it's a one-time target-repo setup step Doctor should surface, not silently skip.

## `first-load` / `interaction` on this framework

No framework-specific driver changes — `first-load`'s trace-based measurement is framework-agnostic.
`LCPBreakdown`'s TTFB-vs-render-delay split routes to server-side work (route handlers, `fetch`
caching) vs client-side work (RSC hydration, client bundle size) respectively — worth checking which
side of that split a candidate fix targets before proposing it.
