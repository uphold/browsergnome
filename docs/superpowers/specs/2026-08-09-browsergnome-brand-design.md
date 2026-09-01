# browsergnome — brand design spec

Locked design foundations for browsergnome's visual identity (logo, banner, product chrome,
diagrams, README, Pages site). Written 2026-08-09. Binding for all visual work in this repo.

## Palette — one accent, dark-first

| Token | Value | Notes |
|---|---|---|
| `--accent` | `#E45FD8` | magenta, 305°, 71% sat. Single token, replaces all violet and the green leftover |
| `--accent-ink` | `#12141A` | text/icons **on** an accent fill. Dark-on-accent is the rule — white fails at 3.03:1 |
| `--ink` | `#0b0e14` | dark canvas |
| `--panel` | `rgba(17,21,31,0.88)` | dark panel fill |
| `--text` | `#e6eaf2` | primary text on dark |
| `--dim` | `#9aa4b8` | secondary text on dark |
| `--faint` | `#5b6472` | tertiary text on dark |
| `--hair` | `rgba(255,255,255,0.08)` | dark hairline |
| `--bone` | `#FAF8F5` | light surfaces (light banner variant, Pages light sections) |
| `--ink-on-bone` | `#12141A` | never `#000000` |

**Why magenta.** Only tuned candidate clearing every reserved data hue by ≥55°, staying under the 71%
saturation ceiling (<80%), legible on the dark canvas — 6.37:1 on `#0b0e14`. Re-verified independently
(WCAG 2.x relative-luminance formula, computed fresh 2026-08-09): `#E45FD8` on `#0b0e14` = **6.37:1** ✓,
`#12141A` on `#E45FD8` = **6.07:1** ✓ — both hold. `#E45FD8` on `#FAF8F5` = **2.86:1**, not the 3.03:1
originally logged — **below the 3:1 UI/large-text floor.** See the corrected treatment rule below.
Signal-lime scored 12.6:1 on dark but 1.53:1 on white (dark-only, 42° from MEDIUM-severity yellow);
fuchsia broke the saturation ceiling. No re-tune needed — the fix is scoping how the accent is used on
bone, not swapping the hue.

### Reserved data hues — never touch for brand

`perf_scan.mjs` severity ramp: `#ff3b3b` CRITICAL (0°) · `#ff9f1c` HIGH (35°) · `#ffd23f` MEDIUM (46°) ·
`#586480`/`#7f8c9b` LOW/cold.
`build_lcp_map.mjs` node classes: `#fbbf24` amber network (43°) · `#38bdf8` sky chunk (198°) ·
`#2dd4bf` teal module (172°).
These are data semantics, not brand. They leave exactly two clean hue arcs for brand use: 60–150° and
220–350°. Magenta (305°) sits inside the second.

### Binding treatment rules

- Flat fills only. No glows, no neon outer shadows, no gradient text, no purple-on-white gradients.
- Accent surface area stays small — accent is for the one thing that matters in a view, never chrome-wide.
- **On `#FAF8F5` the accent is decorative-fill only (2.86:1, fails the 3:1 UI floor):** permitted as a
  solid block/shape fill with no informational load of its own (e.g. the logo's paint-block, a thin
  divider) — **never** as the foreground colour of text, an icon glyph/stroke, or anything whose meaning
  depends on being read directly off the bone background. Headings on light surfaces use
  `--ink-on-bone` (#12141A); the accent shows up as a shape beside or behind them, not as their colour.
  On `#0b0e14` the accent is unrestricted (6.37:1 clears both floors).
- Max one accent colour in the entire system. Neutrals stay cool (slate-family) throughout — no drift
  between warm and cool greys.

## Typography

- **Instrument Sans** (OFL, Google Fonts) — wordmark, banner, Pages headings.
- **JetBrains Mono** (OFL) — eyebrows, metrics, code, technical strings.
- The map/report templates keep their existing system-font `--sans` stack — a deliberate utilitarian
  dev-tool precedent, not to be "fixed". Web fonts apply only to marketing surfaces: banner, logo, Pages
  landing.
- All SVG asset text is converted to `<path>` outlines so nothing depends on a renderer having the font.

## Logo — "the paint block"

First read must be browsergnome's own vocabulary; "gnome" is the second read.

- A viewport frame whose top edge is cut to a shallow peak.
- Inside it, one solid `--accent` block in the upper-left — the LCP element, the thing the tool
  measures. Position mirrors real LCP behaviour.
- A single baseline timing tick below the frame.
- First read: a browser measuring its largest paint. Second read: a hooded silhouette.
- Built on a 32-unit grid so strokes land on whole pixels at 16px.

Variants: `docs/logo.svg` (full mark), `docs/logo-badge.svg` (square, favicon-safe), PNG exports at
1024px via `rsvg-convert`.

## Banner

1280×320, shipped as a theme-aware `<picture>` pair (`banner-dark.svg` + `banner-light.svg`).

Hard legibility floor: GitHub renders README content at ~880px (0.6875 downscale). Smallest text in the
1280-wide artboard must be ≥20px, landing at ≥13.75px rendered. Verified by rendering to PNG and reading
the PNG back at display width.

## Confirmed source facts (verified 2026-08-09)

- Gate formula: `improvement > max(minEffect, k · pooledStdDev)` — `stats.mjs:50-51`.
- LCP confidence model is **two tiers**, not three: `measured` (network, chunk) and `apportioned`
  (module — chunk time split across its modules). Three node *classes*, two confidence levels.
- Warmup discard: 3-sample illustration, stddev 59.9ms → 2.9ms (~20× tighter) discarding one cold-cache
  sample — `measurement.md`.
- Interleaved A/B is a null result: 30.35ms vs 30.63ms noise band, sequential vs interleaved split of
  the same 10 samples — `measurement.md`.
- `.gitignore` excludes `graph.json`, `perf-map.html`, `lcp-map.html` — demo HTML is CI-built only.

## Phase 3 — real screenshot provenance

- `docs/perf-map.png`: excalidraw cloned fresh and checked out at the calibration commit,
  full SHA `4872083c044491b6d5c96ae134a75464f96d6831` (short form `4872083c` per
  `references/perf-map.md`'s calibration note). Scan reproduced the calibration exactly: 527 modules,
  16 hotspot modules, aliases resolved (13 `@excalidraw/*` entries). Phase 6's CI pin for the Pages
  build must use the full SHA — `git fetch --depth 1 origin <partial-sha>` does not work.
- `docs/lcp-map.png`: built from the shipped fixture `skills/browsergnome/assets/trace.render-blocking-sample.json.gz`
  (real nextjs.org capture) via `lcp_attribution.mjs` → `build_lcp_map.mjs`. LCP 922ms, 6 network + 38
  chunk nodes, degraded (no bundle stats, chunk-only view) — matches the fixture's known shape.
- Both screenshotted via `chrome-devtools-mcp` from `file://` URLs, one page at a time.

## Phase 7 — review pass findings

- **`--faint` (#5b6472) on `--ink` (#0b0e14) is 3.23:1, not 4.5:1** — clears the 3:1 large-text/UI floor
  but fails the 4.5:1 body-text floor. The three diagrams (`docs/diagrams/*.svg`) used `--faint` for
  small (11–14px) text labels — eyebrows, footnotes, citations. Fixed: all diagram *text* fills moved
  to `--dim` (#9aa4b8, 7.70:1 on ink); `--faint` kept only for non-text UI (hairline strokes, dashed
  dividers, decorative dot/arrow fills), where the 3:1 floor applies and 3.23 clears it. **Not fixed
  project-wide** — `--faint` is used identically for small text in the pre-existing, already-shipped
  `lcp-map.template.html`/`perf-map.template.html`/`report.template.html` (inherited, not introduced by
  this brand pass); flagging here rather than silently leaving it unrecorded, but rewriting those
  templates' token usage is out of this pass's scope.
- **Accent-on-bone (2.86:1) audit: clean.** Re-checked every asset — the accent is never used as text
  color on `#FAF8F5` anywhere in the shipped assets. `banner-light.svg`'s icon block is the only
  accent-on-bone instance, and it's exactly the sanctioned decorative-fill case (no informational load
  independent of the ink-colored wordmark/tagline next to it).
- Name-leak grep re-run against the final scope (`README.md docs/pages/ docs/*.svg docs/*.png
  .github/`): clean.
- Anti-slop grep (Inter, `#000000`, emoji, gradient-text `background-clip`, glow `box-shadow`): clean
  across README.md, docs/pages/index.html, docs/diagrams/*.svg.
- `npm test`: 6/6 self-tests green.

## Name-leak scope (decided, not left implicit)

The "never name metrognome" rule targets **product-facing surfaces**: README, `docs/pages/`, SVG/PNG
assets, `.github/`. This spec file and git commit messages are internal design/VCS documentation, not
product surface — excluded from the rule (same category as `skills/browsergnome/SKILL.md`'s two
pre-existing, deliberately-kept mentions, which predate the rule and stay). Phase 7's grep should target
`README.md docs/pages/ docs/*.svg docs/*.png .github/`, not `docs/superpowers/`. Verified clean as of
this line: no literal "metrognome" string appears in this spec file itself.
