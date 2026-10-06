# 03 — Yahoo Fantasy Sports API: capability reference

**Researched:** 2026-09-29
**Method:** official Yahoo docs first, then Yahoo help pages, then the source of three mature open-source wrappers read on GitHub (never cloned or run), plus two credential-free probes. No Yahoo app was created and no authenticated call was made. No real league, team or user identifiers appear in this document; keys shown are Yahoo's own documentation placeholders (`461` = the 2025 NFL game id in Yahoo's examples).

## How to read this document

Every claim carries a source tag and a verification mark:

| Mark | Meaning |
|---|---|
| **[V-official]** | Stated in Yahoo's official documentation or portal (fetched 2026-09-29). |
| **[V-probe]** | Observed directly during the research by a credential-free request (OIDC discovery document, or an unauthenticated `GET` that returned only an error). |
| **[V-community]** | Not in official docs; consistent in at least one mature wrapper's source code or a dated GitHub issue. Reliable in practice, but Yahoo can change it silently. |
| **[U]** | Unverified. Needs a live token to confirm. Collected in §F at the end. |

### Sources

| Tag | URL | What it is |
|---|---|---|
| S-DOCS | https://sports.yahoo.com/developer/docs/ | The official API reference (concepts, every resource/collection, filters, write XML, sample responses). Every old `developer.yahoo.com/fantasysports/guide/*` URL now 308-redirects to `https://sports.yahoo.com/developer` [V-probe]. |
| S-PORTAL | https://sports.yahoo.com/developer | Portal landing page: access process, throttling clause, attribution requirement. |
| S-ACCESS | https://sports.yahoo.com/developer/access/ | The application form for API access. |
| S-OAUTH | https://developer.yahoo.com/oauth2/guide/ | OAuth 2.0 guide index. |
| S-OAUTH-FLOW | https://developer.yahoo.com/oauth2/guide/flows_authcode/ | Authorization Code flow, token exchange, refresh. |
| S-OAUTH-FAQ | https://developer.yahoo.com/oauth2/guide/faq/ | Refresh-token rotation, revocation. |
| S-OAUTH-TS | https://developer.yahoo.com/oauth2/guide/troubleshooting/ | Error codes and common mistakes. |
| S-OIDC | https://developer.yahoo.com/oauth2/guide/openid_connect/getting_started.html | Full authorization-request parameter list, redirect_uri rules. |
| S-DISC | https://api.login.yahoo.com/.well-known/openid-configuration | Yahoo's OIDC discovery document (probe, no credentials). |
| S-PROBE | `GET https://fantasysports.yahooapis.com/fantasy/v2/game/nfl` with and without `?format=json`, no credentials | Error-shape probe (returned 401 only). |
| S-HELP-6868 | https://help.yahoo.com/kb/SLN6868.html | "Overview of scoring": update timing, stat corrections. |
| S-HELP-28136 | https://help.yahoo.com/kb/SLN28136.html | IR-eligible injury designations. |
| S-HELP-6775 | https://help.yahoo.com/kb/SLN6775.html | Transaction and lineup deadlines. |
| S-HELP-6451 | https://help.yahoo.com/kb/SLN6451.html | Football scoring-category abbreviations (no ids). |
| S-YFPY | https://github.com/uberfastman/yfpy (`yfpy/query.py`, `models.py`, `utils.py`) | Python wrapper; most complete community model of the JSON responses. |
| S-SPILCHEN | https://github.com/spilchen/yahoo_fantasy_api (`yhandler.py`, `team.py`, `league.py`) | Python wrapper; builds the write XML. |
| S-WAD | https://github.com/whatadewitt/yahoo-fantasy-sports-api (npm `yahoo-fantasy`) | Node wrapper. (The research scope named `edwarddistel/yahoo-fantasy-sports-api`; that repo does not exist — 404 — this is the Node wrapper.) |
| S-YOAUTH | https://github.com/josuebrunel/yahoo-oauth (`yahoo_oauth/oauth.py`, `utils.py`) | The OAuth helper the Python wrappers use. |
| S-ISS-DRB18 | https://github.com/derekrbreese/fantasy-football-mcp-public/issues/18 | 2026-08-11: "Yahoo no longer self-serve provisions the Fantasy Sports API". |
| S-ISS-YFPY84 | https://github.com/uberfastman/yfpy/issues/84 | 403 "This application is not authorized to perform this action" since 2026-07-22. |
| S-ISS-YFPY51 | https://github.com/uberfastman/yfpy/issues/51 | Rate-limit question, unanswered. |
| S-ISS-WAD81 | https://github.com/whatadewitt/yahoo-fantasy-sports-api/issues/81 | "Request denied" block by app id. |
| S-ISS-WAD118 | https://github.com/whatadewitt/yahoo-fantasy-sports-api/issues/118 | `oauth_problem="token_rejected"` body. |
| S-PR-PIKA14 | https://github.com/sfan0704/pikachubball/pull/14 | 2026-09-24: "URI must be https"; `https://localhost:5001/...` accepted. |
| S-MIRROR | https://yahoofantasysportsapidocs.readthedocs.io/guide/GettingStarted/ | Community mirror of the *old* guide (2-legged "public requests", PHP samples). |

---

## Capability matrix

Product need → endpoint(s) → verified? → notes. Base URL for every path: `https://fantasysports.yahooapis.com/fantasy/v2/` [V-official S-DOCS].

| # | Product need | Endpoint(s) | Verified | Notes |
|---|---|---|---|---|
| 0 | **Get API access at all** | Application form, human review | **[V-official]** S-ACCESS | "read access only. Write access is not available at this time." Self-serve app creation no longer grants Fantasy scope [V-community S-ISS-DRB18]. **Gates everything below.** |
| 1 | Discover the user's leagues/teams | `users;use_login=1/games;game_keys=nfl/leagues`, `.../teams` | [V-official] S-DOCS | `nfl` resolves to the current season's game id; use `games;game_codes=nfl;seasons=YYYY` for a specific season. |
| 2 | League settings (scoring, roster slots, waivers, FAAB, trades, playoffs, IR) | `league/{league_key}/settings` | [V-official] S-DOCS | One response carries `stat_categories`, `stat_modifiers`, `roster_positions` and all rule scalars. Sufficient for a scoring engine (§B.5). |
| 3 | Standings | `league/{league_key}/standings` | [V-official] S-DOCS | rank, seed, W-L-T, pct, streak, points for/against. |
| 4 | Weekly matchups / scoreboard | `league/{league_key}/scoreboard;week=N`; `team/{team_key}/matchups;weeks=1,3` | [V-official] S-DOCS | Includes `team_points`, `team_projected_points`, `win_probability`, matchup `status`. |
| 5 | Transaction history | `league/{league_key}/transactions;types=add,drop,trade,commish;count=N` | [V-official] S-DOCS | Only `count`; **no `start`** filter documented, so history is "most recent N". |
| 6 | Pending waivers / trades for my team | `league/{league_key}/transactions;types=waiver,pending_trade;team_key={team_key}` | [V-official] S-DOCS | Pending items are invisible without `team_key`. |
| 7 | Free agents / waiver wire / player search | `league/{league_key}/players;status=FA;position=RB;sort=PTS;sort_type=week;sort_week=N;start=0;count=25` | Filters [V-official]; 25/page cap [V-community] | `status` ∈ A, FA, W, T, K. Wrappers cap pages at 25 (§B.2). |
| 8 | Draft results | `league/{league_key}/draftresults` | [V-official] S-DOCS | pick, round, team_key, player_key, cost (auction) [fields V-community S-YFPY]. |
| 9 | My roster with slots | `team/{team_key}/roster;week=N` (+`/players;out=stats,ownership,percent_owned,draft_analysis`) | [V-official] S-DOCS | Slot names in NFL sample: `QB WR RB TE W/R/T K DEF BN IR`; roster carries `is_editable`. |
| 10 | Team weekly points | `team/{team_key}/stats;type=week;week=N` | [V-official] S-DOCS | Returns `team_points` and `team_projected_points` [keys V-community S-YFPY]. |
| 11 | Player weekly / season stats and fantasy points | `league/{league_key}/players;player_keys=K1,K2/stats;type=week;week=N` (or `type=season`) | [V-official] S-DOCS | `player_points.total` is computed with the league's scoring only when queried in league context. Max 25 keys per call [V-community]. |
| 12 | Ownership / percent owned / ADP | `.../players;player_keys=K/ownership`, `/percent_owned`, `/draft_analysis` | [V-official] S-DOCS | draft_analysis = average pick/round/cost, percent drafted. |
| 13 | Injury status | Player fields `status`, `status_full`, `injury_note` | [V-community] S-YFPY | Status string + body part only; not in the official sample text. |
| 14 | Bye weeks, headshots, NFL team | Player `bye_weeks.week`, `headshot.url`, `editorial_team_key/abbr/full_name` | [V-official] S-DOCS | In every player sample. |
| 15 | **Player projections** | — | **Absent [V-official negative]** | Only `team_projected_points` (per team per week) and `win_probability` exist. No player-level projection anywhere in the reference or in any wrapper model (§B.4). |
| 16 | Set lineup | `PUT team/{team_key}/roster` (XML) | PUT [V-official]; XML body [V-community S-SPILCHEN] | Needs write scope. Official page describes PUT in prose; XML sample is from wrappers. |
| 17 | Add / drop / add+drop / waiver claim with FAAB | `POST league/{league_key}/transactions` (XML) | [V-official] S-DOCS | Adding a player on waivers returns a waiver claim, processed later. |
| 18 | Edit / cancel a pending waiver claim | `PUT transaction/{claim_key}` (`waiver_priority`, `faab_bid`); `DELETE transaction/{claim_key}` | [V-official] S-DOCS | Claim key format `{game}.l.{league}.w.c.{claim_id}`. |
| 19 | Trades: propose / accept / reject / allow / disallow / vote against / cancel | POST (propose), PUT (`action` = accept, reject, allow, disallow, vote_against), DELETE (cancel) | [V-official] S-DOCS | Draft-pick trades: no XML element documented (§C.3). |
| 20 | Rate limits | — | **Undocumented [V-official negative]** | Portal: "may temporarily throttle". Community: HTTP 999 / "Request denied", per app id, short block (§D.1). |
| 21 | Data freshness | Response attribute `refresh_rate="60"` | [V-official] S-DOCS | Official scoring finalised "by 8:00am Pacific Time the morning after" [V-official S-HELP-6868]. |
| 22 | Roster lock timing | Default: each player locks at their game's kickoff | [V-official] S-HELP-6775 (product rule) | API exposes `is_editable` (roster) and `edit_key` (league) [V-official]; per-player lock flag: [U]. |
| 23 | Player news text | — | Absent [V-official negative] | Only `has_player_notes`, `has_recent_player_notes`, `player_notes_last_timestamp`. |
| 24 | Snap counts, air yards, red-zone, practice reports, depth charts, betting lines, weather, NFL schedule/opponent | — | Absent [V-official negative] | Not in any resource; §E. |
| 25 | Commissioner tools, draft-room picks, chat, webhooks | — | Absent [V-official negative] | Only trade allow/disallow exists for commissioners. |

---

## A. Auth

### A.1 Authorization-code flow

Yahoo supports exactly one grant: "Yahoo currently supports one of the four grant types: Authorization Code Grant" [V-official S-OAUTH]. The discovery document confirms `grant_types_supported: ["authorization_code","refresh_token"]` [V-probe S-DISC].

| Item | Value | Verified |
|---|---|---|
| Authorization endpoint | `https://api.login.yahoo.com/oauth2/request_auth` (GET or POST) | [V-official S-OAUTH-FLOW] + [V-probe S-DISC] |
| Token endpoint | `https://api.login.yahoo.com/oauth2/get_token` (POST) | [V-official S-OAUTH-FLOW] + [V-probe S-DISC] |
| Introspection / revocation endpoints | `https://api.login.yahoo.com/oauth2/introspect`, `https://api.login.yahoo.com/oauth2/revoke` | [V-probe S-DISC]; behaviour for Fantasy tokens [U] |
| Authorization params | `client_id` (required), `redirect_uri` (required), `response_type=code` (required), `state` (optional, echoed back), `language` (optional, default `en-us`) | [V-official S-OAUTH-FLOW] |
| Extra params (OIDC page) | `scope`, `nonce`, `prompt`, `max_age` | [V-official S-OIDC] — `scope` is described only for `openid`; see A.1 scopes below |
| Token-exchange params | `grant_type=authorization_code`, `code`, `redirect_uri` (same as the auth request), plus client credentials | [V-official S-OAUTH-FLOW] |
| Client authentication | `Authorization: Basic base64(client_id:client_secret)` **or** `client_id`/`client_secret` in the form body — both accepted | [V-official S-OIDC]; [V-probe S-DISC] `token_endpoint_auth_methods_supported: client_secret_basic, client_secret_post` |
| Token response | `{"access_token","token_type":"bearer","expires_in":3600,"refresh_token","xoauth_yahoo_guid"}` (`xoauth_yahoo_guid` marked deprecated) | [V-official S-OAUTH-FLOW] |
| Refresh params | `grant_type=refresh_token`, `refresh_token`, `redirect_uri` (present in Yahoo's sample body), client credentials as above | [V-official S-OAUTH-FLOW]; whether `redirect_uri` is *required* on refresh [U] — wrappers always send it [V-community S-YOAUTH `oauth.py:161`] |
| **PKCE** | **Not supported / not required.** The discovery document has no `code_challenge_methods_supported` key; neither OAuth page mentions `code_challenge`. A client secret is therefore mandatory: the MCP server is a **confidential client** and must hold the secret. | [V-probe S-DISC] (negative), [V-official S-OAUTH-FLOW, S-OIDC] (absent) |

**Scopes / permissions (`fspt-r` vs `fspt-w`).**
- Where set: on the **app**. "select either Read or Read/Write access for Fantasy Sports" when registering [V-official S-DOCS "Register Your Application"]. The discovery `scopes_supported` lists only `openid, openid2, profile, email` — the Fantasy scopes are not advertised there [V-probe S-DISC].
- The identifiers `fspt-r` (read) and `fspt-w` (write) are community knowledge; managed OAuth clients pass `scope=fspt-r` in the authorization request as well [V-community: S-ISS-DRB18; Pipedream's Yahoo Fantasy client requests `fspt-r profile email`, https://pipedream.com/apps/yahoo-fantasy-sports]. Passing them in the request is harmless but does not grant anything the app was not provisioned for [V-community S-ISS-DRB18: both scopes "rejected at the authorize endpoint" for un-provisioned apps].
- **Current reality (2026-09):** the app-creation form no longer offers a Fantasy Sports permission; access is granted per client id after a manual application; "Access to the Yahoo Fantasy Sports API is read-only by default"; "The Yahoo Fantasy Sports API currently provides read access only. Write access is not available at this time."; "If your use case is unique and requires read/write access, please include additional details in the notes section" [V-official S-ACCESS, quoted verbatim]. Applications are "reviewed by the Yahoo Fantasy Sports team" and "incomplete or insufficiently detailed submissions ... will be closed without further correspondence" [V-official S-ACCESS]. Existing legacy apps were de-provisioned: all Fantasy endpoints returned 403 for previously working apps from 2026-07-22 [V-community S-ISS-YFPY84, S-ISS-DRB18]. No SLA for approval is published [V-official negative; S-ISS-YFPY84].

**`redirect_uri` rules.**
- `oob` **is accepted for OAuth 2.0**: "If your application does not have access to a browser, you must specify the callback as oob (out of band)"; Yahoo then shows the code on screen [V-official S-OAUTH-FLOW]. The Python OAuth helper defaults to `CALLBACK_URI = 'oob'` [V-community S-YOAUTH `utils.py:18`]. For `oob` apps, leave the app's callback field empty — the troubleshooting page's fix for `invalid_grant` is "ensure that the callback area for your app on Yahoo Developer Network is empty" [V-official S-OAUTH-TS].
- A URL callback must be "the complete URL including the HTTP/HTTPS protocol" and match the callback domain registered on the app [V-official S-OIDC].
- **HTTPS is required in the app form** ("URI must be https"); `http://` callbacks are rejected; **`https://localhost:5001/...` was accepted, so localhost with a port works over https** [V-community S-PR-PIKA14, 2026-09-24, one data point]. No official statement on ports or on localhost [U].
- Practical consequence: an MCP server that wants a browser-redirect flow needs a local **https** listener (self-signed cert) or must use `oob` and let the user paste the code. Both avoid a public callback host.

### A.2 Token lifetimes and failure shapes

| Item | Value | Verified |
|---|---|---|
| Access token TTL | 3600 s; "The access token has a 1-hour lifetime" | [V-official S-OAUTH-FLOW] |
| Refresh token TTL | No documented expiry. | [V-official negative S-OAUTH-FLOW/FAQ]; long-term validity (months, inactivity) [U] |
| Refresh token rotation | "Not always [the same]. The best practice is to store the latest refresh token as the refresh token may change." and "The authorization server will revoke the old refresh token after issuing a new refresh token to the client." → **persist the newest refresh token after every refresh.** | [V-official S-OAUTH-FAQ, S-OAUTH-FLOW] |
| Revocation triggers | User revokes in Yahoo account settings; **password change revokes all refresh tokens** and disconnects all authorized apps | [V-official S-OAUTH-FLOW, S-OAUTH-FAQ] |
| Expired/invalid access token on the Fantasy API | `401` with `WWW-Authenticate: OAuth oauth_problem="token_rejected", realm="yahooapis.com"` and body `Please provide valid credentials. OAuth oauth_problem="token_rejected", realm="yahooapis.com"` | [V-community S-ISS-WAD118]; body envelope shape [V-probe S-PROBE], see §B.6. spilchen also matches `token_expired` in 401/403 bodies [V-community S-SPILCHEN `yhandler.py`] |
| No credentials at all | `401`, `WWW-Authenticate: OAuth oauth_problem="unable_to_determine_oauth_type", realm="yahooapis.com"` | [V-probe S-PROBE] |
| Valid token, app not entitled to Fantasy | `401` with `oauth_problem="additional_authorization_required"` **or** `403` "This application is not authorized to perform this action" — refreshing succeeds and does not help | [V-community S-ISS-DRB18, S-ISS-YFPY84] |
| Bad/revoked refresh token at `get_token` | `401` `{"error":"invalid_grant"}` | [V-official S-OAUTH-TS] |
| Apps/tokens per user | Not documented. Portal imposes "single account" per *developer* and forbids automated account creation | [V-official S-PORTAL] for developers; per-user token count [U] |

**Design rule that falls out:** treat `401 token_rejected` as "refresh then retry once"; treat `401 additional_authorization_required` and `403 not authorized` as **terminal** ("your app is not provisioned") — not as a token problem. Two projects shipped the wrong diagnosis [V-community S-ISS-DRB18].

### A.3 Gotchas

- Basic header must be `base64(clientid:clientsecret)` with "no newline at the end of client secret" [V-official S-OAUTH-TS].
- The parameter is `redirect_uri`, not `redirect_url` — a listed common mistake [V-official S-OAUTH-TS].
- Fetching the token URL from a browser yields a 401 "[95022]"; do it from code [V-official S-OAUTH-TS].
- For a standalone app managing its own data, register as "Installed Application" rather than "Web Application" [V-official S-OAUTH-TS].
- A browser is mandatory once: "Is there any way to complete the authentication process without opening up the browser? — No, an user must log in to the browser" [V-official S-OAUTH-FAQ]. An MCP server therefore needs a one-time interactive login step; after that only refreshes.
- Fantasy API calls: `Authorization: Bearer {access_token}`; write calls send `Content-Type: application/xml`; wrappers treat `200` as success for GET/PUT and **`201` for POST** [V-community S-SPILCHEN `yhandler.py` `post()`].
- HTTPS only; the API sends `strict-transport-security: max-age=31536000` [V-probe S-PROBE]. No User-Agent requirement was found anywhere [U].
- The `format=json` switch is a query parameter (`?format=json`), not a header, and is **not in the official reference** (0 hits on S-DOCS) — it is used by every wrapper [V-community S-YFPY `query.py:432`, S-SPILCHEN `yhandler.py`] and the API honours it on error responses too [V-probe S-PROBE].

---

## B. Read surface

Base URL `https://fantasysports.yahooapis.com/fantasy/v2` [V-official S-DOCS]. Everything in this section is [V-official S-DOCS] unless marked otherwise.

**Key formats.** Game key: `{game_id}` or `{game_code}` (`461` or `nfl`). League: `{game_key}.l.{league_id}`. Team: `{game_key}.l.{league_id}.t.{team_id}`. Player: `{game_key}.p.{player_id}`. Completed transaction: `{game_key}.l.{league_id}.tr.{transaction_id}`. Waiver claim: `{game_key}.l.{league_id}.w.c.{claim_id}`. Pending trade: `{game_key}.l.{league_id}.pt.{pending_trade_id}`. "The separator between the game_key and league_id is a lower case L (not the number 1)."

**URI grammar.** Parameters are semicolon-delimited after the resource/collection name: `/{resource}/{key};{k}={v}/{collection};{k}={v}`. `out={sub1},{sub2}` pulls one extra level of sub-resources, but "you cannot pass any parameters along to these out sub-resources" (so `out=stats` cannot carry `type=week`; chain `/players/stats;type=week;week=N` instead).

### B.1 Discovery: games, leagues, teams

| Path | Returns |
|---|---|
| `games;game_codes=nfl` | every season of the NFL game with its `game_id` (`{game_key, game_id, name, code, type, url, season, is_registration_over, is_game_over, is_offseason}`) |
| `games;game_codes=nfl;seasons=2026` | the game id for one season |
| `game/nfl` | the **current** season's NFL game: "using nfl as your game_key ... would be the same as providing the game_id for the [current] season ... Once the next season is available, providing the game_code would return the next season of that game instead (with a new game_id)". Any `game_code` in a request is converted to the numeric `game_id` in the response |
| `users;use_login=1/games` (+`;is_available=1`) | games the logged-in user plays |
| `users;use_login=1/games;game_keys=nfl/leagues` | the user's leagues in that game (league metadata) |
| `users;use_login=1/games;game_keys=nfl/teams` or `users;use_login=1/games/teams` | the user's teams (all games) |
| `game/nfl/game_weeks`, `/stat_categories`, `/position_types`, `/roster_positions`, `/dates` | week date ranges; the full stat-category universe; position types; roster-slot universe; key dates |

Only the logged-in user's own data is viewable: "you can currently only view user information for the logged in user". Which team in a league is the user's: the team-level flag `is_owned_by_current_login` and the manager flag `is_current_login` [V-community S-YFPY `Team`, `Manager` models; S-SPILCHEN uses the same field]. Documentation game ids: 2019 = 390, 2020 = 399, 2025 = 461.

### B.2 League

**`league/{league_key}` (metadata)** — `league_key, league_id, name, url, logo_url, draft_status (predraft|postdraft), num_teams, edit_key, weekly_deadline, league_update_timestamp, scoring_type (head = H2H points), league_type (private|public), renew, renewed, allow_add_to_dl_extra_pos, is_pro_league, is_cash_league, current_week, start_week, start_date, end_week, end_date, is_finished, game_code, season` (from the official sample). `edit_key` is the currently editable week for NFL (a date for daily sports) [V-official sample: `edit_key=16` with `current_week=16`; semantics V-community S-SPILCHEN `edit_date()`].

**`league/{league_key}/settings`** — "draft type, scoring type, roster positions, stat categories and modifiers, divisions". Fields in the official NFL sample:

- Draft: `draft_type (live|self|...), is_auction_draft, draft_time (epoch), draft_pick_time (s), post_draft_players (W|FA), pickem_enabled`
- Scoring: `scoring_type, uses_fractional_points, uses_negative_points, uses_median_score` [last: V-community S-YFPY], `stat_categories`, `stat_modifiers` (§B.5)
- Roster: `roster_positions[] {position, position_type, count}` — NFL sample: `QB×1 (O), WR×2 (O), RB×2 (O), TE×1 (O), W/R/T×1 (O), K×1 (K), DEF×1 (DT), BN×6, IR×1`. yfpy also reads `is_starting_position`, `is_bench`, `abbreviation`, `display_name` [V-community S-YFPY `RosterPosition`]. **Flex is literally `W/R/T`; bench `BN`; injured reserve `IR`.**
- Waivers: `waiver_type` (sample `R`; full enum [U]), `waiver_rule` (sample `gametime`; also `all` in spilchen's MLB sample [V-community]), `waiver_time` (days), `uses_faab` (0/1). **FAAB budget is not a settings field in the sample**; the per-team remaining budget is `faab_balance` on the Team resource [V-community S-YFPY `Team.faab_balance`]; the league's starting budget [U].
- Trades: `trade_end_date`, `trade_ratify_type` (sample `vote`; other values, e.g. commissioner/none, [U]), `trade_reject_time` (days), `can_trade_draft_picks` [V-community S-SPILCHEN sample].
- Playoffs: `uses_playoff, playoff_start_week, num_playoff_teams, uses_playoff_reseeding, uses_lock_eliminated_teams, has_playoff_consolation_games, num_playoff_consolation_teams, has_multiweek_championship`
- Misc: `max_teams, player_pool (ALL|...), cant_cut_list (yahoo|none), allow_add_to_dl_extra_pos, draft_together, invite_permission, persistent_url, sendbird_channel_url, league_premium_features` [last five V-community S-YFPY `Settings`]. Acquisition limits (`max_weekly_adds`, `max_adds`) are **not** in the official sample or yfpy's `Settings` model [U — the product should tolerate their absence].

**`league/{league_key}/standings`** — teams with `team_standings {rank, playoff_seed, outcome_totals {wins, losses, ties, percentage}, streak {type, value}, points_for, points_against}` plus each team's `team_points` (season total), `waiver_priority`, `number_of_moves`, `number_of_trades`, `clinched_playoffs`, `draft_grade`.

**`league/{league_key}/scoreboard;week=N`** — `scoreboard {week, matchups[]}`; each `matchup {week, week_start, week_end, status, is_playoffs, is_consolation, is_tied, winner_team_key, is_matchup_recap_available, matchup_recap_url, matchup_recap_title, matchup_grades[{team_key, grade}], teams[2]}`; each team carries `win_probability`, `team_points {coverage_type=week, week, total}`, `team_projected_points {coverage_type=week, week, total}`. Matchup `status` value `postevent` is in the sample; `preevent`/`midevent` [V-community, widely used by wrappers]. Omit `;week` for the current week.

**`league/{league_key}/transactions`** — filters: `type` (`add,drop,commish,trade`), `types` (comma list), `team_key`, `type with team_key` (`waiver`, `pending_trade` — "You can only use these options when also providing the team_key"), `count` (>0). **No `start`/offset filter is documented** → paging through a full season's history is not possible via documented parameters; fetch with a large `count` [U whether `start` works undocumented]. Completed transaction shape: `{transaction_key, transaction_id, type (add|drop|add/drop|trade|commish), status (successful|...), timestamp, players[] {player_key, ..., transaction_data {type, source_type (team|waivers|freeagents), source_team_key, destination_type, destination_team_key, destination_team_name}}}`. Trade transactions add `trader_team_key`, `tradee_team_key` and status values such as `proposed`, `accepted`, `vetoed` [V-community S-YFPY `Transaction`]. Waiver claims carry `waiver_priority`, `faab_bid` [V-official S-DOCS, PUT section]. "Pending transactions will not show up if you simply ask for all of the transactions in the league, because they can only be seen by certain teams."

**`league/{league_key}/players` (players collection) — filters** (all "applied only in a league's context"):

| Filter | Values | Usage |
|---|---|---|
| `position` | any valid position (`QB`, `RB`, `WR`, `TE`, `K`, `DEF`, and flex names) | `;position=QB` |
| `status` | `A` all available, `FA` free agents only, `W` waivers only, `T` all taken, `K` keepers only | `;status=A` |
| `search` | player name substring | `;search=smith` |
| `sort` | `{stat_id}`, `NAME` (last, first), `OR` overall rank, `AR` actual rank, `PTS` fantasy points | `;sort=60` (`60` in Yahoo's example = a stat id) |
| `sort_type` | `season`, `week` (football only), `date`/`lastweek` (non-football), `lastmonth` | `;sort_type=week;sort_week=10` |
| `sort_season`, `sort_week`, `sort_date` | year / week / `YYYY-MM-DD` | as above |
| `start` | integer ≥ 0 | `;start=25` |
| `count` | "Any integer greater than 0" | `;count=5` |

**Effective page size is 25.** The official text says any count > 0, but both Python wrappers hard-code 25: "The Yahoo! API we use doles out players 25 per page" [V-community S-SPILCHEN `league.py:394-397`], `league_player_retrieval_limit = 25` [V-community S-YFPY]. Likewise "Yahoo only returns 25 players at a time" for `player_keys` lists [V-community S-SPILCHEN `league.py:995`]. Plan on `start += 25` paging and ≤25 keys per `player_keys=` call. Whether `count>25` is silently truncated or errors: [U].

Sub-resources chainable on the collection: `/stats;type=week;week=N`, `/stats;type=season`, `/ownership`, `/percent_owned`, `/draft_analysis` (or `;out=stats,ownership,percent_owned,draft_analysis` without parameters). Stat `type` values beyond `season|week|date`: `average_season`, `lastweek`, `lastmonth` [V-community S-SPILCHEN `player_stats()`].

**`league/{league_key}/draftresults`** — per pick: `pick, round, team_key, player_key, cost` (auction) [endpoint V-official; fields V-community S-YFPY `DraftResult`].

### B.3 Team

| Path | Returns |
|---|---|
| `team/{team_key}` | `team_key, team_id, name, url, team_logos, waiver_priority, number_of_moves, number_of_trades, roster_adds {coverage_type, coverage_value, value}, clinched_playoffs, league_scoring_type, draft_position, has_draft_grade, draft_grade, draft_recap_url, managers[] {manager_id, nickname, guid, is_commissioner, is_current_login, email, felo_score, felo_tier, image_url}` + [V-community S-YFPY] `faab_balance`, `is_owned_by_current_login`, `can_edit_current_week`, `last_editable_week`, `done_week`, `elimination_week` |
| `team/{team_key}/roster;week=N` | `roster {coverage_type=week, week, is_editable, players[]}`; each player has `selected_position {coverage_type, week, position, is_flex}` (`position` ∈ the league's `roster_positions`, i.e. `QB, WR, RB, TE, W/R/T, K, DEF, BN, IR`) plus the player fields in §B.4. `week=current` or omitted = current week. `;date=` for non-NFL |
| `team/{team_key}/roster;week=N/players;out=stats,ownership,percent_owned,draft_analysis` | roster enriched in one call [V-community S-YFPY builds exactly this] |
| `team/{team_key}/matchups;weeks=1,3,6` | the team's matchups (same shape as scoreboard matchups) |
| `team/{team_key}/stats;type=week;week=N` (`week=current` allowed) / `;type=season` | `team_points` and `team_projected_points` [keys V-community S-YFPY `get_team_stats_by_week`] |
| `team/{team_key}/standings` | `team_standings` as in league standings |
| `team/{team_key}/draftresults` | that team's picks |

### B.4 Player

**Player fields** (official samples + yfpy's `Player` model; fields marked † are in yfpy only):

`player_key, player_id, name {full, first, last, ascii_first, ascii_last}, editorial_player_key (nfl.p.{id}), editorial_team_key (nfl.t.{n}), editorial_team_full_name, editorial_team_abbr, editorial_team_url†, bye_weeks {week}, uniform_number, display_position, primary_position, position_type (O offense, K, DT team defense; D IDP†), eligible_positions[position], eligible_positions_to_add†, headshot {url, size}, image_url, is_undroppable (0/1), has_player_notes, has_recent_player_notes, player_notes_last_timestamp, url, status† (e.g. "IR", "PUP", "O", "Q"), status_full† ("Questionable"), injury_note† (body part), is_keeper†, is_editable (roster context), selected_position {coverage_type, week, position, is_flex}, player_stats {coverage_type, season|week, stats[{stat_id, value}]}, player_points {coverage_type, season|week, total}, player_advanced_stats†, ownership {ownership_type (team|waivers|freeagents), owner_team_key, owner_team_name, waiver_date, display_date}†, percent_owned {coverage_type, week, value, delta}†, draft_analysis {average_pick, average_round, average_cost, percent_drafted}, transaction_data (in transactions)`.

| Path | Returns |
|---|---|
| `player/{player_key}` | metadata ("player key, id, name, editorial information, image, eligible positions, etc.") |
| `player/{player_key}/stats` / `;type=week;week=N` / `;type=date;date=` (non-NFL) | raw `stats[{stat_id, value}]`; **`player_points.total` only "if in a league context"** — i.e. use `league/{league_key}/players;player_keys=...` |
| `league/{league_key}/players;player_keys=K/ownership` | owned / on waivers / free agent within that league ("Only relevant within a league") |
| `player/{player_key}/percent_owned` | ownership % across Yahoo (with weekly `delta` [V-community]) |
| `player/{player_key}/draft_analysis` | average pick, average round, percent drafted (and cost) |

**Projections — the precise answer.**
- What exists [V-official S-DOCS samples]: `team_projected_points {coverage_type, week, total}` on each team inside `league/.../scoreboard`, `team/.../matchups`, and `team/.../stats;type=week` [last: V-community S-YFPY]; and `win_probability` (0–1) on matchup teams. That is a **team-level weekly total**, computed by Yahoo from the projected points of the starters the team currently has slotted.
- What does not exist: **no player-level projected points, no projected stat lines, no rest-of-season projections, no projection sub-resource.** Evidence: the Player resource's sub-resource list is exactly `metadata, stats, ownership, percent_owned, draft_analysis` [V-official S-DOCS]; the word "projected" occurs in the entire official reference only as `team_projected_points` (24 occurrences, all inside scoreboard/matchup samples) [V-official S-DOCS, grep]; yfpy's `Player` model — the most complete community model — has `player_points` but no projected field, while its `Team` model has `team_projected_points` [V-community S-YFPY `models.py`]; spilchen exposes no projection at all [V-community S-SPILCHEN]. Yahoo's own projections (consensus and "Fantasy Plus" tiers) exist only in the website/app UI [Yahoo help https://help.yahoo.com/kb/SLN37001.html].
- Consequence: any per-player projection, start/sit ranking or waiver-target score must come from **another source** (fed to research 04 and 05, §E). `team_projected_points` can serve as a coarse cross-check of a lineup's expected total. Whether it is populated before the week's first game and how it evolves mid-week: [U].

### B.5 Stat ids and the scoring engine

Stat categories are identified by integer `stat_id`. Two places carry them: the game-wide universe `game/nfl/stat_categories` ("Detailed description of all available stat categories for the game") and, per league, `league/{league_key}/settings` → `stat_categories.stats[]` (the categories this league tracks) and `stat_modifiers.stats[]` (the point value per unit) [V-official S-DOCS]. Per-stat fields: `stat_id, enabled, name, display_name, sort_order, position_type, stat_position_types[{position_type, is_only_display_stat}]`, and (yfpy) `abbr, group, is_excluded_from_display, bonuses[{target, points}]` [V-community S-YFPY `Stat`, `Bonus`].

**NFL stat ids from Yahoo's official settings sample** [V-official S-DOCS, `league/{league_key}/settings` sample, a public league with default scoring]. The modifier column is that sample league's value (it happens to be half-PPR, 4-pt pass TD, −1 INT, −2 fumble lost — i.e. the same shape as the validation league described in the research scope — but **the product must always read the league's own `stat_modifiers`**):

| stat_id | name | display | pos | modifier |
|---|---|---|---|---|
| 4 | Passing Yards | Pass Yds | O | 0.04 |
| 5 | Passing Touchdowns | Pass TD | O | 4 |
| 6 | Interceptions | Int | O | −1 |
| 8 | Rushing Attempts | Rush Att | O | *display only* |
| 9 | Rushing Yards | Rush Yds | O | 0.1 |
| 10 | Rushing Touchdowns | Rush TD | O | 6 |
| 78 | Targets | Targets | O | *display only* |
| 11 | Receptions | Rec | O | 0.5 |
| 12 | Receiving Yards | Rec Yds | O | 0.1 |
| 13 | Receiving Touchdowns | Rec TD | O | 6 |
| 15 | Return Touchdowns | Ret TD | O | 6 |
| 16 | 2-Point Conversions | 2-PT | O | 2 |
| 18 | Fumbles Lost | Fum Lost | O | −2 |
| 57 | Offensive Fumble Return TD | Fum Ret TD | O | 6 |
| 19–23 | Field Goals 0-19 / 20-29 / 30-39 / 40-49 / 50+ Yards | FG … | K | 3 / 3 / 3 / 4 / 5 |
| 29 | Point After Attempt Made | PAT Made | K | 1 |
| 31 | Points Allowed | Pts Allow | DT | *display only* |
| 32 | Sack | Sack | DT | 1 |
| 33 | Interception | Int | DT | 2 |
| 34 | Fumble Recovery | Fum Rec | DT | 2 |
| 35 | Touchdown | TD | DT | 6 |
| 36 | Safety | Safe | DT | 2 |
| 37 | Block Kick | Blk Kick | DT | 2 |
| 49 | Kickoff and Punt Return Touchdowns | Ret TD | DT | 6 |
| 82 | Extra Point Returned | XPR | DT | 2 |
| 50–56 | Points Allowed 0 / 1-6 / 7-13 / 14-20 / 21-27 / 28-34 / 35+ | Pts Allow … | DT | 10 / 7 / 4 / 1 / 0 / −1 / −4 |

Other ids exist in the game-wide universe (e.g. `0` = GP, `81` = Rush 1st Downs, yardage-bonus and IDP categories) [V-community S-YFPY docs example]; the full NFL table is only obtainable live from `game/nfl/stat_categories` [U for the complete list]. Yahoo's help page lists the category names/abbreviations but no ids [V-official S-HELP-6451].

**Scoring engine, purely from `settings`:** `points(player, week) = Σ_{m ∈ stat_modifiers} m.value × stat(player, week, m.stat_id)`, where categories present in `stat_categories` but absent from `stat_modifiers` (the `is_only_display_stat=1` ones such as 8, 78, 31) contribute 0; respect `uses_fractional_points` and `uses_negative_points`; yardage bonuses, when a league enables them, appear as extra stat ids with their own modifiers and/or as `bonuses[{target, points}]` on a stat [V-community S-YFPY `Bonus`; exact wire form U]. Cross-check the engine against Yahoo's own `player_points.total` (league context) for the same week — the reference implementation is one call away.

### B.6 Response formats, errors, status codes

- **Default is XML** (`content-type: application/xml`) with a `<fantasy_content>` envelope carrying attributes `xml:lang`, `yahoo:uri`, `time` (server ms), `copyright="Data provided by Yahoo! and STATS, LLC"`, **`refresh_rate="60"`** [V-official S-DOCS samples; V-probe S-PROBE for the error variant]. Namespaces: `xmlns="http://fantasysports.yahooapis.com/fantasy/v2/base.rng"`, `xmlns:yahoo="http://www.yahooapis.com/v1/base.rng"`.
- **`?format=json`** switches to JSON [V-community, honoured on errors V-probe]. The JSON is a mechanical transliteration of the XML, with these consequences for a parser (evidence: yfpy's `unpack_data` [S-YFPY `utils.py:103-170`] and spilchen's index-based access [S-SPILCHEN `league.py:189-195`, `team.py:168`]):
  1. A **resource is a JSON array** whose element `[0]` is the metadata object and `[1]` (and onward) is an object keyed by the requested sub-resource name: `fantasy_content.league[0]` = league metadata, `fantasy_content.league[1].settings[0]` = settings.
  2. A **collection is an object keyed by string indices `"0".."n"` plus a `"count"` member**, not an array: `players: {"count": 15, "0": {"player": [...]}, "1": {...}}`. yfpy: "flatten dicts with keys '0', '1', ..., 'n' to a list of objects" and "eliminate data obj counts".
  3. Single-element wrappers `{"0": {...}}` appear at arbitrary depth ("eliminate odd single-key Yahoo dicts with key = '0'").
  4. A resource's fields inside a collection element are themselves a **list of single-key objects**, e.g. `player: [[{"player_key": ...}, {"player_id": ...}, ..., {"eligible_positions": [...]}], {"selected_position": [{"coverage_type": "week"}, {"week": "16"}, {"position": "BN"}, {"is_flex": 0}]}]` — spilchen reads `selected_position[1]['position']`.
  5. **Scalars are strings** (`"is_undroppable": "0"`, `"count": "1"` inside roster positions, `"total": "112.82"`); numbers and booleans must be coerced. Empty elements arrive as `""` or are omitted.
  6. Exception: in `roster_positions`, `"count"` is data (slot count), not a collection size — yfpy special-cases `"count" in obj and "position" in obj`.
  A single normaliser that (a) converts `{count, "0".."n"}` to arrays, (b) merges lists of single-key objects into one object, and (c) coerces numerics, makes the rest of the API tractable. Alternatively parse the XML directly — it is regular and self-describing; the JSON saves nothing.
- **Error shapes** [V-probe S-PROBE]: JSON `{"error":{"lang":"en-US","description":"Please provide valid credentials. OAuth oauth_problem=\"...\", realm=\"yahooapis.com\""}}`; XML `<yahoo:error xmlns:yahoo='http://yahooapis.com/v1/base.rng' xml:lang='en-US'><yahoo:description>...</yahoo:description></yahoo:error>`. yfpy additionally recognises a "data not found" description for empty resources and raises `YahooFantasySportsDataNotFound` [V-community S-YFPY `query.py`].
- **Status codes**: `200` GET/PUT success; `201` POST success [V-community S-SPILCHEN]; `401` auth (`token_rejected`, `additional_authorization_required`, `unable_to_determine_oauth_type`) [V-probe/V-community]; `403` app not authorized [V-community S-ISS-YFPY84]; `999` rate-limited [V-community S-YFPY `query.py:435-437`]; `400` for malformed write XML and the body shape of write errors [U].

---

## C. Write surface

**Precondition for all of §C:** the app must hold Read/Write Fantasy permission — "select either Read or Read/Write access for Fantasy Sports" [V-official S-DOCS] — and today "The Yahoo Fantasy Sports API currently provides read access only. Write access is not available at this time." [V-official S-ACCESS]. Everything below is therefore **design-time knowledge** until Yahoo grants write access on application. What a read-only app receives on a PUT/POST (expected 401/403, exact body): [U].

### C.1 Lineup changes — `PUT team/{team_key}/roster`

- Operation and URI: "You can use this API to edit your lineup by PUTting up new positions for the players on a roster" — `PUT https://fantasysports.yahooapis.com/fantasy/v2/team/{team_key}/roster` [V-official S-DOCS Roster Resource, "HTTP Operations Supported: GET, PUT"].
- Request header `Content-Type: application/xml`; success is `200` [V-community S-SPILCHEN `yhandler.py` `put()`].
- **Request body** — the official page describes PUT in prose only; the body below is what the Python wrapper sends and is consistent with Yahoo's transaction XML [V-community S-SPILCHEN `team.py` `_construct_change_roster_xml`]:

```xml
<?xml version="1.0"?>
<fantasy_content>
  <roster>
    <coverage_type>week</coverage_type>
    <week>{week}</week>
    <players>
      <player>
        <player_key>{game_id}.p.{player_id}</player_key>
        <position>{slot}</position>
      </player>
      <!-- one <player> per player whose slot changes -->
    </players>
  </roster>
</fantasy_content>
```

  For daily sports `coverage_type` is `date` with `<date>YYYY-MM-DD</date>`. The wrapper sends only the players being moved (a partial list) [V-community]; whether Yahoo also accepts/requires the full roster: [U]. A swap (starter ↔ bench) is two `<player>` entries in one PUT.
- `{slot}` values are the league's `roster_positions` names: in NFL `QB, WR, RB, TE, W/R/T, K, DEF, BN, IR` [V-official S-DOCS settings + roster samples]. Eligibility is per player `eligible_positions` [V-official]; flex `W/R/T` accepts WR/RB/TE and the roster marks it with `is_flex=1` [V-official sample field].
- **IR / IL moves** (Yahoo product rules, [V-official S-HELP-28136]): eligible designations are "IR (Injured Reserve), NFI-R (Non-Football Injury (Reserve)), NFI-A (Non-Football Injury (Active)), O (Out) and Physically Unable to Perform (PUP)"; ineligible are "D (Doubtful), NA (Not Active), P (Probable), Q (Questionable), CEL (Commissioner's Exempt List) and SUSP (Suspended)". A player cannot be added straight into IR unless the commissioner enables it (`allow_add_to_dl_extra_pos` in settings is the likely flag [V-official field; mapping U]); activating from IR requires an open active slot; once an IR'd player is activated in real life "you can't complete any transaction that adds a player until you activate the once 'out' player on your fantasy team". API mapping: the player's `status` field (§B.4) must be in the eligible set for `<position>IR</position>` to succeed; the API's enforcement and its error text: [U].
- **Locked players**: by default a player locks at "The start of the player's real-life game" [V-official S-HELP-6775]; a league may instead use weekly lineups (league metadata `weekly_deadline` [V-official field; value semantics U]). The roster response carries `is_editable` at roster level [V-official sample] and per player [V-community S-YFPY `Player.is_editable`]; `edit_key` on the league is the currently editable week [V-official field]. A PUT that touches a locked player is rejected [product behaviour; API error shape U].
- **Errors**: wrappers raise on any non-200 and surface the response body [V-community S-SPILCHEN]. Auth errors use the `<yahoo:error>` envelope (§B.6) [V-probe]; validation-error bodies for illegal moves (wrong slot, locked player, IR-ineligible, roster limit): [U].

### C.2 Add / drop / waiver claims — `POST league/{league_key}/transactions`, `PUT|DELETE transaction/{key}`

All XML in this subsection is Yahoo's own, quoted from the reference [V-official S-DOCS, Transactions Collection "POST" and Transaction Resource "PUT"/"DELETE"]. Success for POST is `201` [V-community S-SPILCHEN].

**Add a free agent**
```xml
<fantasy_content>
  <transaction>
    <type>add</type>
    <player>
      <player_key>{player_key}</player_key>
      <transaction_data>
        <type>add</type>
        <destination_team_key>{team_key}</destination_team_key>
      </transaction_data>
    </player>
  </transaction>
</fantasy_content>
```

**Drop**
```xml
<fantasy_content>
  <transaction>
    <type>drop</type>
    <player>
      <player_key>{player_key}</player_key>
      <transaction_data>
        <type>drop</type>
        <source_team_key>{team_key}</source_team_key>
      </transaction_data>
    </player>
  </transaction>
</fantasy_content>
```

**Add + drop in one transaction** — `<type>add/drop</type>` with a `<players>` list holding one `add` player (`destination_team_key`) and one `drop` player (`source_team_key`) [V-official].

**Waiver claim (with FAAB bid)** — the same POST against a player whose league status is `W`: "the players will not be immediately added to your team, but rather, you will be returned back a waiver claim that will be processed at some point in the future. Various league rules will control in which conditions you will actually receive [the player]". In a FAAB league add `<faab_bid>` at transaction level:
```xml
<?xml version='1.0'?>
<fantasy_content>
  <transaction>
    <type>add/drop</type>
    <faab_bid>25</faab_bid>
    <players>
      <player>
        <player_key>{player_key_to_add}</player_key>
        <transaction_data>
          <type>add</type>
          <destination_team_key>{team_key}</destination_team_key>
        </transaction_data>
      </player>
      <player>
        <player_key>{player_key_to_drop}</player_key>
        <transaction_data>
          <type>drop</type>
          <source_team_key>{team_key}</source_team_key>
        </transaction_data>
      </player>
    </players>
  </transaction>
</fantasy_content>
```
  Note: Yahoo's own FAAB sample writes `destination_team_key` inside the *drop* player's `transaction_data`, which contradicts its plain drop sample and the wrapper (`source_team_key` for drops) [V-official S-DOCS vs S-SPILCHEN `_construct_transaction_player_xml`]. Treat the sample as a documentation typo and use `source_team_key`; confirm live [U].

**Edit a pending claim's priority or bid** — `PUT transaction/{claim_key}`; "You can only PUT to Transactions of the types waiver or pending_trade":
```xml
<?xml version='1.0'?>
<fantasy_content>
  <transaction>
    <transaction_key>{game}.l.{league}.w.c.{claim_id}</transaction_key>
    <type>waiver</type>
    <waiver_priority>1</waiver_priority>
    <faab_bid>20</faab_bid>
  </transaction>
</fantasy_content>
```
  Whether both fields may be sent in a league that uses only one of the mechanisms: [U].

**Cancel a claim or a proposed trade** — `DELETE transaction/{key}`: "you may cancel any pending waiver claim or proposed trade ... You can only DELETE transactions of the types waiver or pending_trade if the pending trade has not yet been accepted" [V-official].

**Discovering pending items** — `league/{league_key}/transactions;types=waiver,pending_trade;team_key={team_key}`; "if you don't have the transaction_key for a waiver claim or pending trade, the only way to discover these transactions is to filter the league Transactions collection by a particular type (waiver or pending_trade) and by a particular [team_key]" [V-official]. Waiver claim keys look like `461.l.1000.w.c.2_6461` (documentation example) — the claim id is not a plain integer.

**Team-level counters** relevant to add/drop limits: `number_of_moves`, `number_of_trades`, `roster_adds {coverage_type=week, coverage_value, value}` (adds this week) on the Team resource [V-official sample]; `faab_balance` [V-community S-YFPY].

### C.3 Trades

- **Propose** — `POST league/{league_key}/transactions` [V-official]:
```xml
<?xml version='1.0'?>
<fantasy_content>
  <transaction>
    <type>pending_trade</type>
    <trader_team_key>{my_team_key}</trader_team_key>
    <tradee_team_key>{their_team_key}</tradee_team_key>
    <trade_note>{free text}</trade_note>
    <players>
      <player>
        <player_key>{my_player}</player_key>
        <transaction_data>
          <type>pending_trade</type>
          <source_team_key>{my_team_key}</source_team_key>
          <destination_team_key>{their_team_key}</destination_team_key>
        </transaction_data>
      </player>
      <player>
        <player_key>{their_player}</player_key>
        <transaction_data>
          <type>pending_trade</type>
          <source_team_key>{their_team_key}</source_team_key>
          <destination_team_key>{my_team_key}</destination_team_key>
        </transaction_data>
      </player>
    </players>
  </transaction>
</fantasy_content>
```
  Multi-player trades are more `<player>` entries. The response is a `pending_trade` transaction with key `{game}.l.{league}.pt.{id}` [V-official key format].
- **Respond** — `PUT transaction/{pt_key}` with `<type>pending_trade</type>` and `<action>` [V-official, each with its own sample]:
  - `accept` (+ optional `<trade_note>`) — by the tradee;
  - `reject` (+ `<trade_note>`) — by the tradee;
  - `allow` / `disallow` — "you're the commissioner of a league that has the commissioner approve trades";
  - `vote_against` + `<voter_team_key>{team_key}</voter_team_key>` — "a league that allows managers to vote against trades".
  Which of these apply is governed by `trade_ratify_type` (sample value `vote`; the commissioner and no-review values [U]) and `trade_reject_time` (days) in settings [V-official fields].
- **Cancel** — `DELETE transaction/{pt_key}` while not yet accepted [V-official].
- **Not available** [V-official negative — no XML element or action documented]: counter-offers (propose a new trade instead), draft-pick trades (settings expose `can_trade_draft_picks` [V-community S-SPILCHEN sample] but the trade XML only carries `<player>` elements — [U] whether picks are accepted via an undocumented element), commissioner "process now"/veto beyond `disallow`, and any trade-block or trade-value endpoint.

### C.4 Which operations need `fspt-w`

| Operation | Verb | Permission |
|---|---|---|
| Every read in §B | GET | Read (`fspt-r`) [V-official "Read or Read/Write"] |
| Set lineup (`team/{key}/roster`) | PUT | Read/Write (`fspt-w`) |
| Add / drop / add-drop / waiver claim / propose trade (`league/{key}/transactions`) | POST | Read/Write |
| Edit claim, accept/reject/allow/disallow/vote on trade (`transaction/{key}`) | PUT | Read/Write |
| Cancel claim or trade (`transaction/{key}`) | DELETE | Read/Write |

The official docs distinguish only "Read" from "Read/Write"; that every non-GET verb requires the latter is the only consistent reading [V-official at that granularity]. Because write access is "not available at this time" [V-official S-ACCESS], the product must be **fully useful read-only** and treat every write tool as a capability that appears only when the granted scope includes it (§G).

---

## D. Limits and behaviour

### D.1 Rate limits and throttling

- **Documented numbers: none.** The reference contains no rate-limit section (0 hits for "rate limit"/"throttle" in S-DOCS text); the Fantasy API Terms of Use URL returns 404 [V-official negative]. The portal's only statement: "If individual usage is excessive over the course of short periods of time or impacts performance, we may temporarily throttle or limit access." [V-official S-PORTAL]. The portal also imposes an **attribution requirement** — "Developers using the Yahoo Fantasy Sports API must provide clear attribution by including 'Fantasy data provided by Yahoo Fantasy' within their products and applications which link back to Yahoo Fantasy" — and forbids automated account creation and "reverse engineering" [V-official S-PORTAL]; those are product obligations, not limits.
- **Observed by the community** [V-community]:
  - Throttling returns **HTTP status `999`**: "when you exceed Yahoo's allowed data request limits, they throw a request status code of 999" [S-YFPY `query.py:435-437`].
  - The body is an HTML/plain "Request denied" page, which crashes naive JSON parsing, and the block is "for a short period of time based on the app ID we have registered on their developer portal" [S-ISS-WAD81] — i.e. **the limit is per client id, shared by all of the app's users**.
  - Rapid sequential calls (two seasons of weekly scoreboards) produced `RemoteDisconnected` (connection dropped) rather than a status code [S-ISS-YFPY51, unanswered by the maintainer].
  - No one has published the threshold, window, or block duration; "I haven't been able to find any documentation with Yahoo on rate limits" [S-ISS-YFPY51]. `429` was not reported for this API [V-community negative].
  - yfpy's policy: on non-2xx, retry up to 3 times with `sleep(0.3 × attempt)`; on `401` re-authenticate first [S-YFPY `query.py`].
- Design consequences: a **single global limiter per client id** in the server (not per user); treat `999`, `429`, `5xx`, connection resets and non-XML/JSON bodies as retryable with exponential backoff and jitter; cache every GET for at least the response's `refresh_rate` (60 s, §D.2); batch `player_keys` in 25s and use `out=`/chained sub-resources to cut call counts (e.g. one `team/{key}/roster;week=N/players;out=stats,ownership,percent_owned` call instead of four).

### D.2 Data freshness, finalisation, roster lock

- **Response-level hint**: every league/team/player/transaction sample carries `refresh_rate="60"` [V-official S-DOCS] — Yahoo's own statement that the payload is good for 60 s. Poll no faster.
- **Live games**: the site scores live and the API's `team_points`/`player_points` reflect live stats during games [V-community — every live-scoreboard wrapper relies on it]; update cadence within the 60-s window: [U].
- **Official finalisation** [V-official S-HELP-6868, verbatim]: "All official player scoring, live data corrections and league standings are normally updated by 8:00am Pacific Time the morning after the game(s)." For football, "official stat corrections can be applied up until the first real life game in the next matchup week", and "If stat corrections aren't received by 11:59 p.m. P.T. at the end of the Game Week, they won't be applied as that week's Head-to-Head is no longer active." → A week's `player_points`, `team_points` and matchup `winner_team_key` are **provisional until the next week's first kickoff (typically Thursday night)**; cache invalidation must respect that.
- `league_update_timestamp` (epoch) is present in league metadata [V-official field]; what it tracks (settings change vs data refresh): [U].
- **Roster lock** [V-official S-HELP-6775 for the product rule]: default deadline for moving players is "The start of the player's real-life game" (per-player lock); private leagues may choose a weekly lineup lock. The API mirrors this through `is_editable` on the roster and player [V-official / V-community], `edit_key` (current editable week) and `weekly_deadline` on the league [V-official fields]. Waivers: sample `waiver_rule=gametime` means dropped players and players whose game has started go through waivers [V-official value; rule semantics are Yahoo product knowledge]; claims process after `waiver_time` days [V-official field; the overnight processing hour: U].
- **Bye weeks** are static per player (`bye_weeks.week`); **game weeks** with start/end dates come from `game/nfl/game_weeks` [V-official] — use them to map "current NFL week" without a second data source.

### D.3 Region-locked, deprecated, or changing

- **Access model changed in 2026** (timeline from community reports, dates as stated in the sources): write access removal first reported around 2025-10; the new portal `sports.yahoo.com/developer` launched around 2026-05; the old guide began 308-redirecting around 2026-05-29 [V-probe today]; on **2026-07-22 all Fantasy endpoints started returning 403 for previously authorised apps**; by 2026-08-11 the YDN app-creation form no longer offered a "Fantasy Sports (Read)" permission, so newly created apps get valid OAuth credentials that are not entitled to the Fantasy API [V-community S-ISS-YFPY84, S-ISS-DRB18]. Only the per-client-id application route remains [V-official S-ACCESS].
- **Docs are partly stale** [V-official text vs V-community reality]: S-DOCS still instructs "follow the New API Key flow on the Yahoo Developer Network (YDN) ... select either Read or Read/Write access for Fantasy Sports" — that option no longer exists. Sample responses are from the 2019 season (game 390) while the URI examples were updated to 2025 (game 461). The "Sample Code" links are PHP gists. `xoauth_yahoo_guid` in the token response is marked deprecated [V-official S-OAUTH-FLOW].
- **OAuth 1.0a is gone**: "The Yahoo Fantasy Sports API requires Oauth 2.0" [V-official S-DOCS]. The old guide's 2-legged "public requests" for public leagues survive only in the community mirror [S-MIRROR]; whether public-league reads still work with app-only credentials: [U] (the credential-free probe got 401, so at least app credentials are required).
- **Region**: no region restriction is stated anywhere [U]. Yahoo Fantasy Football is a US/Canada product; the API host answered from a US region (`x-envoy-decorator-operation: ...use1...`) [V-probe].
- **JSON via `format=json`** is undocumented and could disappear; XML is the documented contract [V-official negative for JSON].

---

## E. Gaps — what the product wants that Yahoo does not provide

Each item is a clean negative against the official resource list (`game, league, team, roster, player, transaction, user` and their sub-resources) [V-official S-DOCS] and the wrappers' models [V-community S-YFPY, S-SPILCHEN]. These feed research 04 and 05.

| Gap | What Yahoo has instead | Needed from elsewhere |
|---|---|---|
| **Player projections** (weekly, ROS, per-stat) | `team_projected_points` per team per week; `win_probability` per matchup | Any per-player projection source; Yahoo's own consensus/"Fantasy Plus" projections are UI-only |
| Player **news / notes text** | `has_player_notes`, `has_recent_player_notes`, `player_notes_last_timestamp` (flags) | News feed with text |
| **Injury detail** beyond a designation | `status` (IR/O/Q/D/PUP/...), `status_full`, `injury_note` (body part) | Practice reports, expected return, game-time decisions |
| **Usage metrics** — snap counts, routes, air yards, red-zone share, target share | `Targets` (78) and `Rush Att` (8) as display-only stats in league context; `player_advanced_stats` exists in yfpy's model with unknown content [U] | Usage/advanced stats provider |
| **NFL schedule, opponent, matchup difficulty, defensive rankings** | `game/nfl/game_weeks` (dates only), player `editorial_team_key`, `bye_weeks` | Schedule + opponent data |
| **Depth charts** | `primary_position`, `eligible_positions` only | Depth-chart source |
| **Betting lines, totals, implied team totals, weather** | nothing | Odds/weather provider |
| **Rankings / rest-of-season values / trade values** | `sort=OR` / `sort=AR` ordering (overall/actual rank as sort keys) and `draft_analysis` (ADP) — no rank value fields [U] | Expert consensus rankings, trade calculators |
| **Cross-provider player identity** | Yahoo `player_id`/`player_key`, `editorial_player_key`, name, team, `uniform_number`, headshot | An id crosswalk (name+team+number matching, or a provider that carries Yahoo ids) |
| **Transaction-history paging** | `count` only, most-recent-N | Local persistence of history if full-season audit is wanted |
| **League FAAB budget** (starting amount) | `uses_faab`; per-team `faab_balance` [V-community] | Derive: max of `faab_balance` pre-season, or ask the user |
| **Commissioner tools** (edit settings, force moves, lock/unlock, veto beyond `disallow`) | `commish` transactions are *readable* only | Not available; out of scope |
| **Draft-room actions** (make a pick, auction bid) | `draftresults` read-only | Not available |
| **League chat / messages** | `sendbird_channel_url`, `iris_group_chat_id` fields (identifiers only) | Not available |
| **Push / webhooks / streaming** | none — polling only, `refresh_rate="60"` | Polling scheduler |
| **Write access** at all, today | "Write access is not available at this time" | Application to Yahoo; product must be read-only-first |

---

## F. Unverified — to confirm with a live token (by name)

1. `redirect_uri` on **refresh** — required or merely tolerated (Yahoo's sample includes it; wrappers always send it).
2. **Refresh-token longevity** across months of inactivity (no documented expiry).
3. **localhost/port rules** in the app form beyond the one data point (`https://localhost:5001/...` accepted; `http://` rejected); whether a `127.0.0.1` https URI or a non-default port range is refused.
4. Behaviour of the **introspection** and **revocation** endpoints for Fantasy tokens.
5. Exact response of a **read-only app** issuing PUT/POST (expected 401 `additional_authorization_required` or 403).
6. Whether **`count > 25`** on the players collection is truncated or errors; whether **`start`** works on the transactions collection despite being undocumented.
7. Whether `team_projected_points` is **populated pre-week** and how it moves mid-week; whether `player_advanced_stats` carries anything for NFL.
8. The **full `game/nfl/stat_categories` list** (ids beyond the 36 in the settings sample, including bonus and IDP categories) and the wire form of yardage **bonuses** (`bonuses[{target, points}]` vs extra stat ids).
9. Enumerations: `waiver_type` (beyond `R`), `waiver_rule` (beyond `gametime`, `all`), `trade_ratify_type` (beyond `vote`), `post_draft_players`, matchup `status` (`preevent`/`midevent` besides the sampled `postevent`), transaction `status` values for waivers/trades.
10. Whether `max_weekly_adds` / `max_adds` (acquisition limits) appear in `settings` at all.
11. **Roster PUT**: partial vs full player list; the error bodies for locked players, ineligible slots, IR-ineligible status, and whether `allow_add_to_dl_extra_pos` is the "add directly to IR" switch.
12. The **FAAB sample's `destination_team_key` on the drop** — typo or accepted.
13. Whether **draft picks** can be included in a trade via an undocumented element.
14. **Rate-limit numbers**: threshold, window, block duration, and whether `429` ever appears; whether the limit is per client id only or also per user/IP.
15. **Live update cadence** within the 60-s `refresh_rate` during games; what `league_update_timestamp` tracks; the hour at which waivers process.
16. Whether **public leagues** are readable with app-only (2-legged) credentials, as the old guide allowed.
17. Any **region** restriction on token issuance or API access.
18. **Approval latency** for the access application, and whether write access is ever granted to small/individual products.

---

## G. The three facts that most constrain the architecture

1. **Access is application-gated, per client id, read-only by default, and write is currently unavailable** [V-official S-ACCESS; V-community S-ISS-DRB18/S-ISS-YFPY84]. The product cannot be built on the assumption that a user can "create a Yahoo app and go"; it needs one approved client id owned by the product, a secret held server-side (no PKCE → confidential client), and a read-only-first design where lineup/waiver/trade tools are conditional capabilities.
2. **There are no player-level projections in the API** — only a team-level weekly projected total and a win probability [V-official negative]. Every start/sit, waiver-target or trade-evaluation feature needs an external projection/news source and an id crosswalk keyed on name + team + number (Yahoo ids are Yahoo-only).
3. **The league is fully self-describing from one call, and the data has a 60-second freshness contract with an undocumented, per-app rate limit.** `league/{key}/settings` yields `stat_modifiers`, `stat_categories` and `roster_positions` (a scoring engine and slot model with zero hard-coding) [V-official]; every response says `refresh_rate="60"`; throttling is HTTP `999` "Request denied" against the client id, shared by all users [V-community]. So: one global limiter, a 60-s cache keyed by URI, XML parsing (JSON is an undocumented transliteration), 25-per-page player paging, and weekly results treated as provisional until the next week's first kickoff.
