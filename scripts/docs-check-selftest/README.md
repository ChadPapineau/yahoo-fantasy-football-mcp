# docs-check self-test fixtures

Deliberately broken inputs that prove `scripts/check-links.mjs` and `scripts/check-mermaid.mjs`
can fail. The empty marker file `.docs-check-skip` in this directory keeps both checkers out of it
during the real run; `.github/workflows/docs.yml` points each checker at this directory explicitly
(`--root scripts/docs-check-selftest`) and asserts the exact verdict:

| Fixture | Expected verdict |
|---|---|
| `links.md` (+ `links-target.md`) | exit 1, `3 broken`: a missing file, a missing heading, a target outside the root. Every other link resolves or is ignored (external, inline code, fenced code, a citation-with-colon that is prose). |
| `mermaid.md` | exit 1, `rendered 1/2, failed 1`: one valid flowchart, one block that is not a diagram. |

This file has no links, so it does not change the counts.
