## The league file — questions, shape, and how to save it

Contents: [Questions](#questions) · [Scoring presets](#scoring-presets) · [The shape](#the-shape) · [Saving it](#saving-it) · [Keeping it current](#keeping-it-current)

### Questions

Ask in this order, a few at a time. "I don't know" is a fine answer: leave the field out and list it as unverified.

1. **League:** season; number of teams; head-to-head points or points-only; last regular-season week; first playoff week and number of playoff teams.
2. **Roster slots:** how many of each — QB, WR, RB, TE, W/R/T (flex), K, DEF, BN (bench), IR.
3. **Scoring:** which preset is closest (below), then every difference. Kicker: points per field goal by distance and per extra point. Defense: sacks, interceptions, fumble recoveries, touchdowns, safeties, blocked kicks, and the points-allowed brackets.
4. **Waivers:** FAAB (and the starting budget) or rolling priority; a weekly add limit if there is one.
5. **The user's team:** a team name (anything), and every player with position, NFL team and current slot. The app's roster page lists all of it.
6. **Optional — this week's opponent:** a name and their starters. Needed only for a win probability.

### Scoring presets

| Stat | Standard | Half-PPR | PPR |
|---|---|---|---|
| `rec` (per reception) | 0 | 0.5 | 1 |
| `pass_yd` | 0.04 | 0.04 | 0.04 |
| `pass_td` | 4 | 4 | 4 |
| `pass_int` | -1 | -1 | -1 |
| `rush_yd`, `rec_yd` | 0.1 | 0.1 | 0.1 |
| `rush_td`, `rec_td` | 6 | 6 | 6 |
| `fum_lost` | -2 | -2 | -2 |
| `two_pt` | 2 | 2 | 2 |

Kicker (common): `fg_0_19` 3, `fg_20_29` 3, `fg_30_39` 3, `fg_40_49` 4, `fg_50p` 5, `pat_made` 1. Defense (common): `dst_sack` 1, `dst_int` 2, `dst_fum_rec` 2, `dst_td` 6, `dst_safety` 2, `dst_blk` 2, points allowed `dst_pa_0` 10, `dst_pa_1_6` 7, `dst_pa_7_13` 4, `dst_pa_14_20` 1, `dst_pa_21_27` 0, `dst_pa_28_34` -1, `dst_pa_35p` -4. Always confirm against the league's own scoring page — leagues differ most in the defense brackets.

### The shape

Illustrative only — `ff doctor` validates the file and names any field it does not accept. The keys below use placeholder names; the user's real names go in their private copy only.

```yaml
schema_version: 1
league:
  key: manual.l.example        # manual.l.<lowercase-slug>
  name: Example League
  season: 2026
  num_teams: 12
  scoring_type: head           # head-to-head points; "point" for points-only
  end_week: 17
  playoffs: { start_week: 15, num_teams: 6 }
roster_slots:
  - { slot: QB, count: 1 }
  - { slot: WR, count: 2 }
  - { slot: RB, count: 2 }
  - { slot: TE, count: 1 }
  - { slot: W/R/T, count: 1 }
  - { slot: K, count: 1 }
  - { slot: DEF, count: 1 }
  - { slot: BN, count: 6 }
  - { slot: IR, count: 2 }
scoring:
  rec: 0.5
  pass_yd: 0.04
  pass_td: 4
  # … every stat from the presets above, with the league's values
rules:
  uses_faab: true
  faab_budget: 100
  max_weekly_adds: null        # unknown → null
my_team:
  key: manual.l.example.t.1
  name: Team A
  roster:
    - { name: Josh Allen, position: QB, team: BUF, slot: QB }
    - { name: Ja'Marr Chase, position: WR, team: CIN, slot: WR }
    - { name: Pittsburgh, position: DEF, team: PIT, slot: DEF }
opponent:                      # optional; only for a win probability
  week: 4
  key: manual.l.example.t.2
  name: Team B
  roster:
    - { name: Jordan Love, position: QB, team: GB, slot: QB }
```

A player the server cannot match to NFL data appears in `ff status` under unmatched rostered players; adding the NFL id (`gsis_id: 00-0034857`) to that line settles it.

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

The server knows only what the file says. Edit it after every add, drop, trade or lineup change, and update `opponent` each week if you want a win probability. `ff doctor` re-checks it after any edit.
