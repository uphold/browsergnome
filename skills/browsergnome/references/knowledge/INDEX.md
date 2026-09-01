# Knowledge base index

The hypothesis space — what's worth trying at all, curated from measured
production experience and web.dev/Chrome DevRel primary sources, cross-referenced
against `GoogleChrome/modern-web-guidance` where a clean match exists (see
**Upstream guidance** below).
`.bgn/playbook.md` holds the *evidence* (what was measured in this repo); this
holds the *candidates* (what to try next). Same 4-line `When`/`Do`/`Evidence`
shape, plus an optional 5th `Guidance:` line, so entries move between the two
without reformatting.

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

## Upstream guidance

Some entries carry a 5th line, `Guidance: <id>`, naming a `modern-web-guidance`
guide id (bare id, e.g. `optimize-image-priority` — never `category/id`, since
upstream category directories churn). `GoogleChrome/modern-web-guidance` ships
as a Claude Code plugin (`/plugin marketplace add GoogleChrome/modern-web-guidance`
then `/plugin install modern-web-guidance@googlechrome`); Doctor reports whether
it's installed.

- **Present** — retrieve the cited guide with `npx modern-web-guidance@latest
  retrieve "<id>"` (or the plugin's equivalent skill call) when reasoning about
  that entry, and treat its "Fallback strategies"/"Fallback strategy" section
  — a Baseline availability line (`Newly available` / `Widely available` /
  `has limited availability`, with a `Baseline since YYYY-MM-DD` date where
  applicable) plus a `Supported by: ...` browser list and sometimes an
  `Unsupported in: ...` line — as browser-support fact, independent of the
  gate. Exact wording varies per guide; don't assume a fixed template.
- **Absent** — proceed on the local entry alone, note `guidance <id> not
  installed` on the finding, and nudge `/plugin install
  modern-web-guidance@googlechrome`.
- A citation is not a measurement — it never upgrades an entry's tier. An
  entry cited to `modern-web-guidance` is `documented` at most; the legend
  above already warns against letting "we found a doc for it" become `proven`,
  and a Google byline is exactly the pressure that warning exists to resist.
