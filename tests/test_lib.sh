#!/usr/bin/env bash
# tests/test_lib.sh
#
# Unit tests for scripts/lib.sh. Run directly: bash tests/test_lib.sh
# No external test framework: die()/require_cmd()/require_file() all call
# exit() on failure, so each case runs the function under test in its own
# `bash -c` subshell (via run_case) rather than sourcing lib.sh into this
# script's own shell, which would kill the test run on the first failure case.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
lib_path="${script_dir}/../scripts/lib.sh"

failures=0
last_output=""

# run_case DESCRIPTION EXPECTED_EXIT COMMAND
# Runs COMMAND (a bash -c string) in a subshell, records its combined
# stdout+stderr in $last_output, and compares the exit code to EXPECTED_EXIT.
run_case() {
  local description="$1"
  local expected_exit="$2"
  local command="$3"
  local exit_code=0
  last_output="$(bash -c "${command}" 2>&1)" || exit_code=$?
  if [ "${exit_code}" -eq "${expected_exit}" ]; then
    echo "PASS: ${description}"
  else
    echo "FAIL: ${description} (expected exit ${expected_exit}, got ${exit_code})"
    echo "  output: ${last_output}"
    failures=$((failures + 1))
  fi
}

# assert_contains DESCRIPTION NEEDLE
# Checks that $last_output, as set by the preceding run_case, contains NEEDLE.
assert_contains() {
  local description="$1"
  local needle="$2"
  case "${last_output}" in
    *"${needle}"*)
      echo "PASS: ${description}"
      ;;
    *)
      echo "FAIL: ${description} (expected output to contain '${needle}')"
      echo "  output: ${last_output}"
      failures=$((failures + 1))
      ;;
  esac
}

# --- die() ---
run_case "die exits 1" 1 "source '${lib_path}'; die 'boom'"
assert_contains "die prints a ::error:: annotation" "::error::boom"

# --- require_cmd() ---
run_case "require_cmd passes for an existing command" 0 \
  "source '${lib_path}'; require_cmd bash"

run_case "require_cmd fails for a missing command" 1 \
  "source '${lib_path}'; require_cmd definitely-not-a-real-command-xyz 'install it from example.test'"
assert_contains "require_cmd's failure includes the install hint" "install it from example.test"

# --- require_file() ---
run_case "require_file passes for an existing file" 0 \
  "source '${lib_path}'; require_file '${script_dir}/test_lib.sh'"

run_case "require_file fails for a missing file" 1 \
  "source '${lib_path}'; require_file '${script_dir}/does-not-exist.txt'"
assert_contains "require_file's failure names the missing file" "does-not-exist.txt"

# --- summary() ---
summary_file="$(mktemp)"
run_case "summary appends when GITHUB_STEP_SUMMARY is set" 0 \
  "source '${lib_path}'; GITHUB_STEP_SUMMARY='${summary_file}' summary 'hello from test'"
if grep -q "hello from test" "${summary_file}"; then
  echo "PASS: summary wrote the line to GITHUB_STEP_SUMMARY"
else
  echo "FAIL: summary did not write the line to GITHUB_STEP_SUMMARY"
  failures=$((failures + 1))
fi
assert_contains "summary also echoes the line to the step's own log" "hello from test"
rm -f "${summary_file}"

run_case "summary no-ops (exit 0) when GITHUB_STEP_SUMMARY is unset" 0 \
  "unset GITHUB_STEP_SUMMARY; source '${lib_path}'; summary 'still visible in the log'"
assert_contains "summary still echoes to the log when GITHUB_STEP_SUMMARY is unset" "still visible in the log"

# --- detect_package_manager() ---
pm_dir="$(mktemp -d)"

touch "${pm_dir}/package-lock.json"
run_case "detect_package_manager finds npm" 0 \
  "source '${lib_path}'; [ \"\$(detect_package_manager '${pm_dir}')\" = npm ]"
rm -f "${pm_dir}/package-lock.json"

touch "${pm_dir}/pnpm-lock.yaml"
run_case "detect_package_manager finds pnpm" 0 \
  "source '${lib_path}'; [ \"\$(detect_package_manager '${pm_dir}')\" = pnpm ]"
rm -f "${pm_dir}/pnpm-lock.yaml"

touch "${pm_dir}/yarn.lock"
run_case "detect_package_manager finds yarn" 0 \
  "source '${lib_path}'; [ \"\$(detect_package_manager '${pm_dir}')\" = yarn ]"
rm -f "${pm_dir}/yarn.lock"

run_case "detect_package_manager dies with no lockfile" 1 \
  "source '${lib_path}'; detect_package_manager '${pm_dir}'"
assert_contains "detect_package_manager names all three accepted lockfiles" "package-lock.json, pnpm-lock.yaml, or yarn.lock"

rm -rf "${pm_dir}"

if [ "${failures}" -eq 0 ]; then
  echo "All tests passed."
  exit 0
else
  echo "${failures} test(s) failed."
  exit 1
fi
