#!/usr/bin/env node
/**
 * stats.mjs — measurement statistics + the keep/revert gate.
 *
 * The whole point of this loop is to never record an unmeasured win. A
 * single before/after sample lies: device perf is noisy (thermals, GC,
 * background work), so a 3% "improvement" is usually noise. This module turns
 * two N-run distributions into an honest keep/revert decision:
 *
 *   improvement clears the gate  <=>  delta > max(minEffect, k * pooledStdDev)
 *
 * i.e. the change must beat BOTH an absolute floor (minEffect — don't chase
 * changes too small to matter) AND the measurement noise (k pooled std devs,
 * k≈2). Otherwise we can't distinguish it from jitter, so we revert.
 *
 * Usage:
 *   node stats.mjs --baseline "1200,1180,1210" --candidate "980,1000,990" \
 *        [--min-effect 50] [--k 2] [--direction lower|higher] [--unit ms]
 *   node stats.mjs --baseline "1,0,0,0,0" --candidate "0,0,0,0,0" --mode occurrence [--alpha 0.05]
 *   node stats.mjs --self-test
 *
 * `--mode occurrence` switches to gateOccurrence() — a Fisher's-exact-test
 * comparison of occurrence rates (0/1 per run), for zero-inflated/bimodal
 * metrics like layout-shift/CLS where gate()'s mean/pooled-stddev formula
 * doesn't fit. See references/measurement.md's "Observed noise — layout-shift"
 * section for why, and its feasibility caveat: this needs a baseline
 * occurrence rate of roughly >=40% before n=10 runs/arm can detect anything.
 */

import process from 'node:process';

export const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

export function stdDev(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1); // sample variance
  return Math.sqrt(v);
}

export function pooledStdDev(a, b) {
  const na = a.length, nb = b.length;
  if (na + nb - 2 <= 0) return Math.max(stdDev(a), stdDev(b));
  const va = stdDev(a) ** 2, vb = stdDev(b) ** 2;
  return Math.sqrt(((na - 1) * va + (nb - 1) * vb) / (na + nb - 2));
}

/**
 * Decide whether `candidate` is a real improvement over `baseline`.
 * direction: 'lower' (default) for TTI/jank/RAM/bytes/commits where smaller is
 * better; 'higher' for FPS where bigger is better.
 */
export function gate({ baseline, candidate, minEffect = 0, k = 2, direction = 'lower' }) {
  const baseMean = mean(baseline);
  const candMean = mean(candidate);
  const improvement = direction === 'higher' ? candMean - baseMean : baseMean - candMean;
  const pooled = pooledStdDev(baseline, candidate);
  const noiseBand = Math.max(minEffect, k * pooled);
  const keep = improvement > noiseBand;
  return {
    baseline: { mean: round(baseMean), std: round(stdDev(baseline)), n: baseline.length },
    candidate: { mean: round(candMean), std: round(stdDev(candidate)), n: candidate.length },
    direction,
    improvement: round(improvement),
    improvementPct: baseMean ? round((improvement / baseMean) * 100) : 0,
    pooledStd: round(pooled),
    k,
    minEffect,
    noiseBand: round(noiseBand),
    decision: keep ? 'KEEP' : 'REVERT',
    reason: keep
      ? `improvement ${round(improvement)} > noise band ${round(noiseBand)} (max of minEffect ${minEffect}, ${k}x pooled std ${round(pooled)})`
      : `improvement ${round(improvement)} did not clear noise band ${round(noiseBand)} — indistinguishable from jitter, revert`,
  };
}

/**
 * Occurrence-rate gate — for metrics that are zero-inflated/bimodal rather than
 * continuous noise (e.g. CLS on a page where a shift only happens if a resource
 * arrives after first paint: mostly exact zeros, occasionally a real nonzero
 * value). `gate()`'s mean/pooled-stddev comparison doesn't fit that shape — see
 * references/measurement.md's "Observed noise — layout-shift" section. Instead,
 * treat "did a shift happen at all" as a binary outcome per run and compare the
 * two occurrence rates with Fisher's exact test on the 2x2 table, one-tailed
 * (is candidate's rate lower than baseline's?).
 *
 * `baseline`/`candidate` are arrays of 0/1 (or falsy/truthy) — one entry per
 * run, 1 if that run had a nonzero shift.
 */
const factLog = (n) => { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; };
const logComb = (n, k) => (k < 0 || k > n) ? -Infinity : factLog(n) - factLog(k) - factLog(n - k);

export function fisherExactPValue(baselineOccurred, candidateOccurred) {
  const a = baselineOccurred.filter(Boolean).length; // baseline occurrences
  const n1 = baselineOccurred.length;
  const b = candidateOccurred.filter(Boolean).length; // candidate occurrences
  const n2 = candidateOccurred.length;
  const K = a + b, N = n1 + n2;
  let p = 0;
  const lo = Math.max(0, K - n1);
  for (let x = lo; x <= b; x++) {
    p += Math.exp(logComb(n1, K - x) + logComb(n2, x) - logComb(N, K));
  }
  return p;
}

export function gateOccurrence({ baseline, candidate, alpha = 0.05 }) {
  const baseRate = baseline.filter(Boolean).length / baseline.length;
  const candRate = candidate.filter(Boolean).length / candidate.length;
  const pValue = fisherExactPValue(baseline, candidate);
  const keep = pValue < alpha;
  // round4, not round() (2dp) — 2dp collapses e.g. 0.047619 to 0.05, which then
  // reads as "0.05 < alpha 0.05" (false) even though the underlying, unrounded
  // pValue correctly cleared the gate. Keep pValue's displayed precision fine
  // enough that the printed reason never contradicts the decision it's reporting.
  const pValueDisplay = round4(pValue);
  return {
    baseline: { occurred: baseline.filter(Boolean).length, n: baseline.length, rate: round(baseRate) },
    candidate: { occurred: candidate.filter(Boolean).length, n: candidate.length, rate: round(candRate) },
    pValue: pValueDisplay,
    alpha,
    decision: keep ? 'KEEP' : 'REVERT',
    reason: keep
      ? `candidate occurrence rate ${round(candRate)} vs baseline ${round(baseRate)} — Fisher exact p=${pValueDisplay} < alpha ${alpha}`
      : `candidate occurrence rate ${round(candRate)} vs baseline ${round(baseRate)} — Fisher exact p=${pValueDisplay} not < alpha ${alpha}, indistinguishable from chance, revert`,
  };
}

const round = (x) => Math.round(x * 100) / 100;
const round4 = (x) => Math.round(x * 10000) / 10000;
const parseList = (s) => String(s).split(',').map((x) => parseFloat(x.trim())).filter((x) => !Number.isNaN(x));

// `raw === undefined` (flag absent) falls back to `def`; an explicit numeric
// string — including "0" — always wins. `parseFloat(raw) || def` was the bug
// here: `0` is falsy, so an explicit `--k 0`/`--alpha 0` silently became the
// default instead of 0.
export function parseNumArg(raw, def) {
  if (raw === undefined) return def;
  const v = parseFloat(raw);
  return Number.isNaN(v) ? def : v;
}

// ---------------------------------------------------------------------------
function selfTest() {
  let pass = 0, fail = 0;
  const check = (name, got, want) => {
    const ok = got === want;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${got}, want ${want})`);
    ok ? pass++ : fail++;
  };

  // 1. Clear win beyond noise -> KEEP
  check('clear TTI win', gate({
    baseline: [1200, 1180, 1210, 1190, 1205], candidate: [980, 1000, 990, 1010, 995], minEffect: 30,
  }).decision, 'KEEP');

  // 2. Within noise -> REVERT
  check('noise-level change', gate({
    baseline: [1000, 1050, 950, 1020, 980], candidate: [990, 1040, 960, 1010, 1000], minEffect: 20,
  }).decision, 'REVERT');

  // 3. Regression (candidate worse) -> REVERT
  check('regression', gate({
    baseline: [1000, 1010, 990, 1005, 995], candidate: [1100, 1120, 1090, 1110, 1095], minEffect: 20,
  }).decision, 'REVERT');

  // 4. FPS higher-is-better win -> KEEP
  check('fps win (higher better)', gate({
    baseline: [45, 46, 44, 45, 46], candidate: [58, 59, 57, 60, 58], direction: 'higher', minEffect: 2,
  }).decision, 'KEEP');

  // 5. Tiny but consistent improvement below minEffect floor -> REVERT
  check('below min-effect floor', gate({
    baseline: [1000, 1000, 1000, 1000], candidate: [995, 995, 995, 995], minEffect: 50,
  }).decision, 'REVERT');

  // 6. mean / stdDev sanity
  check('mean', mean([2, 4, 6]), 4);
  check('stdDev of constant is 0', stdDev([5, 5, 5]), 0);

  // 7. Deterministic layout-shift shape needs no new code — zero variance means
  // pooledStdDev is 0, so gate() degenerates to improvement > minEffect (same
  // pattern as bundle-size). Real constant CLS value from a captured single-shift
  // target: references/measurement.md's "Observed noise — layout-shift" section.
  check('deterministic CLS shape (plain gate())', gate({
    baseline: [0.01528342692057292, 0.01528342692057292, 0.01528342692057292],
    candidate: [0.005, 0.005, 0.005],
    minEffect: 0.005,
  }).decision, 'KEEP');

  // 8. Occurrence-rate gate: exact p-values hand-verified against the same
  // Fisher's-exact-test math, n=10 per arm, candidate = complete
  // elimination of shifts (0/10). Confirms the implementation matches the
  // hand-checked numbers, not just "runs without crashing."
  const occurred = (nOnes, n) => Array.from({ length: n }, (_, i) => (i < nOnes ? 1 : 0));
  check('occurrence rate: 2/10 vs 0/10 not significant', gateOccurrence({
    baseline: occurred(2, 10), candidate: occurred(0, 10),
  }).decision, 'REVERT');
  check('occurrence rate: 8/10 vs 0/10 significant', gateOccurrence({
    baseline: occurred(8, 10), candidate: occurred(0, 10),
  }).decision, 'KEEP');

  // 9. The real 5-run capture from measurement.md (1/5 nonzero, i.e. a ~20%
  // baseline occurrence rate) vs a hypothetical perfect fix (0/5) — even a
  // perfect fix can't clear the gate at this baseline rate and this n.
  // gateOccurrence() needs baseline occurrence rate roughly >= 40% before n=10
  // can detect anything at all — see measurement.md's "Observed noise —
  // layout-shift" section for the full feasibility table.
  check('real 5-run capture: too small a baseline rate to gate at n=5', gateOccurrence({
    baseline: [1, 0, 0, 0, 0], candidate: [0, 0, 0, 0, 0],
  }).decision, 'REVERT');

  // 10. CLI arg parsing regression: an explicit 0 must survive, not fall back
  // to the default (0 is falsy — `parseFloat(...) || def` silently dropped it).
  check('parseNumArg: explicit "0" is kept, not replaced by the default', parseNumArg('0', 2), 0);
  check('parseNumArg: missing flag (undefined) falls back to the default', parseNumArg(undefined, 2), 2);
  check('parseNumArg: unparseable value falls back to the default', parseNumArg('abc', 2), 2);

  // 11. pValue display precision regression: 2dp rounding collapsed 0.047619
  // to 0.05, which then read as "0.05 < alpha 0.05" — false. Pin the exact
  // reported-in-review case (1/2 baseline vs 0/5 candidate) at 4dp.
  check('gateOccurrence: pValue keeps enough precision to not contradict its own decision',
    gateOccurrence({ baseline: [1, 1], candidate: [0, 0, 0, 0, 0] }).pValue, 0.0476);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return selfTest();

  const get = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : def; };
  const getNum = (flag, def) => parseNumArg(get(flag, undefined), def);
  const baseline = parseList(get('--baseline', ''));
  const candidate = parseList(get('--candidate', ''));
  if (!baseline.length || !candidate.length) {
    console.error('usage: node stats.mjs --baseline "a,b,c" --candidate "x,y,z" [--min-effect N] [--k 2] [--direction lower|higher] [--unit ms]');
    console.error('       node stats.mjs --baseline "1,0,0" --candidate "0,0,0" --mode occurrence [--alpha 0.05]');
    console.error('       node stats.mjs --self-test');
    process.exit(1);
  }

  if (get('--mode', 'mean') === 'occurrence') {
    const result = gateOccurrence({ baseline, candidate, alpha: getNum('--alpha', 0.05) });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const result = gate({
    baseline, candidate,
    minEffect: getNum('--min-effect', 0),
    k: getNum('--k', 2),
    direction: get('--direction', 'lower'),
  });
  const unit = get('--unit', '');
  console.log(JSON.stringify({ ...result, unit }, null, 2));
}

main();
