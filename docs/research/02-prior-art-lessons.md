# 02 — Prior-art lessons (architecture only)

**Author:** `repo-security-auditor` agent · **Date:** 2026-09-29 · Source of every claim:
`01-repo-security-audit.md` (file:line evidence lives there). Only repos with a
**Safe** or **Caution** verdict contribute to the matrix. A short final section lists
mistakes seen in *rejected* repos, for avoidance only. **No code was copied from any
repo and none appears here** — these are design observations.

Passing set: asteiger/yahoo_fantasy_mcp (A), michaelfromorg/mcp-yahoo-fantasy (M,
caution), brettadams0/yahoo-fantasy-mcp (B), spilchen/yahoo_fantasy_mcp (S),
kwonye/yahoo-fantasy-agent (K), deepak-or1/yahoo-fantasy-mcp (D, caution);
wrappers whatadewitt `yahoo-fantasy` (W), uberfastman/yfpy (Y, GPL caution),
spilchen/yahoo_fantasy_api (P), josuebrunel/yahoo-oauth (O, caution); data libs
nflverse/nflreadpy + nflreadr (N), ffverse/ffscrapr (F), dtsong/sleeper-api-wrapper (SL).

## 1. Capability matrix — Yahoo MCP servers

✓ present · ◐ partial · ✗ absent · — not applicable

| Capability | A | M | B | S | K | D |
|---|---|---|---|---|---|---|
| Roster read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Lineup write (bench/start) | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ |
| Add / drop | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ |
| Waiver claim / FAAB bid / edit / cancel | ✓ claim(+drop) | ✓ claim(+drop) | ✗ | ◐ read waivers | ✓ claim, edit, cancel | ✗ |
| Trades (propose / accept / reject) | ✓ all three | ◐ accept/reject only | ✗ | ◐ read proposed | ✓ propose + action | ✗ |
| Transactions feed | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Standings / scoreboard / matchups | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Player stats / search / free agents | ✓ | ✓ | ◐ search only | ✓ | ✓ (+ownership, %owned, draft analysis) | ✓ |
| Projections | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| News / player notes | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Caching (data) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ (KV is for auth sessions) |
| Confirmation gate before a write | ✗ (annotations + warning text) | ✗ | — | — | ✗ (destructive hint, no auto-retry, run journal) | — |
| Input validation | raw JSON schema | type hints (FastMCP) | zod v3 | raw JSON schema | zod v4 + key validator | zod v4 |
| Raw "GET any Yahoo path" escape hatch | ✗ | ✗ | ✓ (host-pinned, `..` allowed) | ✗ | ✓ (path-constrained) | ✓ (host-pinned, `..` allowed) |
| Token storage location | cwd `oauth2.json`, 0o600, or env vars | cwd `.env` plaintext (incl. consumer secret) + `~/.config/…/oauth2.json` | `<repo>/credentials/token.json`, default perms | cwd `oauth2.json` (via yahoo-oauth) | XDG `~/.config/…/token.json`, 0o600, atomic, lockfile | remote: AES-GCM in Redis with TTL; local: `~/.config/…/token.json` 0o600 in 0o700 dir |
| OAuth flow | oob via yahoo-oauth | oob via yahoo-oauth | oob, code pasted | oob via yahoo-oauth | local HTTP callback | server is an OAuth 2.1 AS (PKCE S256, DCR) fronting Yahoo |
| Transport | stdio (custom graceful shutdown) | stdio (FastMCP) | stdio | stdio (custom) | stdio + optional HTTP | Streamable HTTP (Next.js) + local stdio variant |
| MCP resources / prompts | ✗ | ✗ | ✗ | ✓ league-id resource from env | ✗ | ✗ |
| Ops tooling | `auth` CLI | `yahoo-login` CLI | `authorize`, `check-auth` | CLI | `auth`, `status`, `doctor`, `smoke` | `.well-known` discovery |
| Tool count | 28 | 29 | 10 | 20 | 50 | 14 |

Two facts fall straight out of the matrix:

- **Nobody has projections, news, or a data cache.** The Yahoo API has no projections
  endpoint; every server stops at what Yahoo returns. Projections/news would have to
  come from a second, declared data source (see §3).
- **Nobody has a confirmation gate.** Every write tool executes on a single model call.
  The best mitigations seen are annotations (`readOnlyHint`/`destructiveHint`),
  an explicit "this modifies your team" suffix in every write description, a
  no-automatic-retry rule, and a journaled run (K) — none of which stops a
  prompt-injected drop.

## 2. Capability matrix — wrappers and data libraries

| Capability | W (Node) | Y (Py, GPL) | P (Py) | O (Py) | N (nflverse) | F (ffscrapr, R) | SL (Sleeper) |
|---|---|---|---|---|---|---|---|
| Yahoo read: games/leagues/teams/players/rosters/transactions | ✓ collections + subresources | ✓ typed models per entity | ✓ | — | — | ✗ (no Yahoo) | — |
| Yahoo writes | not verified | ✗ (read-only library) | ✓ add/drop/claim/trade/roster | — | — | ✗ | — |
| Auth | app-supplied token callback; no persistence | via O; token → `.env` | via O | oob flow; `secrets.json` in cwd | none needed | per-platform | none (public API) |
| Player stats (NFL, not fantasy) | — | — | — | — | ✓ weekly/seasonal, snaps, NGS, FTN, PFR | via N | ✓ Sleeper stats endpoints |
| Projections | — | — | — | — | ✗ (not an nflverse product) | ✗ | Sleeper has weekly projections; wrapper coverage not verified |
| News / injuries | — | — | — | — | ◐ injuries + depth charts | — | ◐ trending adds/drops |
| Caching | — | ✓ optional JSON save/load | — | — | ✓ user cache dir (platformdirs / rappdirs + cachem/memoise) | ✓ memoise + `ratelimitr` | — |
| Config | ctor args | `.env` + env JSON override for containers | ctor | ctor/file | pydantic-settings | R options | — |
| Rate limiting | — | — | — | — | — | ✓ per-platform limiter | — |

## 3. Architectural choices that work (adopt the idea, not the code)

1. **Annotate every tool** with `readOnlyHint` / `destructiveHint` / `openWorldHint` and
   keep the write tools in a separate, explicitly listed set (A, B, D, K). Clients
   render these; it is the cheapest first line of defence.
2. **Schema-validate every argument and validate resource keys before they touch a
   URL** — zod/pydantic per tool plus a single key-format validator and
   URL-encoding at the one place paths are built (K's `resourcePath`, B's
   `encodeURIComponent`). Yahoo keys have a fixed grammar (`game.l.league`,
   `game.p.player`, `game.l.league.t.team`); reject anything else.
3. **The library never stores tokens; the application does** (W). The wrapper takes a
   token and a refresh callback; storage policy (file vs keychain vs KV) stays with the
   host. This is the seam that lets a stdio server and a remote server share one Yahoo
   client.
4. **Token store done right** (K, D-local): OS config dir (XDG / `~/.config/<app>`),
   directory `0o700`, file `0o600`, created with an exclusive temp file and renamed
   (atomic), guarded by a lockfile so two server processes cannot clobber each other,
   with an env override for the path. **Consumer secret only from env**, entered with
   a hidden prompt when interactive (A).
5. **Protocol on stdout, everything else on stderr**, and a stdio transport that shuts
   down cleanly on Ctrl-C (A, S, K). No `print`/`console.log` in server modules —
   keep them in the CLI subcommands.
6. **Return JSON, not language-native `repr`** (M, B, D, K) — see mistake 4 below.
7. **A league identity as an MCP resource** (S): the configured league key is
   discoverable by the client without every tool needing it as an argument, and it is
   set by the operator, not the model.
8. **Operational subcommands**: `auth`, `status`, `doctor`, `smoke` (K), `check-auth`
   (B). A user can prove the token works before wiring the server into a client.
9. **Remote variant = the server is the OAuth 2.1 authorization server** (D):
   `.well-known` discovery, dynamic client registration, PKCE S256 mandatory for public
   clients, redirect allow-list limited to `https:` or `http://localhost`, Yahoo
   tokens encrypted at rest with a server key and stored with TTLs. This is what an
   "install from claude.ai" flow needs.
10. **Pin the MCP SDK exactly and keep the lockfile audit at zero** (K, D). The SDK has
    had cross-client data-leak advisories at ≤1.25.3; a floating `^` picked up the
    vulnerable line in three of the audited repos.
11. **Write journal + reconcile** (K): every mutation is recorded before it is sent,
    sent once, never auto-retried, and later reconciled against the transactions feed.
    This is the natural place to bolt on a confirmation gate (§5).
12. **Data-side patterns from nflverse/ffverse**: content-addressed release files
    fetched over HTTPS from a fixed host; a user-level cache directory with memoised
    reads; a per-platform rate limiter; typed settings object for configuration.
    Sleeper's public, keyless API is the cheapest second source for trending
    adds/drops and player metadata.

## 4. Mistakes to avoid — with the symptom each one produces

| # | Mistake | Seen in | Symptom |
|---|---|---|---|
| 1 | Token file path relative to **cwd** or inside the **repo directory** | A, S (`oauth2.json`), B (`credentials/`), M (`.env`) | Server "loses" its login when launched from another directory by the MCP client; a stray `git add .` or a directory backup captures the token; gitignore is the only guard |
| 2 | **Consumer secret written next to the tokens** in plaintext | M, Y, O | One file leak burns the app registration as well as the user session; Yahoo apps cannot rotate the secret without re-consent |
| 3 | Token file created with **default umask permissions** | O, B, M | World-readable on a 022 umask; any local process or backup agent can read it |
| 4 | Tool result is **`str(dict)` (language-native repr)** instead of JSON | A, S | Model receives `{'key': True, 'x': None}`; downstream parsing and citation break; unicode escapes vary |
| 5 | **No confirmation step** on lineup / drop / waiver / trade | A, M, K | One injected instruction inside a player note or league message can drop a starter; no undo (Yahoo drops are final once processed) |
| 6 | **Error text embeds the raw upstream response body** | B | Yahoo returns HTML on some errors; hundreds of lines of markup land in the model context, sometimes including the request URL |
| 7 | **"Raw GET any path"** escape hatch without path grammar | B, D | Model can reach any Yahoo resource the token allows (other leagues, user profile), and `..`/`;` matrix params defeat intent; K's constrained variant is the right shape |
| 8 | **Floating dependencies, no lockfile** | S (`mcp>=0.1.0`), P, O | Fresh install resolves a different major of the MCP SDK or of the OAuth lib; behaviour differs per machine; unauditable |
| 9 | **Dead transitive auth library** (`rauth`, last release 2017) under the whole OAuth path | O → P → A, S, M, Y | No fixes ever; every consumer inherits it |
| 10 | **Dev-dependency vulnerabilities mixed into the runtime lock** | Y (11 HIGH, all dev/docs) | Audit reads red; real signal hidden; users cannot tell |
| 11 | **Build output and rendered docs committed** | Y (`docs/` site with minified jQuery), jimbrig (`build/`) | Minified blobs trip obfuscation scans; repo size; stale duplicates of source |
| 12 | **Side-effectful "install" scripts** | M (`brew install --cask claude`) | Installer changes the user's machine beyond the project; unreviewable by an MCP client's install flow |
| 13 | One **giant if/elif dispatcher** over tool names in a single file | A (840-line server), S | Adding a tool means editing three places; write tools and read tools share one error path; no per-tool tests |
| 14 | **Two OAuth flows kept alive side by side** (PKCE + local callback and `oob`) | (rejected repos; also latent in A/S via yahoo-oauth defaults) | Users follow the wrong README; redirect URI mismatch errors; two token formats on disk |
| 15 | **Untrusted text returned unlabelled** | every server | Team names, player notes and league messages arrive in the same JSON as system facts; the model cannot tell data from instruction |

## 5. What the matrix says our design should do differently

- **Confirmation gate as a two-step tool pair**: `prepare_<write>` returns a compact
  human-readable diff and an opaque, short-lived confirmation token; `commit_<write>`
  requires that token. The model cannot forge the token; the user (or a client
  elicitation) supplies it. K's journal is the storage for it.
- **Label untrusted fields** in every result: wrap free-text fields (team names, notes,
  messages, news) in a clearly named `untrusted_text` structure and say so in the tool
  description, so the client and model treat them as data.
- **Token store = OS config dir + 0o600 + atomic + lockfile + env override; consumer
  secret never on disk.** (K, D-local) — and a `doctor` command that verifies the mode
  bits.
- **JSON out, always; schema in, always; one path builder with key grammar.**
- **Exact-pinned SDK, lockfile, zero-vuln audit gate in CI; runtime and dev groups
  separated.**
- **Projections/news are out of scope for Yahoo tools** — they come, if at all, from a
  declared second source with its own tool prefix and its own untrusted-text labelling.

## 6. Mistakes observed only in rejected repos (avoidance only; no lessons taken)

- Tokens written into the **desktop client's own config file** (`claude_desktop_config.json`,
  Cursor, Antigravity) — turns the client config into a secret store with unknown
  permissions.
- A **third-party LLM sink** (OpenAI) that switches on merely because a key is present,
  sending roster/league data off-host without a declared tool boundary.
- **Scraping the Yahoo website with a persistent logged-in browser profile** and
  spawning a detached background process from a tool.
- **Pickle** on-disk caches (arbitrary object deserialisation of local files).
- `print()` in server modules (stdout corruption under stdio).
- Real credentials committed and later "removed" — history keeps them; the only fix is
  rotation. Our `.gitignore` already blocks the file patterns; the process rule is that
  no real value is ever typed into a tracked file, example or not.
