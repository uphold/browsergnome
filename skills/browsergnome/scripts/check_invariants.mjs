#!/usr/bin/env node
/**
 * check_invariants.mjs — gates CLAUDE.md's "Cross-file invariants" section.
 *
 * Those invariants have no single source of truth by design (a version pin
 * duplicated into human-readable docs, a config key mirrored into a schema
 * table) — an edit to one side silently breaks the other. This turns the
 * *mechanically* checkable ones into a CI failure instead of tribal
 * knowledge. Run from this repo's root only (unlike doctor.mjs, which runs
 * from a target repo).
 *
 * Deliberately NOT covered here — see CONTRIBUTING.md:
 *   - "one confident, unhedged voice" across product docs — editorial, not
 *     mechanical.
 *   - `Guidance:` ids resolve against the external modern-web-guidance
 *     catalog, which isn't installed in CI — a check here would be theatre.
 *
 * Usage:
 *   node check_invariants.mjs       # run the real checks against this repo, exit 0/1
 *   node check_invariants.mjs --self-test
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { checkVersionPin, checkProviderPin, checkThirdPartyFlag } from './doctor.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => fs.readFileSync(p, 'utf8');

// ── Pure checks (inputs are strings/arrays — no I/O) ────────────────────────

/**
 * Stack-catalog filenames (references/frameworks|bundlers|hosts/*.md) must
 * match doctor.mjs's detectFramework/detectBundler/detectHost return strings
 * verbatim, in both directions.
 * @param {string[]} catalogNames - basenames without extension
 * @param {string[]} detectorValues - non-"unknown" return values from the source
 * @returns {{ok:boolean, missingCatalog:string[], orphanCatalog:string[]}}
 */
export function checkCatalogNames(catalogNames, detectorValues) {
  const catalogSet = new Set(catalogNames);
  const detectorSet = new Set(detectorValues);
  const missingCatalog = detectorValues.filter((v) => !catalogSet.has(v));
  const orphanCatalog = catalogNames.filter((n) => !detectorSet.has(n));
  return { ok: missingCatalog.length === 0 && orphanCatalog.length === 0, missingCatalog, orphanCatalog };
}

/**
 * Mirrored config keys (depPulse / depPulseAutoApply / pageTools) must exist in both SKILL.md's
 * config schema table and doctor.mjs's DEFAULT_CONFIG.
 * @param {string} skillMdText
 * @param {string} doctorMjsText
 * @param {string[]} [keys]
 * @returns {{ok:boolean, missingFromSkillMd:string[], missingFromDoctor:string[]}}
 */
export const MIRRORED_CONFIG_KEYS = ['depPulse', 'depPulseAutoApply', 'pageTools'];
export function checkConfigKeys(skillMdText, doctorMjsText, keys = MIRRORED_CONFIG_KEYS) {
  const missingFromSkillMd = keys.filter((k) => !new RegExp('`' + k + '`').test(skillMdText));
  const missingFromDoctor = keys.filter((k) => !new RegExp('\\b' + k + '\\s*:').test(doctorMjsText));
  return { ok: missingFromSkillMd.length === 0 && missingFromDoctor.length === 0, missingFromSkillMd, missingFromDoctor };
}

/**
 * pages.yml's EXCALIDRAW_SHA must match the short SHA in perf-map.md's
 * calibration note — bumping one without re-verifying the hotspot count
 * against the other is exactly the drift this guards.
 * @param {string} pagesYmlText
 * @param {string} perfMapMdText
 * @returns {{ok:boolean, workflowSha:string|null, docsSha:string|null}}
 */
export function checkPerfMapCalibration(pagesYmlText, perfMapMdText) {
  const workflowMatch = pagesYmlText.match(/EXCALIDRAW_SHA:\s*([0-9a-f]+)/);
  const docsMatch = perfMapMdText.match(/`([0-9a-f]{8,})`,\s*527 modules/);
  const workflowSha = workflowMatch ? workflowMatch[1] : null;
  const docsSha = docsMatch ? docsMatch[1] : null;
  return { ok: workflowSha != null && docsSha != null && workflowSha.startsWith(docsSha), workflowSha, docsSha };
}

// ── Self-test ────────────────────────────────────────────────────────────

function selfTest() {
  let pass = 0, fail = 0;
  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
    ok ? pass++ : fail++;
  };

  check('checkCatalogNames: agreement', checkCatalogNames(['vite', 'webpack'], ['vite', 'webpack']).ok, true);
  check('checkCatalogNames: catches an orphan catalog file', checkCatalogNames(['vite', 'rollup'], ['vite']).orphanCatalog, ['rollup']);
  check('checkCatalogNames: catches a missing catalog file', checkCatalogNames(['vite'], ['vite', 'rspack']).missingCatalog, ['rspack']);

  const dp = ['depPulse', 'depPulseAutoApply'];
  check('checkConfigKeys: both present', checkConfigKeys('| `depPulse` |\n| `depPulseAutoApply` |', 'depPulse: true,\ndepPulseAutoApply: true,', dp).ok, true);
  check('checkConfigKeys: catches SKILL.md drift', checkConfigKeys('| `depPulse` |', 'depPulse: true,\ndepPulseAutoApply: true,', dp).missingFromSkillMd, ['depPulseAutoApply']);
  check('checkConfigKeys: catches doctor.mjs drift', checkConfigKeys('| `depPulse` |\n| `depPulseAutoApply` |', 'depPulse: true,', dp).missingFromDoctor, ['depPulseAutoApply']);
  check('checkConfigKeys: default key list covers pageTools', checkConfigKeys('| `depPulse` | `depPulseAutoApply` |', 'depPulse: 1,\ndepPulseAutoApply: 1,').missingFromSkillMd, ['pageTools']);

  check('checkPerfMapCalibration: agreement (short SHA is a prefix)', checkPerfMapCalibration('EXCALIDRAW_SHA: 4872083c044491b6d5c96ae134a75464f96d6831', '`4872083c`, 527 modules').ok, true);
  check('checkPerfMapCalibration: catches drift', checkPerfMapCalibration('EXCALIDRAW_SHA: deadbeef00000000000000000000000000000000', '`4872083c`, 527 modules').ok, false);

  check('checkVersionPin (re-exported from doctor.mjs): still agrees', checkVersionPin('{"mcpServers":{"chrome-devtools":{"args":["chrome-devtools-mcp@1.6.0"]}}}', '**Pinned: `chrome-devtools-mcp@1.6.0`.**').agree, true);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// ── Real run ─────────────────────────────────────────────────────────────

function main() {
  if (process.argv.includes('--self-test')) return selfTest();

  let pass = 0, fail = 0;
  const report = (name, ok, detail) => {
    console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    ok ? pass++ : fail++;
  };

  const doctorMjsText = read(path.join(repoRoot, 'skills/browsergnome/scripts/doctor.mjs'));

  // 1. chrome-devtools-mcp pin
  const mcpJsonText = read(path.join(repoRoot, '.mcp.json'));
  const toolsMdText = read(path.join(repoRoot, 'skills/browsergnome/references/tools.md'));
  const pin = checkVersionPin(mcpJsonText, toolsMdText);
  report('chrome-devtools-mcp pin (.mcp.json <-> references/tools.md)', pin.agree,
    pin.agree ? `@${pin.mcpPin}` : `mcp=@${pin.mcpPin ?? '?'} docs=@${pin.docsPin ?? '?'}`);

  // 1b. Page Tools: react-devtools-cdt-mcp pin + third-party category flag
  const pkgJsonText = read(path.join(repoRoot, 'package.json'));
  const providerPin = checkProviderPin(pkgJsonText, toolsMdText);
  report('react-devtools-cdt-mcp pin (package.json <-> references/tools.md)', providerPin.agree,
    providerPin.agree ? `@${providerPin.pkgPin}` : `package=@${providerPin.pkgPin ?? '?'} docs=@${providerPin.docsPin ?? '?'}`);
  report('chrome-devtools-mcp --categoryExperimentalThirdParty (.mcp.json)', checkThirdPartyFlag(mcpJsonText));

  // 2. Stack-catalog filenames vs detector return strings
  const axisField = { frameworks: 'framework', bundlers: 'bundler', hosts: 'host' };
  const detectorNames = { frameworks: 'detectFramework', bundlers: 'detectBundler', hosts: 'detectHost' };
  for (const [axis, field] of Object.entries(axisField)) {
    const catalogDir = path.join(repoRoot, 'skills/browsergnome/references', axis);
    const catalogNames = fs.readdirSync(catalogDir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
    const fnMatch = doctorMjsText.match(new RegExp(`function ${detectorNames[axis]}\\([^)]*\\) \\{([\\s\\S]*?)\\n\\}`));
    const fnBody = fnMatch ? fnMatch[1] : '';
    // `field: 'value'` (direct) and `field: cond ? 'a' : 'b'` / `field = cond ? 'a' : 'b'`
    // (ternary) both appear across the three detectors — capture the RHS expression up to the
    // statement end, then pull every quoted literal out of it, so a new ternary branch is picked
    // up without this script's regex needing to change.
    const rhsExprs = [...fnBody.matchAll(new RegExp(`\\b${field}\\s*[:=]\\s*([^,;\\n]+)`, 'g'))].map((m) => m[1]);
    const detectorValues = rhsExprs.flatMap((expr) => [...expr.matchAll(/'([\w-]+)'/g)].map((m) => m[1])).filter((v) => v !== 'unknown');
    const result = checkCatalogNames(catalogNames, [...new Set(detectorValues)]);
    report(`${axis} catalog <-> ${detectorNames[axis]}()`, result.ok,
      result.ok ? undefined : `missing catalog file for [${result.missingCatalog}], orphan catalog file(s) [${result.orphanCatalog}]`);
  }

  // 3. Mirrored config keys
  const skillMdText = read(path.join(repoRoot, 'skills/browsergnome/SKILL.md'));
  const keys = checkConfigKeys(skillMdText, doctorMjsText);
  report(`${MIRRORED_CONFIG_KEYS.join('/')} (SKILL.md <-> doctor.mjs DEFAULT_CONFIG)`, keys.ok,
    keys.ok ? undefined : `missing from SKILL.md: [${keys.missingFromSkillMd}], missing from doctor.mjs: [${keys.missingFromDoctor}]`);

  // 4. Perf Map calibration SHA
  const pagesYmlText = read(path.join(repoRoot, '.github/workflows/pages.yml'));
  const perfMapMdText = read(path.join(repoRoot, 'skills/browsergnome/references/perf-map.md'));
  const calibration = checkPerfMapCalibration(pagesYmlText, perfMapMdText);
  report('Perf Map calibration SHA (pages.yml <-> perf-map.md)', calibration.ok,
    calibration.ok ? calibration.workflowSha.slice(0, 8) : `workflow=${calibration.workflowSha ?? '?'} docs=${calibration.docsSha ?? '?'}`);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
