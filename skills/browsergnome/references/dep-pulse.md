# Dep Pulse — ambient dependency-release perf research

**A read-only subagent dispatched on the side during Autoresearch and Senior Engineer Audit.** While
the main loop measures, Dep Pulse resolves the target's perf-critical dependencies against the
registry, reads the actual release notes for what's newer, and judges whether anything is genuinely
perf-relevant to *this* app's detected architecture — majors included. Findings surface at the end of
the run as a structured "what it brings / what could break" table; nothing is ever installed without
the user having chosen it from that table — a narrow, logged carve-out for benign patch bumps skips the
second confirm before install, never the first choice, and never the post-install checks that gate
KEEP (see "Consent gate" below).

`doctor.mjs` never reads a dependency version — it touches `package.json` exactly once, as a raw regex
for one string. Dep Pulse is the only place in browsergnome that resolves or reasons about versions,
and the only place that talks to the network or dispatches a subagent.

---

## Invariants (must not be violated)

The pulse runs concurrently with a measurement loop — anything it mutates invalidates the numbers the
whole product exists to defend.

1. **No install, ever.** No `npm install`, no `npm ci`, no lockfile write. Registry *reads* only
   (`npm outdated --json`, `npm view <pkg> versions --json`) plus WebFetch of changelogs.
2. **No build, no test run, no `git checkout -b`, no branch, no commit.** All four would poison a
   concurrent baseline/candidate arm.
3. **Read-only on `package.json` and the lockfile.**
4. **No writes to `.bgn/ledger/*`** — the main loop owns those mid-run. The pulse writes exactly one
   file: `.bgn/dep-pulse.json`.
5. **Never blocks and never fails the parent run** — with one bounded exception: `interaction`'s
   post-capture dispatch, which the parent awaits up to 90s (see CPU contention below) since no
   measured window is open by then. Every other dispatch point is pure fire-and-forget. No network,
   registry error, rate limit, or empty result degrades to "no findings" — silently, with one line in
   the final report. The main loop must not be able to tell the difference.

**CPU contention.** The pulse's own load (`npm outdated`, changelog fetches, inference) runs on the
same host as the measurement loop, and any of it landing on one arm's iterations but not another's is
a systematic bias the gate's pooled-stddev math has no way to detect — a between-arm confound, not
ordinary noise `stats.mjs` already accounts for. `measurement.md`'s noise table shows `first-load`
clearing its floor with real but not enormous slack, and `interaction`'s INP band is tighter still
(`SKILL.md`'s `interaction` section) — tight enough that deliberately adding host load during a
measured window is the one thing a reviewer could legitimately call methodologically unsound. Two
dispatch points, picked to keep the pulse's load away from any single measured window rather than
inside one:

- **`first-load`, `bundle-size`, `layout-shift`, Senior Engineer Audit:** dispatch during Preflight,
  before any capture opens. `npm outdated` plus changelog fetches plus inference routinely outlasts
  Preflight, so overlap with iteration 1 is the normal case. This is accepted, not because the noise
  band has comfortable headroom against pulse-induced load (it wasn't measured against that question),
  but because `bundle-size` opens no browser at all and `first-load`/`layout-shift` are the two presets
  where an occasional false-negative KEEP from added noise is the safer failure mode than blocking the
  whole run on the pulse finishing first.
- **`interaction` only:** dispatch after the final capture completes, before the run report — never
  during a measured INP window. Unlike the Preflight dispatch points, this is the one case the parent
  **does** await, bounded to 90s: no measured capture is open anymore, so blocking briefly here is
  safe, and it's the only way step 9 has something to collect before the report renders (a pure
  fire-and-forget dispatch this late would routinely still be running when the report is written).
  Past the 90s bound, stop waiting and record `depPulse: off` — never delay the report indefinitely for
  a background subagent.

Every Ledger entry records `depPulse: dispatched | deferred | cached | off` (see "Presenting findings"
below for what each value means) so a suspicious run can be re-checked with `depPulse: false`.

---

## The spine — reuse, don't author a second list

The checked set is derived, never hardcoded here:

- `.bgn/config.json`'s `framework` / `bundler` / `host` axes (written by Doctor) → the framework and
  bundler packages themselves.
- `react`, `react-dom`, and the detected router.
- **`perf_scan.mjs`'s `CONFIG.heavyLibs` set** (`scripts/perf_scan.mjs:108-111`), **read from the
  script at runtime**. Do not copy the list into this file — that would create a second source of
  truth that silently drifts.

Intersect that spine with the target's actual `dependencies` + `devDependencies`. Everything else is
out of scope: a test-runner bump has no web-vital consequence and would drown the report.

---

## Protocol

### Step 1 — Cache check

Read `.bgn/dep-pulse.json`. If `checkedAt` is under 24 h old, re-run just the cheap local half of Step
2 (`npm outdated --json`'s `current` field per spine package — a read, same as Step 2 proper, no
install) and compare each package's `current` against the `installed` value stored in
`.bgn/dep-pulse.json` from that prior run. Unchanged across the whole spine → reuse the cached
`findings` and skip the changelog fetches (Step 3) and everything after. Any package's `current`
differs → don't trust the cache for that package's findings, re-run Steps 2–6 in full instead of
patching just the changed entries. 24 h is fixed in this protocol, not a config knob — one knob
(`depPulse`) is enough.

### Step 2 — Resolve

`npm outdated --json` in the target repo (read-only; does not modify `node_modules`). Fall back to
`npm view <pkg> versions --json` per spine package if that fails.

### Step 3 — Read the notes

For each package with something newer, WebFetch its GitHub releases / `CHANGELOG.md` across the
version span. Judge perf relevance against this target's detected architecture — a chunking
improvement is irrelevant to a target whose bundler axis doesn't match; an RSC-related change is
irrelevant to a `vite-spa`.

### Step 4 — Signal-vs-noise

Reuse `senior-audit.md`'s signal-vs-noise discipline verbatim: emit few, high-confidence findings. ≤8
total, 3–5 ideal. A finding needs a specific release, a specific perf claim quoted from the notes, and
a stated reason it applies to this stack. "Performance improvements" with no detail is not a finding.

### Step 5 — Suppress what's already known

Skip anything already in `.bgn/perf-memory.md` (proven, disproved, or a declined hypothesis) or listed
as a dead end in `.bgn/playbook.md`. Declined bumps re-surfacing every run is the fastest way to make
this feature annoying — reuse the existing stores, don't add a new "dismissed" file.

### Step 6 — Write and return

Write `.bgn/dep-pulse.json`: `{checkedAt, resolved: {pkg: {installed, latest}}, findings: [...]}`.
Return. Do nothing else.

---

## Honesty tier

Every pulse finding enters as an **ungated hypothesis carrying its changelog citation**. Per
`CLAUDE.md`'s knowledge-base status tiers, a real measured before/after is required to upgrade a tier,
and a citation is not a measurement. The report's wording must never present a changelog claim as a
fact — "the 15.3 release notes claim X" is correct; "15.3 makes your app faster" is not. A finding
becomes `- [x]` in `.bgn/perf-memory.md` only after the gate confirms it.

---

## Presenting findings (end of run)

Print a plain-text one-line-per-finding summary in chat first (same as `senior-audit.md`'s chat-first
report step — the report file is not the user's only view), then an **AskUserQuestion** menu. Same
constraints as the audit's menu: max 4 options, "Skip all" always present, so ≤3 finding slots with a
bundled remainder if there are more.

Use AskUserQuestion's single-select `preview` field for the structured table — it renders monospace
markdown:

```
next  14.2.5 → 15.5.0   MAJOR

WHAT IT BRINGS (from the 15.x release notes)
| Change                          | Relevant here because        | Gate preset |
|---------------------------------|------------------------------|-------------|
| Turbopack prod builds stable    | bundler axis = turbopack     | bundle-size |
| Improved client-router caching  | app-router, 12 routes        | first-load  |

WHAT COULD BREAK
| Breaking change                 | Blast radius in this repo    |
|---------------------------------|------------------------------|
| async request APIs              | 7 files read cookies()/headers() |
| caching defaults flipped        | 3 fetch() call sites rely on default cache |

MIGRATION: codemod required (npx @next/codemod@canary upgrade latest)
VERIFY: npm run build && npm test
```

Majors are **recommended, never auto-applied** — the warning and the confirm are the point. Minors
show the same table; only the `MAJOR` banner and the migration row differ.

**The `depPulse` Ledger value** — pick one, in this priority order:

- `off` — `.bgn/config.json`'s `depPulse` is `false`, **or** the harness can't dispatch a subagent at
  all, **or** (for `interaction`) the bounded await below timed out with nothing to show.
- `cached` — Step 1's cache hit; no network call made this run.
- `deferred` — `interaction`'s dispatch point (after the final capture, before the report); the pulse
  ran and returned (findings possibly empty — Invariant 5 makes a genuine empty result and a silently
  swallowed error indistinguishable by design, so both record normally here, not as `off`).
- `dispatched` — the Preflight dispatch point (`first-load`/`bundle-size`/`layout-shift`/audit); same
  empty-vs-error indistinguishability as `deferred`.

---

## Consent gate — applies to every bump, major and minor

**No install proceeds without either an explicit confirm, or all three pre-install carve-out
conditions below holding.** A dependency change pulls in third-party code the user did not choose — a
different class of act than the internal, behaviour-preserving fixes the rest of the loop applies.
Picking a finding from the menu selects it for *investigation*; a second, explicit confirm is required
before install unless the carve-out applies. The confirm (when shown) displays the same table as the
menu preview, plus the exact command that will run.

**The one carve-out — benign patch bumps.** Skip the second confirm and proceed straight to install
only when all three of these hold — each is checkable from the registry/changelog alone, **before**
anything is installed:

1. The bump is semver **patch** within the same minor (`1.4.2 → 1.4.7`). Any minor or major → confirm.
2. The package is **not** the framework, the bundler, `react`, `react-dom`, or the router. Spine roots
   always confirm regardless of semver distance.
3. The release notes list **zero** breaking changes across the version span. Absent or unreadable notes
   count as "not zero" → confirm.

Any one condition false, or any doubt about one, → confirm before installing.

**Two more conditions gate KEEP, not the install.** Whether or not the carve-out above skipped the
confirm, the install still isn't unsupervised: after applying the bump (see "Acting on a chosen
finding" below), before a KEEP is allowed —

4. The lockfile diff must touch **only that package** — no transitive version cascade.
5. The target's build **and** test command must both pass on the bumped tree.

These two can only be checked post-install, so they're not preconditions for installing — they're the
gate on whether the run is allowed to silently KEEP. If either fails, the bump doesn't get a silent
KEEP even if it entered via the carve-out: fall back to the same explicit-confirm-before-KEEP path as a
build/test failure (see step 2 below), never a silent commit on an unexpectedly wide diff.

Auto-proceeded bumps (carve-out conditions 1–3 met) are still listed individually in the run report,
still gated through `stats.mjs`, and still reverted on REVERT — "no confirm" means no interruption
before install, never no visibility and never a skip of conditions 4–5's post-install check.

`.bgn/config.json`'s `depPulseAutoApply` (default `true`) disables the carve-out entirely when set
`false`: every bump then requires the confirm before install, no exceptions. Conditions 4–5 still gate
KEEP regardless of `depPulseAutoApply`.

---

## Acting on a chosen finding

Two paths, decided by what the upgrade actually touches:

**`package.json` + lockfile only, no source edits → goes through the gate:**

0. Consent gate above — confirm unless the benign-patch carve-out (conditions 1–3) fully applies.
1. Snapshot `package.json` + lockfile. Apply the bump, install.
2. Check consent-gate condition 4 (lockfile diff touches only this package). Fails → no silent KEEP,
   even if the carve-out skipped step 0: require an explicit user confirmation before any KEEP.
   Then run the target's own build + test command (condition 5). Non-zero exit → auto-REVERT,
   recorded as "bump broke the build" — **the gate never runs**. No test command → say so plainly,
   require an explicit user confirmation before any KEEP.
3. Measure through whichever preset the claimed win maps to, then `stats.mjs`'s `gate()` — unchanged
   math. `measurement.md`'s rebuild-fallback list already forces sequential (`AAAA`→`BBBB`) when
   `package.json` is touched.
   - `first-load` / `interaction` claims (LCP, INP) always have a real gate on any stack.
   - **Byte claims are gate-honest**, per `senior-audit.md`'s "Gate mapping is honest, not invented"
     invariant. `bundle_stats.mjs` parses webpack and esbuild only — on Vite/Turbopack, `bundle-size`
     isn't usable (`SKILL.md`'s `bundle-size` section). On a webpack/esbuild target, measure through
     `bundle-size` normally. On Vite/Turbopack, don't force-fit it: offer `first-load` instead if the
     claimed byte win is large enough to plausibly move LCP; otherwise mark the finding **advisory**,
     mirroring `senior-audit.md`'s advisory branch verbatim — apply, tell the user "no gate can confirm
     this automatically, please verify manually," write `- [ ] (hypothesis, ungated — applied)` to
     `.bgn/perf-memory.md`, upgrade to `- [x]` only on the user's explicit confirmation. Bundler/chunking
     improvements are the headline pulse scenario and a large share of targets run Vite — this is not an
     edge case to skip.
4. KEEP → commit `package.json` + lockfile only (`git add <touched paths>`, never `git add -A`).
   REVERT → see below.

**Requires codemods or manual source migration** (most framework/bundler majors) **→ report only,
stop.** State the migration command and effort plainly and hand it to the user; they perform the
migration, then run Autoresearch on the result. This mirrors `what-if.md`'s refusal rule for
framework/bundler migrations ("no single-file snapshot-and-restore for 'the whole app now imports
differently'") — a major bump that needs codemods *is* that.

---

## Revert is a new mechanism

`what-if.md` names "no second revert mechanism to maintain" as a design value, so this must be named
rather than folded into "restore from snapshot": reverting a bump is **restore `package.json` +
lockfile from snapshot, then reinstall** (`npm ci`). File restore alone leaves `node_modules` at the
bumped version and every subsequent measurement is wrong. Verify after: the lockfile's resolved version
for the bumped package must match the snapshot.

---

## Unattended / CI

If the session cannot present an AskUserQuestion confirm (headless, CI), the pulse writes its findings
to the report and stops — it never applies anything, including benign patch bumps. No consent gate
available means no dependency change, full stop.

If the harness cannot dispatch a subagent at all, skip the pulse entirely and record `depPulse: off`.
Never inline it into the main loop as a fallback — that would block a measured run and add its latency
to the very numbers the gate reads.

---

## Dispatching the subagent

It starts cold, so the dispatch must hand it, explicitly: the target repo's absolute path,
`$CLAUDE_PLUGIN_ROOT` (without it, it cannot read `perf_scan.mjs`'s `CONFIG.heavyLibs` — the whole
spine derivation), the detected `framework`/`bundler`/`host` axes from `.bgn/config.json`, this file's
Invariants section, and its Protocol section (Steps 1–6) — the subagent has no other context, so the
six-step sequence has to be handed over explicitly, not assumed known. Dispatch is fire-and-forget for
the Preflight dispatch points; the parent never awaits it there. The one exception is `interaction`'s
deferred dispatch, which the parent does await, bounded to 90s — see the CPU-contention section above.
