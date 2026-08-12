# Fonts

### next/font budget — proven
When: Google Fonts or external fonts load without subsetting or swap.
Do: Use `next/font` with `subsets` + `display:'swap'` (the default since Next.js 13.2); keep `preload:true` (the default) ONLY for fonts visible above the fold (usually the display font), set `preload:false` for body/mono fonts used below the fold — preloaded below-fold fonts compete with the LCP resource for early bandwidth.
Evidence: JetBrains Mono `preload:true`→`false`: CLS 0.03 unchanged, LCP neutral, 3 fewer critical-window requests. Verified against [Next.js Font API Reference](https://nextjs.org/docs/app/api-reference/components/font). This is exactly what the `fontNoDisplaySwap` detector flags statically (an explicit non-`swap` `display` value on a `next/font` call).

### font-display: optional for secondary fonts — documented
When: Body text, decorative, or non-critical fonts that are not visible in the initial viewport.
Do: Use `display:'optional'` for secondary fonts with explicit `preload:false`. The `optional` value (100ms load window) prevents Cumulative Layout Shift if the font doesn't load quickly enough, while still rendering text immediately in the system fallback. For decorative fonts, combine with `preload:false` to avoid competing with LCP resources.
Evidence: [web.dev font-display best practices](https://web.dev/articles/font-best-practices) and [Chrome DevTools font-display guide](https://developer.chrome.com/docs/performance/insights/font-display): swap causes visible FOIT/FOUT, while optional+ preload guarantees consistent metrics on slow 4G.
