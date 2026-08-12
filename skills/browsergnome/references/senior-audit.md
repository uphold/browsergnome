# Senior Engineer Audit — Mode Protocol

**Menu item 5 of the browsergnome menu.** A holistic, standalone scan where browsergnome reasons
like a staff web performance engineer to find the architectural debt mechanical detectors miss.
Device-free scan — **no browser or `chrome-devtools-mcp` session needed for the scan itself**; fix
handoff reuses the existing measure→gate loop.

---

## Invariants (must not be violated)

- **Hypotheses, never verdicts.** Every finding is a ranked, unproven hypothesis until the gate
  runs. Nothing enters `.bgn/perf-memory.md` as a proven fact until the gate confirms it.
- **Signal-vs-noise.** Emit few, high-confidence findings. Each must have a concrete `file:line`,
  blast radius, and expected cost above the thresholds in `architectural-perf-catalog.md` (>16ms
  real render cost, or ≥50ms Long Task / INP risk; <1ms = do not report). Suppress leaf noise.
- **Root-cause, not surface area.** Rank by blast radius (fan-in × architectural role): root
  layout/wrapper > root provider > shared base components > leaf components. One root fix beats
  fifty leaf fixes.
- **It fixes — it doesn't just file.** The audit ends in a choose-and-fix flow (AskUserQuestion menu
  → measure→gate loop for provable findings). A dropped report alone is not enough.
- **No new mechanical extractors.** The brain reads source and reasons; it does not write new AST
  detectors — that's `perf_scan.mjs`'s job, done elsewhere.
- **Gate mapping is honest, not invented.** Web has four gate presets (`first-load`, `bundle-size`,
  `interaction`, `layout-shift` — see `references/presets.md`) and no render-count gate. A finding
  without a clean mapping to one of the four is **advisory** — say so plainly, don't force-fit it to a
  preset that doesn't actually measure it. See
  `architectural-perf-catalog.md`'s per-entry "Gate preset" field; most entries are advisory for
  exactly this reason.

---

## Protocol

### Step 1 — Grounding

- Read `references/architectural-perf-catalog.md` (the reasoning corpus).
- Read `.bgn/perf-memory.md` for known priors (skip already-proven gaps).
- Read `.bgn/playbook.md` if present (dead ends to avoid).
- Read the matching `frameworks/*.md` / `bundlers/*.md` / `hosts/*.md` entries for the target's
  detected stack (from `.bgn/config.json`, written by Doctor) — stack-specific levers and known
  dead ends inform which catalog entries are actually likely to apply.

---

### Step 2 — Substrate + Root-Cause Ranking

Produce or reuse `graph.json` (run `$BG scan <repo> --out graph.json` if absent or stale):

```bash
$BG scan <repo-root> --out graph.json
```

Parse `graph.json` for hub nodes (high centrality/fan-in) — the blast-radius candidates. The brain
layers architectural role on top of the static fan-in score.

**Identify structural roots by reading source:**

| Target | What to look for | Architectural role |
|---|---|---|
| Root layout (`app/layout.tsx`, root `_app.tsx`, a shared `<AppShell>`) | Providers, eager imports, global listeners | Root wrapper — every route below it |
| Root/shared providers | Context `value=` shape, update frequency | Root provider — all consumers |
| Route entry / root router config | Eager route imports, lazy boundaries | Root loading strategy — all routes |
| High-fan-in modules (from `graph.json`) | Shared base components, hooks, utilities | Shared base — blast radius = consumer count |

**Rank candidates by blast radius:**

```
blast_radius = fan_in × role_weight
role_weight: root_wrapper=10 · root_provider=7 · root_loading_strategy=8 · shared_base=fan_in · leaf=1
```

Read the top-ranked source files first. No more than 5–7 candidates per audit to stay signal-sharp.

---

### Step 3 — Reason

For each candidate (highest blast radius first):

1. Read the source file(s) completely.
2. Reason against each applicable entry in `architectural-perf-catalog.md`.
3. Cross-file data-flow: trace where state/data is declared vs consumed. Does a fetch happen higher
   in the tree than it needs to (forcing everything below it to wait)? Does a context value object
   change reference more often than its consumers need?

**Reasoning discipline:** do not flag something unless you can state a concrete `file:line`, a
plausible cost above the thresholds, and a specific catalog entry that describes the pattern.

---

### Step 4 — Signal-vs-Noise Gate

Before including a finding in the report:

- **Has a concrete code path** (`file:line` or `file:line-range`).
- **Has a blast radius** — how many routes/components/users are affected.
- **Expected cost > 16ms**, or is a Long Task (≥50ms) / INP risk, OR is a structural root-cause
  finding in a component with blast radius ≥ 5 (the scale factor compensates for lower individual
  cost).
- **Not already in `.bgn/perf-memory.md`** as a proven fix or a dead end.
- **Not a leaf component** unless the blast radius is unusually high.

If a finding fails these checks, suppress it. Aim for ≤8 findings total; 3–5 is ideal.

---

### Step 5 — Emit Ranked Hypotheses

Each finding in the report:

```markdown
## Finding N — <Short Title>                       [BLAST RADIUS: <n> routes/consumers]

**File:** `path/to/file.tsx:line`
**Catalog entry:** <number + title> (architectural-perf-catalog.md)
**Confidence:** High / Medium
**Expected cost:** <e.g. "ships an extra 40KB of client JS on every route below this layout">
**Gate preset:** `first-load` / `bundle-size` / `interaction` — gate command:
  `node "$BG/skills/browsergnome/scripts/stats.mjs" --baseline "..." --candidate "..." --min-effect <preset-floor> --direction lower --unit <ms|bytes>`
  *(or "Advisory — not auto-provable: <reason, per the catalog entry's honest gate mapping>")*

<2–3 sentence explanation of the architectural problem and why it costs the user.>
```

---

### Step 6 — Write Report + Present Menu

Write the full ranked hypothesis report to:
```
<repo>/.bgn/audit/<YYYY-MM-DDTHH-mm-ssZ>.md
```

`.bgn/audit/` is part of Doctor's `--init` bootstrap (created alongside `ledger/`/`archive/` —
`doctor.mjs`'s `bootstrap()`), so it already exists before this protocol ever runs on a
Doctor-initialized repo.

Before opening the menu, print a short plain-text summary in the chat itself (not just the file) —
one line per finding: title, how many routes/components it affects, expected cost. This is the
user's only view of the findings unless they open the report by hand.

Then present the findings as an **AskUserQuestion** multi-select menu. AskUserQuestion accepts at
most 4 options, and a "Skip all" option must always be present — so at most 3 slots are available
for findings. If ≤3 findings, list them individually. If more, list the top 2 by blast radius plus a
3rd bundled option ("Remaining findings — I'll review the full report"), then "Skip all". Follow up
with a second menu for the bundled remainder if selected.

> "I found N architectural findings ranked by blast radius. Which would you like me to investigate
> and fix now? (I'll apply the fix and prove it through the gate for provable ones; advisory
> findings are applied and flagged for your eyes-on review.)"

The user's selection drives Step 7. Skipped/unselected findings remain as
`- [ ] (hypothesis, ungated)` gaps in `.bgn/perf-memory.md`.

---

### Step 7 — Fix & Prove (the loop)

For each finding the user chose to act on:

**If the finding maps to a gate preset** (`first-load`, `bundle-size`, `interaction`):
1. Propose and apply the fix (one atomic change).
2. Enter the **existing measure→gate loop** (same as Autoresearch, see `SKILL.md`'s Autoresearch
   section for the exact drive sequence per preset): N-run baseline → apply fix → N-run candidate →
   `stats.mjs` gate decision.
   - **KEEP:** commit with measured delta; write a `- [x]` proven fact to `.bgn/perf-memory.md`.
   - **REVERT:** restore from pre-fix snapshot; write `- [ ] (hypothesis, disproved)`.

**If the finding is advisory-tier** (no auto-gate — most catalog entries, honestly, since web has no
render-count gate):
1. Apply the fix.
2. Surface it clearly: "Applied. This is an advisory finding — no gate can confirm it
   automatically. Please verify manually and confirm if it feels better."
3. Write `- [ ] (hypothesis, ungated — applied)` to `.bgn/perf-memory.md`.
4. Do NOT write it as `- [x]` until the user explicitly confirms improvement — then update to
   `- [x]`.

**`.bgn/perf-memory.md` status codes:**
- `- [x]` — gate-confirmed improvement (measured fact)
- `- [ ] (hypothesis, ungated)` — declined or not yet actioned
- `- [ ] (hypothesis, ungated — applied)` — advisory fix applied, awaiting user confirmation
- `- [ ] (hypothesis, disproved)` — gate ran, fix did not clear the noise band

---

## Example Blast-Radius Calculation

```
RootLayout      fan-in=all routes  role=root_wrapper           blast=N×10  → read first
AuthProvider     fan-in=38         role=root_provider           blast=38×7=266 → read second
ProductCard      fan-in=1          role=leaf                    blast=1×1=1    → skip unless obvious finding
```

Fixing the root layout outranks any leaf fix, even if a leaf's per-render cost measures higher in
isolation — the leaf's cost is paid once per instance, the root layout's is paid on every route.
