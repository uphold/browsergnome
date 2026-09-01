# remix

**Detected via** (`doctor.mjs`'s `detectFramework`): `remix.config.*` present.

**Merger caveat:** Remix merged into React Router as of React Router v7 (December 2024) — new Remix
projects are React Router v7 in "framework mode," and `remix.config.js` only exists for the legacy
"Classic Remix Compiler" path. A Vite-based Remix/React-Router-v7 project has no `remix.config.*` at
all and won't hit this detection branch — it'll fall through to `vite.config.*` and detect as
`vite-spa` instead, missing the loader/route-level facts below. If a target repo has both a
`package.json` dependency on `react-router` (not `react-dom`'s own routing) and a `vite.config.*`
but no `remix.config.*`, treat this file's facts as still likely applicable even though
`doctor.mjs` won't route here — `detectFramework` doesn't currently distinguish "Vite SPA" from
"React Router v7 framework mode," a real detection gap worth flagging rather than silently working
around.

## Perf levers specific to this stack

- **Loaders run on the server, always** — there's no equivalent to a client-only "SPA page"; every
  route has a server-side data-loading phase by default. A slow loader is a direct TTFB hit, same
  shape as a slow `getServerSideProps` on Pages Router.
- **Nested routes load their loaders in parallel**, not waterfall-style, by default — this is Remix's
  core pitch. A waterfall usually means a loader was made to `await` a *parent* route's data instead
  of fetching its own, or client-side `useEffect` fetching was used where a loader would parallelize.
- **No RSC-equivalent boundary** — everything in a route module ships to the client unless explicitly
  code-split. `next/dynamic`'s equivalent is a manual `React.lazy` + `<Suspense>`; Remix doesn't have
  a framework-level lazy-route primitive baked in the way Next's App Router does.
- **`<Link prefetch>`** (`"intent"` or `"render"`) is Remix's route-prefetch lever — the closest
  analog to Next's automatic `<Link>` prefetching, but opt-in per link, not on by default.

## `bundle-size` on this framework

Remix's default compiler is esbuild-based (Vite is the newer, now-default path for Remix v2+/React
Router v7 — check `vite.config.*` alongside `remix.config.*`; if both exist, the Vite path is almost
certainly what's actually building). `bundle_stats.mjs` reads esbuild `--metafile` output directly
if the esbuild path is in use; if it's the Vite path, see `bundlers/vite.md` — same degradation
applies (`bundle-size` isn't usable without an added stats-emitting dependency).

## `first-load` / `interaction` on this framework

Framework-agnostic measurement. `LCPBreakdown`'s TTFB phase routes straight to loader performance
here — there's no ambiguity between "server component render" and "loader fetch" the way there can
be on `next-app-router`, since Remix has exactly one server-side data phase per route.
