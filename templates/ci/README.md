# browsergnome CI Autopilot — Adoption Guide

Drop one of these workflows into your web repo and browsergnome runs weekly as a headless
performance engineer: scans your repo → picks the top debt findings → applies and measures fixes →
opens a PR showing exactly what changed and why.

---

## Which template?

| | Build-only (`browsergnome-autopilot-build.yml`) | Browser (`browsergnome-autopilot-browser.yml`) |
|---|---|---|
| **Measures** | Bundle size (bytes) | Bundle size + LCP + INP |
| **Preset coverage** | `bundle-size` only | `first-load`, `bundle-size`, `interaction` |
| **Runner** | `ubuntu-latest` (any) | `ubuntu-latest` (headless Chrome — **no emulator, no KVM, no device tier**) |
| **Runtime** | ~10-15 min | ~20-30 min |
| **Reliability** | High | **High** — this is the real advantage web has over React Native's device template: there is no flaky "boot an emulator" step at all |
| **Setup burden** | Low (just `npm ci`) | Higher — needs your build/start commands and a one-time noise characterization on the runner |

**Start with the build-only template.** Bundle-size findings are reliably actionable and need no
browser at all. Upgrade to the browser template when you want to measure real LCP/INP regressions,
not just shipped bytes.

---

## Quickstart (build-only)

```bash
# 1. Copy the workflow
cp browsergnome-autopilot-build.yml .github/workflows/

# 2. Add repo secret
#    GitHub repo -> Settings -> Secrets -> Actions -> New secret
#    Name: ANTHROPIC_API_KEY   Value: sk-ant-...

# 3. Enable PR creation by Actions
#    Settings -> Actions -> General -> Workflow permissions
#    check "Allow GitHub Actions to create and approve pull requests"

# 4. Edit the workflow — replace plugin_marketplaces URL
#    Default: https://github.com/xavi-999/browsergnome.git
#    Recommended: pin to a tag, e.g. https://github.com/xavi-999/browsergnome.git@v0.2.0

# 5. Trigger manually to verify before the first scheduled run
#    GitHub repo -> Actions -> "browsergnome perf autopilot (weekly)" -> Run workflow
```

A PR will appear on your repo (or a clean exit in the logs if no fix cleared the gate).

---

## Quickstart (browser)

Same steps 1-4 as above, plus:

```bash
# 5. Set your build/start commands and target URL as repo variables
#    Settings -> Variables -> Actions -> New repository variable
#    BROWSERGNOME_BUILD_CMD  = npm run build            (default: npm run build)
#    BROWSERGNOME_START_CMD  = npm start                (default: npm start)
#    BROWSERGNOME_TARGET_URL = http://localhost:3000    (default: http://localhost:3000)

# 6. Trigger manually — the FIRST run characterizes gate noise on this runner
#    (step 0 in the workflow prompt) and commits the result to .bgn/config.json.
#    Every subsequent run reuses those numbers instead of re-characterizing.
```

**Why step 6 matters:** the `minEffect`/`k` numbers in `references/measurement.md` were
characterized on one local machine. A shared CI runner has its own noise profile — inheriting the
laptop numbers risks either a gate too loose (a runner noisier than the laptop lets a fake win
through) or too tight (a cleaner runner rejects a real one). Characterizing once and committing the
result is cheap; guessing isn't.

---

## Configuration

### Tuning the workflow inputs

In the YAML `workflow_dispatch.inputs` block and the job's `env:` section:

| Variable | Default | What it does |
|---|---|---|
| `top_findings` | `3` | How many top findings to attempt per run |
| `max_iters` | `4` | Hard cap on total iterations (also honored via `.bgn/config.json` `budget`) |
| `preset` | `auto` (browser template only) | Restrict to one preset instead of the overall top-X |
| `custom_prompt` | *(blank)* | Run a specific goal instead of top-X (see below) |

### Running a specific goal (custom_prompt)

By default the autopilot picks the top-X findings from the Perf Map.
To target something specific instead, set a goal:

**Manual dispatch:** fill the `custom_prompt` input field when you trigger the workflow.

**Scheduled cron (fixed goal every week):** set a
[repo variable](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/store-information-in-variables)
named `BROWSERGNOME_GOAL`:

```
GitHub repo -> Settings -> Variables -> Actions -> New repository variable
Name: BROWSERGNOME_GOAL
Value: reduce LCP on the pricing page
```

The workflow picks this up via `vars.BROWSERGNOME_GOAL`. A manual dispatch input overrides it.

Examples:
- `"reduce bundle size in the checkout flow"`
- `"fix the LCP on the pricing page"` *(browser template only — needs measurement)*
- `"swap moment for date-fns"`

**Constraint (build-only template):** only `bundle-size` goals can be measured without a browser. If
the custom goal requires browser metrics, the autopilot will note this in the PR body and will not
apply an unmeasured fix.

### `.bgn/config.json`

If your repo has a `.bgn/config.json` (bootstrapped by Doctor), its values take precedence over the
workflow inputs — including, for the browser template, the runner-characterized `minEffect`/`k`
from step 0:

```json
{
  "budget": 4,
  "k": 2,
  "runs": 5,
  "runnerCharacterized": true
}
```

Run `/browsergnome` -> **Configurations** to edit this interactively.

Dep Pulse (perf-relevant dependency-release research) is report-only in unattended runs — it never
applies a bump without an interactive consent prompt, headless or not — and can be turned off entirely
with `"depPulse": false`.

### Tuning the gate floor

The build-only template uses `--min-effect 1024` bytes (1KB) as the absolute improvement floor,
matching `references/presets.md`'s `bundle-size` default. Changes smaller than this are reverted
even if statistically significant, because a 1KB delta is too small to notice in practice. To lower
or raise this, edit the `--min-effect` value in the `prompt:` block, or set it via `.bgn/config.json`.

---

## PR gotchas — read before deploying

### 1. Allow GitHub Actions to create PRs (required)

`gh pr create` fails with 403 unless you enable it in **Settings -> Actions -> General ->
Workflow permissions -> Allow GitHub Actions to create and approve pull requests**. This is off by
default on new repos.

### 2. PRs opened with `github.token` don't trigger downstream CI

If you rely on your CI running on the autopilot PR (e.g., to run tests before merge), this won't
happen with the default `GITHUB_TOKEN` — GitHub intentionally prevents Actions-created events from
cascading. To fix:

- Use a
  [fine-grained PAT](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token)
  with `contents: write` and `pull-requests: write` scopes, added as a repo secret. Replace
  `${{ github.token }}` with `${{ secrets.MY_PAT }}` in the `env:` block.
- Or install the [Claude GitHub App](https://github.com/apps/claude), which uses its own token.

### 3. Chrome version drift (browser template only)

The `browser-actions/setup-chrome` step pins `chrome-version: stable` — this tracks Chrome's own
stable channel, not a fixed version number, so the exact browser build can shift between runs the
same way `chrome-devtools-mcp@1.6.0`'s bundled Puppeteer dependency can. If a run's numbers look
unexpectedly different from the last one, check whether Chrome itself moved before assuming a real
regression.

---

## Device — not applicable here

metrognome's RN CI templates have a device-vs-device-free split because React Native's device tier
needs an Android emulator (~45min, needs KVM, can flake on boot). **Headless Chrome on
`ubuntu-latest` doesn't have that problem** — the browser template above already gets you every
implemented preset (`first-load`, `bundle-size`, `interaction`) on the same plain runner the
build-only template uses, just with Chrome installed and the app served. There is no third,
heavier tier to reach for.

---

## Cost estimate

Both templates run `claude-sonnet-4-6`. Build-only: `--max-turns 80`. Browser: `--max-turns 100`
(extra turns budget for the N-run measurement loop's tool calls).

| | Actions minutes | API input tokens | API output tokens |
|---|---|---|---|
| Build-only | ~10-15 min | ~150K | ~8K |
| Browser | ~20-30 min | ~350K | ~18K |

These are estimates, not measured. Set `--max-turns` lower to cap token spend; set it higher if the
agent reports hitting the limit.

GitHub Actions: `ubuntu-latest` is billed at 2x the base minute rate for private repos. Public repos
get free Actions minutes.

---

## First run — what to check

1. Trigger via `workflow_dispatch` with a small `top_findings=1 max_iters=2`.
2. Watch the Actions log — the agent prints what it found, what it tried, and the gate verdict.
   For the browser template, confirm step 0 (runner characterization) actually ran on the first
   trigger and committed `.bgn/config.json`.
3. If a PR opens, check that the gains table has real numbers (no placeholder text).
4. If no PR: check the log for "no ... findings" or "no improvements cleared the gate" — both are
   valid clean exits.

---

## Optional follow-up (not in this template)

Extract the headless rules and PR-body format into a versioned
`skills/browsergnome/references/ci-autopilot.md` + add a `topFindings` key to `DEFAULT_CONFIG` in
`doctor.mjs`. This keeps the two YAMLs DRY and the behavior under version control. Deferred because
these are templates — teams should be able to edit them directly.

Other CI platforms (GitLab CI, Bitbucket Pipelines) and model providers (Bedrock, Vertex) are not
built here, but the prompt is portable: the logic is the same, only the action wrapper changes.
