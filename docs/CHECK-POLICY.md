# Check Policy

This is the source of truth for when each check runs and whether it blocks
a PR. Composite actions and the reusable workflow (`central-ci.yml`) must
implement defaults that match this table. If you change a default, update
this file in the same PR.

| Check | Runs on | Blocking? |
|---|---|---|
| Lint | Every PR, all target branches | Blocking |
| Unit tests | Every PR, all target branches | Blocking |
| Coverage threshold | Every PR, all target branches | Blocking |
| Secret scan | Every PR + push to `main` | Blocking |
| Dependency scan (SCA) | Every PR + nightly on `main` | Blocking on HIGH/CRITICAL |
| SAST | PRs targeting `main`/`release/*` + nightly | Blocking on CRITICAL, advisory below |
| IaC scan | PRs touching IaC paths only | Blocking |
| LLM PR review | PRs targeting `main` only | Advisory — never blocking |
| SBOM generation | Push/tag on `main` | Non-blocking artifact |

## Why each row is scoped the way it is

**Lint, unit tests, coverage threshold** run on every PR against every
target branch and block merge. These are cheap, deterministic, and catch
the class of bug or regression that should never reach any branch,
including short-lived feature branches. There's no scope where skipping
them is safe.

**Secret scan** runs on every PR and on push to `main`. A leaked secret is
damaging the moment it lands in history, not just when it reaches `main`,
so PRs are covered too. The push-to-`main` trigger catches anything that
slips in via a route that bypasses PR review (e.g. a direct push with
admin override).

**Dependency scan (SCA)** blocks on HIGH/CRITICAL findings on every PR, plus
a nightly run on `main`. PR-time scanning stops a vulnerable dependency
from being introduced; the nightly run catches vulnerabilities newly
disclosed in dependencies that were already merged and clean at the time.
Only HIGH/CRITICAL block, so the check doesn't become noisy enough to get
ignored.

**SAST** is scoped to PRs targeting `main`/`release/*`, plus nightly, because
static analysis is comparatively slow and most valuable at the point code
is about to become shippable. Feature-branch iteration stays fast; the
check still runs before code reaches a branch that matters. Only CRITICAL
findings block — everything else is advisory so the check doesn't stall
merges on findings that need human judgment to triage.

**IaC scan** runs only on PRs that touch IaC paths, and blocks. Scoping to
touched paths keeps the check cheap and relevant; it blocks because
infrastructure misconfiguration (e.g. an open security group) is as
consequential as an application bug and deterministic to detect.

**LLM PR review** runs only on PRs targeting `main` and is always advisory,
never blocking. LLM output is non-deterministic — gating merges on it would
make CI flaky and erode trust in the check. It still adds value as a
second set of eyes on the PRs that matter most.

**SBOM generation** runs on push/tag to `main` and produces a non-blocking
artifact. It's a compliance/traceability output, not a gate — generating it
after merge, on the code that actually shipped, is more meaningful than
generating one for every in-flight PR.

## General rationale

Deterministic tools block; non-deterministic (LLM) tools comment only.
Expensive or slow checks are reserved for `main`-targeting PRs so
feature-branch iteration stays fast.
