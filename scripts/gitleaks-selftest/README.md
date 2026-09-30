# gitleaks self-test fixtures

`.github/workflows/secrets.yml` (job `secrets-selftest`) proves on every push that the custom rules
in `.gitleaks.toml` can actually fire, and that their allowlists are no wider than the documentation
placeholders. A scanner whose rules silently match nothing is worse than no scanner.

| File | Scanned expecting | Guards against |
|---|---|---|
| `must-flag.txt` | a non-zero exit **and** every id in `expected-rule-ids.txt` in the JSON report | a rule that matches nothing; a regex typo; a too-broad path allowlist |
| `must-pass.txt` | exit 0, zero findings | an allowlist narrower than the placeholders the docs use; a rule firing on credential *names* |
| `expected-rule-ids.txt` | — | a rule added to `.gitleaks.toml` without a fixture line |
| `assert-report.mjs` | — | reads the gitleaks JSON report and applies the two assertions above |

## Why the copies

`.gitleaks.toml` allowlists the path `scripts/gitleaks-selftest/` so the ordinary scans (tree, diff,
history) pass with these files in place. The self-test therefore **copies** each fixture to a
directory under `$RUNNER_TEMP` whose name does not contain `gitleaks-selftest` before scanning it,
so the path allowlist cannot apply to the copy while every regex allowlist still does.

## Every value in `must-flag.txt` is fake by construction

Derived from the public phrase `yahoo-fantasy-football-mcp gitleaks self-test`:

- client id: base64 of `v=2&i=SELFTESTFAKECLIENTID&d=…&s=consumersecret&x=00` (the `dj0yJmk9` prefix is base64 of `v=2&i=`), `--` padding as Yahoo emits it
- client secret: `sha1(phrase + ": client secret")` — 40 hex
- access / refresh token: `sha512` / `sha256` of `phrase + ": access token"` / `": refresh token"`, base64url
- GUID: `SELFTESTFAKEGUID0123456789`
- league/team keys: ids `123456`, `987654`, `10012` — outside the placeholder range `1000`, `10000–10009`
- odds key: `md5(phrase + ": odds api key")` — 32 hex

Regenerate them with the same recipe if a rule's shape changes; never paste a real value here.
