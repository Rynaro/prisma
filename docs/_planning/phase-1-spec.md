# Phase 1 Specification — Research Synthesis

> **Audience:** IDG (the agent that will compose the Phase 1 documents).
> **Status:** Contract only. IDG fills the bodies; SPECTRA defines structure, content requirements, and acceptance gates.
> **Source of truth for product principles:** The 10 operating principles and the non-goals list in the originating brief. This spec must not contradict them.

---

## Phase 1 Work Plan (≤ 300 words)

**Authoring order (strict):**
1. `docs/research-summary.md` — establishes the OSS landscape (OpenReview, PR-Agent, ai-codereviewer, Kodus) and the comparative vocabulary the rest of Phase 1 reuses.
2. `docs/architecture-decision-records/adr-001-github-app.md` — depends on RS comparative claims about App vs Action UX/permissions.
3. `docs/architecture-decision-records/adr-002-provider-abstraction.md` — depends on RS observations about provider variance and on ADR-001's surface (where provider calls happen).
4. `docs/architecture-decision-records/adr-003-validation-ranking.md` — depends on ADR-002 (raw output is the input to validation) and on RS noise/trust observations.
5. `docs/threat-model.md` — consumes the prefilter, validation, ranking, and publication-cap mechanisms from ADRs 001–003 as named mitigations.
6. `docs/mvp-scope.md` — consumes the three ADRs (in scope = decided), the threat model (must-have controls), and the brief's non-goals (verbatim).
7. `docs/open-questions.md` — last; aggregates every "deferred" or "TBD" marker raised in the prior six files.

**File dependencies (claim flow):**
RS → ADR-001 → ADR-002 → ADR-003 → threat-model → mvp-scope → open-questions.

**Consistency-check pass before exit:** Run a name-level diff to verify (a) every risk in the verbatim risk register appears in `threat-model.md` with a mitigation that names a mechanism defined in an ADR; (b) every non-goal in `mvp-scope.md` matches the brief verbatim; (c) every ADR decision is referenced as "decided" in `mvp-scope.md`; (d) every "TBD" / "deferred" string in files 1–6 has a matching entry in `open-questions.md`.

**Phase 1 exit gate (testable):** All 7 files exist at the specified paths; every acceptance criterion in the YAML block at the end of this spec evaluates true; the consistency-check pass produces zero violations.

---

## File 1 — `docs/research-summary.md`

### 1. Purpose
A single-document landscape review that gives engineers and reviewers the comparative vocabulary (App vs Action, prefilter vs post-filter, validator vs ranker, single-provider vs abstraction) used by every subsequent Phase 1 file.

### 2. Required sections (exact H2/H3 in order)
- `## Scope and method`
- `## OSS landscape`
  - `### OpenReview`
  - `### PR-Agent`
  - `### ai-codereviewer`
  - `### Kodus`
  - `### Cross-project comparison matrix`
- `## Integration surface findings`
  - `### GitHub App vs GitHub Action`
  - `### Webhook lifecycle and signature handling`
  - `### Checks API vs PR review comments vs issue comments`
- `## Model and provider findings`
  - `### Output shape variance across providers`
  - `### Cost and latency observations`
- `## Noise, trust, and developer experience findings`
- `## Implications for our design`

### 3. Research questions answered (concrete, falsifiable)
- Which of {OpenReview, PR-Agent, ai-codereviewer, Kodus} ship as a GitHub App, which as a GitHub Action, which as both, and which as neither?
- Which of those projects perform a deterministic prefilter (path/size/diff-rule) before any LLM call, and which send the entire diff?
- Which of those projects validate or rank model output before posting, and which post raw LLM output?
- Which of those projects expose repo-local configuration files, and what knobs do they expose (paths, models, caps, severities)?
- Why does the GitHub App model give a richer Checks UX than the Action model? (Cite Checks API access, installation tokens, app-level rate limits.)
- What concrete failure modes (verbatim from the risk register) have been observed in those OSS projects?
- What is the smallest set of provider-output fields we must normalize to be vendor-independent?
- Which integration surface (Checks run vs review comment vs issue comment) is best suited to "advisory, non-blocking" findings?

### 4. Required content per section
- **Scope and method:** state that this is a desk review of the four named OSS projects plus public GitHub docs; list the dimensions used (deployment model, prefiltering, validation, configuration, output surface, provider coupling).
- **OSS landscape:** one subsection per project with: deployment model, prefilter behavior, validation/ranking behavior, configuration surface, provider coupling, observed failure modes. The `### Cross-project comparison matrix` must be a table with columns: `project | deployment | prefilter | validation/ranking | repo-local config | provider coupling | output surface`.
- **Integration surface findings:** must contrast App vs Action on at least: token model (installation token vs `GITHUB_TOKEN`), Checks API richness, rate-limit isolation, multi-repo install UX, webhook ownership. Must describe webhook signature verification (`X-Hub-Signature-256`) and replay risk in plain terms.
- **Model and provider findings:** must enumerate the normalization fields needed (e.g., `path`, `line`, `severity`, `category`, `message`, `rationale`, `confidence`) and note where providers diverge. Must flag cost/latency as a budget concern that prefiltering controls.
- **Noise, trust, and developer experience findings:** must reference at least: noisy comments / trust erosion, duplicate comments and reprocessing loops, large diff overload, generated files / lockfiles / vendored code.
- **Implications for our design:** must produce a bulleted list whose items are the seeds for ADR-001, ADR-002, and ADR-003 (prefilter-first, provider abstraction, validation+ranking+caps). No new decisions here — only "this is why ADR-X exists".

### 5. Acceptance criteria
See YAML block (IDs `RS-1` … `RS-5`).

### 6. Cross-file consistency requirements
- The "Implications for our design" bullets must each be picked up as the rationale of exactly one of ADR-001 / ADR-002 / ADR-003.
- Failure modes named here must be a subset of (or equal to) the verbatim risk register used in `threat-model.md`.
- Project names (OpenReview, PR-Agent, ai-codereviewer, Kodus) must be spelled identically here and in any ADR that references them.

### 7. Out of scope for this file
- No decisions ("we will use X"). Decisions live in ADRs.
- No threat enumeration with mitigations — only observation of failure modes.
- No scope/non-scope statements about our MVP.
- No open-questions list — those go to `open-questions.md`.

---

## File 2 — `docs/architecture-decision-records/adr-001-github-app.md`

### 1. Purpose
Records the decision to ship as a GitHub App (not a GitHub Action) and locks the rationale so later contributors cannot silently drift.

### 2. Required sections (exact H2/H3 in order)
- `## Status`
- `## Context`
- `## Decision`
- `## Rationale`
- `## Trade-offs`
- `## Rejected alternatives`
  - `### GitHub Action`
  - `### OAuth App`
  - `### PR webhook + bot account`
- `## Consequences (now)`
- `## Consequences (later)`

### 3. Research questions answered
- Why GitHub App over GitHub Action for our trust, UX, and rate-limit goals?
- What does the App model give us that the Action model cannot (Checks UX, installation tokens, app-level rate limits, multi-repo install)?
- Why is OAuth App rejected for a bot that posts to PRs?
- Why is "PR webhook + bot account" rejected as a shortcut?
- What do we lose by choosing App-first (e.g., zero-config onboarding for repos that already use Actions)?

### 4. Required content per section
- **Status:** `Accepted` plus date placeholder. ADRs are immutable once accepted.
- **Context:** restate operating principle 1 ("GitHub App first, not GitHub Action first") and reference the integration-surface findings in `research-summary.md`.
- **Decision:** one sentence: "We will deliver this product as a GitHub App."
- **Rationale:** must cite at least: Checks API richness, installation token model, app-level rate-limit isolation, multi-repo installability, webhook ownership.
- **Trade-offs:** must name at least: more setup friction than Action, requires hosting the webhook receiver, requires private-key/secret management.
- **Rejected alternatives:** each subsection must list `Alternative`, `Why considered`, `Why rejected`. The three rejected alternatives are exactly: GitHub Action, OAuth App, PR webhook + bot account.
  - **GitHub Action:** rejected because (at minimum) weaker Checks UX in this usage shape, per-workflow `GITHUB_TOKEN` constraints, repo-by-repo config sprawl, and rate-limit coupling to repo-level Actions runners.
  - **OAuth App:** rejected because user-bound tokens are wrong trust model for an automated reviewer.
  - **PR webhook + bot account:** rejected because bot accounts violate platform expectations, complicate auth, and lose Checks integration.
- **Consequences (now):** webhook receiver, app manifest, installation flow, key management, signature verification are required.
- **Consequences (later):** if Action distribution is later requested, it must be a thin wrapper over the App's HTTP surface, not a fork.

### 5. Acceptance criteria
See YAML block (IDs `ADR1-1` … `ADR1-4`).

### 6. Cross-file consistency requirements
- The decision here must appear as "decided / in scope" in `mvp-scope.md`.
- Webhook signature verification mentioned under "Consequences (now)" must appear as a mitigation in `threat-model.md` for the webhook-replay/signature-failure risk.
- Rate-limit and token-model claims must match the `### GitHub App vs GitHub Action` section of `research-summary.md`.

### 7. Out of scope for this file
- No provider-abstraction discussion (that is ADR-002).
- No validation/ranking discussion (that is ADR-003).
- No threat mitigations — only consequences. Mitigations live in `threat-model.md`.

---

## File 3 — `docs/architecture-decision-records/adr-002-provider-abstraction.md`

### 1. Purpose
Records the decision to introduce a provider-abstraction layer between our pipeline and any LLM/model vendor, preserving operating principle 1's spirit at the model layer (no vendor lock-in).

### 2. Required sections (exact H2/H3 in order)
- `## Status`
- `## Context`
- `## Decision`
- `## Rationale`
- `## Interface contract (sketch)`
- `## Trade-offs`
- `## Rejected alternatives`
  - `### Single hard-coded provider`
  - `### Direct SDK calls scattered through the pipeline`
  - `### LangChain-style heavy framework`
- `## Consequences (now)`
- `## Consequences (later)`

### 3. Research questions answered
- Why must the model provider be abstracted behind a typed interface?
- What is the smallest sufficient provider interface (request shape, response shape, error shape, capability flags)?
- Why is a heavy framework (LangChain-style) rejected for this shape of problem?
- Why is "just call the SDK directly" rejected?
- How does the abstraction interact with operating principle 8 (every public interface typed and schema-validated)?

### 4. Required content per section
- **Status:** `Accepted` plus date placeholder.
- **Context:** restate the no-vendor-lock-in principle and cite `research-summary.md`'s "Output shape variance across providers" finding.
- **Decision:** one sentence: "All model interactions go through a single typed Provider interface; no vendor SDK is imported outside its adapter."
- **Rationale:** must cite: schema-drift risk, cost/latency variance, capability variance (function calling, JSON mode), testability via fakes, ability to A/B providers.
- **Interface contract (sketch):** must enumerate, by name only (not full TypeScript), at minimum: `review(input): ReviewResult`, an input schema referencing normalized diff context, a response schema validated by Zod (named), a typed error union, and capability flags. This sketch is informative — full types live in Phase 2.
- **Trade-offs:** must name at least: indirection cost, lowest-common-denominator capability surface, one more module to maintain.
- **Rejected alternatives:**
  - **Single hard-coded provider:** rejected because it violates principle 1's spirit (vendor independence) and couples roadmap to one vendor's pricing/availability.
  - **Direct SDK calls scattered through the pipeline:** rejected because it makes prefilter/validation boundaries leaky and makes testing require live keys.
  - **LangChain-style heavy framework:** rejected because it imports a large abstract surface we do not need, hides retries/cost, and complicates schema validation.
- **Consequences (now):** one adapter at minimum; Zod schemas for input/output; fake provider for tests; no provider SDK in core packages.
- **Consequences (later):** swapping or adding a provider must be additive; no core change is permitted to add provider B.

### 5. Acceptance criteria
See YAML block (IDs `ADR2-1` … `ADR2-4`).

### 6. Cross-file consistency requirements
- The output schema named here must be the same schema fed into the validator/ranker described in ADR-003.
- "No SDK outside the adapter" must appear as a constraint in `mvp-scope.md`.
- Schema-drift-from-provider-output (verbatim risk) must be mitigated in `threat-model.md` by naming this adapter + Zod validation.

### 7. Out of scope for this file
- No specific vendor names or pricing.
- No prompt engineering content.
- No retry/queue mechanics (those are Phase 2 implementation).
- No validation or ranking logic (that is ADR-003).

---

## File 4 — `docs/architecture-decision-records/adr-003-validation-ranking.md`

### 1. Purpose
Records the decision that nothing reaches a PR directly from raw LLM output: every externally visible finding passes a deterministic validator, a ranker, and a publication cap.

### 2. Required sections (exact H2/H3 in order)
- `## Status`
- `## Context`
- `## Decision`
- `## Pipeline shape`
- `## Rationale`
- `## Trade-offs`
- `## Rejected alternatives`
  - `### Post raw LLM output`
  - `### LLM-as-judge only (self-critique without deterministic validator)`
  - `### Heuristic-only (no model)`
- `## Consequences (now)`
- `## Consequences (later)`

### 3. Research questions answered
- Why are deterministic prefilters mandatory before any model call?
- Why must validation be deterministic (schema + structural + reference checks) rather than another LLM pass?
- Why is ranking required even when validation passes (i.e., volume control vs correctness control)?
- What publication caps prevent trust erosion (per-PR cap, per-file cap, severity floor)?
- How does this composition satisfy operating principles 3, 4, and 5?

### 4. Required content per section
- **Status:** `Accepted` plus date placeholder.
- **Context:** restate operating principles 3, 4, 5; cite "Noise, trust, and developer experience findings" from `research-summary.md`.
- **Decision:** one sentence: "All findings flow through prefilter → provider → validator → ranker → publication cap before any PR-visible artifact is created."
- **Pipeline shape:** ordered list naming each stage, its input, its output, and whether it can short-circuit. Must call out that prefilter runs before any provider call and ranker runs before publication.
- **Rationale:** must cite: hallucinated findings, noisy comments / trust erosion, large diff overload, duplicate comments and reprocessing loops.
- **Trade-offs:** must name at least: some valid findings will be dropped by caps, ranking adds latency, deterministic validation can reject legitimate-but-unverifiable findings.
- **Rejected alternatives:**
  - **Post raw LLM output:** rejected because it directly violates operating principles 4 and 5.
  - **LLM-as-judge only:** rejected because a non-deterministic validator cannot meet principle 3 and reintroduces schema-drift.
  - **Heuristic-only (no model):** rejected because heuristics alone do not deliver the qualitative review value the product promises.
- **Consequences (now):** prefilter module, validator module, ranker module, publication-cap module, and a rejection-reason log are required.
- **Consequences (later):** an optional verifier or stronger ranker can be added without changing the pipeline contract, satisfying the brief's "no multi-agent complexity beyond optional verifier/ranker".

### 5. Acceptance criteria
See YAML block (IDs `ADR3-1` … `ADR3-5`).

### 6. Cross-file consistency requirements
- The pipeline stages named here must appear as named mitigations in `threat-model.md` for: hallucinated findings, noisy comments / trust erosion, large diff overload, duplicate comments and reprocessing loops, generated files / lockfiles / vendored code.
- The validator's input must be the schema produced by ADR-002's adapter.
- "Publication caps" must appear in `mvp-scope.md` as an in-scope feature.

### 7. Out of scope for this file
- No App-vs-Action discussion (ADR-001).
- No provider interface definition (ADR-002).
- No specific cap values (those belong in repo-local config defaults, decided in Phase 2).

---

## File 5 — `docs/threat-model.md`

### 1. Purpose
Enumerates security, abuse, and trust risks for the GitHub App and binds each to a named mitigation defined in ADRs 001–003 (or flags it as residual / deferred).

### 2. Required sections (exact H2/H3 in order)
- `## Scope and assumptions`
- `## Trust boundaries`
- `## Risk register`
  - `### Hallucinated findings`
  - `### Noisy comments / trust erosion`
  - `### Large diff overload`
  - `### Schema drift from provider output`
  - `### Webhook replay or signature failures`
  - `### Secret leakage`
  - `### Token/cost blowups`
  - `### Privacy exposure from over-shared code context`
  - `### Generated files / lockfiles / vendored code`
  - `### Duplicate comments and reprocessing loops`
- `## Mitigation matrix`
- `## Residual risk and deferred items`

### 3. Research questions answered
- For each verbatim risk, what is the attack/failure scenario, what is the impact, and what mitigates it?
- Which mitigations are mechanical (code) vs procedural (review/policy)?
- Which mitigations are deferred to Phase 2+ and why is that acceptable for MVP?
- Which risks have no mitigation today and must be accepted as residual?

### 4. Required content per section
- **Scope and assumptions:** state that the App runs as a hosted webhook receiver with installation tokens; that secrets are stored in a managed secret store; that LLM providers are external untrusted-output sources.
- **Trust boundaries:** must enumerate at least: GitHub → our webhook receiver, our worker → LLM provider, our worker → GitHub API, repo-local config → our worker.
- **Risk register:** ten subsections, one per risk above, each containing: `Description`, `Attack/failure scenario`, `Impact`, `Likelihood`, `Mitigation (named, with ADR reference)`, `Status (mitigated | partially mitigated | accepted | deferred)`. The ten risk titles are verbatim from the brief and must not be reworded. IDG may add additional risks below this set, never replace.
- **Mitigation matrix:** a table with columns `risk | mechanism | source ADR | status`. Every row's `mechanism` must be a named element from ADR-001, ADR-002, or ADR-003 (e.g., "webhook signature verification", "Zod-validated provider output", "deterministic prefilter", "publication cap", "duplicate-suppression key"). No free-form mitigations without an ADR anchor; if one is needed, it goes to `open-questions.md`.
- **Residual risk and deferred items:** explicitly named, each with a pointer into `open-questions.md` if applicable.

### 5. Acceptance criteria
See YAML block (IDs `TM-1` … `TM-5`).

### 6. Cross-file consistency requirements
- All ten verbatim risks present, in order, with no rewording.
- Every mitigation references an ADR by ID (`ADR-001`, `ADR-002`, or `ADR-003`).
- Any "deferred" status must have a matching item in `open-questions.md`.
- Webhook-replay mitigation must match ADR-001's "Consequences (now)".
- Schema-drift mitigation must match ADR-002's "Consequences (now)".
- Hallucinated findings, noise, large diff overload, and duplicate-comment mitigations must match ADR-003's pipeline stages.

### 7. Out of scope for this file
- No new architectural decisions — only mappings to ADRs.
- No implementation details (queue choice, cap numbers, retry policy).
- No vendor-specific guidance.

---

## File 6 — `docs/mvp-scope.md`

### 1. Purpose
Locks the MVP scope: in-scope feature list, the verbatim non-goals from the brief, the success criteria for Phase 1 → Phase 2 transition, and the link from each in-scope item to the ADR that decided it.

### 2. Required sections (exact H2/H3 in order)
- `## MVP definition`
- `## In scope`
  - `### Integration surface`
  - `### Pipeline`
  - `### Provider abstraction`
  - `### Repo-local configuration`
  - `### Observability and logging`
- `## Non-goals (verbatim)`
- `## Success criteria`
- `## Phase boundaries`

### 3. Research questions answered
- What does "MVP" mean for this product in one paragraph?
- Which ADR-decided capabilities are in scope, and which are deferred?
- What is explicitly NOT in MVP (verbatim from the brief)?
- What are the testable success criteria for the MVP?
- Where does Phase 1 end and Phase 2 begin?

### 4. Required content per section
- **MVP definition:** one paragraph, no marketing language. Must mention: GitHub App, advisory non-blocking findings, repo-local config, vendor-independent provider layer, deterministic prefilter, validation, ranking, publication caps.
- **In scope:** five subsections, each a bulleted list. Each bullet must end with a parenthetical ADR reference (e.g., `(ADR-001)`). Required minimum bullets:
  - **Integration surface:** GitHub App; webhook receiver with signature verification; Checks API output for findings.
  - **Pipeline:** deterministic prefilter; provider call via abstraction; validator; ranker; publication cap; duplicate-suppression key.
  - **Provider abstraction:** typed Provider interface; Zod-validated input/output; one reference adapter; fake provider for tests.
  - **Repo-local configuration:** the config file path is `.github/review-bot.yml` (decided by the brief); knobs for paths/globs, severity floor, per-PR cap, per-file cap. Default cap values are TBD → flag in `open-questions.md`.
  - **Observability and logging:** structured logs; rejection-reason log for findings dropped by validator/ranker/cap.
- **Non-goals (verbatim):** must reproduce the brief's non-goals list verbatim, in order: no auto-merge, no autofix, no Slack/ClickUp/Jira write-backs, no org dashboards, no full code-graph platform, no multi-agent complexity beyond optional verifier/ranker, no provider lock-in, no comment-on-everything.
- **Success criteria:** at least four testable bullets, e.g., "Given an installed App on a test repo, when a PR is opened, then the App posts at most N findings via the Checks API, all schema-validated."
- **Phase boundaries:** one paragraph. Phase 1 ends when all 7 documents pass acceptance; Phase 2 begins with package scaffolding and contract tests.

### 5. Acceptance criteria
See YAML block (IDs `MVP-1` … `MVP-5`).

### 6. Cross-file consistency requirements
- Non-goals list is byte-equivalent to the brief's non-goals, in the same order.
- Every in-scope bullet references an existing ADR ID.
- "Provider abstraction" bullets must match ADR-002's "Consequences (now)".
- "Pipeline" bullets must match ADR-003's "Pipeline shape" stages.
- Any TBD knob names route to `open-questions.md`.

### 7. Out of scope for this file
- No threat enumeration (that is `threat-model.md`).
- No architectural rationale (that is the ADRs).
- No project plan / sprint breakdown.

---

## File 7 — `docs/open-questions.md`

### 1. Purpose
A single, ordered backlog of every deferred decision, unknown, or research gap raised in files 1–6 — so Phase 2 starts with a known list, not a hunt.

### 2. Required sections (exact H2/H3 in order)
- `## How this list is maintained`
- `## Open questions`
- `## Deferred decisions`
- `## Research gaps`
- `## Resolution log`

### 3. Research questions answered
- What is unknown right now and must be decided before Phase 2 can finish?
- Which questions are "nice to have answered" vs "blocking"?
- Where in the prior six files was each question raised?
- What is the resolution policy (who decides, when, how recorded)?

### 4. Required content per section
- **How this list is maintained:** state that any "TBD" or "deferred" string in files 1–6 must have a matching numbered entry here; resolutions land in the `Resolution log`.
- **Open questions:** numbered list. Each entry: `ID`, `Question`, `Raised in (file + section)`, `Blocking? (yes/no)`, `Owner (TBD acceptable)`, `Target phase`. At minimum, IDG must include entries that capture every TBD raised by ADRs and `mvp-scope.md` (config file name/path, default cap values, choice of reference provider adapter, log/observability backend).
- **Deferred decisions:** decisions intentionally postponed; same shape as Open questions.
- **Research gaps:** items that need more reading or experimentation, not a binary decision.
- **Resolution log:** empty at Phase 1 exit; reserved for future updates.

### 5. Acceptance criteria
See YAML block (IDs `OQ-1` … `OQ-3`).

### 6. Cross-file consistency requirements
- Every "TBD" / "deferred" / "to be decided" string in files 1–6 has at least one matching entry here.
- No entry here is contradicted by a decision recorded in an ADR (if it is, the entry must be moved to `Resolution log`).

### 7. Out of scope for this file
- No new decisions.
- No re-statement of decided ADRs.
- No risk mitigations.

---

## Cross-cutting consistency-check pass (must pass before Phase 1 exit)

1. **Risk-register completeness:** all ten verbatim risks present in `threat-model.md`, in the order given by the brief.
2. **Risk-mitigation anchoring:** every mitigation in the matrix references `ADR-001`, `ADR-002`, or `ADR-003`, or is listed in `open-questions.md` as deferred.
3. **Non-goals byte match:** `mvp-scope.md` non-goals are byte-equivalent to the brief's list, same order.
4. **ADR rejected-alternatives present:** ADR-001 lists exactly {GitHub Action, OAuth App, PR webhook + bot account}; ADR-002 lists exactly {Single hard-coded provider, Direct SDK calls scattered through the pipeline, LangChain-style heavy framework}; ADR-003 lists exactly {Post raw LLM output, LLM-as-judge only, Heuristic-only (no model)}.
5. **TBD reconciliation:** every TBD in files 1–6 has a matching entry in `open-questions.md`.
6. **Schema chain:** ADR-002's output schema name is the same identifier referenced as the validator input in ADR-003 and in `mvp-scope.md`'s pipeline bullets.
7. **OSS project name uniformity:** `OpenReview`, `PR-Agent`, `ai-codereviewer`, `Kodus` spelled identically wherever they appear.

---

## Machine-readable acceptance criteria (YAML)

```yaml
files:
  docs/research-summary.md:
    acceptance:
      - id: RS-1
        given: docs/research-summary.md exists
        when: a reader inspects the OSS landscape section
        then: subsections for OpenReview, PR-Agent, ai-codereviewer, and Kodus all exist, each describing deployment model, prefilter behavior, validation/ranking behavior, configuration surface, and provider coupling
      - id: RS-2
        given: docs/research-summary.md exists
        when: a reader inspects the cross-project comparison matrix
        then: a table is present with columns project, deployment, prefilter, validation/ranking, repo-local config, provider coupling, output surface, and one row per named OSS project
      - id: RS-3
        given: docs/research-summary.md exists
        when: a reader inspects the integration surface findings section
        then: GitHub App vs GitHub Action is contrasted on at least token model, Checks API richness, rate-limit isolation, and webhook ownership
      - id: RS-4
        given: docs/research-summary.md exists
        when: a reader inspects the noise, trust, and developer experience findings section
        then: at least these failure modes are named verbatim - noisy comments / trust erosion, duplicate comments and reprocessing loops, large diff overload, generated files / lockfiles / vendored code
      - id: RS-5
        given: docs/research-summary.md exists
        when: a reader inspects the implications for our design section
        then: the bullets explicitly seed ADR-001, ADR-002, and ADR-003 by name and contain no new decisions
  docs/architecture-decision-records/adr-001-github-app.md:
    acceptance:
      - id: ADR1-1
        given: adr-001-github-app.md exists
        when: a reader looks for the rejected alternatives section
        then: subsections exist for GitHub Action, OAuth App, and PR webhook + bot account, each with a stated reason for rejection
      - id: ADR1-2
        given: adr-001-github-app.md exists
        when: a reader inspects the rationale section
        then: at least Checks API richness, installation token model, app-level rate-limit isolation, multi-repo installability, and webhook ownership are cited as reasons
      - id: ADR1-3
        given: adr-001-github-app.md exists
        when: a reader inspects the consequences (now) section
        then: webhook receiver, app manifest, installation flow, key management, and signature verification are each listed
      - id: ADR1-4
        given: adr-001-github-app.md and mvp-scope.md both exist
        when: a reader cross-checks them
        then: GitHub App appears as in-scope in mvp-scope.md with an (ADR-001) reference
  docs/architecture-decision-records/adr-002-provider-abstraction.md:
    acceptance:
      - id: ADR2-1
        given: adr-002-provider-abstraction.md exists
        when: a reader looks for the rejected alternatives section
        then: subsections exist for Single hard-coded provider, Direct SDK calls scattered through the pipeline, and LangChain-style heavy framework, each with a stated reason for rejection
      - id: ADR2-2
        given: adr-002-provider-abstraction.md exists
        when: a reader inspects the interface contract (sketch) section
        then: at minimum a review function, a Zod-validated input schema, a Zod-validated output schema, a typed error union, and capability flags are named
      - id: ADR2-3
        given: adr-002-provider-abstraction.md exists
        when: a reader inspects the consequences (now) section
        then: it states that no provider SDK is imported outside its adapter and a fake provider exists for tests
      - id: ADR2-4
        given: adr-002-provider-abstraction.md and threat-model.md both exist
        when: a reader cross-checks the schema drift from provider output risk
        then: its mitigation references ADR-002 and names Zod validation at the adapter boundary
  docs/architecture-decision-records/adr-003-validation-ranking.md:
    acceptance:
      - id: ADR3-1
        given: adr-003-validation-ranking.md exists
        when: a reader looks for the rejected alternatives section
        then: subsections exist for Post raw LLM output, LLM-as-judge only, and Heuristic-only (no model), each with a stated reason for rejection
      - id: ADR3-2
        given: adr-003-validation-ranking.md exists
        when: a reader inspects the pipeline shape section
        then: the stages prefilter, provider, validator, ranker, and publication cap appear in that order with input and output named
      - id: ADR3-3
        given: adr-003-validation-ranking.md exists
        when: a reader inspects the rationale section
        then: at least hallucinated findings, noisy comments / trust erosion, large diff overload, and duplicate comments and reprocessing loops are cited
      - id: ADR3-4
        given: adr-003-validation-ranking.md exists
        when: a reader inspects the consequences (now) section
        then: prefilter module, validator module, ranker module, publication-cap module, and rejection-reason log are listed
      - id: ADR3-5
        given: adr-003-validation-ranking.md and threat-model.md both exist
        when: a reader cross-checks the noisy comments / trust erosion risk
        then: its mitigation references ADR-003 and names ranker plus publication cap
  docs/threat-model.md:
    acceptance:
      - id: TM-1
        given: threat-model.md exists
        when: a reader inspects the risk register section
        then: subsections appear for hallucinated findings, noisy comments / trust erosion, large diff overload, schema drift from provider output, webhook replay or signature failures, secret leakage, token/cost blowups, privacy exposure from over-shared code context, generated files / lockfiles / vendored code, and duplicate comments and reprocessing loops, in that order, with titles unchanged from the brief
      - id: TM-2
        given: threat-model.md exists
        when: a reader inspects each risk subsection
        then: each contains Description, Attack/failure scenario, Impact, Likelihood, Mitigation, and Status fields
      - id: TM-3
        given: threat-model.md exists
        when: a reader inspects the mitigation matrix
        then: every row's mechanism column references ADR-001, ADR-002, or ADR-003, or is marked deferred with a pointer into open-questions.md
      - id: TM-4
        given: threat-model.md exists
        when: a reader inspects the trust boundaries section
        then: at least GitHub to webhook receiver, worker to LLM provider, worker to GitHub API, and repo-local config to worker are enumerated
      - id: TM-5
        given: threat-model.md and adr-001-github-app.md both exist
        when: a reader cross-checks the webhook replay or signature failures risk
        then: its mitigation matches the signature verification consequence listed in ADR-001
  docs/mvp-scope.md:
    acceptance:
      - id: MVP-1
        given: mvp-scope.md exists
        when: a reader inspects the non-goals (verbatim) section
        then: it lists exactly no auto-merge, no autofix, no Slack/ClickUp/Jira write-backs, no org dashboards, no full code-graph platform, no multi-agent complexity beyond optional verifier/ranker, no provider lock-in, no comment-on-everything, in that order
      - id: MVP-2
        given: mvp-scope.md exists
        when: a reader inspects the in scope section
        then: every bullet ends with a parenthetical ADR reference of the form (ADR-001), (ADR-002), or (ADR-003)
      - id: MVP-3
        given: mvp-scope.md exists
        when: a reader inspects the in scope > Pipeline subsection
        then: it lists deterministic prefilter, provider call via abstraction, validator, ranker, publication cap, and duplicate-suppression key
      - id: MVP-4
        given: mvp-scope.md exists
        when: a reader inspects the success criteria section
        then: at least four testable criteria are present, each phrased as a Given/When/Then or equivalent observable check
      - id: MVP-5
        given: mvp-scope.md exists
        when: a reader inspects the phase boundaries section
        then: it states that Phase 1 ends when all 7 Phase 1 documents pass acceptance and Phase 2 begins with package scaffolding and contract tests
  docs/open-questions.md:
    acceptance:
      - id: OQ-1
        given: open-questions.md exists
        when: a reader inspects the open questions section
        then: every entry has ID, Question, Raised in, Blocking?, Owner, and Target phase fields
      - id: OQ-2
        given: open-questions.md and the other six Phase 1 files exist
        when: a reader greps the other six files for TBD, deferred, or to be decided
        then: every match has a corresponding numbered entry in open-questions.md
      - id: OQ-3
        given: open-questions.md exists
        when: a reader inspects the resolution log section
        then: the section is present and is empty at Phase 1 exit
consistency_checks:
  - id: CC-1
    description: Risk register in threat-model.md contains the ten verbatim risks in the order given by the brief
  - id: CC-2
    description: Every mitigation in threat-model.md references ADR-001, ADR-002, or ADR-003, or is deferred to open-questions.md
  - id: CC-3
    description: Non-goals in mvp-scope.md are byte-equivalent to the brief's non-goals list and in the same order
  - id: CC-4
    description: ADR-001 rejected alternatives are exactly {GitHub Action, OAuth App, PR webhook + bot account}
  - id: CC-5
    description: ADR-002 rejected alternatives are exactly {Single hard-coded provider, Direct SDK calls scattered through the pipeline, LangChain-style heavy framework}
  - id: CC-6
    description: ADR-003 rejected alternatives are exactly {Post raw LLM output, LLM-as-judge only, Heuristic-only (no model)}
  - id: CC-7
    description: Every TBD or deferred string in files 1-6 has a matching entry in open-questions.md
  - id: CC-8
    description: ADR-002's output schema identifier is the same identifier used as the validator input in ADR-003 and in mvp-scope.md pipeline bullets
  - id: CC-9
    description: OSS project names OpenReview, PR-Agent, ai-codereviewer, Kodus are spelled identically across all files
exit_gate:
  description: All 7 Phase 1 files exist at their specified paths, all acceptance criteria above evaluate true, and all consistency_checks pass with zero violations.
```
