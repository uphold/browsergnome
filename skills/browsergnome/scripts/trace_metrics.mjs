#!/usr/bin/env node
/**
 * trace_metrics.mjs — parse a saved chrome-devtools-mcp performance trace
 * (`performance_start_trace`'s `filePath` output, .json or .json.gz) into
 * {lcp, fcp, ttfb, cls, inp, tbt, longTasks[], scriptTimings[]}.
 *
 * Pure function of a file — no browser, no MCP — so it's fully offline-testable.
 * `first-load` feeds its output straight into stats.mjs.
 *
 * Field-shape provenance matters here, so it's spelled out below rather than
 * assumed: LCP/FCP/TTFB/script-compile-evaluate/long-task/CLS shapes were all
 * verified against real captured traces — nextjs.org (shipped, trimmed, as
 * ../assets/trace.sample.json.gz), a scripted mid-load-shift page
 * (../assets/trace.cls-sample.json.gz), and a scripted two-candidate page
 * (../assets/trace.multi-lcp-sample.json.gz — a first attempt with a
 * plain-color div produced nothing, because a bare-background div isn't
 * LCP-eligible without an image/text/background-image; a second attempt
 * with a larger inserted text block worked, 42ms→195ms, matching
 * chrome-devtools-mcp's own reported number) — see `selfTest()`'s fixture
 * checks, which assert against the exact numbers chrome-devtools-mcp itself
 * reported for all three captures, including the "last candidate wins"
 * tie-break.
 *
 * `computeINP`'s `EventTiming` shape is live-verified too: a throttled
 * capture reported a nonzero INP on a pure-navigation trace that should
 * have had none, which traced back to chrome-devtools-mcp's own automation
 * driver emitting `interactionId: 0` hover events (its virtual cursor
 * moving into position) that the original `!= null` filter let through —
 * `0 != null` is `true` in JS. Fixed to `> 0` (see `computeINP`'s comment).
 * Null INP on a genuinely interaction-free load trace is still expected,
 * not a bug — the `interaction` preset is what actually drives real
 * interactions before capturing. That capture is shipped too,
 * trimmed, as `../assets/trace.eventtiming-sample.json.gz` — it carries 22
 * real `interactionId: 0` `EventTiming` events on the nav frame, so the fix
 * is checked against a real automation-noise trace, not just the
 * hand-written synthetic case in `selfTest()`.
 *
 * A genuine positive INP is checked too, not just the null cases above:
 * `../assets/trace.interaction-sample.json.gz` is a real capture of a
 * trusted CDP-dispatched click (chrome-devtools-mcp's `click` tool) on a
 * real cookie-consent button, trimmed to the event names this file reads
 * (`RunTask` further trimmed to only the entries that already pass
 * `computeLongTasksAndTBT`'s own pid/tid/threshold filter, which reproduces
 * the untrimmed capture's `longTasks`/`tbt` output exactly). Its INP
 * (72.954ms) matches chrome-devtools-mcp's own `performance_analyze_insight`
 * reading (73ms) for the same capture.
 *
 * A same-shape capture driven by `evaluate_script`'s `element.click()`
 * instead of the `click` tool produced no `INP:` line at all in
 * chrome-devtools-mcp's own insight output — the Event Timing API only
 * tracks trusted, input-pipeline-originated events, and a JS-dispatched
 * `.click()` isn't one. The `interaction` preset's drive sequence must use
 * the `click`/`type_text` tools, never `evaluate_script`, or every
 * measurement silently degrades to `inp: null`.
 *
 * Usage:
 *   node trace_metrics.mjs <trace.json|trace.json.gz>
 *   node trace_metrics.mjs --self-test
 */

import fs from 'node:fs';
import zlib from 'node:zlib';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const LONG_TASK_THRESHOLD_MS = 50;

// ── Pure parsing functions (exported; operate on a decoded traceEvents array) ──

/**
 * Load traceEvents from a raw file buffer/string, transparently gunzipping
 * .gz content (detected by header magic, not by filename — `filePath` in the
 * MCP tool is user-chosen and doesn't have to end in .gz).
 * @param {Buffer} buf
 * @returns {object[]} traceEvents
 */
export function decodeTrace(buf) {
  const isGzip = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  const text = (isGzip ? zlib.gunzipSync(buf) : buf).toString('utf8');
  const data = JSON.parse(text);
  return Array.isArray(data) ? data : (data.traceEvents || []);
}

/**
 * Pick the navigation to measure: the most recent `navigationStart` with a
 * real `documentLoaderURL` (Chrome also emits an earlier synthetic one with
 * an empty URL for the initial about:blank commit — confirmed on a live
 * trace, not assumed). Scoping every other metric to this navigation's
 * frame+pid is what keeps iframes and prior navigations in the same trace
 * from polluting the numbers.
 * @param {object[]} events
 * @returns {{frame:string, pid:number, navStartUs:number, url:string}|null}
 */
export function pickNavigation(events) {
  const starts = events
    .filter(e => e.name === 'navigationStart' && e.args?.data?.documentLoaderURL)
    .sort((a, b) => a.ts - b.ts);
  if (starts.length === 0) return null;
  const last = starts[starts.length - 1];
  return { frame: last.args.frame, pid: last.pid, navStartUs: last.ts, url: last.args.data.documentLoaderURL };
}

/**
 * LCP: last `largestContentfulPaint::Candidate` for the navigation's frame
 * (each new candidate supersedes the previous one as a larger element
 * paints — taking the last by ts is Chrome's own rule, not a guess).
 * Verified against a real two-candidate trace (candidateIndex 1 then 2,
 * 42ms→195ms) — the computed value matched chrome-devtools-mcp's own
 * reported LCP exactly. ms, or null.
 */
export function computeLCP(events, nav) {
  const candidates = events
    .filter(e => e.name === 'largestContentfulPaint::Candidate' && e.args?.frame === nav.frame)
    .sort((a, b) => a.ts - b.ts);
  if (candidates.length === 0) return null;
  return (candidates[candidates.length - 1].ts - nav.navStartUs) / 1000;
}

/** FCP: `firstContentfulPaint` for the navigation's frame. ms, or null. */
export function computeFCP(events, nav) {
  const e = events.find(e => e.name === 'firstContentfulPaint' && e.args?.frame === nav.frame);
  return e ? (e.ts - nav.navStartUs) / 1000 : null;
}

/**
 * TTFB: from the main document's `ResourceReceiveResponse` (mimeType
 * text/html, same frame, earliest after nav start). Uses the CDP `timing`
 * sub-object (`requestTime` in seconds + `receiveHeadersStart` in ms
 * relative to it) rather than the event's own `ts` — verified against a
 * live trace that only the `timing` fields reproduce Chrome's own reported
 * TTFB exactly; the bare event ts was off by ~50ms in that capture.
 * ms, or null.
 *
 * Known gap, not yet hit in practice: filtering `ts >= nav.navStartUs`
 * assumes the final document's response lands after the navigation we
 * picked starts. On a redirect chain that assumption could in principle
 * break (if the committed navigationStart fires after the response that
 * ends the chain), returning null instead of a redirect-aware TTFB. Not
 * worth code until a redirecting target actually shows it — but a null
 * TTFB on a target with redirects is the first thing to suspect.
 */
export function computeTTFB(events, nav) {
  const responses = events
    .filter(e => e.name === 'ResourceReceiveResponse'
      && e.args?.data?.frame === nav.frame
      && e.args?.data?.mimeType === 'text/html'
      && e.ts >= nav.navStartUs)
    .sort((a, b) => a.ts - b.ts);
  if (responses.length === 0) return null;
  const t = responses[0].args.data.timing;
  if (t && t.requestTime >= 0 && t.receiveHeadersStart >= 0) {
    const headersUs = t.requestTime * 1e6 + t.receiveHeadersStart * 1000;
    return (headersUs - nav.navStartUs) / 1000;
  }
  return (responses[0].ts - nav.navStartUs) / 1000; // fallback: event ts itself
}

/**
 * Long tasks + Total Blocking Time. Main thread = the `CrRendererMain`
 * `thread_name` metadata event sharing the navigation's pid — scoping by
 * name rather than a hardcoded tid, since tids aren't stable across traces.
 * TBT sums (duration - 50ms) over the whole post-navigation trace, not
 * clipped to [FCP, TTI] — ponytail: good enough when there's no separately
 * computed TTI; revisit if a preset ever captures well past page load.
 */
export function computeLongTasksAndTBT(events, nav) {
  const mainThread = events.find(e => e.name === 'thread_name' && e.pid === nav.pid && e.args?.name === 'CrRendererMain');
  if (!mainThread) return { longTasks: [], tbt: 0 };
  const longTasks = events
    .filter(e => e.name === 'RunTask' && e.pid === nav.pid && e.tid === mainThread.tid
      && e.ts >= nav.navStartUs && e.dur >= LONG_TASK_THRESHOLD_MS * 1000)
    .map(e => ({ startMs: (e.ts - nav.navStartUs) / 1000, durationMs: e.dur / 1000 }))
    .sort((a, b) => a.startMs - b.startMs);
  const tbt = longTasks.reduce((sum, t) => sum + Math.max(0, t.durationMs - LONG_TASK_THRESHOLD_MS), 0);
  return { longTasks, tbt };
}

/**
 * CLS: sum of `LayoutShift` scores that didn't follow recent user input,
 * for the navigation's frame. Verified against a live trace (a page with a
 * scripted mid-load shift, CLS 0.21 — matched chrome-devtools-mcp's own
 * reported score exactly): `frame` sits at `args.frame` — a sibling of
 * `data`, NOT nested under it (the same nesting mistake this file's
 * `pickNavigation` had for `navigationStart`, caught the same way). 0 if no
 * shifts (a page with no shifts legitimately reports 0, same as this file's
 * own shipped fixture, which has none).
 */
export function computeCLS(events, nav) {
  return events
    .filter(e => e.name === 'LayoutShift' && e.args?.frame === nav.frame && !e.args?.data?.had_recent_input)
    .reduce((sum, e) => sum + (e.args.data.weighted_score_delta ?? e.args.data.score ?? 0), 0);
}

/**
 * INP: max `EventTiming` interaction duration for the navigation's frame —
 * an approximation (the official metric is a high percentile across all
 * interactions; a single-page-load `first-load` measurement typically has
 * zero interactions and legitimately returns null, which is expected here,
 * not a bug — INP is the `interaction` preset's metric, not this one's).
 *
 * `interactionId: 0` must be excluded, not treated as "present" — verified
 * on a live throttled trace: chrome-devtools-mcp's own automation driver
 * fires `pointerover`/`pointerenter`/`mouseover`
 * `EventTiming` events (moving its virtual cursor into position) on every
 * navigation, all stamped `interactionId: 0`, which is the Event Timing
 * API's sentinel for "not a tracked interaction," not a real ID. The first
 * version of this filter used `!= null`, and `0 != null` is `true` in
 * JS — so it silently counted automation noise as a 117ms "interaction" on
 * a trace with zero real ones. `> 0` is the actual "is this real" test.
 *
 * `frame` nesting: confirmed via the same live throttled trace that found the
 * interactionId:0 bug — `EventTiming`'s frame lives at `args.data.frame`,
 * unlike `navigationStart`/`LayoutShift` (both `args.frame`). Both nestings
 * are still accepted here since it costs nothing and guards against a future
 * Chrome version moving it. Returns null rather than NaN/throwing if no
 * interaction has a usable duration. ms, or null.
 */
export function computeINP(events, nav) {
  const durations = events
    .filter(e => e.name === 'EventTiming' && e.args?.data?.interactionId > 0
      && (e.args?.frame ?? e.args?.data?.frame) === nav.frame)
    .map(e => e.args.data.duration)
    .filter(d => typeof d === 'number' && !isNaN(d));
  return durations.length === 0 ? null : Math.max(...durations);
}

/**
 * scriptTimings: chunk-level parse+execute cost, keyed by URL — `v8.compile`
 * and `EvaluateScript` durations summed per URL (a chunk can compile/evaluate
 * more than once). This is the "measured, not apportioned" chunk-tier data
 * the LCP Attribution Map builds on (`lcp_attribution.mjs`'s
 * `attributeChunkTier`) — confirmed present with resolvable URLs on a live
 * trace (38 distinct script URLs, compile and evaluate both populated).
 *
 * Frame scoping is asymmetric, verified on a live trace, not assumed:
 * `EvaluateScript` carries `args.data.frame` and is scoped to the
 * navigation's frame like everything else here. `v8.compile` carries NO
 * frame field at all (checked directly — absent, not just unpopulated), and
 * its `scriptId` doesn't share a namespace with `EvaluateScript`'s (zero
 * overlap on a live trace), so there's no join path to recover one either.
 * **Known limitation:** on a page with same-process cross-origin iframes,
 * `compileMs` can include iframe scripts' compile cost under the main
 * frame's URL bucket; `evaluateMs` cannot (it's correctly frame-scoped).
 * Single-frame pages (most of them) are unaffected — the shipped fixture
 * has exactly one frame throughout. If a heavily-iframed page ever sizes a
 * node on this data and compile-heavy chunks look inflated, this is why.
 */
export function computeScriptTimings(events, nav) {
  const byUrl = new Map();
  const get = (url) => {
    if (!byUrl.has(url)) byUrl.set(url, { url, compileMs: 0, evaluateMs: 0 });
    return byUrl.get(url);
  };
  for (const e of events) {
    if (e.pid !== nav.pid || e.ts < nav.navStartUs) continue;
    const url = e.args?.data?.url;
    if (!url) continue;
    if (e.name === 'v8.compile') get(url).compileMs += e.dur / 1000; // not frame-scoped — see doc comment
    else if (e.name === 'EvaluateScript' && e.args?.data?.frame === nav.frame) get(url).evaluateMs += e.dur / 1000;
  }
  return [...byUrl.values()].sort((a, b) => (b.compileMs + b.evaluateMs) - (a.compileMs + a.evaluateMs));
}

/**
 * Run every metric extractor against a decoded traceEvents array.
 * @param {object[]} events
 * @returns {object}
 */
export function extractMetrics(events) {
  const nav = pickNavigation(events);
  if (!nav) return { error: 'no navigation found in trace (no navigationStart with a documentLoaderURL)' };
  const { longTasks, tbt } = computeLongTasksAndTBT(events, nav);
  return {
    url: nav.url,
    lcp: computeLCP(events, nav),
    fcp: computeFCP(events, nav),
    ttfb: computeTTFB(events, nav),
    cls: computeCLS(events, nav),
    inp: computeINP(events, nav),
    tbt,
    longTasks,
    scriptTimings: computeScriptTimings(events, nav),
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

  const FRAME = 'FRAME1', PID = 111, TID = 222;
  const navStart = 1_000_000; // µs

  // Synthetic trace built to the shapes verified in the file header.
  const events = [
    // decoy pre-navigation start (empty documentLoaderURL) — must be ignored
    { name: 'navigationStart', pid: PID, ts: navStart - 500, args: { frame: FRAME, data: { documentLoaderURL: '' } } },
    { name: 'navigationStart', pid: PID, ts: navStart, args: { frame: FRAME, data: { documentLoaderURL: 'https://example.com/' } } },
    { name: 'thread_name', pid: PID, tid: TID, args: { name: 'CrRendererMain' } },
    {
      name: 'ResourceReceiveResponse', pid: PID, ts: navStart + 200_000,
      args: { data: { frame: FRAME, mimeType: 'text/html', timing: { requestTime: navStart / 1e6, receiveHeadersStart: 150 } } },
    },
    { name: 'largestContentfulPaint::Candidate', pid: PID, ts: navStart + 300_000, args: { frame: FRAME } },
    { name: 'firstContentfulPaint', pid: PID, ts: navStart + 180_000, args: { frame: FRAME } },
    // one long task (80ms) and one short task (10ms, should be excluded)
    { name: 'RunTask', pid: PID, tid: TID, ts: navStart + 210_000, dur: 80_000 },
    { name: 'RunTask', pid: PID, tid: TID, ts: navStart + 400_000, dur: 10_000 },
    // two layout shifts, one following recent input (must be excluded)
    { name: 'LayoutShift', pid: PID, ts: navStart + 250_000, args: { frame: FRAME, data: { had_recent_input: false, weighted_score_delta: 0.05 } } },
    { name: 'LayoutShift', pid: PID, ts: navStart + 260_000, args: { frame: FRAME, data: { had_recent_input: true, weighted_score_delta: 0.5 } } },
    // one interaction, plus a malformed one (missing duration) that must not crash or win the max()
    { name: 'EventTiming', pid: PID, ts: navStart + 350_000, args: { data: { frame: FRAME, interactionId: 7, duration: 120 } } },
    { name: 'EventTiming', pid: PID, ts: navStart + 360_000, args: { data: { frame: FRAME, interactionId: 14 } } },
    // automation noise: chrome-devtools-mcp's own cursor-positioning hover events, interactionId 0 —
    // must be excluded even though it has a large duration, or every load-only trace reports fake INP
    { name: 'EventTiming', pid: PID, ts: navStart + 355_000, args: { data: { frame: FRAME, interactionId: 0, type: 'pointerover', duration: 999 } } },
    // script compile+evaluate, two urls, two events each for one of them
    { name: 'v8.compile', pid: PID, ts: navStart + 10_000, args: { data: { url: 'https://example.com/a.js' } }, dur: 5_000 },
    { name: 'EvaluateScript', pid: PID, ts: navStart + 15_000, args: { data: { url: 'https://example.com/a.js', frame: FRAME } }, dur: 20_000 },
    { name: 'v8.compile', pid: PID, ts: navStart + 40_000, args: { data: { url: 'https://example.com/b.js' } }, dur: 2_000 },
    { name: 'EvaluateScript', pid: PID, ts: navStart + 42_000, args: { data: { url: 'https://example.com/b.js', frame: FRAME } }, dur: 8_000 },
    { name: 'EvaluateScript', pid: PID, ts: navStart + 60_000, args: { data: { url: 'https://example.com/b.js', frame: FRAME } }, dur: 3_000 },
    // an iframe's script in the same process — excluded from evaluateMs (frame-scoped), NOT excluded from compileMs (can't be, see doc comment)
    { name: 'v8.compile', pid: PID, ts: navStart + 45_000, args: { data: { url: 'https://example.com/b.js' } }, dur: 1_000 },
    { name: 'EvaluateScript', pid: PID, ts: navStart + 46_000, args: { data: { url: 'https://example.com/b.js', frame: 'OTHER_FRAME' } }, dur: 999_000 },
  ];

  const nav = pickNavigation(events);
  check('pickNavigation ignores decoy, keeps real URL', nav?.url, 'https://example.com/');
  check('pickNavigation frame', nav?.frame, FRAME);

  check('LCP = last candidate ts - navStart', computeLCP(events, nav), 300);
  check('FCP', computeFCP(events, nav), 180);
  check('TTFB via timing fields', computeTTFB(events, nav), 150);

  const { longTasks, tbt } = computeLongTasksAndTBT(events, nav);
  check('long tasks excludes the 10ms task', longTasks.length, 1);
  check('long task startMs', longTasks[0].startMs, 210);
  check('TBT = 80ms - 50ms threshold', tbt, 30);

  check('CLS excludes the had_recent_input shift', computeCLS(events, nav), 0.05);
  check('INP from the one well-formed interaction, malformed + noise ignored', computeINP(events, nav), 120);
  check('INP null when no interactions', computeINP(events.filter(e => e.name !== 'EventTiming'), nav), null);
  check('INP null (not NaN/throw) when only malformed interactions exist',
    computeINP(events.filter(e => e.name !== 'EventTiming' || e.args.data.interactionId === 14), nav), null);
  check('INP excludes interactionId:0 automation noise even with a huge duration',
    computeINP(events.filter(e => e.name !== 'EventTiming' || e.args.data.interactionId === 0), nav), null);

  const scripts = computeScriptTimings(events, nav);
  check('scriptTimings has 2 urls', scripts.length, 2);
  const bJs = scripts.find(s => s.url.endsWith('b.js'));
  check('b.js evaluateMs excludes the other-frame event (frame-scoped)', bJs.evaluateMs, 11);
  check('b.js compileMs sums both (not frame-scoped — v8.compile has no frame field)', bJs.compileMs, 3);
  check('a.js compile', scripts.find(s => s.url.endsWith('a.js')).compileMs, 5);

  check('extractMetrics on no-navigation events → error', extractMetrics([]).error != null, true);

  // decodeTrace: plain JSON and gzip, both {traceEvents:[...]} and bare array shapes
  const buf = Buffer.from(JSON.stringify({ traceEvents: events }));
  check('decodeTrace plain json (wrapped)', decodeTrace(buf).length, events.length);
  const bareBuf = Buffer.from(JSON.stringify(events));
  check('decodeTrace plain json (bare array)', decodeTrace(bareBuf).length, events.length);
  const gz = zlib.gzipSync(buf);
  check('decodeTrace gzip', decodeTrace(gz).length, events.length);

  // the shipped real-capture fixture must still decode and yield a sane LCP
  try {
    const fixturePath = new URL('../assets/trace.sample.json.gz', import.meta.url);
    const fixtureEvents = decodeTrace(fs.readFileSync(fixturePath));
    const m = extractMetrics(fixtureEvents);
    check('shipped fixture: url', m.url, 'https://nextjs.org/');
    check('shipped fixture: LCP in a sane range (100-2000ms)', m.lcp > 100 && m.lcp < 2000, true);
    check('shipped fixture: has script timings', m.scriptTimings.length > 0, true);
  } catch (err) {
    console.log(`  FAIL  shipped fixture decodes and parses  (threw: ${err.message})`);
    fail++;
  }

  // second shipped fixture: a page with a scripted mid-load layout shift,
  // captured to verify CLS against a live trace (see computeCLS's doc comment)
  try {
    const clsFixturePath = new URL('../assets/trace.cls-sample.json.gz', import.meta.url);
    const clsEvents = decodeTrace(fs.readFileSync(clsFixturePath));
    const m = extractMetrics(clsEvents);
    check('CLS fixture: matches chrome-devtools-mcp\'s own reported score (0.21)', Math.round(m.cls * 100) / 100, 0.21);
  } catch (err) {
    console.log(`  FAIL  CLS fixture decodes and parses  (threw: ${err.message})`);
    fail++;
  }

  // third shipped fixture: a page with two LCP candidates (42ms then 195ms),
  // the empirical proof that the "last candidate wins" tie-break is correct
  try {
    const multiLcpPath = new URL('../assets/trace.multi-lcp-sample.json.gz', import.meta.url);
    const multiLcpEvents = decodeTrace(fs.readFileSync(multiLcpPath));
    const candidates = multiLcpEvents.filter(e => e.name === 'largestContentfulPaint::Candidate');
    check('multi-LCP fixture: actually has 2 candidates (not a single-candidate trace)', candidates.length, 2);
    const m = extractMetrics(multiLcpEvents);
    check('multi-LCP fixture: picks the LATER candidate (195ms), not the first (42ms)',
      Math.round(m.lcp), 195);
  } catch (err) {
    console.log(`  FAIL  multi-LCP fixture decodes and parses  (threw: ${err.message})`);
    fail++;
  }

  // fourth shipped fixture: a real chrome-devtools-mcp capture carrying real
  // `interactionId: 0` automation-noise EventTiming events — the actual
  // shape the interactionId:0 fix guards against, not
  // just the hand-written synthetic case above. Without this fixture the fix
  // was only checked against events the same session's author constructed to
  // match their own diagnosis.
  try {
    const eventTimingPath = new URL('../assets/trace.eventtiming-sample.json.gz', import.meta.url);
    const eventTimingEvents = decodeTrace(fs.readFileSync(eventTimingPath));
    const nav = pickNavigation(eventTimingEvents);
    const matchingFrame = eventTimingEvents.filter(e => e.name === 'EventTiming'
      && (e.args?.frame ?? e.args?.data?.frame) === nav?.frame);
    check('EventTiming fixture: really does carry EventTiming events on the nav frame (not an empty trace)',
      matchingFrame.length > 0, true);
    check('EventTiming fixture: those events are all automation-noise interactionId:0 (the real-world shape)',
      matchingFrame.every(e => e.args.data.interactionId === 0), true);
    const m = extractMetrics(eventTimingEvents);
    check('EventTiming fixture: INP null despite real EventTiming events present (interactionId:0 excluded)',
      m.inp, null);
  } catch (err) {
    console.log(`  FAIL  EventTiming fixture decodes and parses  (threw: ${err.message})`);
    fail++;
  }

  // fifth shipped fixture: a real trusted-click capture (the `interaction`
  // preset's drive sequence) — proves computeINP against a genuine positive
  // value, not just the null cases above.
  try {
    const interactionPath = new URL('../assets/trace.interaction-sample.json.gz', import.meta.url);
    const interactionEvents = decodeTrace(fs.readFileSync(interactionPath));
    const m = extractMetrics(interactionEvents);
    check('interaction fixture: INP matches chrome-devtools-mcp\'s own reported value (73ms)',
      Math.round(m.inp), 73);
    check('interaction fixture: long tasks present (real page-load + interaction activity)',
      m.longTasks.length > 0, true);
  } catch (err) {
    console.log(`  FAIL  interaction fixture decodes and parses  (threw: ${err.message})`);
    fail++;
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  if (process.argv.includes('--self-test')) return selfTest();

  const filePath = process.argv.slice(2).find(a => !a.startsWith('--'));
  if (!filePath) {
    console.error('usage: node trace_metrics.mjs <trace.json|trace.json.gz>');
    console.error('       node trace_metrics.mjs --self-test');
    process.exit(1);
  }
  if (!fs.existsSync(filePath)) {
    console.error(`file not found: ${filePath}`);
    process.exit(1);
  }
  const events = decodeTrace(fs.readFileSync(filePath));
  console.log(JSON.stringify(extractMetrics(events), null, 2));
}

// Only run the CLI when this file is executed directly, not when its
// exported functions are imported by another script (lcp_attribution.mjs
// reuses computeScriptTimings/decodeTrace/etc. this way
// — without this guard, importing this module for its exports would also
// trigger its CLI argv parsing and exit(1) on no args, breaking the import).
// pathToFileURL, not a raw `file://${...}` template string — argv[1] can
// contain spaces/non-ASCII that need percent-encoding to match
// import.meta.url, and a hand-built string silently never matches on those
// paths (this repo's own path happens to be clean ASCII, which is exactly
// the kind of thing that hides a bug until someone else's path isn't).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
