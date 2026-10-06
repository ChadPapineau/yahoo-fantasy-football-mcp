## The league file — questions, shape, and how to save it

Contents: [Questions](#questions) · [Scoring presets](#scoring-presets) · [The shape](#the-shape) · [Saving it](#saving-it) · [Keeping it current](#keeping-it-current) · [The verification log entry](#the-verification-log-entry)

### Questions

Ask in this order, a few at a time. "I don't know" is a fine answer: leave the field out and list it as unverified.

1. **League:** season; number of teams; head-to-head points or points-only; last regular-season week; first playoff week and number of playoff teams.
2. **Roster slots:** how many of each — QB, WR, RB, TE, W/R/T (flex), K, DEF, BN (bench), IR.
3. **Scoring:** which preset is closest (below), then every difference. Kicker: points per field goal by distance, per extra point, and any penalty for a missed field goal by distance. Defense: sacks, interceptions, fumble recoveries, touchdowns, safeties, blocked kicks, the points-allowed brackets, and the yards-allowed brackets if the league scores them. Ask whether tight ends get extra points per reception (a TE premium): it [cannot be stated yet](#te-premium-cannot-be-stated-yet).
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

#### Missed field goals and yards allowed

No preset scores either; a league that does lists them under `overrides`.

- **Missed field goals:** the penalty per distance bin — `fg_miss_0_19`, `fg_miss_20_29`, `fg_miss_30_39`, `fg_miss_40_49`, `fg_miss_50p`. A bin left out scores 0, so a league that penalises only short misses lists only those.
- **Yards allowed:** list every bin of the league's set, the bins worth 0 included, so the set runs from 0 yards to one open-ended bin with no gap or overlap; otherwise `ff doctor` reports `scoring.overrides` and the file does not load. Yahoo's bins are `dst_ya_0_99`, `dst_ya_100_199`, `dst_ya_200_299`, `dst_ya_300_399`, `dst_ya_400_499` and `dst_ya_500p`; ESPN's and Sleeper's are `dst_ya_0_99`, `dst_ya_100_199`, `dst_ya_200_299`, `dst_ya_300_349`, `dst_ya_350_399`, `dst_ya_400_449`, `dst_ya_450_499`, `dst_ya_500_549` and `dst_ya_550p`. For example (the values are the league's own; these only show the shape): `dst_ya_0_99: 5`, `dst_ya_100_199: 3`, `dst_ya_200_299: 2`, `dst_ya_300_399: 0`, `dst_ya_400_499: -1`, `dst_ya_500p: -3`.

#### TE premium: cannot be stated yet

Scoring values apply per position type (offense, kicker, defense), not per position, so the file has no way to give tight ends more per reception than other players; it refuses any key that tries, and `ff doctor` says so. Leave the premium out and tell the user what that omits: in a TE-premium league the tight ends' points read low by the premium × receptions (half a point on six catches is 3 points a week), and every start/sit and weekly-review number for a tight end carries that gap. Any other rule that applies to one position only is the same.

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

The server reads `league.yaml` from its config directory: `$FF_CONFIG_DIR` when that is set, otherwise `$XDG_CONFIG_HOME/fantasy-football-mcp` when `XDG_CONFIG_HOME` is set to an absolute path, otherwise `~/.config/fantasy-football-mcp`. These commands (macOS or Linux, in zsh, bash or sh) work that directory out the same way and print it: a leading `~/` in `FF_CONFIG_DIR` is your home folder and spaces around either value are ignored, as in the server, and an `FF_CONFIG_DIR` the server cannot use (a relative path, or `~name/`) prints a `STOP:` line instead. `umask 077` makes the new file private from the start:

```sh
umask 077
X=${XDG_CONFIG_HOME:-}; while :; do case $X in [[:space:]]*) X=${X#?} ;; *[[:space:]]) X=${X%?} ;; *) break ;; esac; done
V=${FF_CONFIG_DIR:-}; while :; do case $V in [[:space:]]*) V=${V#?} ;; *[[:space:]]) V=${V%?} ;; *) break ;; esac; done
case "$X" in /*) C=$X ;; *) C=$HOME/.config ;; esac
case "$V" in "") D=$C/fantasy-football-mcp ;; "~") D=$HOME ;; "~/"*) D=$HOME/${V#"~/"} ;; /*) D=$V ;; *) D=; echo "STOP: FF_CONFIG_DIR must be an absolute path or start with ~/ - correct it, then run these commands again" ;; esac
if [ -n "$D" ] && mkdir -p "$D" && chmod 700 "$D"; then
  echo "League file: $D/league.yaml"
  R=$(cd "$D" >/dev/null 2>&1 && pwd -P); H=$(cd "$HOME" >/dev/null 2>&1 && pwd -P)
  P=$R; while [ "$P" != / ]; do [ -e "$P/.git" ] && echo "STOP: $D is inside a git repository - choose another folder" && break; P=$(dirname "$P"); done
  find "$HOME" "${XDG_DATA_HOME:-$HOME/.local/share}/yadm" "$C/yadm" "$C/vcsh/repo.d" -mindepth 1 -maxdepth 1 -type d \( -name '.*' -o -name '*.git' \) 2>/dev/null | while IFS= read -r G; do
    [ -f "$G/HEAD" ] && [ -d "$G/objects" ] && W=$(git config --file "$G/config" --get core.worktree 2>/dev/null) || continue
    case "$W" in /*) ;; *) W=$G/$W ;; esac
    W=$(cd "$W" >/dev/null 2>&1 && pwd -P) && case "$R/" in "${W%/}"/*) echo "STOP: $D is in the work tree of the git repository $G - choose another folder" ;; esac
  done
  L=$(printf '%s/' "$R" | tr '[:upper:]' '[:lower:]'); HL=$(printf '%s' "$H" | tr '[:upper:]' '[:lower:]')
  case "$L" in */dropbox*/*|*/"google drive"*/*|*/onedrive*/*|*/cloudstorage/*|*/"mobile documents"/*|"$HL"/documents/*|"$HL"/desktop/*) echo "STOP: $D is in a synced folder - choose another folder" ;; esac
fi
# save the YAML as "$D/league.yaml" with any editor, then:
chmod 600 "$D/league.yaml"
ff doctor
```

Save the file at the path printed after `League file:`. If `ff doctor` then reports "no league file at" some other path, that is the path the server reads: move the file there. Never save it inside a code repository or a synced folder (any git working tree — a dotfiles repository that holds `~/.config` counts — iCloud Drive, Dropbox, Google Drive, OneDrive, or Desktop/Documents when they sync). The project repository is public, and a file in any repository is one `git add` away from being committed. If the commands print a line starting `STOP:`, do not save the file there: choose another folder, set `FF_CONFIG_DIR` to it, and run them again.

The server's own location check is narrower than this rule, so do not rely on it: the server refuses only this project's checkout and these folders in your home folder: `~/Documents`, `~/Desktop`, iCloud Drive (`~/Library/Mobile Documents`), `~/Library/CloudStorage`, `~/Dropbox`, `~/Google Drive` and `~/OneDrive` (a business `~/OneDrive - <organisation>` too). It does not look for other git working trees, or for any other synced folder (another sync app's folder, or one outside the home folder). The commands above catch a git working tree with a `.git` folder or file on the path; a dotfiles repository whose `core.worktree` setting holds the folder (a bare repository in a dot-folder of your home folder, such as `~/.cfg`, or yadm's or vcsh's in their default places); and iCloud Drive, CloudStorage, Dropbox, Google Drive and OneDrive folders wherever they are and whatever their app names them (`Dropbox (Personal)`, `OneDrive - <organisation>`). Neither catches a dotfiles repository used only through `--git-dir` and `--work-tree` (an alias, with no `core.worktree`): if you keep dotfiles that way, make sure that work tree does not hold the folder. Other sync apps' folders (Nextcloud, Box Sync, MEGA and the like) are caught by neither, so check that yourself.

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
