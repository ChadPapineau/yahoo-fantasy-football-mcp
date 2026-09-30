# 01 — Repo security audit (prior-art vetting)

**Author:** `repo-security-auditor` agent · **Date:** 2026-09-29 · **Status:** complete for the
brief's list + 4 additions found by search. Companion doc: `02-prior-art-lessons.md`
(architecture lessons from the repos that pass).

Every repo below was treated as **untrusted**. Nothing from any clone was installed or
executed. All findings come from `git` plumbing, `grep`, reading source, `gh api`,
`npm audit --package-lock-only` (reads the lockfile, runs no scripts) and the public
OSV API. Secret **values** found in history are deliberately not reproduced here; only
the commit and file that contain them.

## Method

1. Metadata via `gh api repos/<o>/<r>` (language, SPDX license, stars, archived, fork
   parent, `pushed_at`). Forks compared to their parent with the compare API
   (`ahead_by`/`behind_by`) — forks with no substantive changes were skipped by name.
2. Clone into the session scratchpad, **outside the repo**
   (`…/scratchpad/yff-research/vendor/<owner>__<name>`). Full history for the small
   MCP servers and wrappers (so `git log -p` history checks are real); `--depth 1` for
   the three large nflverse/ffverse repos (history **not** checked — stated per repo).
3. One static inventory script per clone (`inv.sh`, my own, kept in the scratchpad):
   tracked-file listing, suspicious filenames, `.gitignore`, lockfiles, manifests,
   secret-pattern greps (incl. Yahoo `dj0y…` consumer-key prefix and long hex/base64
   literals), every outbound host literal, obfuscation/exec markers (`eval`,
   `new Function`, `subprocess`, `child_process`, `__import__`, dynamic
   `require`/`import()`, base64 decode), install-time hooks (`preinstall`/`postinstall`/
   `prepare`/`prepack`, `setup.py` custom commands, build backends), token-file writes
   and their permission bits, OAuth markers (`oob`, PKCE, redirect URI, local callback
   server), stdout logging, log lines that mention tokens/URLs, validation libraries,
   confirmation/dry-run markers, MCP tool names, and `git log -p` for secrets and for
   deleted env/token files.
4. Targeted reads of the auth, tool-registration and write-tool code paths.
5. Dependency audit: `npm audit --package-lock-only --ignore-scripts --json` for every
   Node lockfile; for Python, every **pinned** package in `uv.lock`/`requirements.txt`
   was sent to `POST https://api.osv.dev/v1/querybatch` and each returned advisory
   resolved via `/v1/vulns/{id}` for severity. Floating (`>=`) requirements are listed
   as *not queried* rather than guessed. Lookalike dependency names were checked on
   PyPI/npm for existence, age and maintainer.

## Summary table

| # | Repo | Reviewed SHA | Lang | License | Last commit | Stars | Maintained? | Verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | carterfawson/fantasy-football-mcp | `d01f2442e9f61053bedd86e21cb0502822e78d94` | Python | MIT | 2025-09-23 | 0 | No (1 yr idle) | **Do not use** — real Yahoo consumer key/secret + access/refresh tokens in history |
| 2 | asteiger/yahoo_fantasy_mcp (fork of #9, +8 commits) | `9be094a61dd460b7b555eae9665cb458aceb6364` | Python | MIT | 2026-09-14 | 0 | Yes | **Safe to learn from** |
| 3 | michaelfromorg/mcp-yahoo-fantasy | `3ed5e89491a3844427cb26e4cd901be399846755` | Python | MIT | 2026-06-08 | 6 | Slow | **Learn from with caution** — tokens in plaintext `.env` in cwd; unconfirmed writes; 3 CRITICAL deps |
| 4 | cketcham/fantasy-football-mcp (fork of #7, +2/−131) | `628904d` | Python | MIT | 2025-09-15 | 0 | No | **Skipped** — fork, 2 packaging commits, inherits #7's leaked history |
| 5 | kYpranite/fantasy-football-mcp-public (fork of #7, +36) | `e7692660a2ecc8ba1075a4129b84ab62072d7476` | Python | MIT | 2026-09-22 | 0 | Yes | **Do not use** — inherits leaked history; adds logged-in Chrome/Playwright scraping of sports.yahoo.com |
| 6 | brettadams0/yahoo-fantasy-mcp | `32446b83948bc7b192f71b064f3d16e74caa97c6` | JavaScript | MIT | 2026-07-28 | 0 | Small, idle 2 mo | **Safe to learn from** |
| 7 | derekrbreese/fantasy-football-mcp-public | `0e50203984414a09e11780b14cefc6186ebf4fed` | Python | MIT | 2026-09-06 | 87 | Yes | **Do not use** — real Yahoo + Reddit credentials and tokens in history (`.env`, `.env.cloudrun`, `.yahoo_token.json`) |
| 8 | andrewrgoss/fantasy-football-mcp (fork of #7, +7) | `5fd72acc29ef1c94fa70f2e7383944902a7aad0d` | Python | MIT | 2026-08-23 | 0 | Yes | **Do not use** — inherits leaked history; adds undeclared FantasyPros/VegasInsider hosts |
| 9 | spilchen/yahoo_fantasy_mcp | `133a45ab57738dad146dcb6b5557f70f8cf7d4e6` | Python | MIT | 2026-03-15 | 5 | Slow | **Safe to learn from** (caution: floating deps, no lockfile) |
| 10 | jschne88/yahoo-fantasy-football-mcp (fork of jimbrig, +0) | — | — | none | 2025-08-20 | 0 | No | **Skipped** — identical fork; parent audited as #10b |
| 10b | jimbrig/yahoo-fantasy-baseball-mcp | `6aabbe60d377c22144d691eec144efb54173711b` | TS/JS | **none** | 2025-05-14 | 5 | No | **Do not use** — no license; obsolete OAuth 1.0a; 1 CRITICAL/3 HIGH deps |
| 11 | whatadewitt/yahoo-fantasy-sports-api (npm `yahoo-fantasy`; brief's `edwarddistel/…` does not exist) | `fc66175fdb02ecc0b2dac2f646eb90e3f586bed7` | JavaScript | MIT | 2026-09-24 | 228 | Yes | **Safe to learn from** |
| 12 | uberfastman/yfpy | `5287b2d68d33d0f03f24eea70c179ae27aedc99c` | Python | **GPL-3.0** | 2025-09-14 (main) | 268 | Yes | **Learn from with caution** — GPL; token written to `.env` |
| 13 | spilchen/yahoo_fantasy_api | `c9f4fef444a521022579ba38e4721f0a780f66c6` | Python | MIT | 2026-04-03 | 110 | Yes | **Safe to learn from** (caution: unmaintained deps, no lockfile) |
| 14 | josuebrunel/yahoo-oauth | `f4a8583043119a21031c21644afb927051089377` | Python | MIT | 2024-12-17 | 65 | Idle 21 mo | **Learn from with caution** — plaintext `secrets.json` in cwd, default perms; `rauth` dep dead since 2017 |
| 15 | nflverse/nfl_data_py | — | Python | MIT | 2025-09-25 | 441 | **Archived** | **Skipped** (archived); successor audited: |
| 15b | nflverse/nflreadpy | `e7e87b2ef626b8672279db25432b1554ee13348a` | Python | MIT | 2026-09-09 | 223 | Yes | **Safe to learn from** |
| 16 | nflverse/nflreadr | `23f915a5be30415aeaa0c5c80cd23b2c69cda122` | R | MIT | 2026-09-17 | 115 | Yes | **Safe to learn from** |
| 17 | ffverse/ffscrapr | `b6990181e125507a1b4642cea6bc9778d9acd6f3` | R | MIT | 2024-10-31 | 96 | Idle 23 mo | **Safe to learn from** (note: **no Yahoo support** — MFL/Sleeper/ESPN/Fleaflicker) |
| 18 | dtsong/sleeper-api-wrapper | `7d50cf2a5cdd64d6f2901cd5008853d70ba97def` | Python | MIT | 2026-05-24 | 101 | Yes | **Safe to learn from** |
| 19+ | MichaelCrowcroft/fantasy-football-mcp | `d409754c801fce62ebd6df646832f8d030626861` | TypeScript | none (pkg says MIT) | 2025-08-12 | 3 | No (1 commit) | **Do not use** — stdio proxy that ships every request to a third-party host `www.sleeperdraft.com` |
| 20+ | deepak-or1/yahoo-fantasy-mcp | `9311167c6e8957c17711c232ec6a207458db0690` | TypeScript (Next.js) + Python | **none** | 2026-09-16 | 0 | New (3 commits) | **Learn from with caution** — no license; otherwise the best-engineered remote design seen |
| 21+ | kwonye/yahoo-fantasy-agent (npm `@kwonye/yahoo-fantasy-mcp`) | `0f8819d3301ff20aec4191d20c27150137a09e8f` | TypeScript | ISC | 2026-09-13 | 0 | New (6 commits) | **Safe to learn from** (caution: brand-new, single author) |

Search coverage: `gh search repos "yahoo fantasy mcp"` (12 hits) and `"fantasy football mcp"`
(19 hits) on 2026-09-29. Beyond the brief's list, the only non-fork hits with either
stars, TypeScript, or an npm release were #19–#21; the remaining ~15 are 0-star
single-author Python repos of the same shape as #2/#9 and were not cloned (budget).
`yahoo-fantasy-baseball-mcp` (jimbrig) was pulled in only because #10 is its identical
fork. Sleeper clients: `dtsong/sleeper-api-wrapper` is the most-starred (101); npm
`sleeper-mcp` and `@unclick/sleeper-mcp` exist but are 0-star and were not audited.

---

## Per-repo findings

Category key: **C** credentials · **N** network/exfil · **O** obfuscation · **I**
install-time execution · **A** OAuth/token handling · **P** prompt-injection surface ·
**V** input validation · **D** dependencies · **L** license · **G** logging hygiene.

### 1. carterfawson/fantasy-football-mcp — Do not use

- **C — HISTORICAL LEAK.** Commit `f4c4c1b` (2025-09-23, "Enhanced Fantasy Football MCP
  Server") **added** `.yahoo_oauth.json` and `.yahoo_token_complete.json` containing a
  real Yahoo `consumer_key` (`dj0y…` format), `consumer_secret` (40-hex), a full
  `access_token` and `refresh_token`. Commit `d01f244` (same day, "Security: Remove
  sensitive credential files") deleted them, but they remain in history
  (`git log -p` lines 136–151 of the diff stream). `git log --diff-filter=D` also
  shows `.env.example` churn. `.gitignore` now lists those filenames — after the fact.
- **N:** hosts are `api.login.yahoo.com`, `fantasysports.yahooapis.com`,
  `api.sleeper.app` (declared), Reddit via `praw` (opt-in creds). Clean.
- **O:** `utils/verify_setup.py:122` `__import__(package)` over a fixed list — benign.
  `src/agents/cache_manager.py:761/782` **pickle** load/dump of the on-disk cache
  (deserialising local files; a local-tamper risk, not remote).
- **I:** none (`setuptools.build_meta`).
- **A:** two flows coexist: `src/agents/yahoo_auth.py:270` PKCE + local `HTTPServer`
  callback on `localhost:8090`; `utils/setup_yahoo_auth.py:133` `redirect_uri=oob`.
  Tokens written plaintext to `.yahoo_token.json` in the **repo dir**
  (`setup_yahoo_auth.py:96-99`), to `.env` (`refresh_token.py:57-64`), **and into
  `claude_desktop_config.json`** (`utils/refresh_token.py:91-107`) — the desktop
  client's config file becomes a token store.
- **P:** tool results are `json.dumps` of Yahoo/Reddit data with no data/instruction
  labelling; `ff_analyze_reddit_sentiment` returns Reddit text.
- **Write tools with no confirmation:** `ff_add_player`, `ff_drop_player`,
  `ff_set_lineup`, `ff_place_waiver_claim`, `ff_propose_trade`, `ff_manage_trade`
  execute on a single model call (`fantasy_football_multi_league.py:1836-1918`).
- **V:** raw JSON `inputSchema`; handlers use `arguments.get()` with presence checks
  only; keys interpolated into XML/paths unescaped.
- **D:** `requirements.txt` 95 pins (no lockfile). OSV: **5 CRITICAL, 47 HIGH,
  44 MODERATE, 17 LOW** (dominated by `aiohttp==3.11.11`; 5 floating entries not
  queried).
- **L:** MIT. Learning is permitted; we copy no code.
- **G:** 200+ `print()` calls, mostly in `utils/` CLIs; server module has 13 —
  `fantasy_football_multi_league.py` prints on stdout, which corrupts MCP stdio.

### 2. asteiger/yahoo_fantasy_mcp — Safe to learn from

Fork of #9 that **adds write tools** (8 commits ahead, 0 behind).

- **C:** clean — working tree and full history (test fixtures use `env-secret`/
  `typed-key` placeholders only).
- **N:** no host literals beyond docs; all traffic via `yahoo_fantasy_api`. Clean.
- **O:** none. **I:** none (hatchling; no hooks).
- **A:** interactive `auth` subcommand: `input()` for client id, **`getpass`** for the
  secret (`__main__.py:147-148`); token file written with
  `os.open(…, O_WRONLY|O_CREAT|O_TRUNC, 0o600)` (`__main__.py:197`) — correct. Default
  path `oauth2.json` is **relative to cwd** (`__main__.py:222`), so it lands in the repo
  dir when launched there (gitignored: standard Python `.gitignore` does not list it —
  `oauth2.json` is *not* in its `.gitignore`; caution). Env-var auth alternative.
- **P:** results returned as `str(result)` — Python `repr` of dicts, not JSON
  (`server.py:840`); no labelling of untrusted text.
- **Confirmation:** none, but `ToolAnnotations(read_only_hint/destructive_hint)` are set
  and every write description carries `"This modifies the team on Yahoo! Fantasy."`
  (`server.py:60-85`).
- **V:** raw JSON schemas; `player_id: int` typing in the tools layer.
- **D:** `uv.lock` (72 pkgs). OSV: **2 MODERATE** (`oauthlib==3.3.1` CVE-2026-49264/
  -49265), 0 HIGH/CRITICAL. `mcp>=2.2.0,<3` bounded.
- **L:** MIT. **G:** `print()` only in the CLI path; server logs via `logging` (stderr).
  Custom `stdio_transport.py` for clean Ctrl-C shutdown.

### 3. michaelfromorg/mcp-yahoo-fantasy — Learn from with caution

- **C:** clean (tree + history).
- **N:** Yahoo only (via `yahoo_fantasy_api`). Clean.
- **O:** none. **I:** none in `pyproject`; but `scripts/install.sh` runs
  `brew install python@3.12 && brew install --cask claude` and `scripts/setup.sh` runs
  `uv sync` — side-effectful convenience installers (never run here).
- **A — caution:** `login.py:52-58` persists **consumer key, consumer secret, access
  and refresh token in plaintext to `.env`**, default `Path.cwd()/.env`
  (`auth.py:29`) — the repo dir when launched there (it *is* gitignored:
  `.gitignore:145`). `auth.py:79` writes `oauth2.json` with `write_text` (umask
  perms). `oob` verifier flow via `yahoo_oauth`.
- **P:** FastMCP tools return plain dicts → JSON. No labelling.
- **Write tools, no confirmation:** `set_lineup`, `add_player`, `drop_player`,
  `add_and_drop_players`, `claim_player`, `claim_and_drop_players`, `accept_trade`,
  `reject_trade` (`server.py`).
- **V:** FastMCP type hints only.
- **D:** `yahoo/uv.lock` (48 pkgs). OSV: **3 CRITICAL** (`anyio==4.7.0`
  CVE-2026-63374, `h11==0.14.0` CVE-2025-43859, `pyjwt==2.13.0` CVE-2026-102268),
  **12 HIGH** (`cryptography==48.0.0` ×3, `mcp==1.27.2` CVE-2026-59950, `pyjwt` ×2 …),
  13 MODERATE, 1 LOW.
- **L:** MIT. **G:** `print` only in `login.py`.

### 4. cketcham/fantasy-football-mcp — Skipped (fork)

Two own commits (`17c8096` "Update to use fastmcp", `628904d` "Add docker support"),
7 files, 131 commits behind parent. Inherits every #7 history finding. Not cloned for
review beyond the API diff.

### 5. kYpranite/fantasy-football-mcp-public — Do not use

- **C:** inherits #7's leaked history in full (the real `access_token` is visible at the
  fork's `git log -p` line 14897, same commit `951f632`). No new leaks of its own.
- **N — undeclared scraping:** 520 literals for `sports.yahoo.com`, 98 for
  `football.fantasysports.yahoo.com`; `src/extractors/yahoo_web/` drives a **real
  Chrome with a persistent logged-in Yahoo profile** (`session.py:127-133`
  `subprocess.run([chrome, "--user-data-dir=…"])`, then Playwright
  `launch_persistent_context`, `session.py:150-151`). That profile holds live Yahoo
  session cookies on disk. Also `api.openai.com` (inherited, key-gated).
- **O:** `src/datasource/sync_trigger.py:38` spawns a **detached background Python
  process** (`DETACHED_PROCESS`/`CREATE_NEW_PROCESS_GROUP`) from an MCP tool
  (`ff_sync_league`). `_SENSITIVE_KEY_RE` redaction in `session.py:27-33` is a good
  idea in a bad place.
- **D:** 27 pins, OSV **1 CRITICAL** (`fastmcp==2.12.3` CVE-2026-32871), **10 HIGH**
  (fastmcp ×4, `mcp==1.14.0` ×3, …), 22 MODERATE, 15 LOW; `playwright==1.57.0`.
- Everything else as #7.

### 6. brettadams0/yahoo-fantasy-mcp — Safe to learn from

- **C:** clean (tree + 7-commit history). `credentials/client_secret.example.json` is
  an `xxx` placeholder; `.gitignore` uses `credentials/*` + `!credentials/*.example.json`
  (correct git semantics, explained in a comment).
- **N:** `api.login.yahoo.com`, `fantasysports.yahooapis.com` only. Clean.
- **O:** none. **I:** none (no scripts beyond `start`/`test`/`authorize`).
- **A:** `REDIRECT_URI='oob'` (`src/auth.js:11`), code pasted via `readline`; refresh
  via Basic auth header (`auth.js:26`). **Caution:** `TOKEN_PATH` is
  `<repo>/credentials/token.json` (`auth.js:7-9`) written with `writeFile` at default
  perms — token inside the repo tree, gitignored but world-readable on a 022 umask.
- **P:** `json(...)` wraps raw Yahoo JSON; **error text embeds the Yahoo response body
  verbatim** (`auth.js:83` `await res.text()`), which can be HTML.
- **Write tools:** none — all 10 tools are read-only with
  `annotations: { readOnlyHint: true, openWorldHint: true }`.
- **V:** zod shapes per tool (`GAME_KEY`, league/team key schemas);
  `encodeURIComponent` on every key in paths (`fantasy.js:49-126`).
  `yahoo_fantasy_raw_get` accepts any path string; host is pinned by `new URL(API_BASE + path)`
  (`auth.js:73`) but `..` is not rejected.
- **D:** `@modelcontextprotocol/sdk ^1.12.0`, `zod ^3.23.8`; lockfile present.
  `npm audit`: **1 HIGH** (`fast-uri`, transitive), 3 MODERATE (`hono`, `ip-address`,
  `qs`, all transitive via the SDK). 0 direct.
- **L:** MIT. **G:** no `console.log` in `src/`; only in `scripts/`. CI + tests exist.

### 7. derekrbreese/fantasy-football-mcp-public — Do not use

- **C — HISTORICAL LEAK (multiple).** Deleted files recovered from history:
  - `.env` (deleted `d898409` 2025-10-01 and again `cde5779` 2025-10-02): real
    `YAHOO_CLIENT_ID` (`dj0y…`), `YAHOO_CLIENT_SECRET`, `YAHOO_APP_ID`.
  - `.env.cloudrun` (deleted `d898409`): real `YAHOO_CONSUMER_KEY/SECRET`,
    `YAHOO_ACCESS_TOKEN`, `YAHOO_REFRESH_TOKEN`, `YAHOO_GUID`, `REDDIT_CLIENT_ID`,
    `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`, `MCP_API_KEY`, plus an
    `ENVIRONMENT=production` marker.
  - `.yahoo_token.json` + `utils/.yahoo_token.json` (added `b150560` 2025-11-18):
    real `access_token`/`refresh_token`; blanked in `ef6a0ce` 2026-08-26 ("Remove
    sensitive token information"), deleted `b23c4e3`.
  The current tree is clean, but Yahoo/Reddit secrets were public for ~10 months.
- **N:** `api.openai.com` (`src/agents/llm_enhancement.py:378`, gpt-4o-mini; enabled
  only when an OpenAI key is passed — `hybrid_optimizer.py:504`), Reddit via `praw`
  (opt-in), `api.sleeper.app` (declared), `your-app-name.onrender.com` (deploy
  template). OpenAI is an **undeclared-by-default third-party data sink** for roster
  data when the key is set.
- **O:** pickle cache (`cache_manager.py:774/795`); `__import__` in verify script.
- **I:** none.
- **A:** `oob` flow; utility scripts write the token into **`.env` and into the
  Claude, Cursor and Antigravity desktop config files**
  (`utils/setup_yahoo_auth.py:202-263`, `utils/reauth_yahoo.py:272-333`).
- **P:** `json.dumps` of Yahoo/Reddit data unlabelled; MCP *prompts* and *resources*
  are defined (`docs/PROMPTS_AND_RESOURCES.md`).
- **Write tools:** none in the public tree (read + analysis only:
  `ff_build_lineup`, `ff_compare_teams`, `ff_get_waiver_wire`, draft tools…).
- **V:** pydantic models for domain objects; raw JSON tool schemas.
- **D:** 24 pins (`fastmcp==2.12.3`, `mcp==1.14.0`, `aiohttp==3.11.11`,
  `python-dotenv==1.1.1`). OSV: **1 CRITICAL, 9 HIGH, 22 MODERATE, 15 LOW.**
- **L:** MIT. **G:** 100+ `print()` in utils/examples; `src/agents/*` prints 11–12
  lines.

### 8. andrewrgoss/fantasy-football-mcp — Do not use

Fork of #7 (+7, −6). Inherits the leaked history (real token visible at its
`git log -p` line 14818). Adds `ff_evaluate_keeper`, `ff_get_auction_profile`,
`ff_project_auction_values`, `ff_summarize_historical_auction` and **undeclared outbound
hosts** `www.fantasypros.com`, `api.fantasypros.com`, `www.vegasinsider.com`.
Otherwise as #7.

### 9. spilchen/yahoo_fantasy_mcp — Safe to learn from (caution on deps)

- **C:** clean (tree + history). **N:** none beyond Yahoo via library. **O/I:** none.
- **A:** `oauth2.json` from `yahoo_oauth` (`tools.py:38`), default path cwd-relative
  (`__main__.py:130`); env-var alternative (`YAHOO_CLIENT_ID/SECRET`).
- **P:** `str(result)` output (`server.py`). **Write tools:** none (20 read tools).
  Exposes an MCP **resource** `yahoo-league-id` populated from an env var
  (`server.py:27-57`) — a clean way to pin a league without a tool argument.
- **V:** raw JSON schemas.
- **D — caution:** `requirements.txt` is **floating** (`yahoo_fantasy_api>=2.12.2`,
  `mcp>=0.1.0`), **no lockfile**; not queryable in OSV.
- **L:** MIT. **G:** `print` only in CLI; custom graceful stdio transport.

### 10 / 10b. jschne88 (identical fork) → jimbrig/yahoo-fantasy-baseball-mcp — Do not use

- **L — disqualifier:** no `LICENSE` file, no `license` field → all rights reserved.
- **A:** obsolete **OAuth 1.0a** (`src/get-token.ts:21` `/oauth/v2/request_auth`,
  `oauth-1.0a` dep), `oob` PIN; tokens pasted into `.env` by hand.
- **C:** clean (placeholders only). **N:** Yahoo only. **O/I:** none. Compiled `build/`
  is committed.
- **D:** `npm audit`: **1 CRITICAL** (`form-data`), **3 HIGH** (`@modelcontextprotocol/sdk
  ≤1.25.3` DIRECT, `axios ≤1.17.0` DIRECT, `path-to-regexp`), 3 MODERATE.
- One tool (`get_team_roster`); `console.log` in the token CLI only.

### 11. whatadewitt/yahoo-fantasy-sports-api (npm `yahoo-fantasy`) — Safe to learn from

The brief named `edwarddistel/yahoo-fantasy-sports-api`; that repo and that npm name do
not exist (GitHub 404, npm `{"error":"Not found"}`). The widely used Node wrapper is
this one (228 stars, npm `yahoo-fantasy@5.4.1`, published 2026-09-24).

- **C:** clean; only RFC 5849 test vectors in `tests/oauth-vectors.js`.
- **N:** `fantasysports.yahooapis.com`, `api.login.yahoo.com`; `s.yimg.com` only in
  fixtures. Clean.
- **O:** `scripts/check-package-contents.mjs:12` `execFileSync` (pack check, dev only).
  **I:** none.
- **A — good pattern:** the library **never persists tokens**. Caller supplies
  `tokenCallbackFn` (`YahooFantasy.mjs:27-35`) and `setUserToken()`; refresh invokes the
  callback with the new pair (`:148-150`) so storage policy stays with the app.
- **D:** single runtime dep `esm@3.2.25` (last published 2019-05, jdalton — real, but
  unmaintained). `npm audit`: **0**.
- **L:** MIT. **G:** no stdout in library code.

### 12. uberfastman/yfpy — Learn from with caution

- **L — caution:** **GPL-3.0.** Reading and learning is fine; copying any code would
  put our server under GPL. We copy none.
- **C:** clean; `.env.template` only; history shows `auth/private.template.json`
  deleted (a template).
- **N:** Yahoo API hosts; the rest are documentation URLs inside the committed
  `docs/` site (`cdnjs.cloudflare.com`, `readthedocs.org`, `paypal.com` sponsor link).
- **O:** only the vendored `docs/js/jquery-3.6.0.min.js` (docs site). **I:** none
  (hatchling; `scripts/pre_build.py` is a version stamp).
- **A — caution:** `save_access_token_data_to_env_file` writes consumer key/secret and
  the token pair into `.env` (`query.py:412-419`); relies on `yahoo-oauth==2.1.1`
  (#14) for the flow. Good: `YAHOO_ACCESS_TOKEN_JSON` env override for containers
  (`query.py:253`), Docker runtime detection (`:74`).
- **D:** `uv.lock` 75 pkgs, runtime deps pinned exactly (`requests==2.32.5`,
  `yahoo-oauth==2.1.1`, `python-dotenv==1.1.1`, `stringcase==1.2.0`). OSV: **11 HIGH,
  10 MODERATE, 2 LOW** — mostly dev/docs deps (`black==25.1.0`, `cryptography==45.0.7`,
  `jaraco-context==6.0.1`, `pygments`).
- **G:** `logger.debug` of request URLs (`query.py:431/479`) — bearer token is in the
  header, not the URL, so no secret in logs.

### 13. spilchen/yahoo_fantasy_api — Safe to learn from (caution on deps)

- **C/N/O:** clean; Yahoo hosts (+ image CDNs in fixtures).
- **I:** `setup.py:20` `setup_requires=["pytest-runner"]` — deprecated, runs at
  build time, benign.
- **A:** delegated to `yahoo_oauth`; `yhandler.py:70-72` logs refresh success/failure
  without token values; `oauth2_logger.py` re-homes `yahoo_oauth`'s stderr logger.
- **D — caution:** no lockfile; `install_requires=['objectpath','pytz','yahoo_oauth']`
  unpinned. `objectpath` last released 2018-11, `rauth` (via yahoo_oauth) 2017-01.
- **L:** MIT. Write methods (`add_player`, `drop_player`, `add_and_drop_players`,
  `claim_player`, `propose_trade`, `accept_trade`, `reject_trade`, `change_positions`)
  are what #2 and #3 wrap.

### 14. josuebrunel/yahoo-oauth — Learn from with caution

- **C:** clean. `secrets.tar.enc` (Travis-encrypted CI secrets) is tracked;
  `oauth1.json.enc`/`oauth2.json.enc` deleted in history — encrypted blobs, not leaks.
- **N:** Yahoo only. **O:** `setup.py:11` `subprocess.check_output(["git","describe"])`
  at build time (version stamp; benign).
- **A — caution:** `CALLBACK_URI='oob'` (`utils.py:18`); verifier via `input()`
  (`oauth.py:105`); tokens **plus consumer key/secret** written to `secrets.json` in
  cwd by default (`oauth.py:95`) using plain `open(f,'w')` → **umask permissions, often
  world-readable** (`utils.py:42`). `token_time`-based expiry check; refresh
  (`oauth.py:149`).
- **D — caution:** `rauth` (OAuth lib, last release 2017-01-22) and `pyaml` (real,
  maintained; not a `pyyaml` typosquat). No lockfile.
- **L:** MIT. **G:** module logger to stderr; `logger.debug` of the authorize URL (no
  secret).

### 15b. nflverse/nflreadpy — Safe to learn from (shallow clone; history not checked)

- **C:** none; `.claude/settings.local.json` tracked (harmless). **N:**
  `nflreadr.nflverse.com`, GitHub releases only. **O/I:** none (`uv_build`).
- **D:** `uv.lock` 73 pkgs → OSV **0**. `pydantic-settings` config, `platformdirs`
  cache, `polars`.
- **L:** MIT. **G:** a few `print` in library config/cache — irrelevant for MCP.

### 16. nflverse/nflreadr — Safe to learn from (shallow)

- Imports: `cachem`, `cli`, `curl`, `data.table`, `glue`, `memoise`, `rappdirs`, …
  Network only via `curl::curl_fetch_memory` (`R/from_url.R:126/165`). No `system()`.
  Other host strings in `R/` are documentation links to declared data sources
  (nextgenstats, overthecap, ftnfantasy, pro-football-reference). **L:** MIT.

### 17. ffverse/ffscrapr — Safe to learn from (shallow)

- Platforms: MFL, Sleeper, ESPN, Fleaflicker — **no Yahoo**. Imports `httr`,
  `ratelimitr`, `memoise`, `cachem`, `checkmate`. No `system()`. **L:** MIT.
  Idle since 2024-10.

### 18. dtsong/sleeper-api-wrapper — Safe to learn from

- Public, unauthenticated API (`api.sleeper.app` only). **C/O/I:** clean. Poetry
  build. `requirements.txt` fully pinned (5 pkgs) → OSV **2 MODERATE**
  (`idna==3.11` CVE-2026-45409, `requests==2.32.5` CVE-2026-25645). Renovate
  configured. **L:** MIT.

### 19. MichaelCrowcroft/fantasy-football-mcp — Do not use

- **N — disqualifier:** `src/index.ts:63` `proxy("https://www.sleeperdraft.com/mcp")`
  — a stdio→StreamableHTTP proxy that forwards every MCP request/response to an
  opaque third-party hosted server. Nothing to audit locally; all data leaves the
  machine.
- **G:** `console.info("SIGINT received…")` on **stdout** while serving stdio.
- **D:** `npm audit`: **7 HIGH** (`@modelcontextprotocol/sdk ≤1.25.3` DIRECT,
  `rollup`, `glob`, `minimatch`, `picomatch`, `brace-expansion`, `path-to-regexp`),
  3 MODERATE. `test` script runs `npx @modelcontextprotocol/inspector@latest`.
- **L:** no LICENSE file (package.json `"license": "MIT"`).

### 20. deepak-or1/yahoo-fantasy-mcp — Learn from with caution

- **L — caution:** **no license** anywhere (no file, no `license` field). We may read;
  we may not copy — and we don't.
- **C:** clean (tree + 3-commit history; `.env.example` placeholders).
- **N:** `api.login.yahoo.com`, `fantasysports.yahooapis.com`; `claude.ai`/`chatgpt.com`
  appear as MCP-client origins in tests/docs; `evil.example`/`*.test` are test hosts.
  Clean.
- **O:** base64 only for Basic-auth and AES-GCM material (`lib/auth/crypto.ts`). **I:** none.
- **A — strongest design seen:** the server is itself an **OAuth 2.1 authorization
  server** for MCP clients (`/.well-known/oauth-authorization-server`, dynamic client
  registration, **PKCE S256 required for public clients** — `lib/auth/tokens.ts:58-66`,
  redirect allow-list = `https:` or `http://localhost|127.0.0.1` — `clients.ts:21-30`).
  Yahoo tokens are **AES-256-GCM encrypted at rest** (`crypto.ts:25-44`) in Upstash
  Redis with TTLs (`store.ts`). The local Python variant writes `token.json` with
  `0o600` in a `0o700` `~/.config/yahoo-fantasy-mcp` (`local/.../auth.py:21-32`).
- **P:** JSON results; no labelling. **Write tools:** none (14 read tools, all
  `readOnlyHint: true`); `yahoo_get` raw path (host-pinned by string concat,
  `lib/yahoo.ts:84`, `..` not rejected).
- **V:** zod v4 `inputSchema` on every tool.
- **D:** `npm audit` **0**; `local/uv.lock` 40 pkgs → OSV **0**. Deps: `next`,
  `mcp-handler` (Vercel-maintained), `@modelcontextprotocol/server ^2.0.0`,
  `@upstash/redis`, `zod`.
- **G:** `print` only in the local CLI.

### 21. kwonye/yahoo-fantasy-agent (npm `@kwonye/yahoo-fantasy-mcp`) — Safe to learn from

- **C:** clean (tree + history; tests use `"stdio-test-secret"`).
- **N:** Yahoo only (`config.ts:72-73`), `registry.npmjs.org` in packaging scripts,
  `agent-plugins.org` as a JSON-schema `$id` in `plugin.json`. Clean.
- **O:** `execFileSync` in `scripts/` (build/pack), never at runtime. **I:** `prepack`
  = `npm run verify` — publish-time only, not install-time.
- **A — good:** atomic token store: temp file `wx` mode `0o600`, `chmod 0o700` dir,
  `proper-lockfile` mutex (`src/yahoo/token-store.ts:156-168`); XDG config dir
  (`config.ts:164-176`); `YAHOO_TOKEN_PATH` override. Local HTTP callback server
  (`http.ts:194`). Secrets only from env (`YAHOO_CLIENT_SECRET is required`).
- **P:** JSON via `fast-xml-parser`; no labelling. **Write tools, no confirmation:**
  `yahoo_set_lineup`, `yahoo_add_player`, `yahoo_drop_player`, `yahoo_add_drop_player`,
  `yahoo_propose_trade`, `yahoo_trade_action`, `yahoo_cancel_transaction`,
  `yahoo_edit_waiver` — but `destructiveHint: true`, "sent only once, never
  automatically retried" (README:217), and an **agent run journal**
  (`yahoo_agent_start_run` → `execute` → `reconcile`, `src/agent/store.ts`, `0o600`).
- **V:** zod v4 on every tool; `resourcePath()` validates keys
  (`helpers.ts:136-147`); `yahoo_advanced_get` goes through `safeAdvancedPath`.
- **D:** `@modelcontextprotocol/server 2.0.0` + `/node 2.0.0` **exact-pinned**,
  `fast-xml-parser ^5.11.0`, `proper-lockfile ^4.1.2`, `zod ^4.4.3`. `npm audit` **0**.
- **L:** ISC. **G:** README:149 "protocol messages only to stdout; diagnostics to
  stderr" — confirmed: no `console.log` outside `cli.ts`.

---

## Rejected list

| Repo | Reason |
|---|---|
| carterfawson/fantasy-football-mcp | Real Yahoo consumer key/secret + token pair in history (`f4c4c1b`); unconfirmed writes; 5 CRITICAL/47 HIGH deps; stdout prints in server |
| derekrbreese/fantasy-football-mcp-public | Real Yahoo + Reddit credentials/tokens in history (`d898409`, `cde5779`, `b150560`→`b23c4e3`); OpenAI data sink; tokens written into desktop-client configs |
| kYpranite/fantasy-football-mcp-public | Inherits the above; logged-in Chrome profile scraping of sports.yahoo.com; detached background process from a tool |
| andrewrgoss/fantasy-football-mcp | Inherits the above; undeclared FantasyPros/VegasInsider hosts |
| cketcham/fantasy-football-mcp | Fork with 2 packaging commits; inherits the above |
| jschne88/yahoo-fantasy-football-mcp | Identical (0 ahead) fork of jimbrig |
| jimbrig/yahoo-fantasy-baseball-mcp | No license; obsolete OAuth 1.0a; 1 CRITICAL/3 HIGH deps (2 direct) |
| MichaelCrowcroft/fantasy-football-mcp | Proxies all traffic to third-party `www.sleeperdraft.com`; stdout logging; 7 HIGH deps |
| nflverse/nfl_data_py | Archived 2025-09-25 (successor `nflreadpy` audited) |
| edwarddistel/yahoo-fantasy-sports-api | Does not exist (GitHub 404; npm 404). Real wrapper is whatadewitt/… |

## Dependency audit — counts by severity

`npm audit --package-lock-only --ignore-scripts` (Node) / OSV querybatch on pinned
versions (Python). OSV counts below are **GHSA-labelled advisories**; PYSEC duplicates
of the same CVE were excluded from the totals.

| Repo | Source | Critical | High | Moderate | Low | Notes |
|---|---|---|---|---|---|---|
| brettadams0 | package-lock | 0 | 1 | 3 | 0 | all transitive via MCP SDK |
| jimbrig | package-lock | 1 | 3 | 3 | 0 | `axios`, `@modelcontextprotocol/sdk` direct |
| whatadewitt | package-lock | 0 | 0 | 0 | 0 | |
| MichaelCrowcroft | package-lock | 0 | 7 | 3 | 0 | SDK direct |
| deepak-or1 | package-lock + local/uv.lock | 0 | 0 | 0 | 0 | |
| kwonye | package-lock | 0 | 0 | 0 | 0 | |
| asteiger | uv.lock (72) | 0 | 0 | 2 | 0 | oauthlib 3.3.1 |
| michaelfromorg | yahoo/uv.lock (48) | 3 | 12 | 13 | 1 | anyio, h11, pyjwt, cryptography, mcp 1.27.2 |
| uberfastman/yfpy | uv.lock (75) | 0 | 11 | 10 | 2 | mostly dev deps |
| nflverse/nflreadpy | uv.lock (73) | 0 | 0 | 0 | 0 | |
| dtsong | requirements (5 pinned) | 0 | 0 | 2 | 0 | idna, requests |
| derekrbreese | requirements (24 pinned) | 1 | 9 | 22 | 15 | fastmcp 2.12.3, mcp 1.14.0, aiohttp |
| kYpranite | requirements (27 pinned) | 1 | 10 | 22 | 15 | + playwright |
| andrewrgoss | requirements (24 pinned) | 1 | 9 | 22 | 15 | |
| carterfawson | requirements (95 pinned, 5 floating) | 5 | 47 | 44 | 17 | aiohttp 3.11.11 dominates |
| spilchen/yahoo_fantasy_mcp | requirements (floating) | — | — | — | — | `mcp>=0.1.0`, `yahoo_fantasy_api>=2.12.2` — not queryable |
| spilchen/yahoo_fantasy_api | setup.py (floating) | — | — | — | — | `objectpath`, `pytz`, `yahoo_oauth` |
| josuebrunel/yahoo-oauth | requirements (floating) | — | — | — | — | `pyaml`, `rauth` (dead since 2017) |
| nflreadr / ffscrapr | DESCRIPTION (R) | — | — | — | — | CRAN packages; OSV has no CRAN ecosystem coverage — not queried |

Typosquat check (all real, long-lived, expected maintainers): `pyaml` (Mike Kazantsev,
2026-07), `rauth` (Max Countryman, 2017-01), `objectpath` (2018-11), `stringcase`
(2017-08), `asyncio-pool` (2022-05), `aiocache` (2024-09), `mcp-handler` (vercel),
`proper-lockfile` (moxystudio), `esm` (jdalton, 2019-05), `fast-xml-parser`
(NaturalIntelligence), `eventsource` (EventSource org).

## What could not be verified statically

- **History of the three shallow clones** (`nflreadpy`, `nflreadr`, `ffscrapr`) — not
  checked for removed secrets; their maintainers (nflverse/ffverse) and the absence of
  any auth in those packages make a leak unlikely, but it is unverified.
- **Runtime behaviour of the MCP servers** — whether any tool actually writes to stdout
  at runtime beyond the `print()`/`console.*` calls found by grep (e.g. a dependency
  logging to stdout). Grep is the ceiling here.
- **What `www.sleeperdraft.com/mcp` does** (#19) — remote, opaque.
- **`secrets.tar.enc` in yahoo-oauth** — encrypted; contents unknown (assumed CI keys).
- **CRAN dependency vulnerabilities** for the two R packages — no OSV ecosystem.
- **Whether the leaked Yahoo/Reddit credentials in #1 and #7 are still live** — not
  tested (that would be use of someone else's credentials). Treat them as burned; the
  owners may not know. Reporting to the owners is a Chad decision, not an agent action.
- **The ~15 zero-star search hits not cloned** — unaudited by choice (budget); none had
  stars, a release, or TypeScript.
