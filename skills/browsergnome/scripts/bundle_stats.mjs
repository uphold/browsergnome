#!/usr/bin/env node
/**
 * bundle_stats.mjs — parse a bundler's build-time stats output into a
 * normalized {bundler, totalBytes, chunks:[{chunk, file, bytes, modules:[{module, bytes}]}]}
 * shape. Build-time only, no browser — feeds `bundle-size`'s gate directly,
 * and is the exact chunk→module→bytes mapping the LCP Attribution Map's
 * apportioned module tier needs (see references/perf-map.md).
 *
 * Two formats are implemented, both verified against real generated builds
 * (not recalled from memory — see selfTest()'s fixture checks):
 *
 *  - **webpack** (`webpack --json > stats.json`): `assets[]` gives real
 *    shipped bytes per output file; `chunks[]` maps a chunk id to its
 *    names/files; `modules[]` maps modules to chunk ids via a `chunks: []`
 *    array on each entry. Production mode's ModuleConcatenationPlugin
 *    merges multiple source modules into one `modules[]` entry with a
 *    nested `modules` array (`"./src/index.js + 1 modules"`) — a naive
 *    parser reading only top-level `modules[].size` silently drops every
 *    concatenated module. There's also an orphaned duplicate entry per
 *    concatenated module (same module, `chunks: []`) that must be skipped,
 *    not counted twice. A second real build with an added `import()` (real
 *    code-splitting) confirmed multi-chunk attribution keys correctly by
 *    chunk id, and that webpack's own injected runtime modules
 *    (`webpack/runtime/...`) land in whichever chunk really ships them,
 *    which is correct — they're real shipped bytes.
 *
 *  - **esbuild** (`--metafile=meta.json`): `outputs[file].bytes` is the real
 *    shipped size; `outputs[file].inputs[path].bytesInOutput` is each
 *    source module's contribution. Flat, no concatenation quirk — the
 *    simpler of the two real shapes checked here.
 *
 * Vite/Rollup and Turbopack are explicitly NOT implemented: Vite's CLI
 * doesn't emit a stats file by default (would need `rollup-plugin-
 * visualizer` or similar, an added dependency in the *target* repo, not
 * assumable) and Turbopack has no stable public stats format. `detectFormat`
 * returns `null` for anything that isn't webpack or esbuild shaped; callers
 * must treat that as "no bundler stats available" and degrade — never guess
 * a shape for an unsupported format (see `computeINP`'s interactionId:0 bug
 * in trace_metrics.mjs for what guessing field shapes costs).
 *
 * Usage:
 *   node bundle_stats.mjs <stats.json|stats.json.gz>
 *   node bundle_stats.mjs --self-test
 */

import fs from 'node:fs';
import zlib from 'node:zlib';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

// ── Decode ──────────────────────────────────────────────────────────────────

/** Same gzip-by-magic-byte convention as trace_metrics.mjs's decodeTrace. */
export function decodeStats(buf) {
  const isGzip = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  const text = (isGzip ? zlib.gunzipSync(buf) : buf).toString('utf8');
  return JSON.parse(text);
}

/**
 * Which of the two implemented formats this JSON is, or null if neither.
 * webpack stats are array-shaped (`assets`/`chunks`/`modules` all arrays);
 * esbuild metafiles are object-shaped (`inputs`/`outputs` are keyed by path,
 * not arrays) — the two formats don't overlap on this check.
 */
export function detectFormat(json) {
  if (Array.isArray(json?.assets) && Array.isArray(json?.chunks) && Array.isArray(json?.modules)) {
    return 'webpack';
  }
  if (json?.inputs && typeof json.inputs === 'object' && json?.outputs && typeof json.outputs === 'object') {
    return 'esbuild';
  }
  return null;
}

// ── Normalizers ─────────────────────────────────────────────────────────────

/**
 * Flatten a webpack `modules[]` entry into {module, bytes} leaves, expanding
 * ModuleConcatenationPlugin's nested `modules` array when present (the
 * concatenated-entry's own `size` is the pre-summed total of its children,
 * so recursing into `modules` and NOT also counting the parent's own `size`
 * is what avoids double-counting).
 */
function flattenWebpackModule(m) {
  if (Array.isArray(m.modules) && m.modules.length > 0) {
    return m.modules.flatMap(flattenWebpackModule);
  }
  return [{ module: m.name, bytes: m.size ?? 0 }];
}

function normalizeWebpack(json) {
  const chunkById = new Map(json.chunks.map(c => [c.id, c]));
  // asset bytes are the real shipped size (post-minify); keyed by the chunk
  // id(s) the asset belongs to. Only count JS assets — a chunk can also emit
  // a .css or .map sibling asset under the same chunk id.
  const assetBytesByChunkId = new Map();
  for (const asset of json.assets) {
    if (!asset.name.endsWith('.js')) continue;
    for (const chunkId of asset.chunks ?? []) {
      assetBytesByChunkId.set(chunkId, (assetBytesByChunkId.get(chunkId) ?? 0) + (asset.size ?? 0));
    }
  }

  // top-level modules with a non-empty `chunks` are real entries; entries
  // with `chunks: []` are orphaned duplicates of an already-concatenated
  // module (confirmed on a real build — see file header) and must be skipped.
  const modulesByChunkId = new Map();
  for (const m of json.modules) {
    if (!Array.isArray(m.chunks) || m.chunks.length === 0) continue;
    const leaves = flattenWebpackModule(m);
    for (const chunkId of m.chunks) {
      const list = modulesByChunkId.get(chunkId) ?? [];
      list.push(...leaves);
      modulesByChunkId.set(chunkId, list);
    }
  }

  const chunks = [];
  for (const [chunkId, chunk] of chunkById) {
    const bytes = assetBytesByChunkId.get(chunkId) ?? chunk.size ?? 0;
    chunks.push({
      chunk: chunk.names?.[0] ?? String(chunkId),
      file: chunk.files?.[0] ?? null,
      bytes,
      modules: modulesByChunkId.get(chunkId) ?? [],
    });
  }
  return { bundler: 'webpack', totalBytes: chunks.reduce((s, c) => s + c.bytes, 0), chunks };
}

function normalizeEsbuild(json) {
  const chunks = Object.entries(json.outputs)
    .filter(([file]) => file.endsWith('.js'))
    .map(([file, out]) => ({
      chunk: file,
      file,
      bytes: out.bytes ?? 0,
      modules: Object.entries(out.inputs ?? {}).map(([module, info]) => ({
        module,
        bytes: info.bytesInOutput ?? 0,
      })),
    }));
  return { bundler: 'esbuild', totalBytes: chunks.reduce((s, c) => s + c.bytes, 0), chunks };
}

/**
 * Parse + normalize in one call. Returns `{error}` (never throws) for an
 * unrecognized format — Vite/Turbopack callers must check for `.error` and
 * degrade to "no bundler stats available" rather than guessing a shape.
 */
export function parseBundleStats(json) {
  const format = detectFormat(json);
  if (format === 'webpack') return normalizeWebpack(json);
  if (format === 'esbuild') return normalizeEsbuild(json);
  return { error: 'unrecognized bundler stats format — only webpack (--json) and esbuild (--metafile) are implemented; Vite/Turbopack are not (see file header)' };
}

// ── Self-test ───────────────────────────────────────────────────────────────

function selfTest() {
  let pass = 0, fail = 0;
  const check = (name, got, want) => {
    const eq = JSON.stringify(got) === JSON.stringify(want);
    console.log(`  ${eq ? 'PASS' : 'FAIL'}  ${name}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
    eq ? pass++ : fail++;
  };

  check('detectFormat: unrecognized shape returns null', detectFormat({ foo: 1 }), null);
  check('parseBundleStats: unrecognized shape reports error, not a throw', parseBundleStats({ foo: 1 }).error != null, true);

  // shipped fixture 1: a real `webpack --json` production build this
  // session, ModuleConcatenationPlugin ON (the default in production mode) —
  // exercises the concatenated-module + orphan-duplicate handling for real,
  // not via hand-written synthetic data mimicking a guess at the shape.
  try {
    const path = new URL('../assets/bundle-stats.webpack-sample.json.gz', import.meta.url);
    const json = decodeStats(fs.readFileSync(path));
    check('webpack fixture: detected as webpack', detectFormat(json), 'webpack');
    const result = parseBundleStats(json);
    check('webpack fixture: one chunk (main)', result.chunks.length, 1);
    const main = result.chunks[0];
    check('webpack fixture: chunk bytes = real shipped asset size (372), not the pre-minify module sum (308)', main.bytes, 372);
    check('webpack fixture: both concatenated modules recovered, not just the outer entry', main.modules.length, 2);
    check('webpack fixture: module bytes sum to the pre-concatenation module total (308)',
      main.modules.reduce((s, m) => s + m.bytes, 0), 308);
    check('webpack fixture: no double-count from the orphaned duplicate entry',
      result.totalBytes, 372);
  } catch (err) {
    console.log(`  FAIL  webpack fixture decodes and parses  (threw: ${err.message})`);
    fail++;
  }

  // shipped fixture 1b: same real build, but with a dynamic `import()` added
  // (real code-splitting, not simulated) — exercises chunk-id keying across
  // more than one chunk, including webpack's own injected runtime modules
  // (`webpack/runtime/...`) landing in the main chunk's module list, which
  // is correct: they really do ship real bytes in that chunk.
  try {
    const path = new URL('../assets/bundle-stats.webpack-multichunk-sample.json.gz', import.meta.url);
    const json = decodeStats(fs.readFileSync(path));
    const result = parseBundleStats(json);
    check('multi-chunk fixture: two chunks (main + lazy)', result.chunks.length, 2);
    const lazy = result.chunks.find(c => c.file === '899.wp-out.js');
    check('multi-chunk fixture: lazy chunk isolated to its own bytes, not merged into main', lazy?.bytes, 435);
    check('multi-chunk fixture: lazy chunk has only its own module, not main\'s', lazy?.modules, [{ module: './src/lazy.js', bytes: 74 }]);
    const main = result.chunks.find(c => c.file === 'wp-out.js');
    check('multi-chunk fixture: main chunk does not pick up the lazy module', main?.modules.some(m => m.module === './src/lazy.js'), false);
  } catch (err) {
    console.log(`  FAIL  multi-chunk fixture decodes and parses  (threw: ${err.message})`);
    fail++;
  }

  // shipped fixture 2: a real `esbuild --metafile` build.
  try {
    const path = new URL('../assets/bundle-stats.esbuild-sample.json.gz', import.meta.url);
    const json = decodeStats(fs.readFileSync(path));
    check('esbuild fixture: detected as esbuild', detectFormat(json), 'esbuild');
    const result = parseBundleStats(json);
    check('esbuild fixture: one chunk (single entry, no code-splitting)', result.chunks.length, 1);
    const main = result.chunks[0];
    check('esbuild fixture: chunk bytes = real output size', main.bytes, 945);
    check('esbuild fixture: two modules recovered', main.modules.length, 2);
    check('esbuild fixture: per-module bytesInOutput, not raw input bytes',
      main.modules.find(m => m.module === 'src/util.js')?.bytes, 253);
  } catch (err) {
    console.log(`  FAIL  esbuild fixture decodes and parses  (threw: ${err.message})`);
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
    console.error('usage: node bundle_stats.mjs <stats.json|stats.json.gz>');
    console.error('       node bundle_stats.mjs --self-test');
    process.exit(1);
  }
  if (!fs.existsSync(filePath)) {
    console.error(`file not found: ${filePath}`);
    process.exit(1);
  }
  const json = decodeStats(fs.readFileSync(filePath));
  console.log(JSON.stringify(parseBundleStats(json), null, 2));
}

// See trace_metrics.mjs's identical guard (and its comment on why
// pathToFileURL, not a hand-built `file://` string) for why this matters —
// lcp_attribution.mjs imports parseBundleStats from this file directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
