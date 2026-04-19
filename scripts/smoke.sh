#!/usr/bin/env bash
# scripts/smoke.sh — end-to-end smoke test for cordyceps.
#
# Runs the daemon, spawns a Claude agent (default profile — uses your normal
# Claude auth), submits a tiny prompt, verifies output, cleans up.
#
# Usage:
#   scripts/smoke.sh              # default profile (normal Claude env)
#   scripts/smoke.sh deterministic # deterministic profile (--bare; needs API key)
#
# Exit codes:
#   0 — all pass
#   1 — failure
#   2 — claude not installed (skipped)

set -euo pipefail

PROFILE="${1:-default}"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
CORDY="$SCRIPT_DIR/../bin/cordy"

if ! command -v claude >/dev/null 2>&1; then
  echo "[smoke] claude not found on PATH — skipping" >&2
  exit 2
fi

cleanup() {
  "$CORDY" daemon status >/dev/null 2>&1 && "$CORDY" daemon stop >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[smoke] Starting daemon..."
"$CORDY" daemon start

echo "[smoke] Doctor:"
"$CORDY" doctor

echo "[smoke] Spawning Claude agent (profile=$PROFILE)..."
SPAWN_ARGS=(spawn claude --name smoke)
if [ "$PROFILE" = "deterministic" ]; then
  SPAWN_ARGS+=(--profile deterministic)
fi
"$CORDY" "${SPAWN_ARGS[@]}"

echo "[smoke] Listing:"
"$CORDY" list

echo "[smoke] Sending prompt..."
RESPONSE="$("$CORDY" send smoke "respond with exactly: BANANA-SMOKE-OK")"
echo "$RESPONSE"

if echo "$RESPONSE" | grep -q "BANANA-SMOKE-OK"; then
  echo "[smoke] ✓ Response contained expected token."
else
  echo "[smoke] ✗ Response did NOT contain expected token." >&2
  exit 1
fi

echo "[smoke] Killing agent + stopping daemon."
"$CORDY" kill smoke
"$CORDY" daemon stop

echo "[smoke] All good."
