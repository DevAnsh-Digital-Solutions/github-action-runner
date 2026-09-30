# Github-Runner

Central GitHub Actions automation repo. Holds reusable composite actions
(one check each) and a single reusable workflow that orchestrates them.
Any repo in the org calls the reusable workflow with boolean flags to
enable the checks it wants.

This repo contains no application code — only CI definitions, helper
scripts, and tests for those scripts.

> **Status:** Phase 2. Checks are implemented for `js`/`ts` and `python`:
> lint, unit tests, coverage, dependency scan (SCA), secret scan.
> `flutter` and `unity` are accepted as valid `language` values but every
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

See [docs/consumers/typescript.md](docs/consumers/typescript.md) and
[docs/consumers/python.md](docs/consumers/python.md) for full, copy-paste
consumer workflows (lint-only, security-only, and full-suite variants) with
the branch-scoping expressions each check needs.

Consumer repos own their own trigger and branch policy (see
[docs/CHECK-POLICY.md](docs/CHECK-POLICY.md)) — branch-specific logic
belongs in the consumer's own `ci.yml` via expressions on the flags below,
not in this repo.

## Supported languages

`js` | `ts` | `python` | `flutter` | `unity`

Build order: TS/JS → Python → Flutter → Unity. TS/JS and Python are
implemented so far.

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
| `python_version` | string | `3.12` | Python version installed when `language: python` (passed to `actions/setup-python`). Ignored for other languages. |

## What each check does, per language

| Check | `js` / `ts` | `python` |
|---|---|---|
| Setup | `actions/setup-node` + install from the lockfile (npm / pnpm / yarn) | `actions/setup-python` with pip caching; installs `requirements.txt`, or `pyproject.toml` (`pip install -e ".[dev]"`) when there is no `requirements.txt`. Fails if neither exists. |
| Lint | ESLint → SARIF | `ruff check` → SARIF (rules come from the project's own `pyproject.toml` / `ruff.toml`) |
| Unit test | Jest or Vitest (auto-detected) | `pytest` (JUnit XML for the summary); fails if pytest is not installed or no tests are collected |
| Coverage | lcov / Istanbul json-summary, gated on *lines* | `pytest-cov` Cobertura XML (`coverage/coverage.xml`), gated on *lines*; needs `pytest-cov` installed |
| Dependency scan | `osv-scanner` on `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` | `osv-scanner` on every one of `requirements.txt` / `poetry.lock` / `Pipfile.lock` present; fails naming those files if none exists |
| Secret scan | Gitleaks (language-agnostic, runs unchanged) | same |

Tools the checks run (ESLint, Jest, ruff, pytest, pytest-cov, …) must be
declared in the project's own dependency file — the setup action installs
what the project pins and nothing else, so CI uses the same versions as
developers do.

### Dependency-scan output

A failing dependency scan prints a table, highest severity first, both in the
job summary and in the log of the final *Enforce* step (under the failure
message, which says what to run to fix it):

| Severity | Package | Installed | Vulnerability | Fixed in |
|---|---|---|---|---|
| HIGH | urllib3 | 1.26.4 | GHSA-… (CVE-…) | 1.26.5 |

One row is one real vulnerability: GHSA-/PYSEC-/CVE- records that alias each
other are merged. The check blocks on `HIGH`/`CRITICAL` by default; findings
whose advisory carries no severity are listed as `UNKNOWN` and never block.
## Versioning

Releases are tagged `vX.Y.Z`, with a moving major tag (`v1`) pointing at
the latest compatible release. A breaking change gets a new major tag; the
previous major keeps working. This repo's own internal `uses:` references
(workflow → actions) use the same ref the consumer called.
