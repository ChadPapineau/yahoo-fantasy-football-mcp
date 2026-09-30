#!/bin/zsh
# with-node.sh — run a command under this repo's Node version (.nvmrc) via fnm,
# without changing the machine's global default Node (other projects rely on it).
#
# Usage:  scripts/dev/with-node.sh <command> [args…]
#   e.g.  scripts/dev/with-node.sh npm test -- src/domain/scoring
set -euo pipefail
ROOT=${0:A:h:h:h}
ver=$(<"$ROOT/.nvmrc")
exec fnm exec --using="$ver" -- "$@"
