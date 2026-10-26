#!/usr/bin/env node
/**
 * build_perf_map.mjs — merge graph.json into the HTML template to produce a
 * single, fully standalone perf-map.html.
 *
 * "Standalone" is a hard requirement: the vendored 3d-force-graph build (which
 * bundles three.js) and the graph payload are both INLINED into the output, so
 * perf-map.html renders from file:// with the network disabled and no sibling
 * files. That's what makes it safe to hand to anyone / open on a plane.
 *
 * Usage:
 *   node build_perf_map.mjs <graph.json> [--out perf-map.html] [--renders render-profile.json] [--open]
 *
 * --renders overlays a Page Tools render profile (`[{file, renders, selfMs}]`, written by the agent
 * from a react_* profiling pass — see references/page-tools.md) onto matching nodes before injection.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { mergeRenders } from './page_tools.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(__dirname, '..', 'assets');
const TEMPLATE = path.join(ASSETS, 'perf-map.template.html');
const LIB = path.join(ASSETS, '3d-force-graph.min.js');

const LIB_MARKER = '/*__FORCE_GRAPH_LIB__*/';
const DATA_MARKER = '/*__GRAPH_DATA__*/';

function main() {
  const args = process.argv.slice(2);
  const open = args.includes('--open');
  const outIdx = args.indexOf('--out');
  const outFile = outIdx >= 0 ? args[outIdx + 1] : 'perf-map.html';
  const rendersIdx = args.indexOf('--renders');
  const rendersFile = rendersIdx >= 0 ? args[rendersIdx + 1] : null;
  const valueIdxs = [outIdx, rendersIdx].filter((i) => i >= 0).map((i) => i + 1); // flag values, not the graph arg
  const graphFile = args.find((a, i) => !a.startsWith('--') && !valueIdxs.includes(i));

  if (!graphFile) {
    console.error('usage: node build_perf_map.mjs <graph.json> [--out perf-map.html] [--renders render-profile.json] [--open]');
    process.exit(1);
  }
  for (const [p, what] of [[graphFile, 'graph'], [TEMPLATE, 'template'], [LIB, 'vendored lib'], ...(rendersFile ? [[rendersFile, 'render profile']] : [])]) {
    if (!fs.existsSync(p)) { console.error(`missing ${what}: ${p}`); process.exit(1); }
  }

  let graphRaw = fs.readFileSync(graphFile, 'utf8');
  let graph = JSON.parse(graphRaw); // validate it parses before embedding
  let unmatched = [];
  if (rendersFile) {
    ({ graph, unmatched } = mergeRenders(graph, JSON.parse(fs.readFileSync(rendersFile, 'utf8'))));
    graphRaw = JSON.stringify(graph);
  }
  const template = fs.readFileSync(TEMPLATE, 'utf8');
  const lib = fs.readFileSync(LIB, 'utf8');

  if (!template.includes(LIB_MARKER) || !template.includes(DATA_MARKER)) {
    console.error('template is missing an injection marker — did the template change?');
    process.exit(1);
  }

  // Literal split/join (not regex) so the 1.3MB minified lib can't be
  // misinterpreted as a replacement pattern.
  const html = template
    .split(LIB_MARKER).join(lib)
    .split(DATA_MARKER).join(graphRaw.trim());

  fs.writeFileSync(outFile, html);
  const outAbs = path.resolve(outFile);
  const kb = (fs.statSync(outAbs).size / 1024).toFixed(0);

  const s = graph.meta?.stats || {};
  console.log(`\nbrowsergnome perf-map`);
  console.log(`  wrote ${outAbs} (${kb} KB, standalone)`);
  console.log(`  ${s.nodes ?? '?'} modules · ${s.hotspots ?? '?'} hotspot(s) · ${s.findings ?? '?'} findings`);
  if (rendersFile) {
    const overlaid = graph.nodes.filter((n) => 'renders' in n).length;
    console.log(`  render overlay: ${overlaid} module(s)${unmatched.length ? ` · ${unmatched.length} profiled file(s) not in the graph: ${unmatched.join(', ')}` : ''}`);
  }
  if (graph.top3?.length) {
    console.log(`  Top-3:`);
    for (const t of graph.top3) console.log(`    ${t.rank}. ${t.paste}  (debt ${t.debt})`);
  }
  console.log(`  open with:  open ${outAbs}\n`);

  if (open) {
    const opener = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const oArgs = process.platform === 'win32' ? ['/c', 'start', '', outAbs] : [outAbs];
    execFile(opener, oArgs, (err) => { if (err) console.error('could not auto-open:', err.message); });
  }
}

main();
