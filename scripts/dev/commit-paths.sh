#!/bin/zsh
# commit-paths.sh — commit EXPLICIT owned paths on the current build branch and push it,
# without touching the shared index or anyone else's uncommitted work in the same checkout.
#
# Usage (any cwd):  scripts/dev/commit-paths.sh "<conventional commit message>" <path>...
#   <path> may be a file or a directory you own; additions, edits and deletions under it
#   are included; git-ignored files never are.
#
# Refuses (nothing committed) when:
#   * the branch is main/master (build work happens on build/* branches)
#   * a path is outside the repository
#   * the change is empty, or touches a path not under the given paths
#   * scripts/dev/scan-secrets.mjs finds a secret or a personal identifier in any blob being
#     committed (exit 9) or in the commit message (exit 11, QA-2-026: the message is published
#     too), or the author/committer address is not a no-reply or reserved placeholder address
#     (exit 10, QA-1-095)
#
# How: a private index (GIT_INDEX_FILE) is built from HEAD, the paths are added to it,
# `git commit-tree` + a compare-and-swap `update-ref` move the branch, and the shared
# index is realigned for those paths only. A repo-local mkdir lock serialises commits.
set -euo pipefail
ROOT=$(git rev-parse --show-toplevel); cd "$ROOT"
(( $# >= 2 )) || { print -u2 "usage: commit-paths.sh \"<message>\" <path>..."; exit 1; }
msg=$1; shift
branch=$(git symbolic-ref --short HEAD)
[[ $branch == main || $branch == master ]] && { print -u2 "commit-paths: refusing to commit on $branch — use a build/* branch"; exit 7; }

rel=()
for p in "$@"; do
  abs=${p:A}
  [[ $abs == $ROOT/* ]] || { print -u2 "commit-paths: outside the repo: $p"; exit 1; }
  rel+=("${abs#$ROOT/}")
done

LOCK="$ROOT/.git/commit-paths.lock"
waited=0
until mkdir "$LOCK" 2>/dev/null; do
  owner=$(cat "$LOCK/pid" 2>/dev/null || true)
  if [[ -n $owner ]] && ! kill -0 "$owner" 2>/dev/null; then rm -rf "$LOCK"; continue; fi
  (( waited >= 900 )) && { print -u2 "commit-paths: lock held for ${waited}s by pid $owner"; exit 75; }
  sleep 2; waited=$((waited + 2))
done
print $$ > "$LOCK/pid"
IDX=$(mktemp -u "${TMPDIR:-/tmp}/ff-idx.XXXXXX")
ERR=$(mktemp "${TMPDIR:-/tmp}/ff-push.XXXXXX")
MSG=$(mktemp "${TMPDIR:-/tmp}/ff-msg.XXXXXX")
trap 'rm -rf "$LOCK"; rm -f "$IDX" "$ERR" "$MSG"' EXIT INT TERM HUP

PARENT=$(git rev-parse HEAD)
GIT_INDEX_FILE=$IDX git read-tree "$PARENT"
GIT_INDEX_FILE=$IDX git add -A -- "${rel[@]}"
T=$(GIT_INDEX_FILE=$IDX git write-tree)
# NUL-separated, so a name git would C-quote (non-ASCII, tab, quote) stays the real name (QA-1-088)
changed=(${(0)"$(git diff --name-only -z --no-renames "$PARENT" "$T")"})
(( ${#changed} )) || { print -u2 "commit-paths: nothing to commit under: ${rel[*]}"; exit 3; }

for c in "${changed[@]}"; do
  ok=0
  for r in "${rel[@]}"; do [[ $c == $r || $c == $r/* ]] && { ok=1; break; }; done
  (( ok )) || { print -u2 "commit-paths: unexpected path in commit: $c — nothing committed"; exit 4; }
done

# iCloud/Finder conflict copies ("types 2.ts", "coverage 2") must never be committed
for c in "${changed[@]}"; do
  base=${c:t}
  if [[ $base =~ ' [0-9]+(\.[^.]+)*$' ]]; then
    print -u2 "commit-paths: refusing a conflict-copy name (iCloud/Finder duplicate?): $c — nothing committed"; exit 8
  fi
done

# the commit identity first: a machine-derived address must never be published (QA-1-095)
"$ROOT/scripts/dev/with-node.sh" node "$ROOT/scripts/dev/scan-secrets.mjs" --identity \
  || { print -u2 "commit-paths: commit identity refused — nothing committed"; exit 10; }
# the message, scanned as the very bytes `git commit-tree` stores: it is published with the commit,
# and pushed at once below (QA-2-026)
print -r -- "$msg" > "$MSG"
"$ROOT/scripts/dev/with-node.sh" node "$ROOT/scripts/dev/scan-secrets.mjs" --message "$MSG" \
  || { print -u2 "commit-paths: commit message scan FAILED — nothing committed"; exit 11; }
# then EXACTLY the blobs being committed: the private index against HEAD (= $PARENT), read by
# object id, any status but a deletion (type changes included) — not the working-tree files
GIT_INDEX_FILE=$IDX "$ROOT/scripts/dev/with-node.sh" node "$ROOT/scripts/dev/scan-secrets.mjs" --index \
  || { print -u2 "commit-paths: secret/identifier scan FAILED — nothing committed"; exit 9; }

C=$(git commit-tree "$T" -p "$PARENT" < "$MSG")
git update-ref "refs/heads/$branch" "$C" "$PARENT"
git reset -q -- "${rel[@]}" 2>/dev/null || true
print "commit-paths: committed ${C[1,10]} on $branch (${#changed} path(s))"

for attempt in 1 2 3 4; do
  if git push -q origin "$branch" 2>"$ERR"; then print "commit-paths: pushed $branch"; exit 0; fi
  print -u2 "commit-paths: push attempt $attempt failed: $(tail -1 "$ERR")"
  sleep $((attempt * 3))
done
print -u2 "commit-paths: committed locally but the push failed — fix the cause, then run: git push origin $branch"
exit 5
