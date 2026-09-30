# Security policy

This repository holds the **plan** for a local, read-only-first MCP server for Yahoo Fantasy
Football. As of this writing **no server code exists** — the build starts after the plan is
approved (see [README → Status](README.md#status)). The policy below applies to everything that is
here now (documents, CI workflows, scripts) and to the code as it lands.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use **GitHub private vulnerability reporting** for this repository: open the repository's
**Security** tab and choose **Report a vulnerability**. The report reaches the maintainer only;
GitHub turns it into a private security advisory where the fix and a coordinated disclosure can
be worked out.

> **Maintainer step (pending):** private vulnerability reporting is a repository setting that
> the maintainer must switch on (*Settings → Code security → Private vulnerability reporting*).
> Until it is on, the **Report a vulnerability** button is not shown. If you do not see it,
> open an ordinary issue titled `security: please enable private vulnerability reporting` **with
> no details of the finding**, and the maintainer will enable it and follow up there. There is
> no e-mail channel on purpose (the repository is public and identifier-free by rule).

What helps: the file, commit or workflow involved; the class of problem (credential handling,
injection, supply chain, a false security claim in the plan); steps to reproduce; the impact you
believe it has. Reports about the **plan's security claims** are as welcome as reports about code —
the plan states every "cannot" with the session condition under which it holds, and a claim that
does not hold is a defect.

## What to expect

These are intentions for a solo, part-time maintainer, not guarantees:

| Step | Intention |
|---|---|
| Acknowledgement | within **7 days** of the report |
| Triage and severity | within **14 days**; you will hear which class it falls into and whether it is in scope |
| Fix or mitigation | as fast as the severity warrants; credential-exposure and write-path issues first |
| Disclosure | coordinated through the advisory; you are credited unless you ask not to be |

## Scope

**In scope**

- The server, CLI (`ff …`), Skills bundle and scripts in this repository, once they exist.
- The CI workflows (`.github/workflows/*`), the gitleaks rules (`.gitleaks.toml`) and the
  dependency pins — anything that gates what reaches `main` or a release.
- The security architecture as **documented** (`docs/plan/02-security-architecture.md`): a claim
  that is false under the session condition it names is a valid report.
- Any real credential, token, league key, team key or personal identifier found anywhere in the
  repository or its history (the repository must contain none — placeholders only).

**Out of scope**

- Yahoo's Fantasy Sports API, OAuth service or web properties (report those to Yahoo).
- Third-party data providers (nflverse, ffopportunity, Sleeper, Open-Meteo, NWS, The Odds API,
  RSS publishers) and their content.
- Prior-art repositories audited in `docs/research/01-repo-security-audit.md` — that audit
  already records credentials found in *their* histories; notifying those owners is the
  maintainer's decision, and nothing here reproduces the values.
- A user's own client configuration, machine or other MCP servers configured beside this one.

## Credential-handling rules (the ones the plan enforces)

- **Nothing secret is ever committed.** `.gitignore` excludes every `.env*` variant except
  `.env.example`, every token/credential file pattern, `*.sqlite` and `*league.yaml`; gitleaks runs
  on every push with Yahoo-specific rules for client ids, secrets, OAuth tokens, GUIDs and league
  and team keys; GitHub secret-scanning push protection is on.
- **Tokens live outside the repository** — by design in `~/.config/fantasy-football-mcp/`
  (directory `0700`, `tokens.json` `0600`, written atomically, refreshed under a lock). The
  client secret is loaded from an environment variable or a separate `0600` file and is **never**
  written next to the tokens, never logged and never returned by a tool.
- **Logs redact.** The server logs to stderr only, replaces every known secret value and every
  token-shaped pattern with `[redacted:<kind>]`, strips query strings from URLs and never emits an
  upstream response body into a tool result.
- **Fixtures are anonymised.** Recorded Yahoo responses pass through a scrubber that aborts if a
  real league id, team name or manager nickname survives; only the placeholder range
  `461.l.1000…` may appear.
- **Writes are off by default and conditional.** Yahoo grants read access only at present; if
  write access is ever granted, every roster change goes through `prepare → human confirmation →
  commit`. That confirmation is unforgeable by the model **only in a session where no tool can
  read your files or run a shell as you**. In any other session (Claude Code with `Bash`, or a
  Desktop chat with a filesystem/shell server configured beside this one) writes are
  **unsupported** — not "safe" — and the plan says so.

## If a credential leaks

Treat it as **compromised**, not as "probably fine":

1. **Rotate** the Yahoo client secret in the Yahoo developer console and re-run `ff auth`.
2. **Revoke** the app's access in your Yahoo account settings if a token (not just the secret)
   was exposed; a password change also revokes every token.
3. **Delete** the exposed token file (`ff auth --reset`) and any copy in backups you control.
4. If the leak was in this repository's history, report it (above): rewriting history does not
   un-leak a secret — only rotation does — but the commit still needs to be found and scrubbed.
5. Rotate any optional third-party key (`ODDS_API_KEY`) the same way with its provider.

## Supply chain

Exact version pins, a committed lockfile, `npm ci` only, `ignore-scripts=true`, an audit gate on
runtime dependencies (high and above), a runtime dependency allow-list that covers the **full
transitive tree**, no native addons and no install scripts — all specified in
`docs/plan/02-security-architecture.md` §7 and `docs/plan/04-repo-structure-and-ci.md` §2/§4. A
report that a pinned dependency has a published advisory is in scope.

---

*Fantasy data provided by [Yahoo Fantasy](https://football.fantasysports.yahoo.com/).*
