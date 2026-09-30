# repo-security-auditor — working notes

Brief: `docs/scratch/briefs/repo-security-auditor.md`. Static review only; no
installs, no execution of anything from a clone. Clones live in the session
scratchpad (`.../scratchpad/yff-research/vendor/<owner>__<name>`), never in
the repo.

## RESUME HERE

- **Done:** scratch doc created (this file). Nothing else yet.
- **Not done:** all 18 repo audits; `docs/research/01-repo-security-audit.md`;
  `docs/research/02-prior-art-lessons.md`.
- **Next concrete step:** `mkdir -p` the vendor scratch dir; `gh api` metadata
  for repos 1–10 (stars, license, archived, fork, pushed_at); `git clone
  --depth 1` repos 1–4; run the 10-category checklist on each; write findings
  into 01 and push at the 4-repo checkpoint.
- **Gotcha:** `.gitignore:83` (`scratch/`) ignores `docs/scratch/`. This file
  is force-added by explicit path (`git add -f docs/scratch/repo-security-auditor.md`).
  `.gitignore` is off-limits to me — orchestrator should decide whether to
  un-ignore `docs/scratch/` (its own `program.md` and `briefs/` are untracked
  right now).

## Audit log (per repo, appended as I go)

(none yet)
