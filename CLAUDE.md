# CLAUDE.md — Github RUnner

## What this repo is

Central GitHub Actions automation repo. Holds reusable **composite actions** (one check each) and one **reusable workflow** (`workflow_call`) that orchestrates them. Any repo in the org calls the reusable workflow with boolean flags to enable the checks it wants.

This repo contains **no application code**. It only contains CI definitions, helper scripts, and tests for those scripts.

## Architecture rules — do not violate

1. **One composite action per check.** Each lives in `.github/actions/<check-name>/action.yml`. A check never knows about other checks.
2. **One reusable workflow** at `.github/workflows/central-ci.yml`. It is the only entry point for consumer repos. It wires composite actions into jobs and exposes inputs/secrets.
3. **Language handling is internal to each composite action.** Take a `language` input, dispatch with a `case` block. Never create per-language copies of the reusable workflow.
4. **Consumer repos own their trigger/branch policy.** Branch-specific logic lives in the consumer's own `ci.yml` via expressions on `with:` flags. The central workflow stays branch-agnostic.
5. **Every check is behind a boolean flag**, defaulting to a sensible value. A repo must be able to enable exactly one check and nothing else.

## Supported languages

`js` | `ts` | `python` | `flutter` | `unity`

Build order: TS/JS → Python → Flutter → Unity. Do not start a later language until the earlier one is reviewed and approved.

## Non-negotiable engineering standards

### Error handling
- Every shell step starts with `set -euo pipefail`.
- Never let a step pass silently because a tool was missing. Verify the tool/file exists, fail with a clear message naming the missing thing and how to fix it.
- Distinguish **check failure** (real finding → non-zero exit) from **infrastructure failure** (network, missing license, rate limit → clear error message, and fail-open only where explicitly marked advisory).
- Unsupported `language` value = hard fail with the list of supported values. Never default silently.
- All thresholds are inputs, never hardcoded magic numbers.

### Comments
- Every `action.yml` opens with a comment block: what it does, which languages it supports, what it needs (inputs/secrets/tools), and what it exits non-zero on.
- Every `case` branch gets a one-line comment naming the tool used.
- Every non-obvious shell line gets a comment explaining *why*, not *what*.

### Security
- Pin every third-party `uses:` to a full commit SHA with a `# vX.Y.Z` trailing comment. Never a floating tag.
- Declare minimal `permissions:` on every job. Default to `contents: read`.
- Never use `pull_request_target`. Never echo secrets. Never interpolate untrusted input (PR title/body/diff) directly into a shell command — write to a file and pass the path.
- LLM steps treat PR content as untrusted data. LLM jobs get `pull-requests: write` at most, never `contents: write`.

### Output
- Every scanner that can emit SARIF must emit SARIF and upload it via `github/codeql-action/upload-sarif`.
- Every check writes a short human-readable summary to `$GITHUB_STEP_SUMMARY`.

## Check policy — trigger scope and blocking behavior

This table is the source of truth. Implement defaults to match it.

| Check | Runs on | Blocking? |
|---|---|---|
| Lint | Every PR, all target branches | Blocking |
| Unit tests | Every PR, all target branches | Blocking |
| Coverage threshold | Every PR, all target branches | Blocking |
| Secret scan | Every PR + push to `main` | Blocking |
| Dependency scan (SCA) | Every PR + nightly on `main` | Blocking on HIGH/CRITICAL |
| SAST | PRs targeting `main`/`release/*` + nightly | Blocking on CRITICAL, advisory below |
| IaC scan | PRs touching IaC paths only | Blocking |
| LLM PR review | PRs targeting `main` only | **Advisory — never blocking** |
| SBOM generation | Push/tag on `main` | Non-blocking artifact |

Rationale to preserve: deterministic tools block; non-deterministic (LLM) tools comment only. Expensive/slow checks are reserved for `main`-targeting PRs so feature-branch iteration stays fast.

## Versioning

- Tag releases `vX.Y.Z`. Maintain a moving major tag (`v1`) pointing at the latest compatible release.
- Breaking change = new major tag. Keep the previous major working.
- Internal `uses:` references between this repo's own workflow and actions use the same ref the consumer called.

## Testing expectations

- Helper scripts (coverage parsing, threshold checks, LLM client) get unit tests.
- Each phase must be validated against a real consumer repo before being considered done.
- `actionlint` must pass on all workflow/action YAML.

## Definition of done for any phase

- [ ] All new YAML passes `actionlint`
- [ ] Every shell step has `set -euo pipefail` and explicit error messages
- [ ] Every third-party action pinned to a SHA
- [ ] Comment blocks present per the standard above
- [ ] Validated on a real consumer repo PR (green path AND deliberately-failing path)
- [ ] `README.md` updated with the new inputs/flags
- [ ] **Stop and wait for human review. Do not begin the next phase.**