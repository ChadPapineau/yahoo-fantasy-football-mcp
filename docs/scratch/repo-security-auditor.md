# repo-security-auditor — working notes

Brief: `docs/scratch/briefs/repo-security-auditor.md`. Static review only; no
installs, no execution of anything from a clone. Clones live in the session
scratchpad (`.../scratchpad/yff-research/vendor/<owner>__<name>`), never in
the repo. My inventory script (`inv.sh`) and OSV script (`osv.mjs`) live in
`.../scratchpad/yff-research/` — mine, not from any clone.

## RESUME HERE

- **Done:** all 18 brief items + 4 additions audited (21 repos, 3 skipped by
  name). `docs/research/01-repo-security-audit.md` written and pushed
  (verdict table, per-repo findings by category, rejected list, dependency
  counts, unverifiable list).
- **Not done:** `docs/research/02-prior-art-lessons.md` (capability matrix +
  mistakes to avoid; architecture only, no code).
- **Next concrete step:** write 02 from the "passing" set (#2 asteiger,
  #3 michaelfromorg [caution], #6 brettadams0, #9 spilchen mcp, #11 whatadewitt,
  #12 yfpy [caution], #13 spilchen api, #14 yahoo-oauth [caution], #15b nflreadpy,
  #16 nflreadr, #17 ffscrapr, #18 dtsong, #20 deepak-or1 [caution], #21 kwonye),
  then commit + push and reply with SHAs.
- **Gotcha:** `.gitignore:83` (`scratch/`) ignores `docs/scratch/`. This file
  is force-added by explicit path (`git add -f docs/scratch/repo-security-auditor.md`).
  `.gitignore` is off-limits to me — orchestrator should decide whether to
  un-ignore `docs/scratch/` (its own `program.md` and `briefs/` are untracked).
- **Gotcha:** brief item 11 `edwarddistel/yahoo-fantasy-sports-api` does not
  exist; audited `whatadewitt/yahoo-fantasy-sports-api` (npm `yahoo-fantasy`).
- **Gotcha:** macOS has no `timeout`; `npm audit` silently printed nothing
  under it. Re-ran without.

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
