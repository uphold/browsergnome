#!/usr/bin/env node
/**
 * build_lcp_map.mjs — merge lcp_attribution.mjs's JSON output into the HTML
 * template to produce a standalone lcp-map.html. Mirrors build_perf_map.mjs's
 * marker-based split/join. lcp_attribution.mjs emits raw {class, label, ms,
 * confidence, ...} nodes with no render hints, so this script adds val/color
 * (same job perf_scan.mjs does for build_perf_map.mjs).
 *
 * Also resolves the target's production URL and, if found, fetches real-user
 * CrUX field data (crux.mjs) as the map's third readout tier, alongside the
 * lab (unthrottled) and throttled-reference numbers. This is the one network
 * call in the whole toolchain — everything else is offline trace parsing —
 * and it never blocks the build: any failure (no URL, offline, no field data
 * for a low-traffic origin) just omits the tier.
 *
 * Usage:
 *   node lcp_attribution.mjs <trace.json[.gz]> [bundle-stats.json[.gz]] > attribution.json
 *   node build_lcp_map.mjs attribution.json [--out lcp-map.html] [--open] [--prod-url <url>]
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { getFieldData } from './crux.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(__dirname, '..', 'assets');
const TEMPLATE = path.join(ASSETS, 'lcp-map.template.html');
const LIB = path.join(ASSETS, '3d-force-graph.min.js');

const LIB_MARKER = '/*__FORCE_GRAPH_LIB__*/';
const DATA_MARKER = '/*__LCP_DATA__*/';

// class -> hue. Kept off the page's single brand accent (violet, used for
// chrome/"measured" only) so the categorical palette and the accent don't
// collide. Confidence (measured vs apportioned) is alpha, not hue.
const CLASS_COLOR = { network: '#fbbf24', chunk: '#38bdf8', module: '#2dd4bf' };

function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function toRenderNode(n, i) {
  const alpha = n.confidence === 'measured' ? 1 : 0.4;
  return {
    id: `${n.class}:${i}:${n.label}`,
    label: n.label,
    class: n.class,
    ms: n.ms,
    bytes: n.bytes ?? null,
    confidence: n.confidence,
    resourceType: n.resourceType ?? null,
    failed: n.failed ?? false,
    compileMs: n.compileMs ?? null,
    evaluateMs: n.evaluateMs ?? null,
    color: hexToRgba(CLASS_COLOR[n.class] || '#94a3b8', alpha),
    val: Math.max(0.5, Math.sqrt(Math.max(n.ms, 0))),
  };
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * Production URL, cheapest-first: explicit flag, then `.bgn/config.json`'s
 * `prodUrl` (set by Doctor's light repo find, or by hand), then the one
 * cross-repo npm convention (`package.json`'s `homepage`). No repo scanning
 * happens here — that's Doctor's job, once, at setup time; this is just the
 * read.
 */
export function resolveProdUrl({ flagUrl, config, packageJson }) {
  return flagUrl || config?.prodUrl || packageJson?.homepage || null;
}

/**
 * Interactive last resort: only when nothing above resolved a URL and stdout
 * is an actual terminal (never in CI/non-interactive builds). Persists the
 * answer to `.bgn/config.json` so it's asked once, not every build.
 */
async function promptForProdUrl(configPath, config) {
  if (!process.stdin.isTTY) return null;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('Production URL for CrUX field data (blank to skip): ')).trim();
  rl.close();
  if (!answer) return null;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ ...(config || {}), prodUrl: answer }, null, 2) + '\n');
  return answer;
}

async function main() {
  const args = process.argv.slice(2);
  const open = args.includes('--open');
  const outIdx = args.indexOf('--out');
  const outFile = outIdx >= 0 ? args[outIdx + 1] : 'lcp-map.html';
  const prodUrlIdx = args.indexOf('--prod-url');
  const skip = new Set([outIdx >= 0 ? outIdx + 1 : -1, prodUrlIdx >= 0 ? prodUrlIdx + 1 : -1]);
  const inFile = args.find((a, i) => !a.startsWith('--') && !skip.has(i));

  if (!inFile) {
    console.error('usage: node build_lcp_map.mjs <attribution.json> [--out lcp-map.html] [--open] [--prod-url <url>]');
    process.exit(1);
  }
  for (const [p, what] of [[inFile, 'attribution data'], [TEMPLATE, 'template'], [LIB, 'vendored lib']]) {
    if (!fs.existsSync(p)) { console.error(`missing ${what}: ${p}`); process.exit(1); }
  }

  const attribution = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  if (attribution.error) {
    console.error(`attribution data has an error, nothing to render: ${attribution.error}`);
    process.exit(1);
  }

  const configPath = path.join(process.cwd(), '.bgn', 'config.json');
  const config = readJsonSafe(configPath);
  const packageJson = readJsonSafe(path.join(process.cwd(), 'package.json'));
  const prodUrl = resolveProdUrl({ flagUrl: prodUrlIdx >= 0 ? args[prodUrlIdx + 1] : null, config, packageJson })
    || await promptForProdUrl(configPath, config);
  const crux = prodUrl ? await getFieldData(prodUrl, { apiKey: config?.cruxApiKey }) : null;

  const nodes = (attribution.nodes || []).map(toRenderNode);
  const payload = {
    meta: {
      url: attribution.url,
      lcpMs: attribution.lcpMs,
      tbtMs: attribution.tbtMs ?? null,
      phases: attribution.phases ?? null,
      transport: attribution.transport ?? null,
      throttled: attribution.throttled ?? null,
      crux,
      degraded: attribution.degraded,
      counts: {
        network: nodes.filter((n) => n.class === 'network').length,
        chunk: nodes.filter((n) => n.class === 'chunk').length,
        module: nodes.filter((n) => n.class === 'module').length,
      },
    },
    nodes,
  };
  const dataJson = JSON.stringify(payload);

  const template = fs.readFileSync(TEMPLATE, 'utf8');
  const lib = fs.readFileSync(LIB, 'utf8');

  if (!template.includes(LIB_MARKER) || !template.includes(DATA_MARKER)) {
    console.error('template is missing an injection marker — did the template change?');
    process.exit(1);
  }

  const html = template
    .split(LIB_MARKER).join(lib)
    .split(DATA_MARKER).join(dataJson);

  fs.writeFileSync(outFile, html);
  const outAbs = path.resolve(outFile);
  const kb = (fs.statSync(outAbs).size / 1024).toFixed(0);

  console.log(`\nbrowsergnome lcp-map`);
  console.log(`  wrote ${outAbs} (${kb} KB, standalone)`);
  console.log(`  ${payload.meta.url || '(no url)'} · LCP ${payload.meta.lcpMs != null ? Math.round(payload.meta.lcpMs) + 'ms' : '?'}`);
  console.log(`  ${payload.meta.counts.network} network · ${payload.meta.counts.chunk} chunk · ${payload.meta.counts.module} module` +
    (payload.meta.degraded ? '  (degraded: no bundle stats, chunk-only)' : ''));
  if (payload.meta.transport?.legacyHttp) {
    const t = payload.meta.transport;
    console.log(`  ⚠ transport: HTTP/1.1 (${t.http1Count}/${t.firstPartyTotal} first-party requests) — results may not represent production (HTTP/2 CDN). See banner.`);
  }
  if (payload.meta.throttled) {
    const t = payload.meta.throttled;
    console.log(`  throttled reference (${t.label}): FCP ${t.fcpMs != null ? Math.round(t.fcpMs) + 'ms' : '?'} ·` +
      ` LCP ${t.lcpMs != null ? Math.round(t.lcpMs) + 'ms' : '?'} · TBT ${t.tbtMs != null ? Math.round(t.tbtMs) + 'ms' : '?'}`);
  }
  if (payload.meta.crux) {
    const m = payload.meta.crux.metrics;
    const src = payload.meta.crux.source === 'psi' ? 'via PageSpeed Insights, keyless' : 'CrUX API';
    console.log(`  field data (${src}, real users, origin): LCP ${m.lcp.p75 != null ? Math.round(m.lcp.p75) + 'ms' : '?'} ·` +
      ` CLS ${m.cls.p75 != null ? m.cls.p75.toFixed(2) : '?'} · INP ${m.inp.p75 != null ? Math.round(m.inp.p75) + 'ms' : '?'}`);
  } else if (prodUrl) {
    console.log(`  no CrUX field data for ${prodUrl} (low-traffic origin, or offline) — field-data tier omitted`);
  }
  console.log(`  open with:  open ${outAbs}\n`);

  if (open) {
    const opener = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const oArgs = process.platform === 'win32' ? ['/c', 'start', '', outAbs] : [outAbs];
    execFile(opener, oArgs, (err) => { if (err) console.error('could not auto-open:', err.message); });
  }
}

// Guarded like lcp_attribution.mjs/trace_metrics.mjs's identical checks — lets
// resolveProdUrl/getFieldData be imported by another script (e.g. a test)
// without also triggering a CLI run as a side effect.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
