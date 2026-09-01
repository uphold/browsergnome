# CLS

### Media sizing — documented
When: Images or video cause layout shift because dimensions are unknown at paint time.
Do: Reserve space with explicit `width`/`height` (or `aspect-ratio` in CSS) on the media element — this is exactly what the `imageNoDims` detector flags statically.
Evidence: [web.dev: Serve images with correct dimensions](https://web.dev/articles/serve-images-with-correct-dimensions), [web.dev: The CSS aspect-ratio property](https://web.dev/articles/aspect-ratio). 66% of pages have at least one unsized image, causing 0px initial height and CLS on load.

### Web font swap — documented
When: Custom web fonts with different metrics (line-height, kerning) load and swap with fallback fonts, shifting text and surrounding content.
Do: Prevent metric mismatch by using `font-display: optional` (100ms max text delay, zero swap shift), or use `size-adjust`, `ascent-override`, `descent-override`, and `line-gap-override` in `@font-face` to match fallback metrics to the primary font. Combine `<link rel="preload">` with `font-display: optional` for strongest guarantee.
Evidence: [web.dev: Font display](https://developer.chrome.com/docs/lighthouse/performance/font-display), [web.dev: CSS size-adjust for @font-face](https://web.dev/articles/css-size-adjust), [web.dev: Prevent layout shifting and flashes of invisible text (FOIT)](https://web.dev/articles/preload-optional-fonts). Sites using `font-display: swap` frequently suffer layout shifts when web fonts load.

### Ad slot and injected content — documented
When: Ads, embeds, iframes, or dynamically inserted content (including infinite scroll prepending above the fold) have no reserved space, causing existing content to shift down or sideways.
Do: Reserve space in advance with fixed width/height on the container, placeholder elements, or skeleton UI. If ad size varies, size the slot to the most common size. Never collapse space even if no ad is returned; removing reserved space counts as CLS. Position injected content lower in the viewport when possible to reduce shift magnitude.
Evidence: [web.dev: Effectively loading ads without impacting page speed](https://web.dev/articles/loading-ads-page-speed), [web.dev: Optimize Cumulative Layout Shift](https://web.dev/articles/optimize-cls). Ads are among the largest contributors to layout shifts on the web; injected content closer to viewport top causes greater shifts.
