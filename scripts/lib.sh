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
# Print LINE to the step's own log (so it's visible scrolling the run like
# any other CI output, no click into the Summary tab required), and also
# append it to the job's step summary. The step-summary append no-ops with
# a stderr warning (does not fail the step) if $GITHUB_STEP_SUMMARY isn't
# set, e.g. when a script is run locally outside of a GitHub Actions job —
# the console echo still happens in that case.
summary() {
  local line="$1"
  echo "${line}"
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

# detect_python_install_source DIR
# Print "requirements.txt" or "pyproject.toml" — the file pip should install
# from and that setup-python should key its cache on — or die naming both
# accepted files if neither is in DIR. requirements.txt wins when both exist:
# it is the more explicit, reproducible of the two.
detect_python_install_source() {
  local dir="$1"
  if [ -f "${dir}/requirements.txt" ]; then
    echo "requirements.txt"
  elif [ -f "${dir}/pyproject.toml" ]; then
    echo "pyproject.toml"
  else
    die "no Python dependency file found in '${dir}'. Commit a requirements.txt or a pyproject.toml so installs are reproducible."
  fi
}

# detect_python_scan_files DIR
# Print, space-separated, every Python dependency file osv-scanner can read
# that is present in DIR (requirements.txt, poetry.lock, Pipfile.lock), or die
# naming all three if none is. Unlike detect_python_install_source this does
# not pick one: a repo with both a lockfile and a requirements.txt should have
# both scanned, since either can pin a vulnerable version.
detect_python_scan_files() {
  local dir="$1"
  local found=""
  local candidate
  for candidate in requirements.txt poetry.lock Pipfile.lock; do
    if [ -f "${dir}/${candidate}" ]; then
      found="${found:+${found} }${candidate}"
    fi
  done
  if [ -z "${found}" ]; then
    die "no Python dependency file found in '${dir}' for the dependency scan. Commit one of requirements.txt, poetry.lock, or Pipfile.lock (pin exact versions with == so they can be scanned)."
  fi
  echo "${found}"
}
