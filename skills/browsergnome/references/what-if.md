# `/what-if` — bounded experiments that always revert

`/what-if` answers a different question than Autoresearch. Autoresearch asks **"is this specific fix
real?"** and keeps it if the gate says yes. `/what-if` asks **"is this worth doing at all?"** and
**always reverts, regardless of the gate's answer** — it produces a number and a decision memo, never
a commit. It reuses Autoresearch's whole measure→apply→re-measure→gate machinery; the only new part
is the always-revert guarantee and the memo output.

| | Autoresearch | `/what-if` |
|---|---|---|
| Change | one atomic fix from the knowledge base | a bounded, reversible config/dependency/code toggle |
| Outcome | a commit (on KEEP) | a number and a memo — **always reverted, KEEP or REVERT** |
| Question | "is this fix real?" | "is this worth doing at all?" |

**Flagship scenario — the third-party script tax.** Comment out (or remove) one vendor `<script>`
tag or third-party SDK import, re-measure `first-load` through the gate, report *"your Segment tag
costs 340ms of LCP, n=5."* Every team argues about the third-party script budget; nobody has real
numbers. This is the scenario worth demoing first.

**Other buildable scenarios:** defer an analytics provider's initialization, turn on the React
Compiler (`bundle-size` and/or `interaction` — see `references/frameworks/*.md` for how a target's
framework detects/enables it), make a route static instead of dynamic, lazy-load a heavy dependency
that's currently eager, swap a heavy dependency for a lighter one (`moment` → `date-fns`).

**Must refuse: framework/bundler migrations** (Next → Vite, webpack → Rspack). Measuring a migration
means *performing* the migration first — that's a codemod product, not a bounded experiment, and
estimating a migration's cost without actually doing it is exactly the folklore the gate exists to
kill. Decline and say why: *"`/what-if` measures bounded, reversible changes — a framework migration
isn't reversible in the same sense (there's no single-file snapshot-and-restore for 'the whole app
now imports differently'), and estimating its cost without performing it would be a guess dressed up
as a measurement. If you want real migration numbers, that's a separate, much larger effort — not
something to fold into a `/what-if` run."*

## Protocol

Reuses Autoresearch's N-run measurement drive sequences (`references/presets.md`) and gate math
(`references/measurement.md`) unchanged — no new measurement primitive. What's different:

1. **Preflight.** Verify git state is `usable` (`parseGitState`). Run Doctor first if `.bgn/` isn't
   bootstrapped. Record `preExistingDirty` (paths dirty before this run starts) the same way
   Autoresearch does — never touched or reverted by `/what-if`.
2. **Scratch branch.** `git checkout -b bgn/what-if-<timestamp>` from the current branch. Record
   `baselineSha = git rev-parse HEAD`. This is extra insulation on top of the snapshot-restore
   below, not a substitute for it — the branch gets deleted at the end regardless of outcome (step
   7), so nothing about "being on a scratch branch" is itself the revert mechanism.
3. **Baseline measure.** N-run measurement of whichever preset the scenario maps to (`first-load`
   for most scenarios — script-tax, route-static, lazy-load; `bundle-size` for a dependency swap).
   Snapshot each file about to change, same as Autoresearch's pre-apply snapshot step.
4. **Apply the bounded change.** One atomic toggle — comment out a script tag, add a `dynamic`
   import wrapper, change one `export const dynamic`, swap one dependency. Never stack changes in
   one `/what-if` run; that would make the resulting number ambiguous about which change caused it.
5. **Candidate measure.** Identical N-run protocol.
6. **Gate.** `stats.mjs`, same math as Autoresearch. **The gate's verdict (KEEP/REVERT) becomes part
   of the memo's finding, not an action** — `/what-if` never keeps a change regardless of what the
   gate says.
7. **Always revert, then verify the guarantee — don't just assert it.**
   - Restore every touched file from its step-3 snapshot (identical mechanism to Autoresearch's
     REVERT path — no second revert mechanism to maintain).
   - `git checkout <original branch>`, then `git branch -D bgn/what-if-<timestamp>` — delete the
     scratch branch, don't leave it lying around.
   - **Confirm, don't assume:** `git status --porcelain` on the original branch must match the
     pre-run snapshot exactly (accounting for `preExistingDirty`, which was never touched). If it
     doesn't match, the revert failed partway — stop and surface this to the user rather than
     silently reporting a memo for a repo state that doesn't actually match "reverted."
8. **Write the memo**, not a commit: `.bgn/what-if/<timestamp>-<slug>.md` —
   ```markdown
   # what-if: <one-line description of the toggle>

   **Preset:** first-load | bundle-size | interaction
   **Baseline:** <mean> ± <stddev> (n=<N>)
   **Candidate:** <mean> ± <stddev> (n=<N>)
   **Gate verdict:** KEEP (statistically real, clears the noise band) | REVERT (within noise)
   **Recommendation:** <one paragraph, plain English — is this worth doing, given the measured
   number and the effort the real change would take>

   Reverted. No commit made. Scratch branch `bgn/what-if-<timestamp>` deleted.
   ```
9. **Report.** Summarize the memo in chat. Distill into `.bgn/perf-memory.md` only if the finding is
   genuinely a known gap worth tracking (e.g. "Segment tag costs 340ms, not yet addressed") — tag it
   clearly as a `/what-if` finding, not a `fixed`/`reverted` Autoresearch entry, since no fix was
   actually applied to this codebase.

## `.bgn/what-if/`

Bootstrapped by Doctor alongside `ledger/`, `archive/`, `audit/` — memos are committed with the app
the same way Ledger entries are (they're evidence, not a generated artifact).

## Design note: no new `commitMode` value

`/what-if`'s "always revert" behavior is **not** `.bgn/config.json`'s `no-commit` mode (which leaves
KEEP changes staged for review) — `/what-if` never leaves anything staged, KEEP or REVERT. Rather
than add a fourth `commitMode` value to a config key that Autoresearch's loop also reads,
`/what-if`'s always-revert behavior is hardcoded to this protocol only — it doesn't consult or
change `.bgn/config.json`'s `commitMode` at all. Keeping this out of the shared config schema avoids
a config value that only ever means one specific thing for one specific command.
