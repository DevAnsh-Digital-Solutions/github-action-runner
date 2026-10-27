# Consumer workflow: TypeScript / JavaScript

Copy one of the variants below into your repo as `.github/workflows/ci.yml`.
`@v1` always gives you the latest `v1.x.y`; pin `@v1.0.0` instead if you
want nothing to change until you update it. Before you start, check
[Will it work for my repo?](../../README.md#1-will-it-work-for-my-repo) —
public repos can't use this CI. More scenarios (AI review, monorepos,
per-branch rules) are in the [README](../../README.md#3-pick-your-scenario-copy-paste).

All three variants implement the Phase-1 rows of
[docs/CHECK-POLICY.md](../CHECK-POLICY.md) — lint, unit tests, coverage,
dependency scan, secret scan. The branch-scoping and blocking behavior come
from the trigger configuration and job structure below, not from anything
inside `central-ci.yml` — this repo's reusable workflow stays branch-agnostic
by design, per [CLAUDE.md](../../CLAUDE.md)'s architecture rules.

SAST, IaC scan and SBOM generation are not yet implemented
(they land in later phases); they are omitted from every variant below. The
optional advisory AI review is described in the last section.

## Variant 1: lint-only repo

Just the lint check, on every PR to every branch.

```yaml
name: CI

on:
  pull_request:

jobs:
  lint:
    uses: DevAnsh-Digital-Solutions/github-action-runner/.github/workflows/central-ci.yml@v1
    with:
      language: ts
      enable_lint: true
      enable_unit_test: false
      enable_coverage: false
      enable_dependency_scan: false
      enable_secret_scan: false
```

## Variant 2: security-only repo

Secret scan (PR diff + push-to-main full history) and dependency scan
(every PR + nightly on `main`), no lint/test/coverage.

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]
  schedule:
    - cron: '0 3 * * *' # nightly dependency scan, per docs/CHECK-POLICY.md

jobs:
  pr-checks:
    if: github.event_name == 'pull_request'
    uses: DevAnsh-Digital-Solutions/github-action-runner/.github/workflows/central-ci.yml@v1
    with:
      language: ts
      enable_lint: false
      enable_unit_test: false
      enable_coverage: false
      enable_dependency_scan: true
      enable_secret_scan: true

  push-main-secret-scan:
    if: github.event_name == 'push'
    uses: DevAnsh-Digital-Solutions/github-action-runner/.github/workflows/central-ci.yml@v1
    with:
      language: ts
      enable_lint: false
      enable_unit_test: false
      enable_coverage: false
      enable_dependency_scan: false
      enable_secret_scan: true

  nightly-dependency-scan:
    if: github.event_name == 'schedule'
    uses: DevAnsh-Digital-Solutions/github-action-runner/.github/workflows/central-ci.yml@v1
    with:
      language: ts
      enable_lint: false
      enable_unit_test: false
      enable_coverage: false
      enable_dependency_scan: true
      enable_secret_scan: false
```

## Variant 3: full-suite repo

Every Phase-1 check, each scoped to the trigger docs/CHECK-POLICY.md calls
for: lint/unit-test/coverage/dependency-scan on every PR, secret-scan on
every PR plus push-to-main, and dependency-scan again nightly on `main`.

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]
  schedule:
    - cron: '0 3 * * *' # nightly dependency scan, per docs/CHECK-POLICY.md

jobs:
  pr-checks:
    if: github.event_name == 'pull_request'
    uses: DevAnsh-Digital-Solutions/github-action-runner/.github/workflows/central-ci.yml@v1
    with:
      language: ts
      working_dir: '.'
      enable_lint: true
      enable_unit_test: true
      enable_coverage: true
      enable_dependency_scan: true
      enable_secret_scan: true
      coverage_threshold: 80

  push-main-secret-scan:
    if: github.event_name == 'push'
    uses: DevAnsh-Digital-Solutions/github-action-runner/.github/workflows/central-ci.yml@v1
    with:
      language: ts
      enable_lint: false
      enable_unit_test: false
      enable_coverage: false
      enable_dependency_scan: false
      enable_secret_scan: true

  nightly-dependency-scan:
    if: github.event_name == 'schedule'
    uses: DevAnsh-Digital-Solutions/github-action-runner/.github/workflows/central-ci.yml@v1
    with:
      language: ts
      enable_lint: false
      enable_unit_test: false
      enable_coverage: false
      enable_dependency_scan: true
      enable_secret_scan: false
```

## Notes

- `enable_coverage: true` requires `enable_unit_test: true` in the same
  job — coverage is parsed from the unit-test run's output, it doesn't run
  tests itself. `central-ci.yml`'s `validate-inputs` job fails fast with a
  clear message if you enable one without the other.
- Add an ESLint config (flat config or legacy `.eslintrc*`) before enabling
  `enable_lint` — the lint action never generates one for you.
- Vitest coverage needs `@vitest/coverage-v8` (or `@vitest/coverage-istanbul`)
  as a devDependency; Jest's coverage collection is built in.
- The secret-scan job's checkout uses `fetch-depth: 0` internally (full
  history) — you don't need to configure that yourself.

## Optional: advisory AI review

Turn on an LLM review of the PR that explains the lint, unit-test and
coverage results and reviews the diff. It comments on the PR (one comment,
updated on each push) and **never blocks**. Full details are in the
[README](../../README.md#ai-review-advisory).

Setup: add a repository secret named `AI_TOKEN` with your provider's API
key, then add the flag, a model name and the secret mapping. The review
only runs on pull requests; the expression on `enable_llm_review` chooses
which target branches.

```yaml
jobs:
  pr-checks:
    if: github.event_name == 'pull_request'
    uses: DevAnsh-Digital-Solutions/github-action-runner/.github/workflows/central-ci.yml@v1
    permissions:
      contents: read
      pull-requests: write # lets the review post its comment
      security-events: write
      actions: read
    with:
      language: ts
      # every PR:               true
      # one target branch:      ${{ github.base_ref == 'develop' }}
      # several target branches: ${{ contains(fromJSON('["main","develop"]'), github.base_ref) }}
      enable_llm_review: ${{ github.base_ref == 'develop' }}
      llm_provider: openai-compatible   # or anthropic / gemini
      llm_model: gpt-4o
      # Gemini through the OpenAI-compatible endpoint instead:
      #   llm_base_url: https://generativelanguage.googleapis.com/v1beta/openai
      #   llm_model: gemini-2.5-flash
    secrets:
      ai_token: ${{ secrets.AI_TOKEN }}   # or: secrets: inherit
```

If `AI_TOKEN` is missing or rejected, the `AI Review (token check)` job
fails within seconds with a message saying what to fix; the other checks
carry on unaffected.
