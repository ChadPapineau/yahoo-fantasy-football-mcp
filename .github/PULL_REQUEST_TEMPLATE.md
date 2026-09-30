<!-- Plan reference: docs/plan/04-repo-structure-and-ci.md §1 (PR template) and §3 (commits). Keep the checklist; delete the hints. -->

## What and why

<!-- One paragraph. Link the plan section or research doc this implements or changes, e.g. `docs/plan/02-security-architecture.md §4`. -->

## Checklist

- [ ] **No secrets, no identifiers.** Nothing in this PR contains a real Yahoo client id/secret, token, GUID, league or team key, e-mail, username, team name, or any other personal identifier (the repo is public; `docs/HANDOFF.md`). The `secrets` and `secrets-selftest` checks are green.
- [ ] **Fixtures are anonymised.** Any recorded Yahoo response was scrubbed (plan 05 §3) and uses only the placeholder ids (`461.l.1000…`).
- [ ] **Staged explicit paths only.** No `git add -A` / `-u` / directory adds; nothing unrelated rode along.
- [ ] **Conventional Commit** title and commits (`feat|fix|docs|test|chore|refactor|perf|ci|build(scope): subject`).
- [ ] **Plan / research reference** in the description (section, or the decision row a deviation changes).
- [ ] **Docs updated** — the plan or research doc this touches, `docs/HANDOFF.md` if status changed, and (once it exists) `CHANGELOG.md`.
- [ ] **Tests** for every new or changed unit of logic (plan 05); coverage gate untouched.
- [ ] **CI green** on the head commit: `docs` (mermaid, links), `secrets`, and — once `package.json` exists — every `ci.yml` job.

## Notes for the reviewer

<!-- Anything that needs a second pair of eyes: a new dependency (plan 04 §2 allow-list row), a workflow change, a new gitleaks rule (add its fixture line), an assumption marked [A-n]. -->
