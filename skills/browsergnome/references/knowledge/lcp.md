# LCP

### Post-build critical CSS for App Router — proven
When: Next.js App Router project has render-blocking CSS; `experimental.optimizeCss` is a no-op (only wired into Pages Router, confirmed zero hits in `next/dist/server/app-render/`). App Router's streaming architecture is incompatible with critters (critters does not support streaming).
Do: Install `critters` devDep; write a script that runs critters (`ssrMode:true, preload:'media', path:'.next', publicPath:'/_next/'`) over all `.next/server/app/*.html` after each build; chain in `package.json` as `"build": "next build && node scripts/optimize-critical-css.mjs"`.
Evidence: LCP 1650ms → 776ms (−874ms), CLS unchanged; Slow 4G + 4× CPU mobile. Second app: LCP median 1723→1417ms (−306ms), RenderBlocking insight eliminated. See https://github.com/vercel/next.js/discussions/80486 and https://github.com/vercel/next.js/issues/57634 for App Router critical CSS status.

### force-static — documented
When: A page has no dynamic data but is rendered dynamically.
Do: Add `export const dynamic = 'force-static'` at the top of the page file.
Evidence: flips the route to prerendered HTML — see `hydration-rsc.md` / `caching.md` for the broader dynamic-rendering pattern this belongs to. Source: https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config

### LCP-stable text — documented
When: A rotating or animated headline causes the browser to re-register multiple LCP candidates.
Do: Reuse a single persistent DOM node; update only its text content, never replace the node. Avoid innerHTML/textContent (which replaces children) in favor of append() for streamed/dynamic updates.
Evidence: LCP emits at most one candidate per animation frame. Text updates trigger new candidates, but only if element size/position changes significantly. Persistent DOM nodes avoid unnecessary re-renders and layout thrashing. Source: https://web.dev/articles/lcp and https://developer.chrome.com/docs/ai/render-llm-responses

### Next.js `<Image preload>` for LCP images — documented
When: LCP element is an `<Image>` component in a Next.js App Router or Pages Router app.
Do: Add the `preload` prop to the Image component: `<Image src="…" preload />`. This tells Next.js to emit a preload link in `<head>`. Note: as of Next.js 16, `priority` is **deprecated in favor of `preload`** — same mechanism, renamed prop; older code/docs referencing `priority` are now out of date.
Evidence: Next.js documentation recommends this for the page's LCP image, over a manual `<link rel="preload">`. Source: https://nextjs.org/docs/app/api-reference/components/image#preload
Guidance: optimize-image-priority

### `<link rel="preload" as="image">` for the LCP image — dead end (lab)
When: The LCP image isn't discoverable by the browser preload scanner (set via JS/CSS, or deep in the byte stream — e.g. a `<video poster>`).
Do: Add `<link rel="preload" as="image" href="…">` with correct `imagesrcset`/`imagesizes` and **always include `fetchpriority="high"`** (otherwise preload gets low priority by default for images); in App Router, `import { preload } from 'react-dom'; preload(url, { as: 'image', fetchPriority: 'high' })` server-side.
Evidence: structurally valid (discoverable, high priority) but measured **lab-neutral on localhost** — the throttled dev environment lacks realistic TTFB/connection-setup latency, hiding any discovery-timing win. Did not clear the gate in-lab; matches this repo's `playbook.seed.json` dead-end entry. Worth retrying specifically on a real production network/CDN before assuming it's dead there too — that's a different measurement, not the same result. Sources: https://web.dev/blog/common-misconceptions-lcp and https://web.dev/articles/preload-critical-assets
Guidance: optimize-preload-priority

### Removing an eager `modulepreload` for a dynamically-imported chunk — dead end
When: A build tool (verified on Vite) auto-injects `<link rel="modulepreload">` for a chunk that's only ever reached via a genuine dynamic `import()` in source, and it looks like dead weight competing with the entry chunk for bandwidth on a throttled connection.
Do: (tried, did not work) Filter the chunk out of `build.modulePreload.resolveDependencies`, on the assumption that a genuinely dynamic-only import doesn't need the eager hint. On a Vite SPA (excalidraw/excalidraw) this measured a **580.05ms (−8.07%) LCP regression** (baseline mean 7188.63ms → candidate mean 7768.68ms, n=5/arm), not an improvement — removing the eager preload didn't stop the chunk from loading, it serialized two fetches that were previously running in parallel (entry chunk + the "unnecessary" chunk both starting at ts≈0) into sequential ones (entry chunk, then the other chunk only after the entry executes and reaches the `import()` call), and LCP landed right after the second fetch resolved.
Evidence: one-off debug capture per arm, network-resource timeline (ms from navigation start): baseline entry-chunk finish 6524 / other-chunk finish 3778 (parallel, other chunk well clear of LCP). Candidate: entry-chunk finish 5563 (faster — confirms the two chunks *were* contending for bandwidth) / other-chunk finish 7095 (this capture's own LCP lands shortly after — the −580.05ms gate figure above is the N=5/arm measurement this timeline is evidence *for*, not re-derived from it). `k=2`, `minEffect` 216ms (3% of baseline mean). The causal mechanism linking the render path to the second chunk's finish time wasn't isolated (no profiling pass); the measured regression is real regardless of mechanism. Verify with a real before/after on the actual target before assuming an eager preload that "looks" redundant is safe to drop.
