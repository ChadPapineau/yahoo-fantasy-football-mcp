#!/usr/bin/env bash
# install-gitleaks.sh — fetch the pinned gitleaks release into <dest-dir> for GitHub Actions.
#
# Pinned by EXACT version AND the sha256 of the linux_x64 tarball, copied from the release's own
# gitleaks_<ver>_checksums.txt. To bump: change both values below; Dependabot does not manage this
# pin (it is not an action), so the weekly `secrets-history` job prints a notice when a newer release
# exists.
#
# CI only. It refuses to run anywhere but Linux x86_64 — nothing from this repo's CI is ever
# installed on a developer machine (scripts/README.md, rule 1).
#
# Usage: bash scripts/install-gitleaks.sh <dest-dir>   (adds <dest-dir> to GITHUB_PATH when present)
set -euo pipefail

GITLEAKS_VERSION="8.30.1"
GITLEAKS_SHA256_LINUX_X64="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"

dest="${1:?usage: install-gitleaks.sh <dest-dir>}"
if [ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]; then
  echo "install-gitleaks.sh: CI-only (Linux x86_64); refusing to run on $(uname -s)-$(uname -m)" >&2
  exit 2
fi

mkdir -p "$dest"
tarball="$dest/gitleaks.tar.gz"
url="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
echo "fetching $url"
curl -fsSL --retry 3 --retry-delay 2 -o "$tarball" "$url"
echo "${GITLEAKS_SHA256_LINUX_X64}  ${tarball}" | sha256sum -c -
tar -xzf "$tarball" -C "$dest" gitleaks
rm -f "$tarball"
"$dest/gitleaks" version
if [ -n "${GITHUB_PATH:-}" ]; then
  echo "$dest" >> "$GITHUB_PATH"
fi
