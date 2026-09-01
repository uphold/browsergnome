# Caching

### Immutable media cache — documented
When: Fingerprinted static media assets are re-fetched on revisit.
Do: Set `Cache-Control: public, max-age=31536000, immutable` on fingerprinted media paths in the host/framework config's headers.
Evidence: standard immutable-asset caching; only safe when the path is content-hashed. Per [MDN Cache-Control](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control), `immutable` prevents revalidation of fingerprinted assets during their fresh period, and combined with `max-age=31536000` (one year), this is the recommended header for content-hashed static resources.

### SWR edge cache — documented
When: Dynamic API routes are fetched fresh on every request.
Do: Set `s-maxage=…, stale-while-revalidate=…` in the route's `Cache-Control` header.
Evidence: standard edge-cache pattern for semi-fresh data. Per [web.dev stale-while-revalidate](https://web.dev/articles/stale-while-revalidate), this directive defines a window during which a cache serves stale responses while asynchronously revalidating, balancing immediacy and freshness.

### No dynamic APIs in the root layout — proven
When: All routes render dynamically (`cache-control: no-store`) despite `revalidate` exports — check the root layout for `headers()`/`cookies()` (e.g. reading a locale header just to set `<html lang>`).
Do: Remove the dynamic API from the root layout (hardcode the default locale, correct it client-side from the URL if needed); keep per-request reads only in the pages that actually need them.
Evidence: prerendered page count 9→31 in one app; homepage flipped from `no-store` to a cache HIT with `s-maxage=3600, stale-while-revalidate`.

### bfcache eligibility — ungated hypothesis
When: Back-forward navigations trigger a full reload instead of a bfcache restore.
Do: Remove `unload` listeners; close IndexedDB connections; close WebSocket and WebRTC connections during pagehide/freeze events. Minimize `Cache-Control: no-store` (only use on pages with sensitive data).
Evidence: Per [web.dev bfcache](https://web.dev/articles/bfcache) and [Chrome DevTools bfcache testing](https://developer.chrome.com/docs/devtools/application/back-forward-cache):
- **unload listeners**: [Chrome is deprecating the unload event](https://developer.chrome.com/docs/web-platform/deprecating-unload); remove them and use pagehide instead.
- **IndexedDB**: Browsers will not cache pages during active IndexedDB transactions; close connections in pagehide/freeze.
- **WebRTC & WebSocket**: Actively open connections block bfcache in most browsers (Chrome 149+ allows bfcache with WebSocket, closing them automatically). Close these in pagehide/freeze, reopen in pageshow/resume.
- **Cache-Control: no-store**: [As of March-April 2025](https://developer.chrome.com/docs/web-platform/bfcache-ccns), Chrome allows bfcache for no-store pages under limited safe conditions, with a reduced 3-minute timeout. Other browsers may still block. Best practice: reserve no-store for pages with sensitive information only.
