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
import { decodeTrace, pickNavigation, computeLCP, computeScriptTimings } from './trace_metrics.mjs';
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

// ── Combine ──────────────────────────────────────────────────────────────

/**
 * Build the full three-tier node list for one trace (+ optional bundle
 * stats). `bundleStats` is optional — omit it (or pass a `{error}` result
 * from `parseBundleStats`) to get the mandatory degraded chunk-only map.
 */
export function buildAttributionData(events, bundleStats) {
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
  } catch (err) {
    console.log(`  FAIL  buildAttributionData degradation path  (threw: ${err.message})`);
    fail++;
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  if (process.argv.includes('--self-test')) return selfTest();

  const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const [traceFile, bundleStatsFile] = positional;
  if (!traceFile) {
    console.error('usage: node lcp_attribution.mjs <trace.json[.gz]> [bundle-stats.json[.gz]]');
    console.error('       node lcp_attribution.mjs --self-test');
    process.exit(1);
  }
  const events = decodeTrace(fs.readFileSync(traceFile));
  const bundleStats = bundleStatsFile ? parseBundleStats(decodeStats(fs.readFileSync(bundleStatsFile))) : undefined;
  console.log(JSON.stringify(buildAttributionData(events, bundleStats), null, 2));
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
