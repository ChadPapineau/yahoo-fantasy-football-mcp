# repo-security-auditor — working notes

Brief: `docs/scratch/briefs/repo-security-auditor.md`. Static review only; no
installs, no execution of anything from a clone. Clones live in the session
scratchpad (`.../scratchpad/yff-research/vendor/<owner>__<name>`), never in
the repo. My inventory script (`inv.sh`) and OSV script (`osv.mjs`) live in
`.../scratchpad/yff-research/` — mine, not from any clone.

## RESUME HERE

- **Status: COMPLETE (2026-09-29).** All three deliverables written and pushed:
  `docs/research/01-repo-security-audit.md` (21 repos vetted, 3 skipped by name),
  `docs/research/02-prior-art-lessons.md` (capability matrices, working patterns,
  15 mistakes with symptoms, design implications), and this note.
- **Not done / open for the orchestrator:** (a) `.gitignore:83` `scratch/`
  ignores `docs/scratch/` — this file is force-added; `program.md` and `briefs/`
  are still untracked. (b) Two repos (carterfawson, derekrbreese) have real
  Yahoo/Reddit credentials in public git history — whether to notify the owners
  is Chad's call, not an agent action. (c) The ~15 zero-star search hits were not
  cloned (budget); revisit only if a specific one becomes relevant.
- **If resumed for follow-up:** clones are in the session scratchpad
  (`.../scratchpad/yff-research/vendor/`) and may be gone after a reboot;
  re-clone with `git clone` (full for small repos, `--depth 1` for nflverse/
  ffverse). `inv.sh` / `osv.mjs` in `.../scratchpad/yff-research/` are mine.
- No `.wip.patch` was ever needed — every checkpoint was committed directly.

## Audit log (facts I would not want to re-derive)

- Real historical leaks found (values NOT recorded anywhere in this repo):
  - carterfawson `f4c4c1b` added `.yahoo_oauth.json` + `.yahoo_token_complete.json`
    (consumer key/secret + access/refresh); deleted `d01f244`.
  - derekrbreese `.env` / `.env.cloudrun` (deleted `d898409` 2025-10-01,
    `cde5779`): Yahoo client id/secret, access/refresh, GUID, Reddit id/secret/
    username, MCP_API_KEY. `.yahoo_token.json` added `b150560`, blanked
    `ef6a0ce`, deleted `b23c4e3`. Inherited by cketcham, kYpranite, andrewrgoss.
- Fork status: asteiger +8/−0 vs spilchen; cketcham +2/−131, kYpranite +36/−0,
  andrewrgoss +7/−6 vs derekrbreese; jschne88 identical to jimbrig.
- nfl_data_py archived 2025-09-25 → nflreadpy audited instead.
- Escape-hatch "raw GET" tools exist in brettadams0, deepak-or1 (host-pinned by
  string concat, `..` not rejected) and kwonye (`safeAdvancedPath`).
- Token storage patterns seen: repo-dir `credentials/token.json` (brettadams0),
  cwd `oauth2.json` (asteiger/spilchen), cwd `.env` plaintext incl. consumer
  secret (michaelfromorg, yfpy), `secrets.json` umask perms (yahoo-oauth),
  desktop-client config files (carterfawson/derekrbreese), XDG dir 0o600 atomic
  + lockfile (kwonye), 0o700 dir/0o600 file (deepak-or1 local), AES-GCM in
  Redis (deepak-or1 remote), in-memory + callback (whatadewitt).
- No repo has a confirmation step before a write. Best-in-class is annotations
  (readOnlyHint/destructiveHint) + "sent once, never retried" + a run journal
  (kwonye), or a `_WRITE_WARNING` suffix in descriptions (asteiger).
- Output shape: `str(dict)` Python repr (asteiger, spilchen mcp) vs JSON
  (everyone else). Nobody labels untrusted text as data.
