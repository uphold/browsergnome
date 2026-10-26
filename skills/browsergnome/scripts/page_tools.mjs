#!/usr/bin/env node
/**
 * page_tools.mjs — the Page Tools layer: inject a framework provider script into the target page
 * with zero edits to the target repo, so chrome-devtools-mcp's third-party developer tools API
 * (`list_3p_developer_tools` / `execute_3p_developer_tool`, enabled by
 * `--categoryExperimentalThirdParty`) can see framework internals.
 *
 * How the injection works: `serve` hosts each provider's page script on 127.0.0.1 with CORS, and the
 * agent passes `loader`'s one-line script as `navigate_page{initScript}` — it runs before any page
 * script, synchronously fetches the provider, and evaluates it, so the provider's
 * `__REACT_DEVTOOLS_GLOBAL_HOOK__` exists before React loads. The provider ships as ESM with a single
 * trailing `export { … };` statement; `toClassicScript` strips it at serve time so it evaluates as a
 * classic script. The full protocol (dev server lifecycle, re-injection on reload, teardown) lives in
 * `references/page-tools.md`.
 *
 * Imported by doctor.mjs (detectProviders) and build_perf_map.mjs (mergeRenders) — the CLI is gated
 * on the same pathToFileURL guard as trace_metrics.mjs so importing doesn't start a server.
 *
 * Usage:
 *   node page_tools.mjs serve --providers react [--port 0]   # first stdout line: {"port":N,"pid":P}
 *   node page_tools.mjs loader --port N [--provider react]    # prints the initScript loader
 *   node page_tools.mjs locate --repo <dir> --name <Component> [--file <rel>]  # → [{file,line}]
 *   node page_tools.mjs --self-test
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// ── Providers ─────────────────────────────────────────────────────────────

/** id → npm package (a pinned dependency of this plugin), triggering target deps, page script. */
export const PROVIDERS = {
  react: { pkg: 'react-devtools-cdt-mcp', trigger: ['react-dom'], script: 'dist/register.js' },
};

// ── Pure functions (exported, self-tested) ─────────────────────────────────

/**
 * Provider ids whose trigger dependency appears in the target's package.json.
 * @param {string|null} pkgJsonText
 * @returns {string[]}
 */
export function detectProviders(pkgJsonText) {
  let pkg;
  try { pkg = JSON.parse(pkgJsonText || ''); } catch { return []; }
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  return Object.entries(PROVIDERS).filter(([, p]) => p.trigger.some((d) => d in deps)).map(([id]) => id);
}

const TRAILING_EXPORT = /\n\s*export\s*\{[^}]*\}\s*;?\s*$/;
const TOP_LEVEL_ESM = /^(import\s*[\w{*'"]|export\s)/m;

/**
 * Strip the provider bundle's single trailing `export { … };` so it evaluates as a classic script.
 * Throws when any other top-level import/export remains — an upstream format change must fail loudly,
 * not inject a script that silently throws a SyntaxError in the page.
 * @param {string} src
 * @returns {string}
 */
export function toClassicScript(src) {
  const out = src.replace(TRAILING_EXPORT, '\n');
  const leftover = out.match(TOP_LEVEL_ESM);
  if (leftover) throw new Error(`provider script has top-level ESM syntax beyond the trailing export: "${leftover[0]}…"`);
  return out;
}

/**
 * The initScript loader: synchronous XHR (it must finish before any page script runs) + indirect
 * eval (global scope, like a classic <script>).
 * @param {number} port
 * @param {string} providerId
 * @returns {string}
 */
export function loaderScript(port, providerId = 'react') {
  return `(function(){var x=new XMLHttpRequest();x.open('GET','http://127.0.0.1:${port}/${providerId}.js',false);x.send();if(x.status===200)(0,eval)(x.responseText)})()`;
}

/**
 * `re-renders` gate metric: Σ componentsChanged across every commit of a react_get_trace_overview
 * result. Throws on shape drift (the provider is experimental — never gate on a guessed shape).
 * @param {unknown} overview
 * @returns {number}
 */
export function renderTotal(overview) {
  if (!Array.isArray(overview)) throw new Error('trace overview is not an array');
  return overview.reduce((sum, c, i) => {
    if (typeof c?.componentsChanged !== 'number') throw new Error(`commit ${i} has no numeric componentsChanged`);
    return sum + c.componentsChanged;
  }, 0);
}

/**
 * Repo-relative path from a provider source `fileName`, or null when it isn't the target's own code.
 * Handles dev-server URLs (`http://localhost:5173/src/App.jsx?t=1`), Vite `/@fs/<abs>`,
 * `webpack-internal:///(app-pages-browser)/./app/page.tsx`, Turbopack `[project]/app/page.tsx`,
 * `file:///abs`, and plain absolute paths.
 * @param {string|null} fileName
 * @param {string} repoRoot - absolute path of the target repo
 * @returns {string|null}
 */
export function normalizeSource(fileName, repoRoot) {
  if (!fileName || /node_modules/.test(fileName)) return null;
  const root = repoRoot.replace(/\/+$/, '');
  const fromAbs = (abs) => (abs === root || !abs.startsWith(root + '/') ? null : abs.slice(root.length + 1));
  let p = fileName.replace(/[?#].*$/, '');
  if (p.startsWith('webpack-internal:///')) return p.replace(/^webpack-internal:\/\/\/(\([^)]*\)\/)?\.\//, '') || null;
  if (p.startsWith('[project]/')) return p.slice('[project]/'.length) || null;
  if (p.startsWith('file://')) return fromAbs(decodeURIComponent(new URL(p).pathname));
  if (/^https?:\/\//.test(p)) {
    p = decodeURIComponent(new URL(p).pathname);
    if (p.startsWith('/@fs/')) return fromAbs(p.slice('/@fs'.length));
    if (p.startsWith('/@') || p.startsWith('/_next/') || p === '/') return null;
    return p.slice(1);
  }
  if (p.startsWith('/')) return fromAbs(p);
  return null;
}

const DEFINITION = (name) => new RegExp(
  `^\\s*(export\\s+(default\\s+)?)?((async\\s+)?function\\s*\\*?\\s+${name}\\b|(const|let|var)\\s+${name}\\s*[=:]|class\\s+${name}\\b)`);

/**
 * 1-based line where component `name` is defined in `fileText`, or null. Provider `line` values point
 * into the dev server's transformed output (and Turbopack reports a bundled chunk, not a file), so
 * file:line for findings comes from the original source, located by the component's name.
 * @param {string} fileText
 * @param {string} name
 * @returns {number|null}
 */
export function locateComponent(fileText, name) {
  if (!/^[A-Za-z_$][\w$]*$/.test(name || '')) return null;
  const re = DEFINITION(name.replace(/\$/g, '\\$'));
  const i = fileText.split('\n').findIndex((l) => re.test(l));
  return i < 0 ? null : i + 1;
}

/**
 * Perf Map overlay: copy render counts onto graph.json nodes. A node matches when its id (perf_scan's
 * path relative to the scanned root) equals the profile entry's file, or is its path suffix (scan
 * rooted at a subdirectory like src/).
 * @param {{nodes:Array<{id:string}>}} graph
 * @param {Array<{file:string, renders:number, selfMs:number}>} profile
 * @returns {{graph:object, unmatched:string[]}}
 */
export function mergeRenders(graph, profile) {
  const unmatched = [];
  const nodes = graph.nodes.map((n) => ({ ...n }));
  for (const e of profile) {
    const node = nodes.find((n) => n.id === e.file) || nodes.find((n) => e.file.endsWith('/' + n.id));
    if (!node) { unmatched.push(e.file); continue; }
    node.renders = Number(e.renders);
    node.renderSelfMs = Number(e.selfMs);
  }
  return { graph: { ...graph, nodes }, unmatched };
}

// ── CLI ──────────────────────────────────────────────────────────────────

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const SOURCE_EXT = /\.(jsx?|tsx?|mjs)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.bgn', 'dist', 'build', 'out', '.turbo', '.vercel', 'coverage']);

function* sourceFiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* sourceFiles(path.join(dir, e.name)); }
    else if (SOURCE_EXT.test(e.name)) yield path.join(dir, e.name);
  }
}

function locate() {
  const repoDir = path.resolve(arg('--repo', '.'));
  const name = arg('--name');
  const file = arg('--file');
  if (!name) { console.error('usage: node page_tools.mjs locate --repo <dir> --name <Component> [--file <rel>]'); process.exit(1); }
  const candidates = file ? [path.join(repoDir, file)] : sourceFiles(repoDir);
  const hits = [];
  for (const abs of candidates) {
    const line = fs.existsSync(abs) ? locateComponent(fs.readFileSync(abs, 'utf8'), name) : null;
    if (line) hits.push({ file: path.relative(repoDir, abs), line });
  }
  console.log(JSON.stringify(hits));
}

function serve() {
  const ids = arg('--providers', 'react').split(',');
  const scripts = {};
  for (const id of ids) {
    const p = PROVIDERS[id];
    if (!p) { console.error(`unknown provider: ${id} (known: ${Object.keys(PROVIDERS).join(', ')})`); process.exit(1); }
    const file = path.join(pluginRoot, 'node_modules', p.pkg, p.script);
    if (!fs.existsSync(file)) { console.error(`missing ${p.pkg} — run: npm --prefix "${pluginRoot}" install`); process.exit(1); }
    try { scripts[`/${id}.js`] = toClassicScript(fs.readFileSync(file, 'utf8')); }
    catch (e) { console.error(`${p.pkg}: ${e.message}`); process.exit(1); }
  }
  const server = http.createServer((req, res) => {
    const body = scripts[req.url];
    res.writeHead(body ? 200 : 404, { 'Content-Type': 'text/javascript', 'Access-Control-Allow-Origin': '*' });
    res.end(body || '');
  });
  server.listen(Number(arg('--port', '0')), '127.0.0.1', () => {
    console.log(JSON.stringify({ port: server.address().port, pid: process.pid }));
  });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
}

function selfTest() {
  let pass = 0, fail = 0;
  const check = (name, got, want) => {
    const eq = JSON.stringify(got) === JSON.stringify(want);
    console.log(`  ${eq ? 'PASS' : 'FAIL'}  ${name}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
    eq ? pass++ : fail++;
  };
  const throws = (fn) => { try { fn(); return false; } catch { return true; } };

  // detectProviders
  check('react-dom dep → react', detectProviders('{"dependencies":{"react":"19","react-dom":"19"}}'), ['react']);
  check('react-dom devDep → react', detectProviders('{"devDependencies":{"react-dom":"19"}}'), ['react']);
  check('react alone (no react-dom, e.g. RN) → none', detectProviders('{"dependencies":{"react":"19"}}'), []);
  check('vue app → none', detectProviders('{"dependencies":{"vue":"3"}}'), []);
  check('invalid / missing package.json → none', [detectProviders('{'), detectProviders(null)], [[], []]);

  // toClassicScript — shape of the real dist/register.js tail
  const bundle = "var x = 1;\nfunction register() {}\nregister();\n\nexport { buildToolGroup, register };\n";
  check('strips the trailing export', toClassicScript(bundle).includes('export'), false);
  check('keeps the body', toClassicScript(bundle).includes('register();'), true);
  check('rejects a top-level import', throws(() => toClassicScript("import x from 'y';\n" + bundle)), true);
  check('rejects a second export', throws(() => toClassicScript('export const a = 1;\n' + bundle)), true);
  check('ignores "import"/"export" inside indented code and identifiers', throws(() => toClassicScript("  importScripts();\nvar exportsX = 1;\n" + bundle)), false);

  // loaderScript
  const l = loaderScript(5299, 'react');
  check('loader targets 127.0.0.1:<port>/<id>.js synchronously', [l.includes("'http://127.0.0.1:5299/react.js',false"), l.includes('(0,eval)')], [true, true]);
  check('loader is a single line', l.includes('\n'), false);

  // renderTotal — the spike's overview shape (3 commits × 50 components)
  const overview = [0, 1, 2].map((i) => ({ commit: i, committedAt: i * 200, renderDuration: 1.3, layoutDuration: 0, passiveDuration: 0, componentsChanged: 50 }));
  check('Σ componentsChanged', renderTotal(overview), 150);
  check('empty trace → 0', renderTotal([]), 0);
  check('non-array → throws', throws(() => renderTotal({ error: 'x' })), true);
  check('missing componentsChanged → throws', throws(() => renderTotal([{ commit: 0 }])), true);

  // normalizeSource
  const root = '/work/app';
  check('vite dev URL', normalizeSource('http://localhost:5199/src/App.jsx', root), 'src/App.jsx');
  check('vite dev URL with HMR query', normalizeSource('http://localhost:5199/src/App.jsx?t=1700000000', root), 'src/App.jsx');
  check('vite /@fs/ inside repo', normalizeSource('http://localhost:5199/@fs/work/app/lib/x.tsx', root), 'lib/x.tsx');
  check('vite /@fs/ outside repo → null', normalizeSource('http://localhost:5199/@fs/elsewhere/x.tsx', root), null);
  check('vite internal /@react-refresh → null', normalizeSource('http://localhost:5199/@react-refresh', root), null);
  check('webpack-internal with layer', normalizeSource('webpack-internal:///(app-pages-browser)/./app/page.tsx', root), 'app/page.tsx');
  check('webpack-internal without layer', normalizeSource('webpack-internal:///./src/App.jsx', root), 'src/App.jsx');
  check('turbopack [project]', normalizeSource('[project]/app/page.tsx', root), 'app/page.tsx');
  check('file:// inside repo', normalizeSource('file:///work/app/src/A.tsx', root), 'src/A.tsx');
  check('absolute path inside repo', normalizeSource('/work/app/src/A.tsx', root), 'src/A.tsx');
  check('node_modules → null', normalizeSource('http://localhost:5199/node_modules/.vite/deps/react.js', root), null);
  check('empty → null', normalizeSource('', root), null);

  // locateComponent
  const src = "import x from 'y';\nfunction Row({ label }) { return null; }\nexport default function Filter() {}\nconst Card = memo(() => null);\nexport const List: FC = () => null;\nclass Old extends Component {}\nconst RowLike = 1;\n";
  check('function declaration', locateComponent(src, 'Row'), 2);
  check('export default function', locateComponent(src, 'Filter'), 3);
  check('const = memo(...)', locateComponent(src, 'Card'), 4);
  check('typed export const', locateComponent(src, 'List'), 5);
  check('class component', locateComponent(src, 'Old'), 6);
  check('no prefix match (Row ≠ RowLike)', locateComponent('const RowLike = 1;', 'Row'), null);
  check('absent → null', locateComponent(src, 'Missing'), null);
  check('non-identifier name (e.g. "Unknown()") → null', locateComponent(src, 'Anonymous()'), null);

  // mergeRenders
  const graph = { meta: {}, nodes: [{ id: 'src/App.jsx' }, { id: 'components/Row.tsx' }, { id: 'src/util.js' }] };
  const merged = mergeRenders(graph, [
    { file: 'src/App.jsx', renders: 3, selfMs: 1.1 },
    { file: 'src/components/Row.tsx', renders: 40, selfMs: 6.2 },
    { file: 'src/Gone.tsx', renders: 1, selfMs: 0.1 },
  ]);
  check('exact id match', [merged.graph.nodes[0].renders, merged.graph.nodes[0].renderSelfMs], [3, 1.1]);
  check('suffix match (scan rooted at src/)', merged.graph.nodes[1].renders, 40);
  check('unprofiled node untouched', 'renders' in merged.graph.nodes[2], false);
  check('unmatched reported', merged.unmatched, ['src/Gone.tsx']);
  check('input graph not mutated', 'renders' in graph.nodes[0], false);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

function main() {
  const cmd = process.argv[2];
  if (cmd === '--self-test') return selfTest();
  if (cmd === 'serve') return serve();
  if (cmd === 'locate') return locate();
  if (cmd === 'loader') {
    const port = Number(arg('--port'));
    if (!port) { console.error('usage: node page_tools.mjs loader --port N [--provider react]'); process.exit(1); }
    return console.log(loaderScript(port, arg('--provider', 'react')));
  }
  console.error('usage: node page_tools.mjs serve --providers react [--port 0] | loader --port N [--provider react] | locate --repo <dir> --name <Component> [--file <rel>] | --self-test');
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
