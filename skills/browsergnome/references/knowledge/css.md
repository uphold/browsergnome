# CSS

### CSS-first animation — documented
When: JS drives entrance/spin/marquee animations that could be pure CSS.
Do: Define `@keyframes` for entrance/spin/marquee; stick to `transform` and `opacity` properties; honor `prefers-reduced-motion`.
Evidence: Animating only `transform` and `opacity` moves work off the main JS thread onto the compositor thread (GPU), keeping animations smooth even when the main thread is busy. Animating other properties (width, height, left, etc.) triggers layout/paint on the main thread and can cause janky playback. Source: [web.dev: Stick to Compositor-Only Properties and Manage Layer Count](https://web.dev/articles/stick-to-compositor-only-properties-and-manage-layer-count), [web.dev: Animations and Performance](https://web.dev/articles/animations-and-performance) — see `inp.md` for pairing this with off-screen pause/gate patterns once it's in CSS.

### content-visibility — documented
When: A page has heavy off-screen sections that paint eagerly.
Do: Apply `content-visibility:auto` + `contain-intrinsic-size` to those sections. Always pair `contain-intrinsic-size` with a realistic placeholder height to prevent layout shift during scrolling.
Evidence: `content-visibility:auto` skips layout/paint work for off-screen content, deferring rendering until the element enters render proximity. `contain-intrinsic-size` provides a placeholder size so scrollbars don't shift as content is rendered just-in-time. Caveat: each section pays a style/layout burst when entering render proximity, which can jank fast scrolling if the content is heavy — pair with the "Deferred content-visibility release" pattern in `inp.md`. Source: [web.dev: content-visibility](https://web.dev/articles/content-visibility)
Guidance: defer-rendering-heavy-content

### will-change — documented
When: About to animate a specific CSS property, and normal rendering budgets are tight.
Do: Add `will-change: transform, opacity` (or the specific properties you'll animate) to elements just before animation starts; remove it after animation ends. Be specific: use `will-change: rotate, filter` instead of `will-change: transform, filter` when only rotate/filter are animated.
Evidence: `will-change` tells the browser to pre-create GPU layers and optimize data structures for the named properties, avoiding compositor-thread jank during the animation. Overusing it causes browser resource waste and can create more performance problems than it solves. General guidance: apply only when a change is likely within 200ms. Pitfall: leaving `will-change` on permanently defeats optimization and adds memory overhead. Source: [web.dev: How to create high-performance CSS animations](https://web.dev/articles/animations-guide), [MDN: will-change](https://developer.mozilla.org/en-US/docs/Web/CSS/will-change)
