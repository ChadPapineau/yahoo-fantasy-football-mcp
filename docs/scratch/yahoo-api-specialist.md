# yahoo-api-specialist — working notes

Agent: yahoo-api-specialist. Brief: `docs/scratch/briefs/yahoo-api-specialist.md`
(ignored by git — see note below). Owned paths: this file,
`docs/research/03-yahoo-api.md`, `docs/scratch/yahoo-api-specialist.wip.patch`.

## RESUME HERE

**Status:** 2026-09-29 — research complete for A–E; writing `docs/research/03-yahoo-api.md`.

**Done**
- Repo oriented; scratch doc pushed (`5d7618d`).
- All primary sources fetched and grepped (see Source log). Key facts nailed down:
  gated access (manual approval, read-only default), OIDC discovery (no PKCE
  advertised), 1-h access token, refresh rotation, 401/403 shapes, full official
  reference incl. players filters, roster PUT, transaction POST/PUT/DELETE XML,
  NFL stat_id table + modifiers from the official settings sample, projections =
  team-level `team_projected_points` only, `refresh_rate="60"`, 25/page cap
  (community), 999/"Request denied" (community), IR eligibility (help.yahoo.com).

**Not done**
- `docs/research/03-yahoo-api.md` not yet written (next).

**Next concrete step**
- Write 03-yahoo-api.md: matrix + A + B, commit/push; then C + D + E + unverified
  list, commit/push; retire any wip.patch; final reply with SHAs.

**Blockers / findings for the orchestrator**
- `docs/scratch/` is **gitignored** (`.gitignore:83`, pattern `scratch/`). This file
  is force-added by explicit path (`git add -f`); `.gitignore` untouched.
  `program.md`, `roster.md`, `briefs/*` are therefore NOT on origin.
- The brief's third wrapper `edwarddistel/yahoo-fantasy-sports-api` does not exist
  (404); the Node wrapper is `whatadewitt/yahoo-fantasy-sports-api` (npm
  `yahoo-fantasy`). Used that instead.
- **Architecture-critical:** Yahoo stopped self-serve provisioning of the Fantasy
  API in summer 2026; access is by application with human review, read-only by
  default; write (`fspt-w`) "not available at this time". The product cannot
  assume write access.

## Rules I am operating under (from the brief)
- No Yahoo app, no authenticated calls, no real league/team/user identifiers.
- Source URL per claim; verified / unverified marked explicitly.
- Stage explicit paths only; `git pull --rebase origin main` before every push;
  never force-push; confirm `HEAD == origin/main` after each push.
- Commit after each section lands. Stop taking scope at ~20% context.

## Source log
(appended as sources are read — URL, date fetched, what it established)
- 2026-09-29 `https://developer.yahoo.com/oauth2/guide/` — index; only Authorization Code grant supported.
- 2026-09-29 `https://developer.yahoo.com/oauth2/guide/flows_authcode/` — request_auth/get_token params, Basic header, expires_in 3600, "1-hour lifetime", oob, old refresh token revoked after new one issued.
- 2026-09-29 `https://developer.yahoo.com/oauth2/guide/faq/` — refresh token "may change; store the latest"; password change revokes all.
- 2026-09-29 `https://developer.yahoo.com/oauth2/guide/troubleshooting/` — `{"error":"invalid_grant"}` 401; base64(clientid:clientsecret) no newline; "Installed Application" type.
- 2026-09-29 `https://developer.yahoo.com/oauth2/guide/openid_connect/getting_started.html` — redirect_uri "complete URL incl. protocol", must match registered domain; body OR Basic; no code_challenge.
- 2026-09-29 `https://api.login.yahoo.com/.well-known/openid-configuration` (curl, no creds) — endpoints; grant_types authorization_code+refresh_token; token_endpoint_auth_methods client_secret_basic+client_secret_post; NO code_challenge_methods_supported key; scopes_supported lists only openid/openid2/profile/email.
- 2026-09-29 `https://fantasysports.yahooapis.com/fantasy/v2/game/nfl[?format=json]` (curl, no creds) — 401, `www-authenticate: OAuth oauth_problem="unable_to_determine_oauth_type"`, JSON `{"error":{"lang","description"}}` / XML `<yahoo:error><yahoo:description>`.
- 2026-09-29 `https://developer.yahoo.com/fantasysports/guide/*` — every old guide URL 308 → `https://sports.yahoo.com/developer`.
- 2026-09-29 `https://sports.yahoo.com/developer` — 3-step application; "may temporarily throttle or limit access"; attribution "Fantasy data provided by Yahoo Fantasy".
- 2026-09-29 `https://sports.yahoo.com/developer/access/` — "reviewed by the Yahoo Fantasy Sports team"; "read-only by default"; write needs justification; incomplete submissions closed.
- 2026-09-29 `https://sports.yahoo.com/developer/docs/` (raw HTML → docs.txt, 4192 lines) — full API reference: concepts, keys, all resources/collections, players filters, roster PUT, transactions POST/PUT/DELETE XML, league settings sample with stat_categories + stat_modifiers + roster_positions, scoreboard sample with team_projected_points + win_probability, refresh_rate="60".
- 2026-09-29 `https://legal.yahoo.com/us/en/yahoo/terms/product-atos/fantasysportsapi/index.html` — 404.
- 2026-09-29 GitHub issues: derekrbreese/fantasy-football-mcp-public#18 (2026-08-11, de-provisioning), uberfastman/yfpy#84 (403 "This application is not authorized to perform this action", 2026-07-22 cutoff), uberfastman/yfpy#51 (rate limits: no numbers), whatadewitt/yahoo-fantasy-sports-api#81 ("Request denied", block by app ID, "short period").
- 2026-09-29 wrapper sources (raw.githubusercontent, read-only): spilchen team.py/league.py/yhandler.py; uberfastman yfpy query.py/models.py/utils.py; whatadewitt README; josuebrunel yahoo-oauth oauth.py/utils.py (CALLBACK_URI='oob', Basic header on refresh, 3600 s validity).
- 2026-09-29 help.yahoo.com: SLN6868 (scoring updated by 8:00am PT next morning; football corrections until first game of next week; 11:59pm PT cutoff), SLN28136 (IR-eligible designations), SLN6775 (default: until player's real-life game starts), SLN6451 (category abbreviations, no ids).
- 2026-09-29 sfan0704/pikachubball PR#14 (2026-09-24): "URI must be https"; `https://localhost:5001/...` accepted.
