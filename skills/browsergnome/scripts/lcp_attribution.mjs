#!/usr/bin/env node
/**
 * lcp_attribution.mjs — DATA LAYER ONLY for the LCP Attribution Map.
 * Combines a captured trace (trace_metrics.mjs's decoded events) with
 * bundle_stats.mjs's chunk→module bytes mapping into a three-tier node
 * list: network resources (measured), chunks (measured), source modules
 * (apportioned). No visualization here — see the file-level note at the
 * bottom for what's deliberately not built and why.
 *
 * **Network timing comes from raw trace events, not `performance_
 * analyze_insight`.** That MCP tool's RenderBlocking/LCPBreakdown/
 * DocumentLatency insights return semi-structured text (a report with an
 * embedded pseudo-CSV table), not JSON — fine for an agent reading it
 * live, wrong for a pure offline-testable script. `ResourceSendRequest`
 * carries `url`, `renderBlocking` ('blocking' | 'potentially_blocking' |
 * 'non_blocking' | absent), `resourceType`, and `frame` directly;
 * `ResourceReceiveResponse`/`ResourceFinish` carry response/finish timing,
 * correlated by `requestId`. Computing each render-blocking CSS request's
 * duration from these raw events (send.ts to finish.ts) reproduced
 * `performance_analyze_insight`'s own reported duration for the same
 * requests to within ~1ms on a live capture — the small gap is expected,
 * since the insight's window is queuedTime→processingCompleteTime,
 * slightly wider than send→finish.
 * `assets/trace.render-blocking-sample.json.gz` ships that capture,
 * headers stripped, as `selfTest()`'s fixture.
 *
 * **The module-apportionment ratio divides by the chunk's own module-byte
 * sum, not `bundle_stats.mjs`'s `chunk.bytes`.** Those are two different
 * numbers for the same chunk: `chunk.bytes` is the real shipped ASSET size
 * (post-minify); the sum of `chunk.modules[].bytes` is the pre-minify
 * MODULE size (webpack's own `chunk.size` stat). On the shipped multi-chunk
 * fixture: asset bytes 11886, module-byte sum 7546 — apportioning against
 * the asset-size denominator would under-attribute every module by the
 * same ~36% ratio, and the ms wouldn't sum back to `chunk_ms`.
 * `apportionModuleMs` computes the denominator fresh from `chunk.modules`
 * instead.
 *
 * **Network tier = resources with `renderBlocking === 'blocking'` that
 * started before the navigation's LCP timestamp** — the same set
 * `performance_analyze_insight`'s RenderBlocking insight reports (matched
 * 6/6 on the real capture). This is deliberately NOT "the exact resource
 * that IS the LCP element" — the one real `largestContentfulPaint::
 * Candidate` event captured this way (a text node, not an image) carries
 * no `url` field at all, only `nodeId`/`type`/`size`, so there's no
 * reliable node↔network-request link to build on. "The LCP-critical-path
 * network resources" is the honest claim here, not "the LCP resource itself."
 *
 * **Contribution ms is each resource's own load duration, clipped to the
 * pre-LCP window — not a wall-clock-additive model.** Render-blocking
 * requests load in parallel (the real fixture's 6 CSS requests all start
 * within ~1ms of each other), so summing every node's `ms` will generally
 * exceed the actual LCP time. That's a known, disclosed property of
 * per-resource duration, not a bug — the map's job is showing *which*
 * resources were on the critical path and *how long each individually
 * took*, not decomposing wall-clock time into non-overlapping slices
 * (that would need a browser main-thread contention model this trace
 * doesn't provide). Say so in the UI when this ships — see the bottom note.
 *
 * Usage:
 *   node lcp_attribution.mjs <trace.json[.gz]> [bundle-stats.json[.gz]]
 *   node lcp_attribution.mjs --self-test
 */

import fs from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { decodeTrace, pickNavigation, computeLCP, computeFCP, computeTTFB, computeLongTasksAndTBT, computeScriptTimings } from './trace_metrics.mjs';
import { decodeStats, parseBundleStats } from './bundle_stats.mjs';

// ── Network tier (measured) ────────────────────────────────────────────────

/**
 * Correlate ResourceSendRequest/ResourceReceiveResponse/ResourceFinish by
 * `requestId`, scoped to the navigation's frame, into per-request records.
 * A request missing its Finish event (still in flight when the trace
 * stopped) is dropped — no finish time means no measured duration.
 *
 * `ResourceFinish` carries no `frame` field at all (confirmed on a real
 * capture — only `decodedBodyLength`/`didFail`/`encodedDataLength`/
 * `finishTime`/`requestId`), so frame scoping happens once, on the `sends`
 * map, and `finishes` is looked up by requestId without re-checking frame.
 * This only stays correct because requestId doesn't collide across frames:
 * most requests use `<pid>.<counter>` with the counter unique per renderer
 * process (confirmed on 92 of 93 requests in the real fixture); the
 * navigation request itself uses a GUID instead. Neither form can produce
 * the same value across two different requests, so a finish can't
 * cross-attach to the wrong frame's send. A synthetic two-frame test below
 * with distinct requestIds locks in that behavior; it doesn't (and can't,
 * given the ID scheme) test an actual collision, because nothing here
 * produces one.
 *
 * `didFail` requests ARE included, deliberately: a render-blocking request
 * that failed (404, aborted, CSP-blocked) still occupied the render-blocking
 * slot for however long it took to fail, which is real cost the map should
 * show, not silently drop. Each resource carries `failed` so a future UI
 * can render it distinctly (a failed blocking request is a different kind
 * of fix — "why is this failing" — than a slow-but-successful one).
 */
export function computeNetworkResources(events, nav) {
  const sends = new Map();
  for (const e of events) {
    if (e.name === 'ResourceSendRequest' && e.args?.data?.frame === nav.frame) {
      sends.set(e.args.data.requestId, e);
    }
  }
  const finishes = new Map();
  for (const e of events) {
    if (e.name === 'ResourceFinish' && sends.has(e.args?.data?.requestId)) {
      finishes.set(e.args.data.requestId, e);
    }
  }

  const resources = [];
  for (const [requestId, sendEvent] of sends) {
    const finishEvent = finishes.get(requestId);
    if (!finishEvent) continue;
    const d = sendEvent.args.data;
    resources.push({
      url: d.url,
      resourceType: d.resourceType,
      renderBlocking: d.renderBlocking === 'blocking',
      startMs: (sendEvent.ts - nav.navStartUs) / 1000,
      finishMs: (finishEvent.ts - nav.navStartUs) / 1000,
      bytes: finishEvent.args.data.decodedBodyLength ?? 0,
      failed: finishEvent.args.data.didFail ?? false,
    });
  }
  return resources;
}

/**
 * Network tier: render-blocking resources that started before LCP, each
 * node's `ms` clipped to [start, min(finish, lcpMs)] — see file header for
 * why this isn't wall-clock-additive. Returns [] if `lcpMs` is null (no LCP
 * in this trace) since "before LCP" is undefined without an LCP timestamp.
 */
export function attributeNetworkTier(resources, lcpMs) {
  if (lcpMs == null) return [];
  return resources
    .filter(r => r.renderBlocking && r.startMs < lcpMs)
    .map(r => ({
      class: 'network',
      label: r.url,
      resourceType: r.resourceType,
      bytes: r.bytes,
      ms: Math.max(0, Math.min(r.finishMs, lcpMs) - Math.max(r.startMs, 0)),
      confidence: 'measured',
      failed: r.failed ?? false, // see computeNetworkResources's doc comment — included deliberately
    }));
}

// ── Chunk tier (measured) ───────────────────────────────────────────────────

/**
 * Chunk tier: reuses trace_metrics.mjs's computeScriptTimings verbatim
 * (already verified against real traces — see that file's header) —
 * {url, compileMs, evaluateMs} per script URL, ms = compile+evaluate.
 */
export function attributeChunkTier(events, nav) {
  return computeScriptTimings(events, nav).map(s => ({
    class: 'chunk',
    label: s.url,
    ms: s.compileMs + s.evaluateMs,
    compileMs: s.compileMs,
    evaluateMs: s.evaluateMs,
    confidence: 'measured',
  }));
}

// ── Module tier (apportioned) ───────────────────────────────────────────────

/**
 * For one bundle_stats.mjs chunk record, split its measured `chunkMs`
 * (from the chunk tier above, matched by filename — see `matchChunkToUrl`)
 * across its modules by BYTE SHARE OF THAT CHUNK'S OWN MODULES, not by
 * share of the chunk's shipped asset bytes (see file header for why those
 * are different numbers and dividing by the wrong one under-attributes
 * every module). Modules with 0 total chunk bytes (an empty modules[] —
 * e.g. an unsupported-format bundler stats file) get no module tier for
 * that chunk; the caller should already have degraded before this point
 * (see `attributeModuleTier`).
 */
export function apportionModuleMs(chunk, chunkMs) {
  const totalModuleBytes = chunk.modules.reduce((s, m) => s + m.bytes, 0);
  if (totalModuleBytes === 0) return [];
  return chunk.modules.map(m => ({
    class: 'module',
    label: m.module,
    bytes: m.bytes,
    ms: chunkMs * (m.bytes / totalModuleBytes),
    confidence: 'apportioned',
  }));
}

/**
 * Glue chunk-tier nodes (URLs, from the trace) to bundle_stats chunks
 * (filenames, from the build) by suffix match — a trace script URL is
 * always `<origin>/<path>/<file>`, and bundle_stats' `chunk.file` is just
 * `<file>`, so `url.endsWith('/' + chunk.file)` is the correct match, not
 * equality.
 */
function matchChunkToUrl(chunkFile, scriptUrl) {
  return typeof scriptUrl === 'string' && scriptUrl.endsWith('/' + chunkFile);
}

/**
 * Module tier for every bundle_stats chunk that has a matching chunk-tier
 * (measured) entry. Chunks with no bundle stats match, or bundle stats that
 * failed to parse (`bundleStats.error` set — unsupported bundler), produce
 * no module tier — degrade to chunk-only, per the plan's mandatory
 * degradation rule (see file header). Callers must not fabricate one.
 */
export function attributeModuleTier(chunkTierNodes, bundleStats) {
  if (!bundleStats || bundleStats.error || !Array.isArray(bundleStats.chunks)) return [];
  const modules = [];
  for (const chunk of bundleStats.chunks) {
    const matched = chunkTierNodes.find(n => matchChunkToUrl(chunk.file, n.label));
    if (!matched) continue;
    modules.push(...apportionModuleMs(chunk, matched.ms));
  }
  return modules;
}

// ── Transport profile ────────────────────────────────────────────────────

function safeOrigin(url) {
  try { return new URL(url).origin; } catch { return null; }
}

/**
 * First-party request count by HTTP protocol, scoped to the navigation's
 * frame. First-party only (same origin as the navigation URL) — third-party
 * CDN/widget/analytics requests are usually already on h2/h3 and would mask
 * a first-party origin still on HTTP/1.1.
 *
 * HTTP/1.1 caps the browser at ~6 connections per origin; a first-party
 * origin with many requests on HTTP/1.1 serializes into a request waterfall
 * a production CDN (h2/h3, multiplexed) wouldn't have. `legacyHttp` flags
 * that case so a measurement against it can be labeled non-representative
 * instead of reported at face value.
 */
export function computeTransportProfile(events, nav) {
  const origin = safeOrigin(nav.url);
  const sends = new Map();
  for (const e of events) {
    if (e.name === 'ResourceSendRequest' && e.args?.data?.frame === nav.frame) {
      sends.set(e.args.data.requestId, e.args.data.url);
    }
  }
  const byProtocol = {};
  let firstPartyTotal = 0, http1Count = 0;
  for (const e of events) {
    if (e.name !== 'ResourceReceiveResponse') continue;
    const requestId = e.args?.data?.requestId;
    const url = sends.get(requestId);
    if (!url || (origin && safeOrigin(url) !== origin)) continue;
    firstPartyTotal++;
    const protocol = e.args.data.protocol || 'unknown';
    byProtocol[protocol] = (byProtocol[protocol] || 0) + 1;
    if (protocol === 'http/1.1') http1Count++;
  }
  const http1Share = firstPartyTotal ? http1Count / firstPartyTotal : 0;
  return {
    firstPartyTotal,
    byProtocol,
    http1Count,
    http1Share,
    legacyHttp: firstPartyTotal > 0 && http1Share >= 0.5,
  };
}

// ── Phase breakdown ──────────────────────────────────────────────────────

/**
 * TTFB / load-to-FCP / FCP-to-LCP split of the full lcpMs window. Unlike
 * the node tiers above (per-resource, can overlap, can undershoot lcpMs —
 * see file header), this always sums to exactly lcpMs by construction: each
 * mark is clamped into [previous mark, lcpMs] before subtracting, so a
 * missing or out-of-order FCP/TTFB can't make a phase negative or make the
 * three parts not add up. It exists because the node tiers only cover
 * network-loading time — a load that's fast but whose LCP fires long after
 * FCP (main-thread work, client-side data fetching, hydration) would
 * otherwise show a handful of small nodes next to a much larger lcpMs with
 * nothing accounting for the difference.
 */
export function computeLcpPhases(ttfbMs, fcpMs, lcpMs) {
  if (lcpMs == null) return null;
  const ttfb = Math.max(0, Math.min(ttfbMs ?? 0, lcpMs));
  const fcp = Math.max(ttfb, Math.min(fcpMs ?? ttfb, lcpMs));
  return { ttfbMs: ttfb, loadToFcpMs: fcp - ttfb, fcpToLcpMs: lcpMs - fcp };
}

// ── Throttled reference (optional, secondary capture) ───────────────────

/**
 * Summary metrics (LCP/FCP/TBT) from a second, separately-captured trace —
 * a throttled reference run alongside the main (default: unthrottled)
 * capture, for a Lighthouse-comparable secondary readout. `label` describes
 * whatever `emulate` conditions that second trace was actually captured
 * under; this function has no way to know that from the trace itself, so it
 * takes the caller's word for it rather than guessing.
 */
export function computeThrottledReference(events, label) {
  const nav = pickNavigation(events);
  if (!nav) return null;
  const lcpMs = computeLCP(events, nav);
  const { tbt } = computeLongTasksAndTBT(events, nav);
  return { label: label || 'throttled', lcpMs, fcpMs: computeFCP(events, nav), tbtMs: tbt };
}

// ── Combine ──────────────────────────────────────────────────────────────

/**
 * Build the full three-tier node list for one trace (+ optional bundle
 * stats). `bundleStats` is optional — omit it (or pass a `{error}` result
 * from `parseBundleStats`) to get the mandatory degraded chunk-only map.
 * `throttledEvents`/`throttledLabel` are optional — a second trace's events
 * to summarize as a secondary reference reading (see `computeThrottledReference`).
 */
export function buildAttributionData(events, bundleStats, throttledEvents, throttledLabel) {
  const nav = pickNavigation(events);
  if (!nav) return { error: 'no navigation found in trace' };
  const lcpMs = computeLCP(events, nav);
  const network = attributeNetworkTier(computeNetworkResources(events, nav), lcpMs);
  const chunks = attributeChunkTier(events, nav);
  const degraded = !bundleStats || bundleStats.error != null;
  const modules = degraded ? [] : attributeModuleTier(chunks, bundleStats);
  return {
    url: nav.url,
    lcpMs,
    tbtMs: computeLongTasksAndTBT(events, nav).tbt,
    phases: computeLcpPhases(computeTTFB(events, nav), computeFCP(events, nav), lcpMs),
    transport: computeTransportProfile(events, nav),
    throttled: throttledEvents ? computeThrottledReference(throttledEvents, throttledLabel) : null,
    degraded, // true → no bundler stats, module tier intentionally empty
    nodes: [...network, ...chunks, ...modules],
  };
}

// ── Self-test ───────────────────────────────────────────────────────────────

function selfTest() {
  let pass = 0, fail = 0;
  const check = (name, got, want) => {
    const eq = JSON.stringify(got) === JSON.stringify(want);
    console.log(`  ${eq ? 'PASS' : 'FAIL'}  ${name}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
    eq ? pass++ : fail++;
  };

  // apportionModuleMs: divides by module-byte-sum, not asset bytes (see file header).
  const chunk = { file: 'main.js', bytes: 1000, modules: [{ module: 'a.js', bytes: 30 }, { module: 'b.js', bytes: 70 }] };
  const modMs = apportionModuleMs(chunk, 100);
  check('apportionModuleMs: a.js gets 30% of chunk ms (30/100 module-byte share, not 30/1000 asset-byte share)',
    modMs.find(m => m.label === 'a.js').ms, 30);
  check('apportionModuleMs: b.js gets 70%', modMs.find(m => m.label === 'b.js').ms, 70);
  check('apportionModuleMs: module ms sums back to chunk ms exactly (proves the denominator fix)',
    modMs.reduce((s, m) => s + m.ms, 0), 100);
  check('apportionModuleMs: empty modules[] (unsupported-format degrade case) returns []',
    apportionModuleMs({ file: 'x.js', bytes: 100, modules: [] }, 50), []);

  // computeLcpPhases: always sums to exactly lcpMs, even with missing/out-of-order marks
  check('computeLcpPhases: null lcpMs -> null', computeLcpPhases(10, 20, null), null);
  check('computeLcpPhases: normal case sums to lcpMs', computeLcpPhases(10, 40, 100),
    { ttfbMs: 10, loadToFcpMs: 30, fcpToLcpMs: 60 });
  check('computeLcpPhases: missing ttfb/fcp treated as 0, still sums to lcpMs',
    computeLcpPhases(null, null, 100), { ttfbMs: 0, loadToFcpMs: 0, fcpToLcpMs: 100 });
  check('computeLcpPhases: fcp before ttfb clamped, no negative phase',
    computeLcpPhases(50, 10, 100), { ttfbMs: 50, loadToFcpMs: 0, fcpToLcpMs: 50 });
  check('computeLcpPhases: marks past lcpMs clamped, no negative phase',
    computeLcpPhases(200, 300, 100), { ttfbMs: 100, loadToFcpMs: 0, fcpToLcpMs: 0 });

  // computeTransportProfile: first-party-only protocol profiling
  {
    const FRAME = 'TFRAME', PID = 111;
    const nav = { frame: FRAME, pid: PID, navStartUs: 1_000_000, url: 'https://example.com/' };
    const send = (n, url) => ({ name: 'ResourceSendRequest', ts: 1_000_000 + n, args: { data: { requestId: `r${n}`, frame: FRAME, url } } });
    const recv = (n, protocol) => ({ name: 'ResourceReceiveResponse', ts: 1_000_000 + n + 1, args: { data: { requestId: `r${n}`, protocol } } });

    const mostlyHttp1 = [
      send(1, 'https://example.com/a.js'), recv(1, 'http/1.1'),
      send(2, 'https://example.com/b.js'), recv(2, 'http/1.1'),
      send(3, 'https://example.com/c.js'), recv(3, 'h2'),
    ];
    const mostlyHttp1Profile = computeTransportProfile(mostlyHttp1, nav);
    check('computeTransportProfile: mostly http/1.1 first-party -> legacyHttp true', mostlyHttp1Profile.legacyHttp, true);
    check('computeTransportProfile: http1Count counts only http/1.1', mostlyHttp1Profile.http1Count, 2);
    check('computeTransportProfile: firstPartyTotal counts all first-party responses', mostlyHttp1Profile.firstPartyTotal, 3);

    const thirdPartyHttp1 = [
      send(1, 'https://example.com/a.js'), recv(1, 'h2'),
      send(2, 'https://widget.example/w.js'), recv(2, 'http/1.1'), // third-party, must not count
    ];
    check('computeTransportProfile: third-party http/1.1 excluded, first-party is h2 -> legacyHttp false',
      computeTransportProfile(thirdPartyHttp1, nav).legacyHttp, false);

    check('computeTransportProfile: no responses -> firstPartyTotal 0, legacyHttp false',
      computeTransportProfile([], nav), { firstPartyTotal: 0, byProtocol: {}, http1Count: 0, http1Share: 0, legacyHttp: false });
  }

  // matchChunkToUrl (via attributeModuleTier): suffix match, not equality
  const chunkTier = [{ class: 'chunk', label: 'https://example.com/_next/static/main.js', ms: 100, confidence: 'measured' }];
  const bundleStats = { chunks: [{ file: 'main.js', bytes: 1000, modules: [{ module: 'a.js', bytes: 100 }] }] };
  check('attributeModuleTier: matches trace URL to bundle chunk by filename suffix, not exact equality',
    attributeModuleTier(chunkTier, bundleStats).length, 1);
  check('attributeModuleTier: no bundle stats (undefined) degrades to empty module tier',
    attributeModuleTier(chunkTier, undefined), []);
  check('attributeModuleTier: bundle stats with .error (unsupported bundler) degrades to empty module tier',
    attributeModuleTier(chunkTier, { error: 'unrecognized format' }), []);

  // attributeNetworkTier: clipping + null-LCP handling
  const resources = [
    { url: 'a.css', resourceType: 'Stylesheet', renderBlocking: true, startMs: 10, finishMs: 40, bytes: 500 },
    { url: 'b.css', resourceType: 'Stylesheet', renderBlocking: false, startMs: 10, finishMs: 40, bytes: 500 }, // not blocking, excluded
    { url: 'c.css', resourceType: 'Stylesheet', renderBlocking: true, startMs: 200, finishMs: 300, bytes: 500 }, // starts after LCP, excluded
    { url: 'd.css', resourceType: 'Stylesheet', renderBlocking: true, startMs: 10, finishMs: 150, bytes: 500 }, // finishes after LCP, clipped
  ];
  const net = attributeNetworkTier(resources, 100);
  check('attributeNetworkTier: excludes non-blocking resources', net.some(n => n.label === 'b.css'), false);
  check('attributeNetworkTier: excludes resources starting after LCP', net.some(n => n.label === 'c.css'), false);
  check('attributeNetworkTier: clips a resource finishing after LCP to the LCP boundary (150->100, ms=90 not 140)',
    net.find(n => n.label === 'd.css')?.ms, 90);
  check('attributeNetworkTier: unclipped resource keeps its real duration (a.css, 40-10=30)',
    net.find(n => n.label === 'a.css')?.ms, 30);
  check('attributeNetworkTier: null LCP (no LCP in trace) returns no network tier, not a guess',
    attributeNetworkTier(resources, null), []);

  // computeNetworkResources: frame scoping + didFail — see that function's
  // doc comment for why a finish never cross-attaches across frames here.
  {
    const FRAME_A = 'FRAMEA', FRAME_B = 'FRAMEB', PID = 111;
    const navA = { frame: FRAME_A, pid: PID, navStartUs: 1_000_000, url: 'https://a.example/' };
    const crossFrameEvents = [
      { name: 'ResourceSendRequest', ts: 1_010_000, args: { data: { requestId: '111.1', frame: FRAME_A, url: 'a.css', resourceType: 'Stylesheet', renderBlocking: 'blocking' } } },
      { name: 'ResourceSendRequest', ts: 1_020_000, args: { data: { requestId: '111.2', frame: FRAME_B, url: 'b.css', resourceType: 'Stylesheet', renderBlocking: 'blocking' } } },
      { name: 'ResourceFinish', ts: 1_030_000, args: { data: { requestId: '111.1', decodedBodyLength: 100, didFail: false } } },
      { name: 'ResourceFinish', ts: 1_099_000, args: { data: { requestId: '111.2', decodedBodyLength: 200, didFail: false } } },
    ];
    const resourcesA = computeNetworkResources(crossFrameEvents, navA);
    check('computeNetworkResources: only frame A\'s request is returned, not frame B\'s (distinct requestIds, no cross-attach)',
      resourcesA.map(r => r.url), ['a.css']);
    check('computeNetworkResources: frame A\'s request gets frame A\'s own finish time (20ms), not frame B\'s (89ms)',
      resourcesA[0].finishMs - resourcesA[0].startMs, 20);

    const failedEvents = [
      { name: 'ResourceSendRequest', ts: 1_010_000, args: { data: { requestId: '111.3', frame: FRAME_A, url: 'broken.js', resourceType: 'Script', renderBlocking: 'blocking' } } },
      { name: 'ResourceFinish', ts: 1_015_000, args: { data: { requestId: '111.3', decodedBodyLength: 0, didFail: true } } },
    ];
    const failedResources = computeNetworkResources(failedEvents, navA);
    check('computeNetworkResources: a failed (didFail:true) request is still included, not silently dropped',
      failedResources.length, 1);
    check('computeNetworkResources: failed request carries failed:true so a UI can render it distinctly',
      failedResources[0].failed, true);
    check('attributeNetworkTier: failed field passes through to the node',
      attributeNetworkTier(failedResources, 100)[0]?.failed, true);
  }

  // shipped fixture: a real nextjs.org capture — six real render-blocking
  // CSS requests (see file header for the performance_analyze_insight
  // spot-check these durations were checked against).
  try {
    const path = new URL('../assets/trace.render-blocking-sample.json.gz', import.meta.url);
    const events = decodeTrace(fs.readFileSync(path));
    const nav = pickNavigation(events);
    const resources = computeNetworkResources(events, nav);
    const blocking = resources.filter(r => r.renderBlocking);
    check('real fixture: 6 real render-blocking CSS requests found (matches performance_analyze_insight\'s own count)',
      blocking.length, 6);
    const lcpMs = computeLCP(events, nav);
    check('real fixture: LCP present and in a sane range (matches the ~922ms chrome-devtools-mcp reported live)',
      lcpMs > 800 && lcpMs < 1000, true);
    const network = attributeNetworkTier(resources, lcpMs);
    check('real fixture: all 6 render-blocking requests attributed (all started well before LCP)',
      network.length, 6);
    const durations = network.map(n => Math.round(n.ms * 10) / 10).sort((a, b) => a - b);
    check('real fixture: durations in the range independently spot-checked against performance_analyze_insight (32-35ms window)',
      durations.every(d => d > 25 && d < 40), true);
    // confirms the trim kept EvaluateScript/v8.compile — without this check,
    // a fixture with only network events would pass every assertion above
    // by luck rather than by content.
    const chunkTier = attributeChunkTier(events, nav);
    check('real fixture: chunk tier is genuinely non-empty (real script timings survived the trim, not just network events)',
      chunkTier.length > 0, true);
    const phases = computeLcpPhases(computeTTFB(events, nav), computeFCP(events, nav), lcpMs);
    check('real fixture: phases sum to exactly lcpMs',
      Math.round((phases.ttfbMs + phases.loadToFcpMs + phases.fcpToLcpMs) * 1000) / 1000,
      Math.round(lcpMs * 1000) / 1000);
    check('real fixture: nextjs.org served over modern HTTP, no false-positive legacyHttp flag',
      computeTransportProfile(events, nav).legacyHttp, false);
  } catch (err) {
    console.log(`  FAIL  real fixture decodes and parses  (threw: ${err.message})`);
    fail++;
  }

  // buildAttributionData: degradation path (no bundle stats -> chunk-only)
  try {
    const path = new URL('../assets/trace.render-blocking-sample.json.gz', import.meta.url);
    const events = decodeTrace(fs.readFileSync(path));
    const result = buildAttributionData(events, undefined);
    check('buildAttributionData: degrades cleanly with no bundle stats (no module-tier nodes)',
      result.nodes.some(n => n.class === 'module'), false);
    check('buildAttributionData: degraded flag set true so a UI can say so, per the plan\'s mandatory rule',
      result.degraded, true);
    check('buildAttributionData: network + chunk tiers still present even when degraded',
      result.nodes.some(n => n.class === 'network') && result.nodes.some(n => n.class === 'chunk'), true);
    check('buildAttributionData: top-level tbtMs is a number (for the main-run stats row)',
      typeof result.tbtMs, 'number');
  } catch (err) {
    console.log(`  FAIL  buildAttributionData degradation path  (threw: ${err.message})`);
    fail++;
  }

  // buildAttributionData: optional throttled reference wiring
  try {
    const path = new URL('../assets/trace.render-blocking-sample.json.gz', import.meta.url);
    const events = decodeTrace(fs.readFileSync(path));
    const noThrottled = buildAttributionData(events, undefined);
    check('buildAttributionData: throttled is null when no second trace given', noThrottled.throttled, null);

    const withThrottled = buildAttributionData(events, undefined, events, '4x CPU · Slow 4G');
    check('buildAttributionData: throttled reference present when a second trace is given', withThrottled.throttled != null, true);
    check('buildAttributionData: throttled reference carries the caller-supplied label', withThrottled.throttled.label, '4x CPU · Slow 4G');
    check('buildAttributionData: throttled.lcpMs matches computeLCP on that trace directly', withThrottled.throttled.lcpMs, noThrottled.lcpMs);
    check('buildAttributionData: throttled reference has a numeric tbtMs', typeof withThrottled.throttled.tbtMs, 'number');

    check('computeThrottledReference: default label when none given', computeThrottledReference(events).label, 'throttled');
    check('computeThrottledReference: no navigation -> null', computeThrottledReference([]), null);
  } catch (err) {
    console.log(`  FAIL  buildAttributionData throttled reference wiring  (threw: ${err.message})`);
    fail++;
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  if (process.argv.includes('--self-test')) return selfTest();

  const args = process.argv.slice(2);
  const flagValueIdx = (flag) => { const i = args.indexOf(flag); return i >= 0 ? i + 1 : -1; };
  const throttledIdx = flagValueIdx('--throttled');
  const throttledLabelIdx = flagValueIdx('--throttled-label');
  const skip = new Set([throttledIdx, throttledLabelIdx]);
  const positional = args.filter((a, i) => !a.startsWith('--') && !skip.has(i));
  const [traceFile, bundleStatsFile] = positional;
  if (!traceFile) {
    console.error('usage: node lcp_attribution.mjs <trace.json[.gz]> [bundle-stats.json[.gz]] [--throttled <trace.json[.gz]>] [--throttled-label <text>]');
    console.error('       node lcp_attribution.mjs --self-test');
    process.exit(1);
  }
  const events = decodeTrace(fs.readFileSync(traceFile));
  const bundleStats = bundleStatsFile ? parseBundleStats(decodeStats(fs.readFileSync(bundleStatsFile))) : undefined;
  const throttledEvents = throttledIdx >= 0 ? decodeTrace(fs.readFileSync(args[throttledIdx])) : undefined;
  const throttledLabel = throttledLabelIdx >= 0 ? args[throttledLabelIdx] : undefined;
  console.log(JSON.stringify(buildAttributionData(events, bundleStats, throttledEvents, throttledLabel), null, 2));
}

// See trace_metrics.mjs's identical guard for why pathToFileURL, not a
// hand-built `file://` string.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

/**
 * NOT built, deliberately — reviewing attribution math and reviewing a
 * rendering are different jobs, and bundling them risks not being able to
 * tell which one a bug is in: `build_lcp_map.mjs`'s HTML/3D output (nodes
 * laid out by import graph X/Y, elevated by execution-order Z, the red LCP
 * plane, click-to-collapse causal chains, node shrink-on-KEEP animation —
 * see `references/perf-map.md`).
 */
