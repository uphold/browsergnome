# Experiment Ledger — {{preset}} on {{target}}

- **Run:** {{timestamp}}
- **Repo / commit baseline:** {{repo}} @ {{baseline_sha}}
- **Metric:** {{metric}} ({{direction}}-is-better, unit {{unit}})
- **Protocol:** N={{n}} runs, 1 warm-up discarded, identical workload ({{workload}})
- **Tools:** drive={{drive_tool}}, measure={{measure_tool}}

## Baseline
- runs: {{baseline_runs}}
- mean ± stddev: {{baseline_mean}} ± {{baseline_std}}

## Hypotheses

### H1 — {{hypothesis}}
- **Guide:** {{guide}}
- **Guidance:** {{guidance}}
- **Change (atomic):** {{change_description}}  ({{files_touched}})
- **Measurement mode:** {{mode}} (interleaved ABABAB, or sequential AAAA→BBBB if the diff needed a
  rebuild — see references/measurement.md's rebuild-fallback list; `n/a (deterministic build)` for
  `bundle-size`, where there's no run-to-run variance for interleaving/sequencing to matter)
- **Candidate runs:** {{candidate_runs}}
- **mean ± stddev:** {{candidate_mean}} ± {{candidate_std}}
- **Gate:** improvement {{improvement}} vs noise band {{noise_band}} (max of min_effect {{min_effect}}, k·pooled_std {{k_pooled}})
  — or, for `layout-shift`'s race-driven shape (`gateOccurrence()` instead of `gate()`):
  `occurrence rate improvement {{improvement}} (baseline {{baseline_rate}} vs candidate {{candidate_rate}}, Fisher exact p={{p_value}})`
- **Decision:** {{KEEP|REVERT}}
- **Commit / revert:** {{commit_sha_or_reverted}}
- **Memory line distilled:** `{{memory_line}}`

<!-- repeat ### H2, H3 … one atomic hypothesis each; never stack fixes in one entry -->

## Result
- **Kept:** {{kept_summary}}
- **Net delta vs baseline:** {{net_delta}}
- **Commits:** {{commit_list}}
- **Reverted dead-ends (don't retry):** {{reverted_list}}
- **Dep Pulse:** {{dep_pulse}} (`dispatched` | `deferred` | `cached` | `off` — see references/dep-pulse.md)
