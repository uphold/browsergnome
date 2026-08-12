# Knowledge base index

The hypothesis space — what's worth trying at all, curated from measured
production experience and web.dev/Chrome DevRel primary sources (no external
package covers this for the web the way Callstack's react-native-best-practices
does for React Native, so this catalog is maintained here directly).
`.bgn/playbook.md` holds the *evidence* (what was measured in this repo); this
holds the *candidates* (what to try next). Same 4-line `When`/`Do`/`Evidence`
shape so entries move between the two without reformatting.

**Always read this file. Read a leaf file ONLY when its symptom matches.**

| Symptom | File |
|---|---|
| LCP too slow, render-blocking critical path, prerendering/static rendering for LCP | `lcp.md` |
| CLS, layout shift, images/video without reserved space | `cls.md` |
| INP, long tasks, scroll jank, off-screen animation/transform work | `inp.md` |
| Bundle size, unused exports, code-splitting, heavy deps at entry | `bundle.md` |
| Web fonts, `next/font`, FOIT/FOUT, font preload budget | `fonts.md` |
| Images, video, format/encoding, `next/image`, CDN media | `images-media.md` |
| HTTP caching, edge/CDN cache headers, bfcache | `caching.md` |
| RSC/`'use client'` boundaries, hydration cost, static vs dynamic rendering | `hydration-rsc.md` |
| Third-party scripts, analytics, preconnect/prefetch, speculative navigation | `third-party.md` |
| CSS-driven animation, `content-visibility`, off-screen paint cost | `css.md` |

## Detector → topic (perf_scan.mjs findings map here)

| Detector | Topic |
|---|---|
| `heavyEntryImport`, `barrelImport`, `nonLazyRoute`, `largeStaticImport` | `bundle.md` |
| `imageNoDims` | `cls.md` / `images-media.md` |
| `clientComponentInServerTree` | `hydration-rsc.md` |
| `syncScriptInHead` | `third-party.md` |
| `fontNoDisplaySwap` | `fonts.md` |
| `nestedComponent`, `inlinePropLiteral`, `listRowNoMemo`, `effectNoCleanup`, `indexAsKey`, `unvirtualizedLongList` | `inp.md` |

## Status legend used inside leaf files

- **proven** — measured before/after in a real production repo (a real number, not a population stat).
- **documented** — sourced to an authoritative doc (web.dev/MDN/Chrome DevRel/framework docs), mechanism verified, but no before/after delta from actual use. The bulk of this knowledge base lives here — don't let "we found a doc for it" get written as `proven`, that's the exact confusion this tool's gate exists to prevent.
- **ungated hypothesis** — plausible and sourced, but speculative/experimental/edge-case rather than standard practice, and never locally measured.
- **dead end** — tried, measured (or measured-in-lab with a stated caveat), did not clear the gate or was structurally a no-op. Do not re-propose without a new angle.

Autoresearch may propose anything here regardless of status, but everything still goes through the full gate — no priority boost for looking authoritative.
