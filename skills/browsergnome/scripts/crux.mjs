#!/usr/bin/env node
/**
 * crux.mjs — real-user field data (CrUX) for the LCP Attribution Map's third
 * tier, alongside the lab (unthrottled) and throttled-reference readouts.
 * Build-time only: `build_lcp_map.mjs` fetches this once when the map is
 * built, so the shipped HTML stays a standalone offline file.
 *
 * Two paths, in preference order:
 * - the canonical CrUX API (`records:queryRecord`) — needs a free Google
 *   Cloud API key, returns origin-level p75 + histograms directly.
 * - keyless PageSpeed Insights (`runPagespeed`) — same underlying field
 *   data via `originLoadingExperience`/`loadingExperience`, no key needed,
 *   used whenever no `cruxApiKey` is configured (the common case).
 *
 * Both APIs report field data for an ORIGIN (all pages aggregated) or a
 * single URL; this always queries by origin, since "production at max" for
 * a whole app is the origin-level number, not one route's.
 *
 * `fetch` is injectable so selfTest() runs fully offline.
 *
 * Usage:
 *   import { getFieldData } from './crux.mjs'
 *   node crux.mjs --self-test
 */

import process from 'node:process';

const CRUX_ENDPOINT = 'https://chromeuxreport.googleapis.com/v1/records:queryRecord';
const PSI_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

// Standard Core Web Vitals good/needs-improvement/poor boundaries — [good-max, poor-min].
// ms for everything except cls (unitless).
const THRESHOLDS = {
  lcp: [2500, 4000],
  fcp: [1800, 3000],
  cls: [0.1, 0.25],
  inp: [200, 500],
  ttfb: [800, 1800],
};

export function rateMetric(key, value) {
  if (value == null) return null;
  const t = THRESHOLDS[key];
  if (!t) return null;
  if (value <= t[0]) return 'good';
  if (value > t[1]) return 'poor';
  return 'ni';
}

// CrUX API: metrics keyed by snake_case; every percentile is a raw ms
// integer except cumulative_layout_shift, whose p75 ships as a string
// decimal (already unscaled — see Chrome's own API docs).
const CRUX_METRIC_KEYS = {
  lcp: 'largest_contentful_paint',
  fcp: 'first_contentful_paint',
  cls: 'cumulative_layout_shift',
  inp: 'interaction_to_next_paint',
  ttfb: 'experimental_time_to_first_byte',
};

export function normalizeCruxResponse(json) {
  const metrics = json?.record?.metrics || {};
  const out = {};
  for (const [key, cruxKey] of Object.entries(CRUX_METRIC_KEYS)) {
    const p75 = metrics[cruxKey]?.percentiles?.p75;
    const value = p75 == null ? null : key === 'cls' ? parseFloat(p75) : Number(p75);
    out[key] = { p75: value, rating: rateMetric(key, value) };
  }
  return out;
}

// PSI carries the same field data under SCREAMING_SNAKE keys. Its own
// FAST/AVERAGE/SLOW/NONE category is used as-is when present (it's Google's
// judgement of the same number) rather than re-deriving from THRESHOLDS.
// CLS's percentile is scaled x100 (a value of 15 means CLS 0.15) — every
// other metric is a raw ms integer.
const PSI_METRIC_KEYS = {
  lcp: 'LARGEST_CONTENTFUL_PAINT_MS',
  fcp: 'FIRST_CONTENTFUL_PAINT_MS',
  cls: 'CUMULATIVE_LAYOUT_SHIFT_SCORE',
  inp: 'INTERACTION_TO_NEXT_PAINT',
  ttfb: 'EXPERIMENTAL_TIME_TO_FIRST_BYTE',
};
const PSI_CATEGORY = { FAST: 'good', AVERAGE: 'ni', SLOW: 'poor', NONE: null };

export function normalizePsiResponse(json) {
  const metrics = (json?.originLoadingExperience || json?.loadingExperience)?.metrics || {};
  const out = {};
  for (const [key, psiKey] of Object.entries(PSI_METRIC_KEYS)) {
    const m = metrics[psiKey];
    if (!m) { out[key] = { p75: null, rating: null }; continue; }
    const value = key === 'cls' ? m.percentile / 100 : m.percentile;
    out[key] = { p75: value, rating: PSI_CATEGORY[m.category] ?? rateMetric(key, value) };
  }
  return out;
}

/**
 * Fetch real-user field data for `prodUrl`'s origin. Never throws — any
 * failure (invalid URL, offline, no `fetch` global, non-2xx, no field data
 * for this origin — CrUX/PSI both return this for low-traffic origins)
 * returns null so the map still builds without this tier.
 */
export async function getFieldData(prodUrl, { apiKey, fetchImpl, timeoutMs = 8000 } = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return null;
  let origin;
  try { origin = new URL(prodUrl).origin; } catch { return null; }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (apiKey) {
      const res = await doFetch(`${CRUX_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ origin, formFactor: 'DESKTOP' }),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      return { source: 'crux', url: origin, metrics: normalizeCruxResponse(await res.json()) };
    }
    const res = await doFetch(`${PSI_ENDPOINT}?url=${encodeURIComponent(origin)}&strategy=DESKTOP`, { signal: controller.signal });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json?.originLoadingExperience && !json?.loadingExperience) return null;
    return { source: 'psi', url: origin, metrics: normalizePsiResponse(json) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Self-test ───────────────────────────────────────────────────────────────

function selfTest() {
  let pass = 0, fail = 0;
  const check = (name, got, want) => {
    const eq = JSON.stringify(got) === JSON.stringify(want);
    console.log(`  ${eq ? 'PASS' : 'FAIL'}  ${name}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
    eq ? pass++ : fail++;
  };

  // rateMetric — boundary values
  check('rateMetric: exactly at good boundary -> good', rateMetric('lcp', 2500), 'good');
  check('rateMetric: just past good boundary -> ni', rateMetric('lcp', 2501), 'ni');
  check('rateMetric: exactly at poor boundary -> ni (poor is strictly greater)', rateMetric('lcp', 4000), 'ni');
  check('rateMetric: just past poor boundary -> poor', rateMetric('lcp', 4001), 'poor');
  check('rateMetric: null value -> null', rateMetric('lcp', null), null);
  check('rateMetric: unknown key -> null', rateMetric('bogus', 100), null);

  // normalizeCruxResponse — real documented shape, cls as a string decimal
  const cruxFixture = {
    record: {
      key: { origin: 'https://example.com' },
      metrics: {
        largest_contentful_paint: { percentiles: { p75: 2400 } },
        first_contentful_paint: { percentiles: { p75: 1500 } },
        cumulative_layout_shift: { percentiles: { p75: '0.05' } },
        interaction_to_next_paint: { percentiles: { p75: 150 } },
        experimental_time_to_first_byte: { percentiles: { p75: 600 } },
      },
    },
  };
  const cruxNorm = normalizeCruxResponse(cruxFixture);
  check('normalizeCruxResponse: lcp p75 + good rating', cruxNorm.lcp, { p75: 2400, rating: 'good' });
  check('normalizeCruxResponse: cls string decimal parsed to a number, not left as a string', cruxNorm.cls.p75, 0.05);
  check('normalizeCruxResponse: cls rating from the parsed number', cruxNorm.cls.rating, 'good');
  check('normalizeCruxResponse: missing metrics object -> every field null, no throw', normalizeCruxResponse({}).lcp, { p75: null, rating: null });

  // normalizePsiResponse — category used as-is; cls percentile /100
  const psiFixture = {
    originLoadingExperience: {
      metrics: {
        LARGEST_CONTENTFUL_PAINT_MS: { percentile: 4200, category: 'SLOW' },
        FIRST_CONTENTFUL_PAINT_MS: { percentile: 1700, category: 'FAST' },
        CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 5, category: 'FAST' },
        INTERACTION_TO_NEXT_PAINT: { percentile: 600, category: 'SLOW' },
        EXPERIMENTAL_TIME_TO_FIRST_BYTE: { percentile: 900, category: 'AVERAGE' },
      },
    },
  };
  const psiNorm = normalizePsiResponse(psiFixture);
  check('normalizePsiResponse: lcp uses PSI\'s own SLOW category, not a re-derived rating', psiNorm.lcp, { p75: 4200, rating: 'poor' });
  check('normalizePsiResponse: cls percentile scaled /100 (5 -> 0.05)', psiNorm.cls.p75, 0.05);
  check('normalizePsiResponse: falls back to loadingExperience when originLoadingExperience is absent',
    normalizePsiResponse({ loadingExperience: psiFixture.originLoadingExperience }).lcp.p75, 4200);
  check('normalizePsiResponse: metric absent from response (e.g. pre-INP PSI payload) -> null, not a throw',
    normalizePsiResponse({ originLoadingExperience: { metrics: {} } }).inp, { p75: null, rating: null });

  // getFieldData — offline, fully injected fetch
  (async () => {
    let calls = 0;
    const okFetch = (body) => async () => { calls++; return { ok: true, json: async () => body }; };

    const invalidUrlCalls = calls;
    const r1 = await getFieldData('not a url', { fetchImpl: async () => { calls++; return { ok: true, json: async () => ({}) }; } });
    check('getFieldData: invalid prodUrl -> null, without ever calling fetch', [r1, calls - invalidUrlCalls], [null, 0]);

    const r2 = await getFieldData('https://example.com/some/page', { apiKey: 'k', fetchImpl: okFetch(cruxFixture) });
    check('getFieldData: with an apiKey, uses the CrUX API and normalizes it', [r2.source, r2.url, r2.metrics.lcp.p75], ['crux', 'https://example.com', 2400]);

    const r3 = await getFieldData('https://example.com', { fetchImpl: okFetch(psiFixture) });
    check('getFieldData: no apiKey, falls back to keyless PSI', [r3.source, r3.metrics.cls.p75], ['psi', 0.05]);

    const r4 = await getFieldData('https://example.com', { fetchImpl: async () => ({ ok: false }) });
    check('getFieldData: non-2xx response -> null', r4, null);

    const r5 = await getFieldData('https://example.com', { fetchImpl: async () => { throw new Error('offline'); } });
    check('getFieldData: fetch throws (offline/aborted) -> null, not an unhandled rejection', r5, null);

    const r6 = await getFieldData('https://example.com', { fetchImpl: okFetch({}) });
    check('getFieldData: 2xx but no field data for this origin -> null, not an empty metrics object', r6, null);

    console.log(`\n  ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  })();
}

if (process.argv.includes('--self-test')) selfTest();
