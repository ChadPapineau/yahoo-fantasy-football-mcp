# fixtures/players — the shared fixture roster

`fixture-roster.json` is the one list of real NFL players every Phase-1a fixture is built from:
the nflverse excerpts (`fixtures/nflverse/`, plan 05 §3.2), the placeholder manual league
(`fixtures/manual/league.yaml`, plan 10 §3.1a) and any test that needs a real player. Build new
fixtures from it rather than picking players ad hoc, so every excerpt joins with every other.

## Contents

- **19 players** — 2 QB, 5 RB, 6 WR, 3 TE, 3 K — and **4 team defences** (DET, HOU, PIT, SEA).
- Every player is present in nflverse `roster_weekly_2026` **and** has a `stats_player_week_2026`
  line in **each of weeks 1–3** (kickers included). `team`, `jersey` and the platform ids are from
  the player's latest 2026 `roster_weekly` row (release of 2026-09-30); `team_2025` is the team of
  their last 2025 regular-season stat line (null for 2026 rookies).
- `tags` mark the crosswalk / matcher edge cases each player exercises:
  - `rookie_2025`, `rookie_2026`, `no_yahoo_id` — no `yahoo_id` in `roster_weekly` (research 04 §D:
    no free source carries Yahoo ids for the 2025–2026 draft classes), so they must resolve by
    name + team + position (plan 10 A5a);
  - `same_surname` — Allen (QB BUF, WR IND), Love (QB GB, RB ARI), Henry (RB BAL, TE NE);
  - `team_change_2026` — a different team than in 2025 (a persisted pair must survive it);
  - `name_suffix`, `hyphenated_name`, `punctuated_name`, `apostrophe_name` — name normalisation.
  Note `Josh Allen`'s `first_name` is `Joshua`: match on `name` (nflverse `full_name`), not on
  first + last.
- Team defences carry no `gsis_id`: their identity is the nflverse team abbreviation
  (`ProjectionSubject` `defense`, critic C-13).

The file holds no league, team or manager identifiers of any real fantasy league — only public
NFL data.

## Licence and attribution

Player names, teams, jersey numbers and ids are from **nflverse** (`nflverse-data` releases
`weekly_rosters`, `stats_player`), © the nflverse contributors, licensed under
**Creative Commons Attribution 4.0 International (CC-BY 4.0)** —
<https://github.com/nflverse/nflverse-data>. Redistributed here unmodified in substance (a
selection of columns and rows).
