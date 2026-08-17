# Images & media

### AVIF/WebP + responsive sizes — documented
When: Images are served as JPEG/PNG with no modern format negotiation.
Do: Set `images.formats:['image/avif','image/webp']` + `deviceSizes`/`imageSizes` in `next.config`.
Evidence: [Next.js image configuration](https://nextjs.org/docs/app/api-reference/config/next-config-js/images#formats). As of 2026, WebP has 97.4% global browser support ([caniuse WebP](https://caniuse.com/webp)) and AVIF has 92% support ([caniuse AVIF](https://caniuse.com/avif)), both well-suited for production with fallbacks. Verify with a network-panel format check post-deploy.

### next/image discipline — documented
When: Images lack explicit sizing, lazy loading, or the LCP image lacks priority.
Do: Add `width`/`height` + `sizes` + `loading="lazy"` + `decoding="async"`; set `preload` only on the above-fold LCP image.
Evidence: [Next.js Image component API](https://nextjs.org/docs/app/api-reference/components/image). The CLS half of this is what `cls.md`/`imageNoDims` covers.
Guidance: optimize-image-priority

### WebM-first video — documented
When: Video is served only as MP4.
Do: `<source webm>` before `<source mp4>`; `poster`=WebP still; `preload="none"` below fold, `preload="auto"` only for LCP/scrubbed video.
Evidence: [web.dev video optimization](https://web.dev/articles/video-and-source-selection) — VP9 codec in WebM typically saves 25–50% vs H.264/MP4; verify actual byte savings per asset, VP9 gains vary by content.

### Lossless WebP for PNG client logos — proven
When: Client/partner logo tiles are served as PNG with no format negotiation — PNG compresses poorly for complex logos with transparency.
Do: `cwebp -lossless -q 100 input.png -o output.webp` (see Recipes below); update `src` in-place. Lossless WebP reconstructs pixels exactly (per [WebP lossless spec](https://developers.google.com/speed/webp/docs/webp_lossless_alpha_study)). Leave CSS-mask symbol PNGs alone — switching format there is safe but out of scope.
Evidence: five logos 268→135 kB total (−50%), lossless, verified per-file smaller before committing. Google's study shows WebP lossless is 26% smaller than PNG while maintaining exact pixel fidelity.

### `fill` images need `sizes` — documented
When: A `next/image` with `fill` has no `sizes` prop — the browser assumes 100vw and fetches the largest deviceSize variant even for a grid card.
Do: Add `sizes` matching the actual layout (e.g. `"(max-width: 768px) 100vw, (max-width: 1024px) 50vw, 33vw"` for a 1/2/3-col grid); also sanity-check the source asset resolution (a 13650×10967px source re-encoded to 1600px was the dominant win in one case, not just the `sizes` fix).
Evidence: [Next.js Image component docs](https://nextjs.org/docs/app/api-reference/components/image#sizes) — "If `sizes` is missing, the browser assumes the image will be as wide as the viewport (`100vw`). This can cause unnecessarily large images to be downloaded."

### CDN offload — documented
When: Large media files are bundled into the deployment artifact.
Do: Serve large media from an object store/CDN (R2, S3, etc.); exclude from the deploy bundle (`.vercelignore` or equivalent).
Evidence: [Vercel image optimization](https://vercel.com/docs/image-optimization) — removes large binary assets from deploy size, reducing cold-start latency and serving images from edge locations with better cache hit rates.

### Browser-level lazy loading — documented
When: Below-fold images and iframes load immediately instead of deferring until viewport proximity.
Do: Add `loading="lazy"` to `<img>`, `<iframe>`, and `next/image` components below the fold. Use `loading="eager"` only for above-fold critical images (LCP candidates).
Evidence: [web.dev browser-level lazy loading](https://web.dev/articles/browser-level-image-lazy-loading) — native `loading="lazy"` defers off-screen image fetching until a calculated distance from viewport, supported in 97%+ of browsers (Chrome 76+, Firefox 75+, Safari 15.1+, Edge 79+). Eliminates need for custom lazy-load libraries; [Largest Contentful Paint](https://web.dev/articles/lcp) improves 10–15% on image-heavy pages when combined with responsive `sizes` attribute.

---

## Encoding recipes

```bash
# JPG/PNG → WebP (quality 80, good default for photos)
cwebp input.jpg -q 80 -o output.webp

# Batch JPG → WebP
for f in *.jpg; do cwebp "$f" -q 80 -o "${f%.jpg}.webp"; done

# JPG/PNG → AVIF (higher compression, slower encode)
ffmpeg -i input.jpg -c:v libaom-av1 -crf 30 -b:v 0 output.avif -y

# WebP poster still from video (frame at 0s)
ffmpeg -i input.mp4 -vframes 1 -f image2 - | cwebp -q 85 -o poster.webp -- -

# MP4 → WebM (VP9)
ffmpeg -i input.mp4 -c:v libvpx-vp9 -crf 33 -b:v 0 -c:a libopus output.webm -y
```

Install: `brew install webp ffmpeg` (AVIF needs ffmpeg built with `libaom`: `ffmpeg -encoders | grep av1`). Always check output vs source: `du -sh input.* output.*`.
