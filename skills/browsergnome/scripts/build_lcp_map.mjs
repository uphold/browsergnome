#!/usr/bin/env node
/**
 * build_lcp_map.mjs — merge lcp_attribution.mjs's JSON output into the HTML
 * template to produce a standalone lcp-map.html. Mirrors build_perf_map.mjs's
 * marker-based split/join. lcp_attribution.mjs emits raw {class, label, ms,
 * confidence, ...} nodes with no render hints, so this script adds val/color
 * (same job perf_scan.mjs does for build_perf_map.mjs).
 *
 * Usage:
 *   node lcp_attribution.mjs <trace.json[.gz]> [bundle-stats.json[.gz]] > attribution.json
 *   node build_lcp_map.mjs attribution.json [--out lcp-map.html] [--open]
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

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

function main() {
  const args = process.argv.slice(2);
  const open = args.includes('--open');
  const outIdx = args.indexOf('--out');
  const outFile = outIdx >= 0 ? args[outIdx + 1] : 'lcp-map.html';
  const outValIdx = outIdx >= 0 ? outIdx + 1 : -1;
  const inFile = args.find((a, i) => !a.startsWith('--') && i !== outValIdx);

  if (!inFile) {
    console.error('usage: node build_lcp_map.mjs <attribution.json> [--out lcp-map.html] [--open]');
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

  const nodes = (attribution.nodes || []).map(toRenderNode);
  const payload = {
    meta: {
      url: attribution.url,
      lcpMs: attribution.lcpMs,
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
  console.log(`  open with:  open ${outAbs}\n`);

  if (open) {
    const opener = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const oArgs = process.platform === 'win32' ? ['/c', 'start', '', outAbs] : [outAbs];
    execFile(opener, oArgs, (err) => { if (err) console.error('could not auto-open:', err.message); });
  }
}

main();
