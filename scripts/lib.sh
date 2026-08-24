#!/usr/bin/env bash
# scripts/lib.sh
#
# Shared bash helpers sourced by composite actions under .github/actions/.
# Keeps error handling and $GITHUB_STEP_SUMMARY output consistent across
# every check instead of each action reimplementing it.
#
# Usage (from a composite action's run step, e.g. .github/actions/<name>/action.yml):
#   source "${GITHUB_ACTION_PATH}/../../../scripts/lib.sh"
#
# Requires: bash. No other tools.

set -euo pipefail

# die MESSAGE
# Print MESSAGE to stderr as a GitHub Actions error annotation and exit
# non-zero. Callers use this for both check failures (a real finding) and
# infrastructure failures (network, missing license, rate limit) — the
# wording of MESSAGE is what distinguishes them to a human reading the log.
die() {
  local message="$1"
  echo "::error::${message}" >&2
  exit 1
}

# require_cmd COMMAND [INSTALL_HINT]
# Verify COMMAND is on PATH, or die with install guidance. Prevents a step
# from failing later with an opaque "command not found" partway through a
# check, instead naming exactly what's missing and how to fix it up front.
require_cmd() {
  local cmd="$1"
  local hint="${2:-install ${cmd} and ensure it is on PATH}"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    die "required command '${cmd}' not found. ${hint}"
  fi
}

# require_file PATH
# Verify PATH exists as a regular file, or die naming the missing file.
require_file() {
  local path="$1"
  if [ ! -f "${path}" ]; then
    die "required file '${path}' not found"
  fi
}

# summary LINE
# Append LINE to the job's step summary. No-ops with a stderr warning (does
# not fail the step) if $GITHUB_STEP_SUMMARY isn't set, e.g. when a script
# is run locally outside of a GitHub Actions job.
summary() {
  local line="$1"
  if [ -z "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "warning: GITHUB_STEP_SUMMARY not set, skipping summary line" >&2
    return 0
  fi
  echo "${line}" >> "${GITHUB_STEP_SUMMARY}"
}

# detect_package_manager DIR
# Print "npm", "pnpm", or "yarn" depending on which lockfile is present in
# DIR (checked in that priority order), or die naming all three accepted
# lockfiles if none is found. Shared by any composite action that needs to
# install or identify JS/TS dependencies, so the detection rule can't drift
# between them.
detect_package_manager() {
  local dir="$1"
  if [ -f "${dir}/package-lock.json" ]; then
    echo "npm"
  elif [ -f "${dir}/pnpm-lock.yaml" ]; then
    echo "pnpm"
  elif [ -f "${dir}/yarn.lock" ]; then
    echo "yarn"
  else
    die "no lockfile found in '${dir}'. Commit one of package-lock.json, pnpm-lock.yaml, or yarn.lock so installs are reproducible."
  fi
}
