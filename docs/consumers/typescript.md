# Consumer workflow: TypeScript / JavaScript

Copy one of the variants below into your repo as `.github/workflows/ci.yml`.
Replace `@v1` with the ref you want to pin to. **`v1` has not been tagged
yet**, so use the current pre-release (`@v1.1.0-rc.2`) for now; see
[Status and versions](../../README.md#status-and-versions) and
[Versioning](../../README.md#versioning-and-releases).

All three variants implement the Phase-1 rows of
[docs/CHECK-POLICY.md](../CHECK-POLICY.md) — lint, unit tests, coverage,
dependency scan, secret scan. The branch-scoping and blocking behavior come
from the trigger configuration and job structure below, not from anything
inside `central-ci.yml` — this repo's reusable workflow stays branch-agnostic
by design, per [CLAUDE.md](../../CLAUDE.md)'s architecture rules.

SAST, IaC scan, LLM PR review, and SBOM generation are not yet implemented
(they land in later phases); they're omitted from every variant below.

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
