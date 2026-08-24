# Github-Runner

Central GitHub Actions automation repo. Holds reusable composite actions
(one check each) and a single reusable workflow that orchestrates them.
Any repo in the org calls the reusable workflow with boolean flags to
enable the checks it wants.

This repo contains no application code — only CI definitions, helper
scripts, and tests for those scripts.

> **Status:** Phase 0 (scaffold). The reusable workflow currently only
> validates its `language` input; no checks are wired up yet.

## How to consume this repo

Call the reusable workflow from a consumer repo's own `.github/workflows/ci.yml`:

```yaml
jobs:
  ci:
    uses: <org>/Github-Runner/.github/workflows/central-ci.yml@v1
    with:
      language: js
```

Consumer repos own their own trigger and branch policy (see
[docs/CHECK-POLICY.md](docs/CHECK-POLICY.md)) — branch-specific logic
belongs in the consumer's own `ci.yml` via expressions on the flags below,
not in this repo.

## Supported languages

`js` | `ts` | `python` | `flutter` | `unity`

Build order: TS/JS → Python → Flutter → Unity.

## Available flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `language` | string | *(required)* | Language to run checks for. One of: `js`, `ts`, `python`, `flutter`, `unity`. |
| `working_dir` | string | `.` | Directory containing the project to check, relative to the consumer repo root. |
| `runner_label` | string | `ubuntu-latest` | Runner label the jobs execute on. |

Per-check boolean flags will be added here as each check is implemented.

## Versioning

Releases are tagged `vX.Y.Z`, with a moving major tag (`v1`) pointing at
the latest compatible release. A breaking change gets a new major tag; the
previous major keeps working. This repo's own internal `uses:` references
(workflow → actions) use the same ref the consumer called.
