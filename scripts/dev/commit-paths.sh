#!/bin/zsh
# commit-paths.sh — commit EXPLICIT owned paths on the current build branch and push it,
# without touching the shared index or any other agent's uncommitted work.
#
# Usage (any cwd):  scripts/dev/commit-paths.sh "<conventional commit message>" <path>...
#   <path> may be a file or a directory you own; additions, edits and deletions under it
#   are included; git-ignored files never are.
#
# Refuses (nothing committed) when:
#   * the branch is main/master (build work happens on build/* branches)
#   * a path is outside the repository
#   * the change is empty, or touches a path not under the given paths
#   * scripts/dev/scan-secrets.mjs finds a secret or a personal identifier
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
trap 'rm -rf "$LOCK"; rm -f "$IDX" "$ERR"' EXIT INT TERM HUP

PARENT=$(git rev-parse HEAD)
GIT_INDEX_FILE=$IDX git read-tree "$PARENT"
GIT_INDEX_FILE=$IDX git add -A -- "${rel[@]}"
T=$(GIT_INDEX_FILE=$IDX git write-tree)
changed=(${(f)"$(git diff --name-only "$PARENT" "$T")"})
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

files=()
for c in "${changed[@]}"; do [[ -f $c ]] && files+=("$c"); done
if (( ${#files} )); then
  "$ROOT/scripts/dev/with-node.sh" node "$ROOT/scripts/dev/scan-secrets.mjs" -- "${files[@]}" \
    || { print -u2 "commit-paths: secret/identifier scan FAILED — nothing committed"; exit 9; }
fi

C=$(print -r -- "$msg" | git commit-tree "$T" -p "$PARENT")
git update-ref "refs/heads/$branch" "$C" "$PARENT"
git reset -q -- "${rel[@]}" 2>/dev/null || true
print "commit-paths: committed ${C[1,10]} on $branch (${#changed} path(s))"

for attempt in 1 2 3 4; do
  if git push -q origin "$branch" 2>"$ERR"; then print "commit-paths: pushed $branch"; exit 0; fi
  print -u2 "commit-paths: push attempt $attempt failed: $(tail -1 "$ERR")"
  sleep $((attempt * 3))
done
print -u2 "commit-paths: committed locally but the push failed — report this; the orchestrator will push"
exit 5
