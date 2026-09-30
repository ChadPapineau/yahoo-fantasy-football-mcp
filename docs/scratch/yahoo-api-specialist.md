# yahoo-api-specialist — working notes

Agent: yahoo-api-specialist. Brief: `docs/scratch/briefs/yahoo-api-specialist.md`
(ignored by git — see note below). Owned paths: this file,
`docs/research/03-yahoo-api.md`, `docs/scratch/yahoo-api-specialist.wip.patch`.

## RESUME HERE

**Status:** COMPLETE 2026-09-29. Deliverable `docs/research/03-yahoo-api.md` (549 lines) pushed.

**Done**
- `docs/research/03-yahoo-api.md`: capability matrix (25 rows) + A auth + B read surface
  (incl. NFL stat_id table from Yahoo's own settings sample, JSON-shape rules) + C write
  surface (all XML from the reference; roster PUT body from wrapper source) + D limits /
  freshness / deprecations + E gaps + F unverified list (18 items) + G the three
  architecture constraints. Commits `422ad0f` (matrix, A, B) and `8e19974` (C–G).
- No `.wip.patch` was needed (work landed as complete sections); nothing to retire.

**Not done / open for the orchestrator**
- 18 items in §F need a live token (none can be closed without an approved client id).
- `docs/scratch/` is gitignored (`.gitignore:83`); this file is force-tracked by
  explicit path. `program.md`, `roster.md`, `briefs/*` remain untracked on origin
  unless someone decides the push rule beats the ignore rule.
- The brief's `edwarddistel/yahoo-fantasy-sports-api` does not exist (404); the Node
  wrapper is `whatadewitt/yahoo-fantasy-sports-api` and was used instead.

**Next concrete step (for whoever continues)**
- When an approved client id exists: run the §F checklist top to bottom with one
  read-only token, in a throwaway public league, and move each item from [U] to
  [V-live] in 03-yahoo-api.md. Do not test writes until write scope is granted.

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
