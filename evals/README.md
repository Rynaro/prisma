# Evaluation Suite

## Purpose

This directory holds the Phase 6 evaluation harness for the AI Code Review GitHub App. The harness package is `@prisma-bot/eval-runner`, located at `evals/runner/`. The entry-point command is `make eval`. Methodology, metric definitions, and the canonical scenario taxonomy live in `docs/evaluation-plan.md`; this readme is operator-facing and forwards to that document for any "why" question.

The suite is deterministic and offline: **no live API calls; no provider key required**. The harness uses `FakeProvider` for the typed provider boundary, `InMemoryReplayCache` for the idempotency-key state record, `InMemoryJobQueue` for the BullMQ-equivalent surface, and a hand-rolled `OctokitLike` for the GitHub API surfaces consumed by the publisher (Checks API, Pull Request Review Comments API, Pull Requests API).

## How to run

Use the `make` targets only. The harness runs inside the `tools` container via `docker compose`; a host runtime install is not required. The package manager and runtime are encapsulated by the container; the host operator never invokes them directly.

```
make eval
make eval -- --scenario <id>
make eval -- --report-md <path>
make eval -- --all --report-md <path>
```

`make eval` runs the full nine-scenario suite. `make eval -- --scenario <id>` runs a single scenario by ID. `make eval -- --report-md <path>` writes the Markdown report to the chosen path. `make eval -- --all --report-md <path>` is the explicit form of "all scenarios plus a Markdown report at this path".

## Scenario index

| ID | Description |
| --- | --- |
| `security-bug` | A high-severity `security`-category finding survives all gates and is published inline. |
| `missing-tests` | A `tests`-category finding at severity ≥ floor publishes inline (verifies severity-floor + category coverage). |
| `risky-migration` | A `migration`-category finding publishes inline. |
| `harmless-refactor` | No findings expected; provider returns empty. FP guard. |
| `generated-files` | Prefilter excludes; provider not called. |
| `noisy-diff-with-lockfiles` | Lockfile path skipped, source path analyzed. |
| `malformed-provider-output` | Pipeline degrades to `failed_terminal` with summary-only. |
| `duplicate-issue-across-hunks` | Within-run dedupe collapses to one. |
| `oversized-pr` | Prefilter `oversized` short-circuit; provider not called; summary-only regardless of mode. |

The IDs and order match `docs/evaluation-plan.md` § Scenario taxonomy byte-equivalent.

## Adding a new scenario

1. Pick an ID (kebab-case) not present in `evals/scenarios.yaml`.
2. Add a new entry at the end of `evals/scenarios.yaml` with `id`, `name`, `fixture: fixtures/<id>.yaml`, and `tags`.
3. Create `evals/fixtures/<id>.yaml` against the schema in `docs/evaluation-plan.md` § Scenario YAML schema.
4. Create `evals/fixtures/<id>/` and add any auxiliary payload files (`pr_data.json`, `files.json`, etc.) that the YAML references via `@file:<relative-path>`.
5. Run `make eval -- --scenario <id>` and iterate until PASS.
6. Add the scenario to `docs/evaluation-plan.md` § Scenario taxonomy with its name, "what this exercises", and metric identifiers.
7. Open a PR; CI will run `make eval` and block on FAIL.

## CI

CI runs the eval step after `make test`. The workflow step is named `eval`; it invokes `make eval` and blocks the merge on any FAIL. The full CI-integration rules are documented in `docs/evaluation-plan.md` § CI integration.
