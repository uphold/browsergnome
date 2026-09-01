#!/usr/bin/env node
/**
 * perf_scan.mjs — static web perf-debt scanner.
 *
 * Walks a web app repo, parses every JS/TS(X) source with Babel, runs a set
 * of anti-pattern detectors, and emits graph.json: a module dependency graph
 * where each node carries a perf-debt score and the findings behind it.
 *
 * The Babel AST walker, alias resolution, import graph, centrality, and the
 * four noise-control mechanisms (severity weights, diminishing returns,
 * log-scale centrality amplification, the combined hotspot gate) are
 * stack-independent — see references/perf-map.md. Only the detector catalog
 * below is web-specific.
 *
 * Design notes:
 *  - Nodes = source modules (files). Edges = static import relationships.
 *  - The make-or-break property of this tool is signal-vs-noise. Score, then
 *    GATE: only nodes whose debt clears HOTSPOT_DEBT are colored/enlarged;
 *    everything else stays small and grey with findings tucked into the
 *    tooltip.
 *  - Every tuning knob lives in CONFIG below. Tune there against a real OSS
 *    app, never against a seeded fixture (a fixture is circular).
 *
 * Usage:
 *   node perf_scan.mjs <repo-or-src-path> [--out graph.json] [--quiet] [--no-compiler-detect]
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

// Babel packages are CJS — load via createRequire (same pattern as doctor.mjs)
// so a missing install fails with one actionable line instead of a raw
// ERR_MODULE_NOT_FOUND stack.
const requireLocal = createRequire(import.meta.url);
let parse, traverse;
try {
  ({ parse } = requireLocal('@babel/parser'));
  const _traverse = requireLocal('@babel/traverse');
  traverse = _traverse.default || _traverse;
} catch {
  console.error(`[browsergnome] missing deps (@babel/parser, @babel/traverse) — run: npm install in ${path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// CONFIG — the single place to tune signal-vs-noise. See perf-map.md.
// ---------------------------------------------------------------------------
const CONFIG = {
  // Severity -> raw debt weight. MEDIUM/LOW are deliberately small so the
  // common-but-harmless detectors can't drown the structural ones.
  severityWeight: { CRITICAL: 10, HIGH: 5, MEDIUM: 1.5, LOW: 0.4 },

  // Per-detector weight override, used instead of the tier default. Only
  // barrelImport needs one: its MEDIUM severity label is earned (real
  // shipped-byte cost) but 3-4 barrel imports in one file is common import
  // hygiene, not a hotspot-worthy defect by itself — at the tier default it
  // crossed the gate alone in 7 of 33 hotspots on a real-app calibration run
  // (excalidraw). Tuned down until that stopped, while it still counts
  // normally when combined with real structural findings.
  weightOverride: { barrelImport: 0.6 },

  // debt = rawSeverity * (1 + centralityK*log2(1+fanIn) + (hasList ? listBonus : 0))
  // Central modules (imported widely) and list screens amplify their debt — a
  // flaw in a shared hub matters more than in a leaf. LOGARITHMIC because a
  // real repo's hub file can have fan-in in the hundreds, and a linear
  // multiplier lets one such file dwarf everything. Calibrated on a
  // React Native app's import graph — re-verify on a real web app.
  centralityK: 0.25,
  listBonus: 0.5,

  // Diminishing returns: the Nth identical finding in one file carries far
  // less signal than the first. Past this many of the SAME detector in a
  // file, extra instances add only log2 weight.
  diminishAfter: 3,

  // Gating combines two rules (see isHotspot below):
  //   1. debt >= hotspotDebt — for MEDIUM/LOW findings that only matter once
  //      they accumulate.
  //   2. any HIGH/CRITICAL finding — structurally important even in a leaf
  //      file, so it's ALWAYS a hotspot regardless of debt.
  hotspotDebt: 6,

  // Perf Map renders only nodes with debt >= this (live-adjustable in the HTML).
  displayMinDebt: 2,

  // Node sizing for the 3D map.
  sizeBaseHot: 6,
  sizeK: 1.3,
  sizeMax: 60,
  sizeCold: 0.8,

  // Files/dirs never scanned. Web swap: drop ios/android/Pods/.expo (no
  // native platform trees), keep .next, add the other framework build dirs.
  ignoreDirs: new Set([
    'node_modules', '.git', 'build', 'dist', '.next', '.turbo', '.vercel',
    'out', 'coverage', '__snapshots__', '__mocks__', 'vendor',
  ]),
  // Test/spec/story files are excluded — they aren't shipped perf surface.
  ignoreFileRe: /(\.test\.|\.spec\.|\.stories\.|\.d\.ts$)/,
  exts: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs'],

  // heavyEntryImport: full-package imports of these at an app-entry file are
  // HIGH cost. Scoped packages never satisfy the plain "no slash" full-package
  // test, so @mui's heavy barrels are listed explicitly — "@mui/material"
  // (bare) is the barrel; "@mui/material/Button" is already tree-shakeable.
  heavyLibs: new Set([
    'moment', 'lodash', 'chart.js', 'three', 'date-fns', 'crypto-js', 'rxjs',
    'core-js', '@mui/material', '@mui/icons-material',
  ]),
  entryFileRe: /(^|\/)(_app|_document|layout|main|index|App)\.(t|j)sx?$/,

  // clientComponentInServerTree: 'use client' at a module this central turns
  // that much of the server-rendered tree into client bundle. Heuristic
  // threshold, not derived — tune against a real Next App Router repo.
  useClientFanInThreshold: 8,

  // largeStaticImport: JSON/SVG imported directly into shared code. 8KB is a
  // guess at "big enough to matter shipped raw into a bundle" — tune on a
  // real repo, this isn't derived from anything.
  largeStaticImportBytes: 8192,

  // Virtualization libraries that make an unbounded .map() render safe.
  virtualizationLibs: new Set([
    '@tanstack/react-virtual', '@tanstack/virtual-core', 'react-window',
    'react-virtualized',
  ]),
};

// Severity ordering for "max severity" of a node.
const SEV_RANK = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
const SEV_COLOR = {
  CRITICAL: '#ff3b3b',
  HIGH: '#ff9f1c',
  MEDIUM: '#ffd23f',
  LOW: '#7f8c9b',
};
const COLD_COLOR = '#586480'; // visible-but-muted grey-blue for below-gate nodes

// Detector catalog: id -> { preset, guide, severity, title }.
// `guide` points at a references/knowledge/<topic>.md leaf — the hypothesis
// space a finding routes into (see references/knowledge/INDEX.md).
// `preset` is one of the four v1 presets: first-load | layout-shift |
// bundle-size | interaction. Re-render/leak/list-stability findings all
// bucket under `interaction` (they degrade INP) — there is no re-renders or
// memory-leaks preset in web v1 (memory-leaks deferred, see references/tools.md).
const DETECTORS = {
  nestedComponent: { preset: 'interaction', guide: 'inp', severity: 'HIGH',
    title: 'Component defined inside another component' },
  inlinePropLiteral: { preset: 'interaction', guide: 'inp', severity: 'LOW',
    title: 'Inline function/object literal as prop' },
  listRowNoMemo: { preset: 'interaction', guide: 'inp', severity: 'MEDIUM',
    title: 'List row component not wrapped in React.memo' },
  effectNoCleanup: { preset: 'interaction', guide: 'inp', severity: 'HIGH',
    title: 'useEffect subscription/timer/observer with no cleanup' },
  indexAsKey: { preset: 'interaction', guide: 'inp', severity: 'HIGH',
    title: 'List uses array index as key' },
  barrelImport: { preset: 'bundle-size', guide: 'bundle', severity: 'MEDIUM',
    title: 'Barrel re-export import' },
  heavyEntryImport: { preset: 'first-load', guide: 'bundle', severity: 'HIGH',
    title: 'Heavy synchronous import at app entry' },
  imageNoDims: { preset: 'layout-shift', guide: 'images-media', severity: 'HIGH',
    title: 'Image without explicit dimensions' },
  unvirtualizedLongList: { preset: 'interaction', guide: 'inp', severity: 'MEDIUM',
    title: 'Unbounded list rendered without virtualization' },
  clientComponentInServerTree: { preset: 'first-load', guide: 'hydration-rsc', severity: 'HIGH',
    title: "'use client' boundary at a high-fan-in module" },
  syncScriptInHead: { preset: 'first-load', guide: 'third-party', severity: 'HIGH',
    title: 'Render-blocking <script> without async/defer' },
  nonLazyRoute: { preset: 'bundle-size', guide: 'bundle', severity: 'MEDIUM',
    title: 'Route component imported synchronously instead of lazily' },
  fontNoDisplaySwap: { preset: 'layout-shift', guide: 'fonts', severity: 'MEDIUM',
    title: 'Web font opted out of font-display: swap' },
  largeStaticImport: { preset: 'bundle-size', guide: 'bundle', severity: 'MEDIUM',
    title: 'Large JSON/SVG asset imported into a shared module' },
};

// ---------------------------------------------------------------------------
// React Compiler suppression — non-negotiable (see references/perf-map.md).
// React Compiler auto-inserts memoization; on a compiler-enabled repo,
// listRowNoMemo/inlinePropLiteral are dead findings that would flood the map.
// String-matched against config source rather than executed/imported, so an
// untrusted target repo's config never runs.
// ---------------------------------------------------------------------------
function detectReactCompiler(repoRoot) {
  const candidates = [
    'babel.config.js', 'babel.config.cjs', 'babel.config.mjs', 'babel.config.json',
    '.babelrc', '.babelrc.js', '.babelrc.json',
    'next.config.js', 'next.config.mjs', 'next.config.ts',
    'vite.config.js', 'vite.config.ts', 'vite.config.mjs',
  ];
  for (const name of candidates) {
    const p = path.join(repoRoot, name);
    let src;
    try { src = fs.readFileSync(p, 'utf8'); } catch { continue; }
    if (/babel-plugin-react-compiler/.test(src)) return true;
    if (/reactCompiler\s*:\s*true/.test(src)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------
function walk(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!CONFIG.ignoreDirs.has(e.name) && !e.name.startsWith('.')) stack.push(full);
      } else if (e.isFile()) {
        const ext = path.extname(e.name);
        if (CONFIG.exts.includes(ext) && !CONFIG.ignoreFileRe.test(e.name)) out.push(full);
      }
    }
  }
  return out;
}

// Path-alias map (e.g. "@/*" -> "<repo>/src/*"), loaded from tsconfig/jsconfig.
// Real web apps import almost everything through aliases, not "../". Without
// resolving them the dependency graph is a disconnected cloud and centrality
// (import fan-in) is meaningless — so this is correctness, not cosmetics.
let ALIASES = [];

function stripJsonComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1');
}

function loadAliases(startDir) {
  let dir = path.resolve(startDir);
  try { if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) dir = path.dirname(dir); } catch {}
  for (let i = 0; i < 8; i++) {
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const cfg = path.join(dir, name);
      if (!fs.existsSync(cfg)) continue;
      try {
        const json = JSON.parse(stripJsonComments(fs.readFileSync(cfg, 'utf8')));
        const co = json.compilerOptions || {};
        if (!co.paths) continue;
        const baseUrl = path.resolve(dir, co.baseUrl || '.');
        const out = [];
        for (const [pat, targets] of Object.entries(co.paths)) {
          const tgt = Array.isArray(targets) ? targets[0] : null;
          if (!tgt) continue;
          if (pat.endsWith('/*') && tgt.endsWith('/*')) {
            out.push({ prefix: pat.slice(0, -1), base: path.resolve(baseUrl, tgt.slice(0, -1)) });
          } else {
            out.push({ exact: pat, file: path.resolve(baseUrl, tgt) });
          }
        }
        if (out.length) return out;
      } catch { /* tolerant: ignore unparseable config */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [];
}

function tryResolveFile(base) {
  // base is an extensionless (or extensioned) absolute path; resolve to a real
  // file, falling back to a directory's index.* (the barrel-file pattern).
  if (CONFIG.exts.includes(path.extname(base)) && fs.existsSync(base)) {
    return { file: base, isBarrel: false };
  }
  for (const ext of CONFIG.exts) {
    const cand = base + ext;
    if (fs.existsSync(cand)) return { file: cand, isBarrel: false };
  }
  try {
    if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
      for (const ext of CONFIG.exts) {
        const cand = path.join(base, 'index' + ext);
        if (fs.existsSync(cand)) return { file: cand, isBarrel: true };
      }
    }
  } catch { /* ignore */ }
  return { file: null, isBarrel: false };
}

function resolveImport(fromFile, spec) {
  // Returns { file: absolutePath|null, isBarrel: bool }.
  if (spec.startsWith('.')) {
    return tryResolveFile(path.resolve(path.dirname(fromFile), spec));
  }
  for (const a of ALIASES) {
    if (a.exact && spec === a.exact) return tryResolveFile(a.file);
    if (a.prefix && spec.startsWith(a.prefix)) {
      return tryResolveFile(path.join(a.base, spec.slice(a.prefix.length)));
    }
  }
  return { file: null, isBarrel: false };
}

// Resolves an asset import (.json/.svg) to a real path without the
// extension-guessing tryResolveFile does — the spec already carries its
// extension, we just need the alias/relative base it points at.
function resolveStaticAsset(fromFile, spec) {
  if (spec.startsWith('.')) return path.resolve(path.dirname(fromFile), spec);
  for (const a of ALIASES) {
    if (a.exact && spec === a.exact) return a.file;
    if (a.prefix && spec.startsWith(a.prefix)) return path.join(a.base, spec.slice(a.prefix.length));
  }
  return null;
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------
const isPascal = (name) => typeof name === 'string' && /^[A-Z]/.test(name);

function functionContainsOwnJSX(fnPath) {
  let found = false;
  fnPath.traverse({
    'JSXElement|JSXFragment'(p) {
      if (found) return;
      if (p.getFunctionParent() === fnPath) { found = true; p.stop(); }
    },
  });
  return found;
}

function isComponentFunction(fnPath, name) {
  return isPascal(name) && functionContainsOwnJSX(fnPath);
}

// Is this JSX usage inside a list-rendering context (a .map callback)?
function insideListContext(jsxPath) {
  return !!jsxPath.findParent((p) => {
    if (p.isCallExpression()) {
      const callee = p.node.callee;
      if (callee && callee.type === 'MemberExpression' &&
          callee.property && callee.property.name === 'map') return true;
    }
    return false;
  });
}

// Does a .map() callback render JSX (directly or via a return)?
function mapCallbackReturnsJSX(cbNode) {
  if (!cbNode) return false;
  if (cbNode.type === 'ArrowFunctionExpression') {
    if (cbNode.body.type === 'JSXElement' || cbNode.body.type === 'JSXFragment') return true;
    if (cbNode.body.type === 'BlockStatement') {
      return cbNode.body.body.some((s) => s.type === 'ReturnStatement' && s.argument &&
        (s.argument.type === 'JSXElement' || s.argument.type === 'JSXFragment'));
    }
  }
  if (cbNode.type === 'FunctionExpression' && cbNode.body.type === 'BlockStatement') {
    return cbNode.body.body.some((s) => s.type === 'ReturnStatement' && s.argument &&
      (s.argument.type === 'JSXElement' || s.argument.type === 'JSXFragment'));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Per-file analysis
// ---------------------------------------------------------------------------
function analyzeFile(absFile, code, repoRoot, suppressed) {
  const rel = path.relative(repoRoot, absFile);
  const findings = [];
  const imports = [];
  const rawSpecs = [];
  const add = (id, line, detail) => {
    if (suppressed.has(id)) return;
    const d = DETECTORS[id];
    findings.push({ id, severity: d.severity, preset: d.preset, guide: d.guide,
      title: d.title, line: line || 0, detail: detail || '' });
  };

  let ast;
  try {
    ast = parse(code, {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
      errorRecovery: true,
      plugins: [
        'jsx', 'typescript', 'classProperties', 'decorators-legacy',
        'objectRestSpread', 'optionalChaining', 'nullishCoalescingOperator',
        'topLevelAwait', 'dynamicImport',
      ],
    });
  } catch {
    return { rel, absFile, findings, imports, hasList: false, isBarrelFile: false,
      hasUseClient: false, parseError: true };
  }

  const hasUseClient = (ast.program.directives || []).some((d) => d.value.value === 'use client');
  const isEntry = CONFIG.entryFileRe.test(rel);
  const localComponents = new Set();
  const memoized = new Set();
  let hasList = false;
  let hasVirtualization = false;
  let reExportAll = 0;
  let reExportNamed = 0;
  const listRowFlagged = new Set();
  const routeBoundNames = new Set();

  // Pass 1: collect local component definitions + memo status.
  traverse(ast, {
    VariableDeclarator(p) {
      const id = p.node.id;
      if (!id || id.type !== 'Identifier' || !isPascal(id.name)) return;
      const init = p.node.init;
      if (!init) return;
      if (init.type === 'CallExpression') {
        const c = init.callee;
        const callName = c && (c.name || (c.property && c.property.name));
        if (callName === 'memo' || callName === 'forwardRef') {
          localComponents.add(id.name); memoized.add(id.name); return;
        }
      }
      if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
        const fnPath = p.get('init');
        if (functionContainsOwnJSX(fnPath)) localComponents.add(id.name);
      }
    },
    FunctionDeclaration(p) {
      const name = p.node.id && p.node.id.name;
      if (isPascal(name) && functionContainsOwnJSX(p)) localComponents.add(name);
    },
  });

  // Pass 2: detectors.
  traverse(ast, {
    ImportDeclaration(p) {
      const spec = p.node.source.value;
      rawSpecs.push(spec);
      if (CONFIG.virtualizationLibs.has(spec)) hasVirtualization = true;

      // largeStaticImport: JSON/SVG resolved directly (extension already known).
      if (/\.(json|svg)$/.test(spec)) {
        const staticPath = resolveStaticAsset(absFile, spec);
        if (staticPath) {
          try {
            const sz = fs.statSync(staticPath).size;
            if (sz > CONFIG.largeStaticImportBytes) {
              add('largeStaticImport', p.node.loc?.start.line, `${(sz / 1024).toFixed(0)}kB`);
            }
          } catch { /* not found — not our problem here */ }
        }
      }

      const { file } = resolveImport(absFile, spec);
      const hasNamed = p.node.specifiers.some((s) => s.type === 'ImportSpecifier');
      // Local binding names this statement introduces — used post-traversal to
      // check which imports are actually bound to a <Route> (see nonLazyRoute).
      const locals = p.node.specifiers.map((s) => s.local && s.local.name).filter(Boolean);
      // barrelImport is decided later, once we know which target files are
      // actual re-export barrels.
      if (file) imports.push({ file, line: p.node.loc?.start.line || 0, spec, hasNamed, locals });
      // heavyEntryImport: full-package import (no deep path) of a heavy lib.
      // Scoped packages (@mui/*) always contain a slash, so they need their
      // own "bare package" test: exactly "@scope/pkg", no deeper subpath.
      const isFullPkg = !spec.startsWith('.') &&
        (!spec.includes('/') || (spec.startsWith('@') && spec.split('/').length === 2));
      if (isEntry && isFullPkg && CONFIG.heavyLibs.has(spec)) {
        add('heavyEntryImport', p.node.loc?.start.line, spec);
      }
    },

    // Re-export tallies identify whether THIS file is itself a barrel.
    ExportAllDeclaration() { reExportAll++; },
    ExportNamedDeclaration(p) { if (p.node.source) reExportNamed++; },

    // Data-router config (`createBrowserRouter([{ Component: X }])`) binds a
    // route the same way `<Route element={X}>` does — same routeBoundNames
    // set, so nonLazyRoute catches both react-router route-declaration styles.
    ObjectProperty(p) {
      const keyName = p.node.key && (p.node.key.name || p.node.key.value);
      if ((keyName === 'Component' || keyName === 'element') &&
          p.node.value && p.node.value.type === 'Identifier') {
        routeBoundNames.add(p.node.value.name);
      }
    },

    // Named component defined inside another component.
    'FunctionDeclaration|ArrowFunctionExpression|FunctionExpression'(p) {
      let name = null;
      if (p.isFunctionDeclaration()) name = p.node.id && p.node.id.name;
      else if (p.parentPath.isVariableDeclarator()) {
        const idn = p.parentPath.node.id;
        name = idn && idn.type === 'Identifier' ? idn.name : null;
      }
      if (!isComponentFunction(p, name)) return;
      const parentFn = p.getFunctionParent();
      if (parentFn) {
        let parentName = null;
        if (parentFn.isFunctionDeclaration()) parentName = parentFn.node.id && parentFn.node.id.name;
        else if (parentFn.parentPath && parentFn.parentPath.isVariableDeclarator()) {
          const idn = parentFn.parentPath.node.id;
          parentName = idn && idn.type === 'Identifier' ? idn.name : null;
        }
        if (isComponentFunction(parentFn, parentName)) {
          add('nestedComponent', p.node.loc?.start.line, name);
        }
      }
    },

    JSXAttribute(p) {
      const valNode = p.node.value;
      if (!valNode || valNode.type !== 'JSXExpressionContainer') return;
      const expr = valNode.expression;
      const attrName = p.node.name && p.node.name.name;
      // Inline arrow/object/style literal as a prop in render.
      if (expr && (expr.type === 'ArrowFunctionExpression' ||
                   expr.type === 'FunctionExpression' ||
                   expr.type === 'ObjectExpression')) {
        if (attrName !== 'key') add('inlinePropLiteral', p.node.loc?.start.line, attrName);
      }
    },

    JSXOpeningElement(p) {
      const nameNode = p.node.name;
      const tag = nameNode && (nameNode.name ||
        (nameNode.type === 'JSXMemberExpression' && nameNode.property && nameNode.property.name));
      if (!tag) return;
      const attrs = p.node.attributes.filter((a) => a.type === 'JSXAttribute');
      const attrNames = new Set(attrs.map((a) => a.name && a.name.name));

      // <img>/<Image> without width/height (or a fill/style equivalent) is a
      // direct CLS cause — the browser can't reserve layout space up front.
      if (tag === 'img' || tag === 'Image') {
        const hasDims = attrNames.has('width') && attrNames.has('height');
        const hasFill = attrNames.has('fill');
        const styleAttr = attrs.find((a) => a.name && a.name.name === 'style');
        let dimInStyle = false;
        if (styleAttr && styleAttr.value && styleAttr.value.type === 'JSXExpressionContainer') {
          dimInStyle = /width|height/.test(code.slice(styleAttr.value.start, styleAttr.value.end));
        }
        if (!hasFill && !hasDims && !dimInStyle) add('imageNoDims', p.node.loc?.start.line, tag);
      }

      // <Route element={X}>/<Route component={X}> — X is an actual route
      // target, the claim nonLazyRoute needs to check before flagging.
      if (tag === 'Route') {
        for (const attrName2 of ['element', 'component']) {
          const a = attrs.find((x) => x.name && x.name.name === attrName2);
          const v = a && a.value;
          if (v && v.type === 'JSXExpressionContainer' && v.expression.type === 'Identifier') {
            routeBoundNames.add(v.expression.name);
          }
        }
      }

      // Raw <script src> with no async/defer blocks the parser. next/script's
      // <Script> is a different tag name, so it's not caught here — by design,
      // it already defers loading unless strategy="beforeInteractive".
      if (tag === 'script') {
        const hasSrc = attrNames.has('src');
        const hasAsyncOrDefer = attrNames.has('async') || attrNames.has('defer');
        if (hasSrc && !hasAsyncOrDefer) add('syncScriptInHead', p.node.loc?.start.line, 'raw <script>');
      }

      // list-row component used in a list context but not memoized.
      if (isPascal(tag) && localComponents.has(tag) && !memoized.has(tag) && !listRowFlagged.has(tag)) {
        if (insideListContext(p)) {
          listRowFlagged.add(tag);
          add('listRowNoMemo', p.node.loc?.start.line, tag);
        }
      }
    },

    CallExpression(p) {
      const callee = p.node.callee;
      const name = callee && (callee.name || (callee.property && callee.property.name));

      // useEffect with subscription/timer/observer and no cleanup return.
      if (name === 'useEffect') {
        const cb = p.node.arguments[0];
        if (cb && (cb.type === 'ArrowFunctionExpression' || cb.type === 'FunctionExpression')) {
          const cbPath = p.get('arguments.0');
          let subscribes = false;
          let returnsCleanup = false;
          cbPath.traverse({
            CallExpression(c) {
              const cn = c.node.callee;
              const m = cn && (cn.name || (cn.property && cn.property.name));
              if (['addEventListener', 'addListener', 'setInterval', 'setTimeout',
                   'subscribe', 'on', 'addObserver'].includes(m)) subscribes = true;
            },
            NewExpression(n) {
              const nm = n.node.callee && n.node.callee.name;
              if (['IntersectionObserver', 'MutationObserver', 'ResizeObserver'].includes(nm)) subscribes = true;
            },
            ReturnStatement(r) {
              if (r.getFunctionParent() === cbPath && r.node.argument &&
                  (r.node.argument.type === 'ArrowFunctionExpression' ||
                   r.node.argument.type === 'FunctionExpression' ||
                   r.node.argument.type === 'Identifier')) returnsCleanup = true;
            },
          });
          if (subscribes && !returnsCleanup) add('effectNoCleanup', p.node.loc?.start.line);
        }
      }

      // Unbounded .map() rendering JSX. A literal array (`[1,2,3].map(...)`)
      // is never a "long list" concern by construction, so it's excluded —
      // everything else renders an unknown-length collection.
      if (name === 'map' && callee.type === 'MemberExpression' &&
          callee.object && callee.object.type !== 'ArrayExpression') {
        const cb = p.node.arguments[0];
        if (mapCallbackReturnsJSX(cb)) {
          hasList = true; // structural: this file renders a list, regardless of findings
          if (!hasVirtualization) add('unvirtualizedLongList', p.node.loc?.start.line);

          // index-as-key: key={index} where `index` is the callback's own
          // second (index) parameter — the actual web anti-pattern, unlike
          // RN's function-valued keyExtractor.
          const idxParam = cb.params && cb.params[1] && cb.params[1].type === 'Identifier'
            ? cb.params[1].name : null;
          if (idxParam) {
            p.get('arguments.0').traverse({
              JSXAttribute(kp) {
                const kn = kp.node.name && kp.node.name.name;
                const kv = kp.node.value;
                if (kn === 'key' && kv && kv.type === 'JSXExpressionContainer' &&
                    kv.expression.type === 'Identifier' && kv.expression.name === idxParam) {
                  add('indexAsKey', kp.node.loc?.start.line, idxParam);
                }
              },
            });
          }
        }
      }

      // next/font display: only flags an explicit non-'swap' value — the
      // implicit default varies by next/font version and isn't worth a
      // version lookup here. Gated on the file actually importing next/font/*
      // so an unrelated function named e.g. `Inter(...)` can't false-positive.
      const arg0 = p.node.arguments[0];
      if (isPascal(name) && arg0 && arg0.type === 'ObjectExpression' && rawSpecs.some((s) => s.startsWith('next/font/'))) {
        const displayProp = arg0.properties.find(
          (prop) => prop.key && (prop.key.name === 'display' || prop.key.value === 'display'));
        if (displayProp && displayProp.value && displayProp.value.type === 'StringLiteral' &&
            displayProp.value.value !== 'swap') {
          add('fontNoDisplaySwap', p.node.loc?.start.line, displayProp.value.value);
        }
      }
    },
  });

  // A re-export barrel: `export * from` anywhere, or several `export { } from`
  // statements. Importing named symbols through such a file pulls the whole
  // barrel into the bundle and defeats tree-shaking.
  const isBarrelFile = reExportAll > 0 || reExportNamed >= 3;

  // Barrel cross-reference happens in build() once every file's isBarrelFile
  // is known. clientComponentInServerTree needs fanIn, computed in build()
  // too — both are finished there, not here.

  // nonLazyRoute: a file that imports a routing library AND statically
  // imports a component actually bound to a <Route element=.../component=...>
  // (routeBoundNames, collected above) is the "route config table" pattern —
  // that specific import should be React.lazy'd instead. Checking the actual
  // <Route> binding — not "any import in a file that imports react-router" —
  // is the difference between flagging the route and flagging every helper
  // and hook the route file happens to also import.
  const isRouteConfigFile = rawSpecs.includes('react-router-dom') || rawSpecs.includes('react-router');
  if (isRouteConfigFile) {
    for (const imp of imports) {
      if (imp.locals.some((l) => routeBoundNames.has(l))) add('nonLazyRoute', imp.line, imp.spec);
    }
  }

  return { rel, absFile, findings, imports, hasList, isBarrelFile, hasUseClient, parseError: false };
}

// ---------------------------------------------------------------------------
// Graph assembly + scoring
// ---------------------------------------------------------------------------
function build(repoRoot, files, suppressed) {
  const analyses = [];
  for (const f of files) {
    let code;
    try { code = fs.readFileSync(f, 'utf8'); } catch { continue; }
    analyses.push(analyzeFile(f, code, repoRoot, suppressed));
  }

  const byAbs = new Map(analyses.map((a) => [a.absFile, a]));

  // Barrel cross-reference: now that every file knows whether IT is a re-export
  // barrel, flag the import SITES that pull named symbols through one.
  const barrelSet = new Set(analyses.filter((a) => a.isBarrelFile).map((a) => a.absFile));
  for (const a of analyses) {
    if (suppressed.has('barrelImport')) break;
    const seen = new Set();
    for (const imp of a.imports) {
      if (!imp.hasNamed || !barrelSet.has(imp.file) || seen.has(imp.file)) continue;
      seen.add(imp.file);
      const d = DETECTORS.barrelImport;
      a.findings.push({ id: 'barrelImport', severity: d.severity, preset: d.preset,
        guide: d.guide, title: d.title, line: imp.line, detail: imp.spec });
    }
  }

  const fanIn = new Map();
  const links = [];
  const seenLink = new Set();
  for (const a of analyses) {
    for (const imp of a.imports) {
      const tgt = imp.file;
      if (!byAbs.has(tgt) || tgt === a.absFile) continue;
      const tRel = byAbs.get(tgt).rel;
      fanIn.set(tRel, (fanIn.get(tRel) || 0) + 1);
      const key = a.rel + '->' + tRel;
      if (!seenLink.has(key)) { seenLink.add(key); links.push({ source: a.rel, target: tRel }); }
    }
  }

  // clientComponentInServerTree needs fanIn, only known now that every file
  // has been walked.
  if (!suppressed.has('clientComponentInServerTree')) {
    for (const a of analyses) {
      if (!a.hasUseClient) continue;
      const fi = fanIn.get(a.rel) || 0;
      if (fi >= CONFIG.useClientFanInThreshold) {
        const d = DETECTORS.clientComponentInServerTree;
        a.findings.push({ id: 'clientComponentInServerTree', severity: d.severity, preset: d.preset,
          guide: d.guide, title: d.title, line: 0, detail: `fan-in ${fi}` });
      }
    }
  }

  const diminish = (count) => count <= CONFIG.diminishAfter
    ? count
    : CONFIG.diminishAfter + Math.log2(count - CONFIG.diminishAfter + 1);

  const nodes = analyses.map((a) => {
    // Sum per-detector with diminishing returns so a long tail of one noisy
    // pattern can't dominate; distinct detectors still stack normally.
    // Split STRUCTURAL (MEDIUM+) from COSMETIC (LOW). Centrality only
    // amplifies structural debt.
    const byDet = {};
    for (const f of a.findings) (byDet[f.id] ||= []).push(f);
    let structuralRaw = 0;
    let cosmeticRaw = 0;
    for (const arr of Object.values(byDet)) {
      const baseWeight = CONFIG.weightOverride[arr[0].id] ?? CONFIG.severityWeight[arr[0].severity];
      const w = baseWeight * diminish(arr.length);
      // barrelImport is priced MEDIUM (it costs real shipped bytes) but isn't
      // a structural code-hub defect the way a leak or re-render bug is — its
      // cost is a flat per-barrel bundler tax that doesn't compound with a
      // file's fan-in. Without this carve-out, 3-4 barrel imports in a file
      // with modest centrality cross the hotspot gate ALONE — calibrated on
      // excalidraw, where it drove 29 of 69 hotspots (target ~15-25) before
      // this fix. So it stays cosmetic (uncentralized) despite its weight.
      const isStructural = SEV_RANK[arr[0].severity] >= SEV_RANK.MEDIUM && arr[0].id !== 'barrelImport';
      if (isStructural) structuralRaw += w;
      else cosmeticRaw += w;
    }
    const raw = structuralRaw + cosmeticRaw;
    const fi = fanIn.get(a.rel) || 0;
    const mult = 1 + CONFIG.centralityK * Math.log2(1 + fi) + (a.hasList ? CONFIG.listBonus : 0);
    const debt = +(structuralRaw * mult + cosmeticRaw).toFixed(2);
    const maxSev = a.findings.reduce((m, f) =>
      (SEV_RANK[f.severity] > SEV_RANK[m] ? f.severity : m), 'LOW');
    // index.* files are everywhere; label them by their folder so the map
    // and tooltips stay legible (e.g. "Gallery/index.tsx").
    const base = path.basename(a.rel);
    const label = /^index\./.test(base) ? `${path.basename(path.dirname(a.rel))}/${base}` : base;
    return { id: a.rel, label, findings: a.findings,
      rawDebt: +raw.toFixed(2), fanIn: fi, hasList: a.hasList, debt,
      maxSeverity: a.findings.length ? maxSev : null, parseError: a.parseError };
  });

  // Gate: classify hotspots, assign visual size + color.
  for (const n of nodes) {
    const hasStructural = n.maxSeverity && SEV_RANK[n.maxSeverity] >= SEV_RANK.HIGH;
    n.isHotspot = n.findings.length > 0 && (n.debt >= CONFIG.hotspotDebt || hasStructural);
    if (n.isHotspot) {
      n.val = Math.min(CONFIG.sizeMax, CONFIG.sizeBaseHot + n.debt * CONFIG.sizeK);
      n.color = SEV_COLOR[n.maxSeverity] || SEV_COLOR.MEDIUM;
    } else {
      n.val = CONFIG.sizeCold;
      n.color = COLD_COLOR;
    }
  }

  return { nodes, links };
}

// Top-3 prioritized, ready to paste into Autoresearch.
function topThree(nodes) {
  const hotspots = nodes.filter((n) => n.isHotspot).sort((a, b) => b.debt - a.debt);
  return hotspots.slice(0, 3).map((n, i) => {
    const dom = [...n.findings].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity])[0];
    const baseNoExt = path.basename(n.id).replace(/\.(t|j)sx?$/, '');
    const target = (!baseNoExt || baseNoExt === 'index')
      ? (path.basename(path.dirname(n.id)) || 'App') : baseNoExt;
    return {
      rank: i + 1,
      file: n.id,
      debt: n.debt,
      preset: dom.preset,
      why: `${dom.title}${dom.detail ? ` (${dom.detail})` : ''} at ${n.id}:${dom.line}`,
      paste: `/browsergnome ${dom.preset} --target ${target}`,
    };
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  const quiet = args.includes('--quiet');
  const noCompilerDetect = args.includes('--no-compiler-detect');
  const outIdx = args.indexOf('--out');
  const outFile = outIdx >= 0 ? args[outIdx + 1] : 'graph.json';
  const outValIdx = outIdx >= 0 ? outIdx + 1 : -1;
  const target = args.find((a, i) => !a.startsWith('--') && i !== outValIdx);

  if (!target) {
    console.error('usage: node perf_scan.mjs <repo-or-src-path> [--out graph.json] [--quiet] [--no-compiler-detect]');
    process.exit(1);
  }
  const repoRoot = path.resolve(target);
  if (!fs.existsSync(repoRoot)) {
    console.error(`path not found: ${repoRoot}`);
    process.exit(1);
  }

  const reactCompiler = !noCompilerDetect && detectReactCompiler(repoRoot);
  const suppressed = reactCompiler ? new Set(['inlinePropLiteral', 'listRowNoMemo']) : new Set();

  ALIASES = loadAliases(repoRoot);
  const files = walk(repoRoot);
  const { nodes, links } = build(repoRoot, files, suppressed);
  const top3 = topThree(nodes);

  const hotspots = nodes.filter((n) => n.isHotspot);
  const findingCount = nodes.reduce((s, n) => s + n.findings.length, 0);
  const byDetector = {};
  for (const n of nodes) for (const f of n.findings) byDetector[f.id] = (byDetector[f.id] || 0) + 1;

  const graph = {
    meta: {
      generatedAt: new Date().toISOString(),
      repoRoot,
      reactCompiler,
      config: CONFIG,
      stats: {
        filesScanned: files.length,
        nodes: nodes.length,
        links: links.length,
        findings: findingCount,
        hotspots: hotspots.length,
        byDetector,
      },
    },
    nodes,
    links,
    top3,
  };

  fs.writeFileSync(outFile, JSON.stringify(graph, (k, v) =>
    (v instanceof Set ? [...v] : v), 2));

  if (!quiet) {
    console.log(`\nbrowsergnome perf_scan`);
    console.log(`  scanned   ${files.length} files in ${repoRoot}`);
    console.log(`  aliases   ${ALIASES.length ? ALIASES.map((a) => a.prefix || a.exact).join(', ') : '(none found)'}`);
    console.log(`  react compiler  ${reactCompiler ? 'detected — inlinePropLiteral/listRowNoMemo suppressed' : 'not detected'}`);
    console.log(`  graph     ${nodes.length} nodes / ${links.length} edges`);
    console.log(`  findings  ${findingCount} total, ${hotspots.length} hotspot module(s)`);
    console.log(`  by detector:`);
    for (const [id, c] of Object.entries(byDetector).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(c).padStart(4)}  ${id}`);
    }
    console.log(`\n  Top-3 (paste into /browsergnome):`);
    if (!top3.length) console.log(`    (no module cleared the hotspot gate — repo looks clean or thresholds too high)`);
    for (const t of top3) {
      console.log(`    ${t.rank}. [debt ${t.debt}] ${t.paste}`);
      console.log(`        ${t.why}`);
    }
    console.log(`\n  wrote ${outFile}\n`);
  }
}

main();
