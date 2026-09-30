# fixtures/manual — the placeholder manual league

`league.yaml` is the fixture league for `ManualLeagueProvider` (plan 01 §8 X1, plan 10 §3.1a): the
validation league's **shape** with **placeholder identifiers only** — league "Example League"
(`manual.l.example`), teams "Team A".."Team L", managers "Manager A".."Manager L". It is the one
league file allowed inside the repository (`.gitignore` carries `*league.yaml` with the exception
`!fixtures/manual/*.yaml`); a real league lives at `<config>/league.yaml`, mode `0600`, in a `0700`
directory outside the checkout, and is never copied here.

## What it holds

- **League:** 2026, 12 teams, weeks 1–17, playoffs from week 15 (6 teams), per-game lineup lock.
- **Scoring:** the `half_ppr` preset with the validation league's values stated explicitly
  (`pass_td 4`, `rush_td 6`, `rec_td 6`, `fum_lost −2`, `pass_int −1`); no TE premium, no yardage
  bonuses.
- **Roster slots (17):** QB, WR×2, RB×2, TE, W/R/T, K, DEF, BN×6, IR×2.
- **Rules:** FAAB, budget 100, 2 waiver days, commissioner trade review (plan 10 D5).
- **My team ("Team A"):** 16 players from `fixtures/players/fixture-roster.json` — nine starters,
  six bench, and Nico Collins in IR with status `O` (he was Out on the 2026 week 2–3 injury
  reports); the second IR seat is empty. Two rookies (Ashton Jeanty, Denzel Boston) are listed by
  name + team + position only, so the crosswalk must resolve them without a gsis id (plan 10 A5a).
- **Opponent ("Team B") for weeks 1–3:** a plausible 15-player roster of real 2026 starters (gsis
  ids from nflverse `roster_weekly_2026`, release 2026-09-30), one listed by name only.
- **Teams C–L:** names only (no rosters).
- **Free agents / waivers / transactions:** two free agents, one waiver-wire kicker and one week-2
  FAAB claim ($7), so every optional section is exercised.

## File format

The schema is `src/providers/manual/schema.ts` (zod, `.strict()` everywhere). Each roster entry is
either a player — `{ name, team, position, gsis_id?, slot?, status?, eligible?, jersey? }` — or a
team defence — `{ defense: TEAM, slot? }`. A player with a `gsis_id` gets the key
`manual.p.<gsis_id>`, a defence `manual.p.def-<team>`, and a name-only player a stable
`manual.p.n-<hash>` key. The parser (`src/providers/manual/parse.ts`) accepts YAML 1.2 core schema
only: no aliases, no custom tags, no duplicate keys, string keys only, no
`__proto__`/`constructor`/`prototype` keys, ≤ 128 KiB, ≤ 12 levels deep, ≤ 100 entries per mapping
and ≤ 600 per sequence. Every problem is reported as a path + a fixed reason — never the value.

## Licence and attribution

Player names, teams and ids are public NFL data from **nflverse** (`nflverse-data` releases
`weekly_rosters`, `injuries`), © the nflverse contributors, licensed **CC-BY 4.0** —
<https://github.com/nflverse/nflverse-data>.
