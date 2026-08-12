# Third-party scripts

### Analytics off critical path — documented
When: Client-side analytics JS is in the render-blocking bundle.
Do: Use server-side analytics where possible; ship no client analytics JS bundle for the events that don't need it.
Evidence: removes a whole script from the critical path. Where a client tag is unavoidable, `/what-if` prices it — "your analytics tag costs N ms of LCP, n=5" instead of an argument.

### Preconnect critical origins — documented
When: The page loads assets from a CDN or external domain without early hints.
Do: Add `<link rel="preconnect">` to that origin in `<head>`.
Evidence: standard early-connection pattern. Modern browsers maintain up to 6 TCP connections per domain (HTTP/1.1 limit); HTTP/2+ does not have per-domain connection limits. Only preconnect to critical origins you'll use within ~10 seconds — unused preconnected connections close after 10 seconds, wasting the setup cost. Preconnecting to everything wastes browser resources. See [web.dev/preconnect-and-dns-prefetch](https://web.dev/articles/preconnect-and-dns-prefetch), [MDN rel=preconnect](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/rel/preconnect), [Chrome Lighthouse guide](https://developer.chrome.com/docs/lighthouse/performance/uses-rel-preconnect).

### Speculation Rules API — ungated hypothesis
When: Navigation to a predictable next page is likely.
Do: Add `<script type="speculationrules">` with prerender/prefetch rules for next-page prerendering or prefetching.
Evidence: Speculation Rules API is production-ready in Chrome (v122+, latest improvements in Jan 2026) with limited support in other browsers. Enables prerendering or prefetching of predicted navigations to speed up subsequent page loads. See [MDN Speculation_Rules_API](https://developer.mozilla.org/en-US/docs/Web/API/Speculation_Rules_API), [Chrome Speculation Rules guide](https://developer.chrome.com/docs/web-platform/prerender-pages), [Chrome blog on improvements](https://developer.chrome.com/blog/speculation-rules-improvements).

### dns-prefetch — ungated hypothesis
When: Third-party origins are used but `preconnect` isn't feasible for all of them.
Do: Add `<link rel="dns-prefetch" href="https://example.com">` for non-critical third-party domains.
Evidence: Lighter-weight than preconnect — performs only DNS lookup, not TCP + TLS setup. Use for many third-party domains where preconnecting all of them would waste browser resources. Better browser support than preconnect. See [MDN dns-prefetch guide](https://developer.mozilla.org/en-US/docs/Web/Performance/Guides/dns-prefetch), [web.dev/preconnect-and-dns-prefetch](https://web.dev/articles/preconnect-and-dns-prefetch), [Chrome resource hints guide](https://web.dev/learn/performance/resource-hints).

### Facade pattern for third-party embeds — documented
When: Third-party embeds (video players, chat widgets, social media embeds) load heavy sub-resources even when never viewed.
Do: Replace embed with a lightweight static facade (image + play button for video, e.g. `lite-youtube-embed`). Load the real embed on user interaction (click/hover).
Evidence: Facade delays loading of expensive third-party resources until user engages. Common pattern for video embeds — if user never plays, resources never download. Trades some interactivity (e.g., autoplay) for faster initial load. See [Chrome Lighthouse guide](https://developer.chrome.com/docs/lighthouse/performance/third-party-facades), [web.dev embed best practices](https://web.dev/articles/embed-best-practices), [Chrome third-party loading article](https://developer.chrome.com/blog/third-party-scripts).
