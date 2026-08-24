# Github-Runner

Central GitHub Actions automation repo. Holds reusable composite actions
(one check each) and a single reusable workflow that orchestrates them.
Any repo in the org calls the reusable workflow with boolean flags to
enable the checks it wants.

This repo contains no application code — only CI definitions, helper
scripts, and tests for those scripts.

> **Status:** Phase 1. Checks are implemented for `js`/`ts` only: lint,
> unit tests, coverage, dependency scan (SCA), secret scan. `python`,
> `flutter`, and `unity` are accepted as valid `language` values but every
> check hard-fails them with "not yet implemented in this version."

## How to consume this repo

Call the reusable workflow from a consumer repo's own `.github/workflows/ci.yml`:

```yaml
jobs:
  ci:
    uses: <org>/Github-Runner/.github/workflows/central-ci.yml@v1
    with:
      language: ts
      enable_lint: true
      enable_unit_test: true
      enable_coverage: true
      enable_dependency_scan: true
      enable_secret_scan: true
```

See [docs/consumers/typescript.md](docs/consumers/typescript.md) for full,
copy-paste consumer workflows (lint-only, security-only, and full-suite
variants) with the branch-scoping expressions each check needs.

Consumer repos own their own trigger and branch policy (see
[docs/CHECK-POLICY.md](docs/CHECK-POLICY.md)) — branch-specific logic
belongs in the consumer's own `ci.yml` via expressions on the flags below,
not in this repo.

## Supported languages

`js` | `ts` | `python` | `flutter` | `unity`

Build order: TS/JS → Python → Flutter → Unity. Only TS/JS are implemented
so far.

## Available flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `language` | string | *(required)* | Language to run checks for. One of: `js`, `ts`, `python`, `flutter`, `unity`. |
| `working_dir` | string | `.` | Directory containing the project to check, relative to the consumer repo root. |
| `runner_label` | string | `ubuntu-latest` | Runner label the jobs execute on. |
| `enable_lint` | boolean | `true` | Run the lint check ([.github/actions/lint](.github/actions/lint)). |
| `enable_unit_test` | boolean | `true` | Run the unit-test check ([.github/actions/unit-test](.github/actions/unit-test)). Must be `true` if `enable_coverage` is `true`. |
| `enable_coverage` | boolean | `true` | Run the coverage check ([.github/actions/coverage](.github/actions/coverage)). Requires `enable_unit_test: true` — coverage is parsed from the unit-test run's output, it never runs tests itself. |
| `enable_dependency_scan` | boolean | `true` | Run the dependency-scan (SCA) check ([.github/actions/dependency-scan](.github/actions/dependency-scan)). |
| `enable_secret_scan` | boolean | `true` | Run the secret-scan check ([.github/actions/secret-scan](.github/actions/secret-scan)). Language-agnostic. |
| `coverage_threshold` | number | `80` | Minimum required "lines" coverage percentage, when `enable_coverage` is `true`. |

## Versioning

Releases are tagged `vX.Y.Z`, with a moving major tag (`v1`) pointing at
the latest compatible release. A breaking change gets a new major tag; the
previous major keeps working. This repo's own internal `uses:` references
(workflow → actions) use the same ref the consumer called.
