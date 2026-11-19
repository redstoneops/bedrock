#!/usr/bin/env bash
# Shallow-clone (or update) Bedrock's reference repositories into ./refs.
#
# refs/ is gitignored. These repos are read-only learning material:
# never import from refs/ at runtime and never commit it.
# See docs/refs.md for what to study in each one.
#
# Usage:
#   scripts/fetch-refs.sh            # clone/update all refs
#   scripts/fetch-refs.sh pi codex   # clone/update only the named refs
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REFS_DIR="${ROOT}/refs"
mkdir -p "${REFS_DIR}"

# name|url  (keep in sync with docs/refs.md)
REFS=(
  "pi|https://github.com/earendil-works/pi"
  "oh-my-pi|https://github.com/can1357/oh-my-pi"
  "prime-agent|https://github.com/PrimeIntellect-ai/prime-agent"
  "codex|https://github.com/openai/codex"
  "opencode|https://github.com/anomalyco/opencode"
  "ace|https://github.com/ace-agent/ace"
  "swe-agent|https://github.com/SWE-agent/SWE-agent"
  "openhands|https://github.com/All-Hands-AI/OpenHands"
  "terminal-bench|https://github.com/laude-institute/terminal-bench"
  "kira|https://github.com/krafton-ai/KIRA"
  "meta-harness|https://github.com/stanford-iris-lab/meta-harness-tbench2-artifact"
  "impossiblebench|https://github.com/safety-research/impossiblebench"
  "camel|https://github.com/google-research/camel-prompt-injection"
  "moatless-tree-search|https://github.com/aorwall/moatless-tree-search"
  "dgm|https://github.com/jennyzzt/dgm"
)

want() {
  local name="$1"
  shift
  if [ "$#" -eq 0 ]; then return 0; fi
  for w in "$@"; do
    if [ "$w" = "$name" ]; then return 0; fi
  done
  return 1
}

failed=()
for entry in "${REFS[@]}"; do
  name="${entry%%|*}"
  url="${entry#*|}"
  want "${name}" "$@" || continue
  dest="${REFS_DIR}/${name}"
  if [ -d "${dest}/.git" ]; then
    echo "==> updating ${name}"
    if ! (git -C "${dest}" fetch --depth 1 origin HEAD && git -C "${dest}" reset --hard FETCH_HEAD) >/dev/null 2>&1; then
      echo "    !! update failed for ${name}" >&2
      failed+=("${name}")
    fi
  else
    echo "==> cloning ${name} <- ${url}"
    if ! git clone --depth 1 --quiet "${url}" "${dest}"; then
      echo "    !! clone failed for ${name} (moved? search for the canonical repo and update this script + docs/refs.md)" >&2
      failed+=("${name}")
    fi
  fi
done

if [ "${#failed[@]}" -gt 0 ]; then
  echo "Failed: ${failed[*]}" >&2
  exit 1
fi
echo "All refs up to date in ${REFS_DIR}"
