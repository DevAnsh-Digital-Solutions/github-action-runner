# Changelog

All notable changes to this repo. Versions follow `vX.Y.Z`; the moving major
tag `v1` points at the latest `v1.x.y` (see
[README → Versioning and releases](README.md#versioning-and-releases)).

---

## Unreleased — advisory AI review (branch `Feature/LLM-Review`, pre-release `v1.1.0-rc.3`)

Not yet tagged; becomes part of the next release once validated.

- **New check: AI review** (`enable_llm_review`, default `false`). A new
  composite action `.github/actions/llm-review/` and two jobs in
  `central-ci.yml`: `llm-preflight` (verifies the `ai_token` secret and the
  provider settings before anything is sent) and `llm-review` (reviews the PR
  diff plus the lint, unit-test and coverage outputs and posts one marked,
  checkbox-style PR comment that is updated on each push). Advisory: both jobs
  are `continue-on-error`, and the review job has `pull-requests: write` only.
- **Any model.** `llm_provider` (`openai-compatible`, `anthropic`, `gemini`),
  `llm_base_url`, `llm_model`. Groq, OpenRouter, Ollama, Gemini's OpenAI
  endpoint etc. work through `openai-compatible`. Unit-tested against a fake
  `fetch` and a local mock server; live validation against OpenAI and Gemini
  on the consumer repos is still pending.
- New inputs: `enable_llm_review`, `llm_provider`, `llm_base_url`,
  `llm_model`, `llm_max_output_tokens`, `llm_timeout_seconds`,
  `llm_max_diff_kb`, `llm_max_findings`, `llm_exclude_paths`. New optional
  secret: `ai_token`.
- New scripts `scripts/llm-client.mjs` and `scripts/llm-review.mjs` with unit
  tests `tests/test_llm-client.mjs` and `tests/test_llm-review.mjs`.
- `unit-test` now also uploads the raw runner report as the
  `unit-test-results` artifact (additive; used by the AI review).
- `docs/CHECK-POLICY.md`: the LLM review row now reads "branches a consumer
  opts in (recommended: `main`)" instead of "`main` only".

---

## v1.0.0 — DRAFT, not yet tagged

> **Status:** release candidate `v1.1.0-rc.2`. Becomes `v1.0.0` once the
> validation checklist at the bottom is complete and the release is approved.
> (The `-rc` tags were named before the first stable version was settled.
> `v1.0.0` is the first stable release, and the rc tags are its candidates.)

The first stable release of the org's central CI. A consumer repo calls one
reusable workflow, turns checks on with boolean flags, and gets five
blocking checks for **JavaScript, TypeScript and Python** with the same
summaries, annotations and SARIF output everywhere.

```yaml
jobs:
  ci:
    uses: DevAnsh-Digital-Solutions/github-action-runner/.github/workflows/central-ci.yml@v1
    with:
      language: python   # js | ts | python
```

### What v1.0.0 contains

#### Reusable workflow: `central-ci.yml`

- The single entry point for consumers (`workflow_call`).
- Inputs: `language`, `working_dir`, `runner_label`, `enable_lint`,
  `enable_unit_test`, `enable_coverage`, `enable_dependency_scan`,
  `enable_secret_scan`, `coverage_threshold` (default `80`),
  `python_version` (default `3.12`).
- Every check sits behind its own flag. Enabling exactly one check runs
  exactly that check.
- A `validate-inputs` job fails fast on an unsupported `language` (and lists
  the supported ones) or on coverage enabled without unit tests.
- Branch-agnostic. Each consumer owns its triggers and branch policy.

#### Languages

| Language | Support |
|---|---|
| `js`, `ts` | All five checks |
| `python` | All five checks |
| `flutter`, `unity` | Accepted as values; every check hard-fails with "not yet implemented" |

#### Checks

| Check | JS / TS | Python | Blocks on |
|---|---|---|---|
| Setup | `actions/setup-node`; installs from the npm / pnpm / yarn lockfile | `actions/setup-python` with pip cache; installs `requirements.txt`, or `pyproject.toml` with the `dev` extra | missing lockfile / dependency file, failed install |
| Lint | ESLint → SARIF (`@microsoft/eslint-formatter-sarif` 3.1.0) | `ruff check` → SARIF, paths made repo-relative | findings (ESLint: `error` and up) |
| Unit test | Jest or Vitest, auto-detected | `pytest`, JUnit summary + per-failure annotations | failing tests, no tests collected, runner missing |
| Coverage | lcov / Istanbul json-summary | `pytest-cov` Cobertura XML | line coverage < `coverage_threshold` |
| Dependency scan | osv-scanner 2.5.1 on the lockfile | osv-scanner on `requirements.txt` / `poetry.lock` / `Pipfile.lock` | HIGH or CRITICAL vulnerability |
| Secret scan | Gitleaks 8.30.1 | same | any finding |

Behaviour shared by every check:

- **Findings and crashes are kept apart.** A real problem and a broken
  tool / config / network both fail the job, but the message says which one
  it was. Nothing passes because a tool was missing or produced no output.
- **Readable output.** A job-summary table, up to 15 inline annotations on
  the PR diff, and a final *Enforce* step that says what to do.
- **SARIF.** Lint, dependency scan and secret scan upload SARIF to the
  Security tab (where GitHub Code Security is available; otherwise the step
  warns and continues), and always as a downloadable artifact:
  `lint-sarif`, `dependency-scan-sarif`, `secret-scan-sarif` (30 days).
  Unit test publishes `coverage-report` (7 days) for the coverage job.

Dependency-scan specifics:

- One row per real vulnerability: GHSA / PYSEC / CVE records that alias each
  other are merged.
- A table of **Severity | Package | Installed | Vulnerability | Fixed in**,
  highest severity first, appears in the job summary *and* in the *Enforce*
  step's log, under a failure message that says which command fixes it
  (npm / pnpm / yarn, or pip / poetry / pipenv).
- Advisories with no usable severity are listed as `UNKNOWN` and never block.

Secret-scan specifics:

- `pull_request`: scans only the PR's commits (`base..head`).
- `push`: scans the full history reachable from the pushed commit, never
  other branches.
- Matched values are always redacted (`--redact`).

#### Security

- Every third-party action pinned to a full commit SHA:
  `actions/checkout` v7.0.1, `actions/setup-node` v7.0.0,
  `actions/setup-python` v7.0.0, `actions/upload-artifact` v7.0.1,
  `actions/download-artifact` v8.0.1,
  `github/codeql-action/upload-sarif` v4.37.8.
- Downloaded binaries (osv-scanner, gitleaks) are pinned by version and
  verified against a SHA-256 before they run.
- Least-privilege `permissions:` on every job (`contents: read`, plus
  `security-events: write` / `actions: read` only where SARIF is uploaded).
- Inputs and event data reach shell only through `env:`. No
  `pull_request_target`. No secrets needed beyond `GITHUB_TOKEN`.

#### Repo tooling and docs

- `self-check.yml`: actionlint on workflows, plus shellcheck on `scripts/`,
  `tests/` and every composite action's `run:` blocks.
- Helper scripts with unit tests: `parse-coverage.mjs`,
  `parse-osv-results.mjs`, `summarize-sarif.mjs`, `summarize-junit.mjs`,
  `lib.sh`.
- README, `docs/CHECK-POLICY.md`, and copy-paste consumer workflows in
  `docs/consumers/typescript.md` and `docs/consumers/python.md`.

### Fixed during the release candidates

- **rc.2:** the secret scan on `push` scanned every branch, so a secret on
  an unrelated, unmerged branch failed the scan of `main`. It now scans only
  the pushed commit's ancestry. **Do not use `v1.1.0-rc.1`.**

### Known limitations

- Linux x64 runners only (the downloaded scanner binaries are linux_amd64).
- Some action inputs are not exposed through `central-ci.yml` yet and run at
  their defaults: `fail_on` (`error`), `severity_threshold` (`HIGH`),
  `test_command`, `coverage_file`, `node_version` (`20`), `pip_extras`
  (`dev`).
- osv-scanner reads `requirements.txt` literally. Unpinned or missing
  transitive dependencies are not scanned, so pin with `pip freeze` or use a
  lockfile.
- Advisories that carry only a CVSS vector (no label or score) are reported
  as `UNKNOWN` and do not block.
- The workflow's internal action refs are pinned to this release's own tag,
  not to whatever ref the consumer called.
- `self-check.yml` does not run the script unit tests yet. They run locally.
- Not included yet (later phases): SAST, IaC scan, LLM PR review, SBOM,
  Flutter, Unity.

### Upgrading

- From `@main` or `@v1.1.0-rc.*`: change the ref to `@v1` (automatic
  `v1.x.y` fixes) or `@v1.0.0` (fixed). No input changes are needed.
- Private consumers need this repo's Settings → Actions → General → Access
  set to "Accessible from repositories in the organization".

### Validation checklist (must be complete before tagging)

- [ ] `self-check` (actionlint + shellcheck) green on `Feature/Phase-2`
- [x] Script unit tests pass locally (5 suites)
- [x] python-private: PR into `main`, all five checks green
- [x] python-private: push to `dev` runs lint only, green
- [ ] python-private: push to `main` on rc.2, all five green (confirms the secret-scan fix)
- [ ] python-private: failing PRs for lint, unit-test, coverage, dependency-scan, secret-scan each fail only their own check
- [ ] python-private: manual run with a single check runs only that check
- [ ] python-public: green PR, plus failing PRs for lint, unit-test, coverage
- [ ] Summaries, annotations and SARIF artifacts checked as readable on each run
- [ ] Release approved; `Feature/Phase-2` merged to `main`
