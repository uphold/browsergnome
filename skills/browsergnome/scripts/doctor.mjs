#!/usr/bin/env node
/**
 * doctor.mjs — browsergnome preflight + first-run setup.
 *
 * Run from the TARGET web repo. Auto-bootstraps the .bgn/ workspace, detects
 * git state, and detects framework/bundler/host on three independent axes
 * (unknown on any axis is fine — the loop still runs on the generic catalog).
 *
 * The web needs one MCP (chrome-devtools-mcp, which manages its own browser
 * process) and a URL — no simulator, no device, no CLI daemon to probe.
 * What this script CANNOT do is speak the MCP protocol to verify the live
 * tool surface — that would mean bundling an MCP client into a preflight
 * script, an extra dependency this project avoids. Instead it cross-checks
 * the two static sources
 * that should agree (`.mcp.json`'s pin vs `references/tools.md`'s
 * documented pin) and leaves live-drift detection to the agent, at the
 * point it actually calls a tool (see SKILL.md's Scope & delegation note).
 *
 * Usage:
 *   node doctor.mjs                 # report checklist + setup actions
 *   node doctor.mjs --init          # also create .bgn/ if missing
 *   node doctor.mjs --url <url>     # verify the target URL responds
 *   node doctor.mjs --self-test     # run parser unit assertions (CI contract), exit 0/1
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execSync, execFileSync } from 'node:child_process';

// ── Pure detection functions (exported; no I/O — all inputs are strings/booleans) ─

/**
 * Classify git repository state from raw command output — four states:
 * usable / no-repo / no-commits / detached.
 * @param {{insideWorkTree:boolean|null, headSha:string|null, symbolicRef:string|null, porcelain?:string}} opts
 * @returns {{ state:'usable'|'no-repo'|'no-commits'|'detached', branch:string|null, dirty:string[] }}
 */
export function parseGitState({ insideWorkTree, headSha, symbolicRef, porcelain = '' }) {
  if (!insideWorkTree) return { state: 'no-repo', branch: null, dirty: [] };
  if (!headSha) return { state: 'no-commits', branch: null, dirty: [] };
  if (!symbolicRef) return { state: 'detached', branch: null, dirty: [] };
  const branch = symbolicRef.replace('refs/heads/', '');
  const dirty = porcelain ? porcelain.split('\n').map(l => l.trim()).filter(Boolean) : [];
  return { state: 'usable', branch, dirty };
}

/**
 * Framework axis. Unknown is a legitimate result, not a failure — the loop
 * falls back to the generic knowledge base.
 * @param {{hasNextConfig:boolean, hasAppDir:boolean, hasPagesDir:boolean, hasRemixConfig:boolean, hasTanstackStartDep:boolean, hasViteConfig:boolean}} opts
 */
export function detectFramework({ hasNextConfig, hasAppDir, hasPagesDir, hasRemixConfig, hasTanstackStartDep, hasViteConfig }) {
  if (hasNextConfig) {
    const framework = hasAppDir ? 'next-app-router' : hasPagesDir ? 'next-pages' : 'next-app-router';
    return { framework, source: 'next.config' };
  }
  if (hasRemixConfig) return { framework: 'remix', source: 'remix.config' };
  if (hasTanstackStartDep) return { framework: 'tanstack-start', source: 'package.json dependency' };
  if (hasViteConfig) return { framework: 'vite-spa', source: 'vite.config' };
  return { framework: 'unknown', source: 'none' };
}

/**
 * Bundler axis. Infers from framework when no bundler config file exists
 * (e.g. Next.js ships webpack/turbopack without a standalone config).
 * @param {{framework:string, nextConfigText:string, hasWebpackConfig:boolean, hasRspackConfig:boolean, hasViteConfig:boolean, hasEsbuildMetafile:boolean}} opts
 */
export function detectBundler({ framework, nextConfigText = '', hasWebpackConfig, hasRspackConfig, hasViteConfig, hasEsbuildMetafile }) {
  if (hasRspackConfig) return { bundler: 'rspack', source: 'rspack.config' };
  if (hasWebpackConfig) return { bundler: 'webpack', source: 'webpack.config' };
  if (hasEsbuildMetafile) return { bundler: 'esbuild', source: 'metafile' };
  if (framework === 'next-app-router' || framework === 'next-pages') {
    // Two config shapes exist across Next.js versions: `experimental.turbo` (13-15.x) and a
    // top-level `turbopack` key (16+, after the `next-experimental-turbo-to-turbopack` codemod).
    // `\bturbo\s*:` alone matches the old key but not the new one — "turbopack:" has no word
    // boundary between "turbo" and "pack", so it silently fell through to the webpack default on
    // a Next 16 config. `turbo(pack)?\s*:` catches both without executing the config file.
    const turbo = /\bturbo(pack)?\s*:/.test(nextConfigText);
    return { bundler: turbo ? 'turbopack' : 'webpack', source: turbo ? 'next.config turbo key' : 'next.js default' };
  }
  if (hasViteConfig || framework === 'vite-spa' || framework === 'tanstack-start') {
    return { bundler: 'vite', source: hasViteConfig ? 'vite.config' : 'framework default' };
  }
  return { bundler: 'unknown', source: 'none' };
}

/**
 * Host axis.
 * @param {{hasVercelJson:boolean, hasVercelDir:boolean, hasWranglerToml:boolean, hasHeadersFile:boolean, hasDockerfile:boolean, hasServerJs:boolean}} opts
 */
export function detectHost({ hasVercelJson, hasVercelDir, hasWranglerToml, hasHeadersFile, hasDockerfile, hasServerJs }) {
  if (hasVercelJson || hasVercelDir) return { host: 'vercel', source: 'vercel.json/.vercel' };
  if (hasWranglerToml || hasHeadersFile) return { host: 'cloudflare', source: 'wrangler.toml/_headers' };
  if (hasDockerfile || hasServerJs) return { host: 'node', source: 'Dockerfile/server.js' };
  return { host: 'unknown', source: 'none' };
}

/**
 * Parse the pinned version out of `.mcp.json`'s chrome-devtools args
 * (`["chrome-devtools-mcp@1.6.0"]` → `"1.6.0"`), and out of
 * `references/tools.md`'s `**Pinned: \`chrome-devtools-mcp@1.6.0\`.**` line.
 * The two must agree — this is a config-consistency check, not a live
 * protocol check (see file header).
 * @param {string|null} mcpJsonText
 * @param {string|null} toolsMdText
 * @returns {{ mcpPin:string|null, docsPin:string|null, agree:boolean }}
 */
export function checkVersionPin(mcpJsonText, toolsMdText) {
  const mcpMatch = mcpJsonText?.match(/chrome-devtools-mcp@([\d.]+)/);
  const docsMatch = toolsMdText?.match(/Pinned:\s*`chrome-devtools-mcp@([\d.]+)`/);
  const mcpPin = mcpMatch ? mcpMatch[1] : null;
  const docsPin = docsMatch ? docsMatch[1] : null;
  return { mcpPin, docsPin, agree: mcpPin != null && mcpPin === docsPin };
}

/**
 * Parse a simple `curl -sI -o /dev/null -w '%{http_code}'`-style status
 * code string.
 * @param {string|null} statusCodeOut
 * @returns {{ reachable:boolean, status:number|null }}
 */
export function parseUrlProbe(statusCodeOut) {
  const status = statusCodeOut ? parseInt(statusCodeOut, 10) : NaN;
  if (isNaN(status) || status === 0) return { reachable: false, status: null };
  return { reachable: status < 500, status };
}

// ── Module-level helpers ──────────────────────────────────────────────────────

const ok = (b) => (b ? '\x1b[32mOK \x1b[0m' : '\x1b[31mXX \x1b[0m');
const warn = '\x1b[33m?? \x1b[0m';

function sh(cmd) {
  try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; }
}
function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function exists(p) { return fs.existsSync(p); }

const repo = process.cwd();
const doInit = process.argv.includes('--init');
const urlIdx = process.argv.indexOf('--url');
const targetUrl = urlIdx !== -1 ? process.argv[urlIdx + 1] : null;

// ── Bootstrap .bgn/ workspace ──────────────────────────────────────────────────

const PERF_MEMORY_HEADER = (name) => `# Performance Memory — ${name}

> browsergnome's per-repo brain. One line per perf gap:
> \`area/file · symptom · suspected cause · preset · status(open|fixed|reverted) · ref\`
> Read at the start of any perf work. Commit this file with the app.

<!-- entries below, newest first -->
`;

const DEFAULT_CONFIG = (axes) => ({
  commitMode: 'per-iteration', // "per-iteration" | "one-commit" | "no-commit"
  liveReport: false,           // write/refresh .bgn/report.html during the run
  openReport: true,            // auto-open report.html when liveReport is on
  runs: 5,                     // N measurement runs per iteration
  warmupDiscard: 1,            // warm-up runs to discard
  k: 2,                        // gate noise multiplier
  budget: 6,                   // max iterations per run (0 = run until no fix clears gate)
  interleaved: true,           // ABABAB measurement — see references/measurement.md
  framework: axes.framework,
  bundler: axes.bundler,
  host: axes.host,
  emulate: {
    cpuThrottlingRate: 4,
    networkConditions: 'Slow 4G',
    viewport: '1280x720x1',
  },
});

const GITIGNORE_CONTENT = `# browsergnome — generated run artifacts (not committed with the app)
report.html
run-state.json
`;

function bootstrap(axes) {
  const dir = path.join(repo, '.bgn');
  fs.mkdirSync(path.join(dir, 'ledger'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'archive'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'what-if'), { recursive: true });

  const mem = path.join(dir, 'perf-memory.md');
  if (!fs.existsSync(mem)) fs.writeFileSync(mem, PERF_MEMORY_HEADER(path.basename(repo)));

  const cfg = path.join(dir, 'config.json');
  if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, JSON.stringify(DEFAULT_CONFIG(axes), null, 2) + '\n');

  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, GITIGNORE_CONTENT);

  console.log(`  bootstrapped ${path.relative(repo, dir) || '.bgn'}/ (perf-memory.md, config.json, ledger/, archive/, audit/, what-if/)`);
  console.log(`  .bgn/.gitignore created — report.html and run-state.json are gitignored`);
}

// ── Self-test (CI contract — short-circuits before main() I/O) ────────────────

function selfTest() {
  let pass = 0, fail = 0;
  const check = (name, got, want) => {
    const eq = JSON.stringify(got) === JSON.stringify(want);
    console.log(`  ${eq ? 'PASS' : 'FAIL'}  ${name}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
    eq ? pass++ : fail++;
  };

  // parseGitState — four states
  check('no-repo → state', parseGitState({ insideWorkTree: false }).state, 'no-repo');
  check('no-commits → state', parseGitState({ insideWorkTree: true, headSha: null }).state, 'no-commits');
  check('detached → state', parseGitState({ insideWorkTree: true, headSha: 'a', symbolicRef: null }).state, 'detached');
  {
    const r = parseGitState({ insideWorkTree: true, headSha: 'a', symbolicRef: 'refs/heads/main', porcelain: ' M a.js\n?? b.js' });
    check('usable → branch', r.branch, 'main');
    check('usable → dirty length', r.dirty.length, 2);
  }

  // detectFramework
  {
    check('next.config + app/ → next-app-router', detectFramework({ hasNextConfig: true, hasAppDir: true }).framework, 'next-app-router');
    check('next.config + pages/ → next-pages', detectFramework({ hasNextConfig: true, hasAppDir: false, hasPagesDir: true }).framework, 'next-pages');
    check('remix.config → remix', detectFramework({ hasRemixConfig: true }).framework, 'remix');
    check('@tanstack/start dep → tanstack-start', detectFramework({ hasTanstackStartDep: true }).framework, 'tanstack-start');
    check('@tanstack/react-start (the actively-maintained package name) also detected',
      detectFramework({ hasTanstackStartDep: /@tanstack\/(react-|solid-)?start/.test('@tanstack/react-start') }).framework, 'tanstack-start');
    check('vite.config → vite-spa', detectFramework({ hasViteConfig: true }).framework, 'vite-spa');
    check('nothing → unknown', detectFramework({}).framework, 'unknown');
  }

  // detectBundler
  {
    check('rspack.config wins over next → rspack', detectBundler({ framework: 'next-app-router', hasRspackConfig: true }).bundler, 'rspack');
    check('next.config turbo key (13-15.x shape) → turbopack', detectBundler({ framework: 'next-app-router', nextConfigText: 'module.exports = { experimental: { turbo: {} } }' }).bundler, 'turbopack');
    check('next.config turbopack key (16+ shape) → turbopack', detectBundler({ framework: 'next-app-router', nextConfigText: 'module.exports = { turbopack: {} }' }).bundler, 'turbopack');
    check('next default (no turbo/turbopack key) → webpack', detectBundler({ framework: 'next-app-router', nextConfigText: 'module.exports = {}' }).bundler, 'webpack');
    check('vite-spa framework → vite', detectBundler({ framework: 'vite-spa' }).bundler, 'vite');
    check('esbuild metafile → esbuild', detectBundler({ framework: 'unknown', hasEsbuildMetafile: true }).bundler, 'esbuild');
    check('nothing → unknown', detectBundler({ framework: 'unknown' }).bundler, 'unknown');
  }

  // detectHost
  {
    check('vercel.json → vercel', detectHost({ hasVercelJson: true }).host, 'vercel');
    check('.vercel/ dir → vercel', detectHost({ hasVercelDir: true }).host, 'vercel');
    check('wrangler.toml → cloudflare', detectHost({ hasWranglerToml: true }).host, 'cloudflare');
    check('Dockerfile → node', detectHost({ hasDockerfile: true }).host, 'node');
    check('nothing → unknown', detectHost({}).host, 'unknown');
  }

  // checkVersionPin
  {
    const r1 = checkVersionPin('{"mcpServers":{"chrome-devtools":{"args":["chrome-devtools-mcp@1.6.0"]}}}', '**Pinned: `chrome-devtools-mcp@1.6.0`.**');
    check('matching pins agree', r1.agree, true);
    const r2 = checkVersionPin('{"mcpServers":{"chrome-devtools":{"args":["chrome-devtools-mcp@1.7.0"]}}}', '**Pinned: `chrome-devtools-mcp@1.6.0`.**');
    check('drifted pins disagree', r2.agree, false);
    check('drifted pins → both values reported', [r2.mcpPin, r2.docsPin], ['1.7.0', '1.6.0']);
    check('missing file → no agreement, no crash', checkVersionPin(null, null).agree, false);
  }

  // parseUrlProbe
  {
    check('200 → reachable', parseUrlProbe('200').reachable, true);
    check('404 → reachable (server responded)', parseUrlProbe('404').reachable, true);
    check('500 → not reachable', parseUrlProbe('500').reachable, false);
    check('empty → not reachable', parseUrlProbe('').reachable, false);
    check('null → not reachable', parseUrlProbe(null).reachable, false);
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// ── Main ──────────────────────────────────────────────────────────────────────

function gatherAxes() {
  const nextConfigPath = ['next.config.js', 'next.config.mjs', 'next.config.ts'].map(f => path.join(repo, f)).find(exists);
  const nextConfigText = nextConfigPath ? read(nextConfigPath) : '';
  const framework = detectFramework({
    hasNextConfig: !!nextConfigPath,
    hasAppDir: exists(path.join(repo, 'app')) || exists(path.join(repo, 'src', 'app')),
    hasPagesDir: exists(path.join(repo, 'pages')) || exists(path.join(repo, 'src', 'pages')),
    hasRemixConfig: exists(path.join(repo, 'remix.config.js')),
    // `@tanstack/start` (the original unscoped name) is now stale — the project split into
    // `@tanstack/react-start` / `@tanstack/solid-start`, neither of which the bare
    // `@tanstack/start` substring match would catch. See `frameworks/tanstack-start.md`.
    hasTanstackStartDep: /@tanstack\/(react-|solid-)?start/.test(read(path.join(repo, 'package.json')) || ''),
    hasViteConfig: ['vite.config.js', 'vite.config.ts'].some(f => exists(path.join(repo, f))),
  });
  const bundler = detectBundler({
    framework: framework.framework,
    nextConfigText,
    hasWebpackConfig: ['webpack.config.js', 'webpack.config.ts'].some(f => exists(path.join(repo, f))),
    hasRspackConfig: exists(path.join(repo, 'rspack.config.js')),
    hasViteConfig: ['vite.config.js', 'vite.config.ts'].some(f => exists(path.join(repo, f))),
    hasEsbuildMetafile: exists(path.join(repo, 'meta.json')),
  });
  const host = detectHost({
    hasVercelJson: exists(path.join(repo, 'vercel.json')),
    hasVercelDir: exists(path.join(repo, '.vercel')),
    hasWranglerToml: exists(path.join(repo, 'wrangler.toml')),
    hasHeadersFile: exists(path.join(repo, '_headers')),
    hasDockerfile: exists(path.join(repo, 'Dockerfile')),
    hasServerJs: exists(path.join(repo, 'server.js')),
  });
  return { framework: framework.framework, bundler: bundler.bundler, host: host.host, sources: { framework: framework.source, bundler: bundler.source, host: host.source } };
}

function main() {
  if (process.argv.includes('--self-test')) return selfTest();

  console.log(`\nbrowsergnome doctor — ${repo}\n`);

  const node = process.versions.node;
  console.log(`  ${ok(parseInt(node, 10) >= 18)} node ${node} (>=18 required)`);

  // ── chrome-devtools-mcp pin consistency ─────────────────────────────────
  const mcpJsonPath = process.env.CLAUDE_PLUGIN_ROOT
    ? path.join(process.env.CLAUDE_PLUGIN_ROOT, '.mcp.json')
    : path.join(path.dirname(new URL(import.meta.url).pathname), '../../../.mcp.json');
  const toolsMdPath = process.env.CLAUDE_PLUGIN_ROOT
    ? path.join(process.env.CLAUDE_PLUGIN_ROOT, 'skills/browsergnome/references/tools.md')
    : path.join(path.dirname(new URL(import.meta.url).pathname), '../references/tools.md');
  const pin = checkVersionPin(read(mcpJsonPath), read(toolsMdPath));
  if (pin.mcpPin == null) {
    console.log(`  ${warn} could not find a pinned chrome-devtools-mcp version in .mcp.json`);
  } else if (pin.docsPin == null) {
    console.log(`  ${warn} references/tools.md has no parseable "Pinned: \`chrome-devtools-mcp@X.Y.Z\`" line —`);
    console.log(`        can't confirm it agrees with .mcp.json's @${pin.mcpPin}. Fix the line's format, not the version.`);
  } else if (pin.agree) {
    console.log(`  ${ok(true)} chrome-devtools-mcp@${pin.mcpPin} — .mcp.json and references/tools.md agree`);
  } else {
    console.log(`  ${ok(false)} chrome-devtools-mcp pin drift: .mcp.json has @${pin.mcpPin}, references/tools.md documents @${pin.docsPin}`);
    console.log(`        Re-verify the live tool surface against the new version and update tools.md (see its header for how).`);
  }
  console.log(`  ${warn} live tool-surface drift (added/removed/renamed tools) can't be checked from this script —`);
  console.log(`        it needs a live MCP call. If a tool call returns an unexpected shape mid-run, that's the signal;`);
  console.log(`        re-verify against references/tools.md rather than assuming the pin still holds.`);

  // ── Git state ─────────────────────────────────────────────────────────────
  const gitInsideWorkTree = sh('git rev-parse --is-inside-work-tree') === 'true';
  const gitHeadSha = gitInsideWorkTree ? sh('git rev-parse HEAD') : null;
  const gitSymbolicRef = (gitInsideWorkTree && gitHeadSha) ? sh('git symbolic-ref HEAD') : null;
  const gitPorcelain = (gitInsideWorkTree && gitHeadSha) ? (sh('git status --porcelain') || '') : '';
  const gitState = parseGitState({ insideWorkTree: gitInsideWorkTree, headSha: gitHeadSha, symbolicRef: gitSymbolicRef, porcelain: gitPorcelain });

  console.log('');
  if (gitState.state === 'no-repo') {
    console.log(`  ${ok(false)} git: not inside a git repo`);
    console.log(`        browsergnome uses git as memory. Run: git init && git add -A && git commit -m 'init'`);
  } else if (gitState.state === 'no-commits') {
    console.log(`  ${ok(false)} git: no commits yet — run: git commit --allow-empty -m init`);
  } else if (gitState.state === 'detached') {
    console.log(`  ${ok(false)} git: detached HEAD — checkout a branch first: git switch -c perf/browsergnome`);
  } else {
    const branchStr = gitState.branch ? ` on ${gitState.branch}` : '';
    if (gitState.dirty.length === 0) {
      console.log(`  ${ok(true)} git tree clean${branchStr}`);
    } else {
      console.log(`  ${warn} ${gitState.dirty.length} pre-existing change(s)${branchStr} — browsergnome will leave these untouched:`);
      for (const f of gitState.dirty) console.log(`      ${f}`);
    }
  }

  // ── Stack detection (three independent axes) ─────────────────────────────
  const axes = gatherAxes();
  console.log(`\n  Stack:`);
  console.log(`  ${ok(axes.framework !== 'unknown')} framework: ${axes.framework} (${axes.sources.framework})`);
  console.log(`  ${ok(axes.bundler !== 'unknown')} bundler: ${axes.bundler} (${axes.sources.bundler})`);
  console.log(`  ${ok(axes.host !== 'unknown')} host: ${axes.host} (${axes.sources.host})`);
  if (axes.framework === 'unknown' || axes.bundler === 'unknown' || axes.host === 'unknown') {
    console.log(`  ${warn} unknown axes fall back to the generic knowledge base — still fully functional.`);
  }

  // ── Target URL reachability ───────────────────────────────────────────────
  if (targetUrl) {
    // execFileSync, not sh()'s shell string — targetUrl is user/config-supplied and must not be
    // shell-interpolated (a URL containing shell metacharacters would otherwise break out of the quotes).
    let status = null;
    try {
      status = execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '5', targetUrl], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {}
    const probe = parseUrlProbe(status);
    console.log(`\n  ${ok(probe.reachable)} ${targetUrl} — ${probe.status ? `HTTP ${probe.status}` : 'not reachable'}`);
  } else {
    console.log(`\n  ${warn} no --url given — pass the target repo's dev/preview URL to verify reachability`);
  }

  // ── .bgn/ workspace ────────────────────────────────────────────────────────
  const bgnExists = fs.existsSync(path.join(repo, '.bgn'));
  console.log('');
  if (bgnExists) {
    console.log(`  ${ok(true)} .bgn/ workspace present`);
    const cfgPath = path.join(repo, '.bgn', 'config.json');
    if (!fs.existsSync(cfgPath)) {
      fs.writeFileSync(cfgPath, JSON.stringify(DEFAULT_CONFIG(axes), null, 2) + '\n');
      console.log(`  ${ok(true)} .bgn/config.json created with defaults`);
    } else {
      console.log(`  ${ok(true)} .bgn/config.json present`);
    }
  } else if (doInit) {
    bootstrap(axes);
  } else {
    console.log(`  ${warn} .bgn/ not found — run: node doctor.mjs --init  (creates perf-memory.md, config.json, ledger/, archive/, audit/, what-if/)`);
  }
}

main();
