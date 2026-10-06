#!/bin/zsh
# heavy-lock.sh — run ONE heavy job at a time across every process on this machine.
#
# Usage:  scripts/dev/heavy-lock.sh <command> [args…]
#   e.g.  scripts/dev/heavy-lock.sh scripts/dev/with-node.sh npm run test:coverage
#
# Heavy = `npm ci`/`npm install`, full test/coverage runs, `npm run build`, process
# tests, bulk data passes. Unit tests for one module are NOT heavy.
#
# Why: the development machine rebooted twice on 2026-09-29 under overlapping heavy jobs.
# The default lock path is outside the checkout and shared machine-wide, so heavy jobs from
# other checkouts that use the same lock never overlap with these either. Set HEAVY_LOCK_DIR
# (or, per clone and untracked, `git config dev.heavyLockDir <path>`) to share one lock with any
# other script that serialises heavy jobs the same way.
# The lock is an atomic `mkdir`; a lock whose owner PID is dead is stolen; the wait is
# bounded (MAX_WAIT_S, default 90 min) — every wait ends. Released on exit, even on failure.
set -uo pipefail
LOCK=${HEAVY_LOCK_DIR:-$(git -C "${0:A:h}" config --get dev.heavyLockDir 2>/dev/null || true)}
LOCK=${LOCK:-$HOME/.cache/heavy-lock/.heavy.lock}
MAX_WAIT_S=${MAX_WAIT_S:-5400}
mkdir -p "${LOCK:h}"
waited=0
until mkdir "$LOCK" 2>/dev/null; do
  owner=$(cat "$LOCK/pid" 2>/dev/null || true)
  if [[ -n $owner ]] && ! kill -0 "$owner" 2>/dev/null; then
    print -u2 "heavy-lock: stealing stale lock from dead pid $owner"; rm -rf "$LOCK"; continue
  fi
  (( waited >= MAX_WAIT_S )) && { print -u2 "heavy-lock: gave up after ${waited}s; held by pid $owner ($(cat $LOCK/cmd 2>/dev/null))"; exit 75; }
  (( waited % 300 == 0 )) && print -u2 "heavy-lock: waiting (${waited}s) — held by pid $owner: $(cat $LOCK/cmd 2>/dev/null)"
  sleep 10; waited=$((waited + 10))
done
print $$ > "$LOCK/pid"; print -r -- "$*" > "$LOCK/cmd"; date > "$LOCK/since"
trap 'rm -rf "$LOCK"' EXIT INT TERM HUP
"$@"
