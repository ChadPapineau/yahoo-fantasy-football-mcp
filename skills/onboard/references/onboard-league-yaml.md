## The league file — questions, shape, and how to save it

Contents: [Questions](#questions) · [Scoring presets](#scoring-presets) · [The shape](#the-shape) · [Saving it](#saving-it) · [Keeping it current](#keeping-it-current)

### Questions

Ask in this order, a few at a time. "I don't know" is a fine answer: leave the field out and list it as unverified.

1. **League:** season; number of teams; head-to-head points or points-only; last regular-season week; first playoff week and number of playoff teams.
2. **Roster slots:** how many of each — QB, WR, RB, TE, W/R/T (flex), K, DEF, BN (bench), IR.
3. **Scoring:** which preset is closest (below), then every difference. Kicker: points per field goal by distance and per extra point. Defense: sacks, interceptions, fumble recoveries, touchdowns, safeties, blocked kicks, and the points-allowed brackets.
4. **Waivers:** FAAB (and the starting budget) or rolling priority; a weekly add limit if there is one.
5. **The user's team:** a team name (anything), and every player with position, NFL team and current slot. The app's roster page lists all of it.
6. **Optional — this week's opponent:** a name and their starters (they go under `other_teams`, and the week under `opponents`). Needed only for a win probability.

### Scoring presets

The server has three built-in presets with the platform's public default values; the file names one and lists only the differences under `overrides`:

| Stat | `standard` | `half_ppr` | `ppr` |
|---|---|---|---|
| `rec` (per reception) | 0 | 0.5 | 1 |
| `pass_yd` / `pass_td` / `pass_int` | 0.04 / 4 / -1 | same | same |
| `rush_yd`, `rec_yd` | 0.1 | same | same |
| `rush_td`, `rec_td` | 6 | same | same |
| `fum_lost` / `two_pt` | -2 / 2 | same | same |

Kicker (every preset): `fg_0_19` 3, `fg_20_29` 3, `fg_30_39` 3, `fg_40_49` 4, `fg_50p` 5, `pat_made` 1. Defense (every preset): `dst_sack` 1, `dst_int` 2, `dst_fum_rec` 2, `dst_td` 6, `dst_safety` 2, `dst_blk` 2, points allowed `dst_pa_0` 10, `dst_pa_1_6` 7, `dst_pa_7_13` 4, `dst_pa_14_20` 1, `dst_pa_21_27` 0, `dst_pa_28_34` -1, `dst_pa_35p` -4. Always confirm against the league's own scoring page — leagues differ most in the defense brackets. Threshold bonuses go under `bonuses` (`{ stat, target, points }`); every value stays between -50 and 50.

### The shape

This is the format `ff doctor` validates (`version: 1`; unknown keys are rejected, and every problem is reported as a path and a reason, never the value). Names below are placeholders; the user's real names go in their private copy only.

```yaml
version: 1
league:
  key: example                 # the league becomes manual.l.example (lowercase, digits, hyphens)
  name: Example League
  season: 2026
  num_teams: 12
  scoring_type: head           # head-to-head points; "point" for points-only
  start_week: 1
  end_week: 17
  lineup_lock: per_game        # each player locks at his own kickoff; "weekly" if the whole lineup locks at once
  playoffs:
    start_week: 15
    num_teams: 6
scoring:
  preset: half_ppr             # standard | half_ppr | ppr
  overrides:                   # only the league's differences from the preset
    pass_td: 6
roster_slots:
  - { name: QB, count: 1 }
  - { name: WR, count: 2 }
  - { name: RB, count: 2 }
  - { name: TE, count: 1 }
  - { name: W/R/T, count: 1 }
  - { name: K, count: 1 }
  - { name: DEF, count: 1 }
  - { name: BN, count: 6 }
  - { name: IR, count: 2 }
rules:
  waiver_type: faab            # faab | rolling | reverse_standings | continual | none
  waiver_time_days: 2
  faab_budget: 100             # leave a rule out when unknown
  trade_review: commissioner   # none | commissioner | league_vote
my_team:
  id: 1
  name: Team A
  players:
    - { name: Josh Allen, team: BUF, position: QB, slot: QB }
    - { name: Ja'Marr Chase, team: CIN, position: WR, slot: WR }
    - { name: Chris Boswell, team: PIT, position: K, slot: K }
    - { defense: DET, slot: DEF }
    - { name: Kenneth Walker III, team: KC, position: RB, slot: BN }
other_teams:                   # optional; needed only for this week's opponent
  - id: 2
    name: Team B
    players:
      - { name: Jordan Love, team: GB, position: QB, slot: QB }
opponents:                     # optional; which team the user plays each week
  - { week: 4, team: 2 }
```

Players are `{ name, team, position, slot }` with the nflverse team abbreviation (`LA` for the Rams, `LV`, `JAX`) and a position of QB, RB, WR, TE or K; a team defense is `{ defense: TEAM, slot }`. Add `status: O` (or `Q`, `D`, `IR`) when the app shows one. A player the server cannot match to NFL data is listed by `ff status` under unmatched rostered players; adding the NFL id to that line (`gsis_id: "00-0034857"`, quoted) settles it. Free agents, waiver-wire players and transactions may be pasted too (`free_agents`, `waivers`, `transactions`), but nothing requires them.

### Saving it

Paste the YAML into a new file with these commands in a terminal (macOS or Linux). `umask 077` makes the new file private from the start:

```sh
umask 077
mkdir -p ~/.config/fantasy-football-mcp
chmod 700 ~/.config/fantasy-football-mcp
# save the YAML as ~/.config/fantasy-football-mcp/league.yaml with any editor, then:
chmod 600 ~/.config/fantasy-football-mcp/league.yaml
ff doctor
```

When `FF_CONFIG_DIR` is set, use that directory instead. Never save it inside a code repository or a synced folder (iCloud Drive, Dropbox, or Desktop/Documents when they sync): the server refuses those paths, and the repository is public.

### Keeping it current

The server knows only what the file says. Edit it after every add, drop, trade or lineup change, and add each week's line to `opponents` (with that team's roster under `other_teams`) if you want a win probability. `ff doctor` re-checks it after any edit.
