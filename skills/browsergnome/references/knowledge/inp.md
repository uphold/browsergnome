# INP / long tasks

### Deferred content-visibility release — proven
When: `content-visibility:auto` sections stutter during fast scroll (long animation frames with near-zero script time at section boundaries).
Do: Keep `content-visibility:auto` in CSS to protect FCP/LCP; after window `load`, set `el.style.contentVisibility='visible'` one section per `requestIdleCallback` slice (set a timeout to ensure execution even if main thread is busy — RAF loops can starve idle callbacks without one) so the layout cost is paid once, off the scroll path.
Evidence: fast-scroll 34→61fps mobile (LoAF 727→254ms), 24→35fps desktop; FCP/LCP/CLS unchanged; 4× CPU.
Source: https://web.dev/articles/content-visibility, https://developer.chrome.com/blog/loaf-has-shipped

### Pause off-screen CSS animation (IntersectionObserver) — documented
When: A CSS `animation: … infinite` element (marquee, spinner, shimmer) composites continuously even scrolled out of view.
Do: Add `.is-paused { animation-play-state: paused }`; observe the wrapper with `IntersectionObserver` with positive `rootMargin` (e.g. `'200px 0px'`) to expand the intersection area and toggle the class before elements come into view. Gate any per-frame JS transform writes to the same element with the same flag. No-op under `prefers-reduced-motion`.
Evidence: mechanism verified (running in-view, paused out-of-view, resumes on scroll-back).
Source: https://web.dev/articles/intersectionobserver

### Gate off-screen parallax/transform writes — dead end (unmeasurable in lab)
When: A scroll `render()` loop writes `transform`/`opacity` every frame even while an element is fully off-screen.
Do: For scroll-position-predictable elements (hero), a synchronous in-range check; for mid-page elements, an `IntersectionObserver` with positive `rootMargin` (e.g. `'100px 0px'` to expand detection area). Recompute every value from absolute scroll position (stateless) so first in-view frame is exact. Do NOT cache `scrollHeight` — stale after lazy-image/font-swap height changes.
Evidence: applied and measured — matches this repo's `playbook.seed.json` dead-end entry (`tried:1, kept:0`). The numeric delta was **unmeasurable**, not negative, in a throttled capture environment; that's still "did not clear the gate," not "never tried" — don't relabel it `ungated hypothesis` (that means never locally measured) if it comes up again. Don't force a KEEP without a real gate pass on a fresh attempt.
Source: https://web.dev/articles/intersectionobserver

### Predecode ahead of viewport (two-tier) — documented
When: Lazy images entering the viewport during fast scrolling cause decode/raster stutter.
Do: After `load`: Tier 1 = per-section `IntersectionObserver` with large positive `rootMargin` (e.g. ~3000px) to preload `img[loading="lazy"]` ahead of viewport; create a `new Image()`, copy `srcset`/`sizes` (not just `src`), and await `img.decode()` to ensure the image is fully decoded before entering viewport; Tier 2 = drain remaining lazy images 3-per-`requestIdleCallback` slice with a timeout to ensure execution even if main thread is busy. Skip Tier 2 on `navigator.connection.saveData`.
Evidence: network-level prefetch validated; decode-jank contribution measured as minor versus the content-visibility release above — don't over-invest here before that one.
Source: https://web.dev/articles/intersectionobserver, https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/decode

### Defer heavy JS — documented
When: Animation/utility libraries are in the initial bundle but not needed for first paint.
Do: Dynamic `import()` after the `load` event, not at module init.
Evidence: removes the library from the critical bundle; also relevant to `bundle.md` for initial JS weight.
Source: https://web.dev/articles/reduce-javascript-payloads-with-code-splitting

### Break up long tasks with scheduler.yield() — documented
When: A single JavaScript function processes large datasets, runs complex loops, or performs heavy computations, blocking the main thread for >50ms and delaying user input response (affecting INP).
Do: Use `await scheduler.yield()` to pause execution and yield control back to the browser at strategic points. For batch processing, yield after ~50ms of work: measure with `performance.now()` and call `scheduler.yield()` when elapsed time exceeds your deadline. This gives the browser a chance to handle high-priority work (user input, rendering) while ensuring your task resumes at higher priority than newly queued tasks. Polyfill with fallback to `setTimeout(resolve, 0)` for non-supporting browsers.
Evidence: scheduler.yield() continuation priority ensures your multi-part operation completes efficiently without being indefinitely delayed by other tasks; shipped in Chromium-based browsers; prevents blocking user interactions during intensive processing.
Source: https://developer.chrome.com/blog/use-scheduler-yield, https://web.dev/articles/optimize-long-tasks
