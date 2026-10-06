## The league file — questions, shape, and how to save it

Contents: [Questions](#questions) · [Scoring presets](#scoring-presets) · [The shape](#the-shape) · [Saving it](#saving-it) · [Keeping it current](#keeping-it-current) · [The verification log entry](#the-verification-log-entry)

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
    players:                   # his full starting lineup: an empty starting slot means no win probability
      - { name: Jordan Love, team: GB, position: QB, slot: QB }
      - { name: Amon-Ra St. Brown, team: DET, position: WR, slot: WR }
      - { name: Keenan Allen, team: IND, position: WR, slot: WR }
      - { name: Derrick Henry, team: BAL, position: RB, slot: RB }
      - { name: Jahmyr Gibbs, team: DET, position: RB, slot: RB }
      - { name: Trey McBride, team: ARI, position: TE, slot: TE }
      - { name: Jaxon Smith-Njigba, team: SEA, position: WR, slot: W/R/T }
      - { name: Jake Bates, team: DET, position: K, slot: K }
      - { defense: HOU, slot: DEF }
opponents:                     # optional; which team the user plays each week
  - { week: 4, team: 2 }
```

Players are `{ name, team, position, slot }` with the nflverse team abbreviation (`LA` for the Rams, `LV`, `JAX`) and a position of QB, RB, WR, TE or K; a team defense is `{ defense: TEAM, slot }`. Add `status: O` (or `Q`, `D`, `IR`) when the app shows one. A player the server cannot match to NFL data is listed by the assistant's status check (`ff_get_status`, under `crosswalk.unmatched_rostered`) with the reason, the number of close NFL candidates and up to three of them (`candidate_players`: NFL id, team, position, name). The usual cause is an old NFL team: check the player's current team in the fantasy app and correct `team:`. If he is still unmatched, the assistant lists that NFL team's players with `ff_project_players` and `players: { nfl_team: "<TEAM>" }`, which shows each player's NFL id (`gsis_id`); adding that id to his line (`gsis_id: "00-0034857"`, quoted) settles it. An id whose NFL name differs from the line is accepted only when his team and position match; otherwise the status check shows him as ambiguous — fix the id (a typo names someone else) or the team. Slot names are the app's: a flex is `W/R/T` (or `W/R`, `W/T`, `Q/W/R/T`) and the team defense slot is `DEF` (not D/ST), filled by `{ defense: TEAM }`. The assistant's league check (`ff_get_league`) lists the rules left out under `rules.unverified_fields`, by their output names (such as `playoffs_reseeding`, `playoffs_multiweek_championship`, `playoffs_consolation_teams`). Free agents, waiver-wire players and transactions may be pasted too (`free_agents`, `waivers`, `transactions`), but nothing requires them.

### Saving it

The server reads `league.yaml` from its config directory: `$FF_CONFIG_DIR` when that is set, otherwise `$XDG_CONFIG_HOME/fantasy-football-mcp` when `XDG_CONFIG_HOME` is set to an absolute path, otherwise `~/.config/fantasy-football-mcp`. These commands (macOS or Linux) work that directory out the same way and print it; `umask 077` makes the new file private from the start:

```sh
umask 077
case "${XDG_CONFIG_HOME:-}" in /*) B="$XDG_CONFIG_HOME" ;; *) B="$HOME/.config" ;; esac
D="${FF_CONFIG_DIR:-$B/fantasy-football-mcp}"
mkdir -p "$D" && chmod 700 "$D" && echo "League file: $D/league.yaml"
R=$(cd "$D" && pwd -P)
P=$R; while [ "$P" != / ]; do [ -e "$P/.git" ] && echo "STOP: $D is inside a git repository - choose another folder" && break; P=$(dirname "$P"); done
case "$R/" in */Dropbox/*|*/"Google Drive"/*|*/OneDrive*/*|*/CloudStorage/*|*/"Mobile Documents"/*|"$HOME"/Documents/*|"$HOME"/Desktop/*) echo "STOP: $D is in a synced folder - choose another folder" ;; esac
# save the YAML as "$D/league.yaml" with any editor, then:
chmod 600 "$D/league.yaml"
ff doctor
```

Save the file at the path printed after `League file:`. If `ff doctor` then reports "no league file at" some other path, that is the path the server reads: move the file there. Never save it inside a code repository or a synced folder (any git working tree — a dotfiles repository that holds `~/.config` counts — iCloud Drive, Dropbox, Google Drive, OneDrive, or Desktop/Documents when they sync). The project repository is public, and a file in any repository is one `git add` away from being committed. If the commands print a line starting `STOP:`, do not save the file there: choose another folder, set `FF_CONFIG_DIR` to it, and run them again.

The server's own location check is narrower than this rule, so do not rely on it: the server refuses only this project's checkout and these folders in your home folder: `~/Documents`, `~/Desktop`, iCloud Drive (`~/Library/Mobile Documents`), `~/Library/CloudStorage`, `~/Dropbox`, `~/Google Drive` and `~/OneDrive` (a business `~/OneDrive - <organisation>` too). It does not look for other git working trees, or for any other synced folder (another sync app's folder, or one outside the home folder). The commands above catch other git working trees, and iCloud Drive, CloudStorage, Dropbox, Google Drive and OneDrive folders wherever they are. Other sync apps' folders (Nextcloud, Box Sync, MEGA and the like) are caught by neither, so check that yourself.

### Keeping it current

The server knows only what the file says. Edit it after every add, drop, trade or lineup change, and add each week's line to `opponents` (with that team's roster under `other_teams`) if you want a win probability. `ff doctor` re-checks it after any edit.

### The verification log entry

The verify flow calls no analytics tool, so there is no result `rec` to copy. Log this exact entry with `ff_record_recommendation` (step 5 of verify), replacing only the values in angle brackets: `week` and `as_of` from the `ff_get_league` result, and one `source_calls` item per call made with that call's `meta.request_id`. Every other field stays as written — the server rejects a `rec` with any field missing.

```json
{
  "kind": "onboarding",
  "week": "<league.current_week from ff_get_league>",
  "rec": {
    "action": "League file verified; engine self-check shown for three players over the last two final weeks",
    "subjects": [],
    "lineup": null,
    "point_estimate": 0,
    "distribution": {
      "mean": 0,
      "p10": 0,
      "p25": 0,
      "p50": 0,
      "p75": 0,
      "p90": 0,
      "p_zero": 1,
      "basis": "position_cv"
    },
    "delta_vs_next": {
      "value": 0,
      "p10": 0,
      "p90": 0
    },
    "decision_metric": "settings_check",
    "drivers": [],
    "assumptions": [
      {
        "text": "The league file matches the league's settings and roster pages",
        "revisit_trigger": "a roster move or a settings change by the commissioner"
      }
    ],
    "confidence": {
      "role_games": 0,
      "inputs": []
    },
    "as_of": "<meta.as_of of the ff_get_league result>",
    "latest_execution_time": null,
    "no_move": true,
    "log_id": null
  },
  "alternatives": [],
  "source_calls": [
    {
      "tool": "ff_get_league",
      "request_id": "<its meta.request_id>"
    },
    {
      "tool": "ff_get_roster",
      "request_id": "<its meta.request_id>"
    },
    {
      "tool": "ff_get_player_stats",
      "request_id": "<its meta.request_id, one entry per call>"
    }
  ],
  "followed_hint": "unknown",
  "client_ref": "onboard-verify"
}
```
