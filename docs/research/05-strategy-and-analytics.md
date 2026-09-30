# 05 — Strategy and analytics methodology

Author: `fantasy-strategy-analyst` (wave 2). Brief: `docs/scratch/briefs/fantasy-strategy-analyst.md`.
Companion docs: `03-yahoo-api.md` (what Yahoo exposes — read §B.4, §B.5, §E first) and
`04-data-sources.md` (which source supplies each *kind* of data named here; written in parallel,
so this document refers to data by kind only).

## How to read this document

- Every decision type has the same six parts: **Inputs → Method → Format sensitivity →
  Pitfalls → Output shape → Evaluation.** The output shape is a contract: a recommendation
  that carries only a point estimate is a failed recommendation.
- Evidence markers on claims: **[V]** a cited page was fetched and says this; **[S]** only a
  search summary said it (never used for a number); **[F]** folk wisdom / community practice
  with no published evidence found — stated as such so the plan can treat it as a hypothesis.
  The full source log with URLs and dates is in `docs/scratch/fantasy-strategy-analyst.md`.
- **Nothing here is hard-coded to a format.** Three parameters appear everywhere:
  - `S` — the league's stat modifiers (`stat_modifiers.stats[] {stat_id, value}` plus any
    `bonuses[{target, points}]`), read from `league/{key}/settings` (03 §B.5).
  - `R` — the roster slots (`roster_positions[] {position, count}`; fixed slots, flex slots
    with their eligible-position sets such as `W/R/T`, `BN`, `IR`).
  - `N` — the number of teams (`num_teams`).
  Plus the H2H/points flag (`scoring_type`), playoff settings, `uses_faab`, waiver type.
- **The worked example** is the validation league: `N=12`, H2H, half-PPR (rec 0.5), pass
  TD 4, rush/rec TD 6, pass yds 0.04, rush/rec yds 0.1, INT −1, fumble lost −2, no TE
  premium, no yardage bonuses; `R` = QB, 2 WR, 2 RB, TE, W/R/T, K, DEF, 6 BN, 2 IR. It is
  the same shape as Yahoo's own public-league sample (03 §B.5). Each section says what
  changes under full-PPR, 6-pt pass TD, TE premium, superflex, 10-team, and yardage bonuses.
- Yahoo constraints inherited from 03 and not re-derived: there are **no player-level
  projections** in the API (only `team_projected_points` and `win_probability` per matchup
  team, 03 §B.4); the scoring rules and slots are fully self-describing from one `settings`
  call; weekly stats are provisional until the next week's first kickoff (03 §D.2).

### The common output contract

Every recommendation the product emits should contain, at minimum:

```
recommendation {
  action            // what to do, in the league's own vocabulary (slot names, player keys)
  point_estimate    // E[points] or E[value], under S
  distribution      // p10 / p25 / p50 / p75 / p90, P(zero) — never omitted
  delta_vs_next     // the margin over the best alternative, with its own interval
  decision_metric   // the metric actually optimised (E[pts], P(win), VOR, weeks-of-value …)
  drivers[]         // ranked contributions: opportunity, efficiency, TD, matchup, market, weather, health
  assumptions[]     // "assumes X active", "assumes role unchanged" — each with a trigger to revisit
  confidence        // sample size behind the role estimate + data freshness timestamps
  as_of             // timestamp of the latest input; lock times relevant to the action
  log_id            // so §12 can score it later
}
```

---

## 1. Projection construction (floor / median / ceiling per player per week)

The projection is the substrate for every other decision, so this section is the longest.
Its architecture is a **layered opportunity × efficiency model, converted to points by the
scoring engine (§15), with the distribution obtained by simulation rather than by scaling a
mean**.

### Inputs (by kind)

| Kind | Fields | Window / notes |
|---|---|---|
| League settings | `S`, `R`, `N` | one call; cache per league |
| Player usage (per game) | snap share, route participation (routes ÷ team dropbacks), target share, air-yards share, targets per route run (TPRR), carry share, red-zone (inside-20) and goal-line (inside-5/inside-10) target and carry shares, two-minute/no-huddle involvement | trailing windows, exponentially weighted (below) |
| Player efficiency (per opportunity) | yards per route run (YPRR), yards per target, yards per carry, catch rate, YAC/rec, TD per opportunity | **regressed** — see step 4 |
| Team context | plays per game (pace), dropback rate, pass rate over expectation (PROE), red-zone trips per game, offensive line pressure allowed | season + last-4 |
| Opponent | schedule-adjusted fantasy points allowed per position (aFPA-style), pressure rate, pace, pass-defence EPA allowed | rolling ~10 weeks; regressed |
| Market | game total, spread → implied team totals; line movement | latest before lock |
| Weather | wind speed, precipitation, temperature, roof/dome | game-time forecast |
| Health / availability | injury designation (Q/D/O/IR), practice trend (DNP/LP/FP by day), teammates' availability (for §6 cascades) | daily |
| Play-by-play (optional, high value) | per-play situation for expected-points models: down, distance, yard line, air yards, target location | historical seasons for training; current for live |

### Method

**Step 0 — decide what is stable and what is noise (the evidence).** Volume is sticky;
efficiency mostly is not. Year-over-year for WRs over ten seasons [V Sharp Football]:
targets/game R² 0.54, receiving yards/game 0.49, team target share 0.40, TPRR 0.39,
air-yards/target 0.38, YPRR 0.28, YAC/rec 0.14, catch% 0.11, yards/target 0.03, **TD/target
0.008**. Since 2021, for players with 100+ key snaps in consecutive seasons [V Sumer Sports]:
target share r ≈ 0.70 (the stickiest metric), YPRR r > 0.60, QB EPA/attempt r ≈ 0.60, **RB
EPA/rush "virtually negligible"**. So the model must be built on opportunity, with efficiency
shrunk hard toward positional priors and TD rate shrunk almost entirely.

**Step 1 — team volume from the market and tendencies.**
```
implied_total(team)  = total/2 − spread/2           // favourite has negative spread
plays(team)          = f(pace_team, pace_opp, expected game state)   // ~ season plays/game adjusted by spread
xpass(team)          = xpass_model(spread, total)     // expected pass rate from situation
dropbacks(team)      = plays × (xpass + PROE_team)    // PROE = called pass rate − xpass  [V ETR]
rushes(team)         = plays − dropbacks
rz_trips(team)       = g(implied_total)               // fit on history; ~linear in implied total
```
Why the market drives scale: implied totals correlate with QB scoring strongly, with WR/TE
moderately, and are noisier for RB [S]; the market already prices injuries, matchups and
weather, which is exactly why it is the anchor and why step 6 must not add those again. PROE
being "a bit more stable than game script" is asserted by ETR without numbers [V, no figures]
— treat the PROE term as a tendency prior, not a strong signal.

**Step 2 — player opportunity shares, with role conditioning.** Use an exponentially
weighted mean of each share with a half-life of ~3 games (parameter `h`, to be tuned in
§1-Evaluation), computed **only over games where the current depth chart applied**: if a
starter ahead of the player was out, those games are weighted by the probability that the
same situation holds this week (§6). A change-point rule overrides the smoothing: if snap
share or route participation jumped ≥ 15 points and held for two straight games, re-base the
window at the change [S; this "two straight weeks" heuristic is community practice, F].

**Step 3 — expected opportunities.**
```
targets(p)      = dropbacks × routes%(p) × TPRR(p)        // or dropbacks × target_share(p)
carries(p)      = rushes × carry_share(p)
rz_targets(p)   = rz_trips × rz_target_share(p) × pass_rate_rz
gl_carries(p)   = gl_trips × gl_carry_share(p)
```
Both target formulations should be computed; disagreement between them is itself a
diagnostic (routes without targets = a role that has not yet paid, §4).

**Step 4 — efficiency with regression to the mean.** Bayesian shrinkage per rate:
```
rate_hat = (n × rate_obs + k × prior) / (n + k)
```
where `n` is the player's opportunity count in the window, `prior` is the positional (and
depth-role) mean, and `k` is the stabilisation constant per stat. Evidence-driven starting
points: YPRR needs on the order of 180 routes / ~11 games to stabilise [S]; **yards per carry
should be treated as pure prior** (RB per-rush EPA stability ≈ 0 [V Sumer]; YPC "almost
entirely noise" [S FTN/Footballguys]); yards per target is noise (R² 0.03 [V Sharp]). `k`
per stat is a tuned parameter, not a constant to hard-code.

**Step 5 — touchdowns from location, not from the player's TD rate.** Expected TDs come from
*where* the opportunities happen (goal-line carries, red-zone targets, air yards), i.e. an
expected-fantasy-points / expected-TD model of the kind `ffopportunity` builds with xgboost on
play-by-play [V]. Player TD/target has YoY R² 0.008 [V Sharp]: a player's own TD rate is the
single worst input in the sport. Without pbp, the fallback is `E[TD] = Σ over opportunity
types of (count × league TD rate for that opportunity type)`.

**Step 6 — opponent adjustment, regressed.** Multiplicative, with shrinkage toward 1:
```
matchup_mult(pos, opp) = 1 + β_pos × w(weeks) × (aFPA_opp,pos − league_mean) / league_mean
```
`aFPA` = fantasy points allowed adjusted for the offences faced [V 4for4], never raw points
allowed. `w(weeks)` rises from ~0 at week 1 toward 1 by roughly week 8–10 (4for4 uses a
rolling 10-week window for aFPA). Why the shrink is heavy: year-over-year correlation of
defensive fantasy points allowed is only QB 0.27, RB 0.22, WR ≈ 0.15, TE 0.16 (2015–2025)
[V 4for4/Eakins], so preseason "matchup" is mostly noise, and even in-season the signal is
modest. `β_pos` is tuned in evaluation; expect it to be small.

**Step 7 — weather, only where the evidence supports it.** Apply PFF's measured multipliers
[V Spratt 2018]: wind ≥ 10 mph → QB completion −1.8 pts and −0.30 yards/attempt (grows with
wind); temperature < 30 °F → QB completion −3.1 pts, RB +0.26 yards/carry; light/moderate
rain → completion −2.3 to −3.4 pts, pass-catcher catch rate −2.3 to −2.4 %. 4for4 [V]: in
wind > 13 mph deep passes (> 15 air yards) fall 6.2 %, air yards fall 2–5 %, RB targets rise
~7.7 % in bad weather, and actual totals fall short of the Vegas total in rain/wind/snow. So:
wind and heavy precipitation hit deep-target receivers and QBs modestly; RBs are unaffected
or slightly helped; temperature alone is a small effect. **Do not apply weather to the
implied total again** — the market moves on forecasts.

**Step 8 — availability.** `P(active)` from designation + practice trend + team base rate
(§10). The projection is a mixture: with probability `P(active)` the player draws from the
active distribution, otherwise scores 0 (or the partial-game distribution if a mid-game
exit risk is modelled).

**Step 9 — points and distribution.** The mean is linear in the stat expectations, so
`E[points] = Σ_i S_i × E[stat_i]` (+ expected bonus contributions, which are *not* linear —
see §15). The distribution is **simulated**: draw opportunities (negative binomial around
the expected count), per-opportunity yards (right-skewed, e.g. gamma), TDs (Poisson with
the location-based rate), turnovers (Poisson), then score each draw with the engine. Report
p10/p25/p50/p75/p90, P(≥ thresholds), and P(zero). Sanity targets for the simulated
coefficient of variation, from half-PPR 2015–2021 [V Underdog]: QB 0.36–0.39, RB
0.54–0.63, WR 0.58–0.67, TE 0.63–0.70 — TE most volatile because TD-dependent, QB least. A
simpler parametric fallback (gamma with those CVs, scaled up by the player's TD share of
projected points) is acceptable for an MVP; the 2014 FFA simulation [V] shows per-category
normal draws work but averaging SDs across talent levels is the known weakness.

### Format sensitivity

- The **mean** changes only through `S` (the engine). The **distribution** changes shape:
  full-PPR adds a low-variance component (receptions) → lower CV for WR/RB/TE, floors rise,
  "floor vs ceiling" distinctions shrink; standard scoring does the opposite.
- **6-pt pass TD** increases the QB's variance and TD share → QB CV rises toward RB levels;
  QB ceiling weeks matter more (§3).
- **TE premium** (e.g. +0.5/rec for TEs) lowers TE CV and raises the TE mean relative to WR —
  nothing changes in usage modelling, everything changes in §2.
- **Superflex / 2-QB**: no change to per-player projection; all change is in §2/§3.
- **Yardage bonuses** (e.g. +3 at 100 rush yards): the mean is no longer linear in stats —
  `E[bonus] = P(stat ≥ target) × points`, which needs the simulated distribution. This is
  the one format where "scale the consensus mean" is simply wrong.
- **10-team**: no change to the projection; replacement level moves (§2).

### Pitfalls / where naive versions fail

1. Overfitting to last week — a single game is one draw from a distribution with CV ≈ 0.6.
2. Raw DvP as a multiplier (see Step 6 evidence). 3. Using the player's own TD rate.
4. Using season-average shares after a role change (Step 2 conditioning). 5. Double counting:
applying injury/weather/matchup after anchoring on an implied total that already moved on
them. 6. Season averages that include bye weeks or partial games as full games. 7. Symmetric
(normal) player distributions with a wall at zero — the right tail is long, the left is not.
8. Treating Yahoo's `team_projected_points` as if a per-player source existed underneath it.
9. Ignoring `P(active)`. 10. Applying a position-level CV to a player whose points are
unusually TD-dependent (goal-line backs) or unusually reception-dependent (slot WRs).

### Output shape

Per player-week: the common contract plus `stat_line_expectation {stat_id → E[value]}`
(so the engine can re-score under any `S` without re-projecting), `opportunity
{targets, carries, rz_targets, gl_carries}` with the window used, the shrinkage applied per
rate (`n`, `k`), the matchup and weather multipliers actually used, `P(active)`, and the
**role-confidence** tag (games in the current role).

### Evaluation

Backtest on prior seasons, weekly, under the league's own `S`, against three baselines:
(a) trailing-4-game average, (b) season-to-date average, (c) an external consensus
projection if available. Metrics: MAE and RMSE of the mean (least important); **CRPS** for
the full distribution and **pinball loss** at p10/p50/p90 [V Gneiting & Raftery 2007 — CRPS is
strictly proper, the integral of Brier over thresholds]; **interval coverage** (the p10–p90
band should contain ~80 % of outcomes; less means overconfident); **Spearman rank
correlation** within position per week (this is what start/sit consumes); Brier score of
`P(active)`. "Working" = beats baseline (a) on CRPS and rank correlation in ≥ 2 held-out
seasons, with the gain not concentrated in weeks 1–3, and coverage within ±5 points of
nominal. Tune `h`, `k` per stat, `β_pos`, and the weather multipliers on one season, test on
another.

---

## 2. Replacement level, VOR/VBD, and positional scarcity

### Inputs

`R` (fixed slots, flex slots and their eligible sets, bench count, IR count), `N`, §1
projections (weekly and rest-of-season, ROS), the **actual free-agent pool** in this league
(ownership via `league/{key}/players;status=A` — 03 §B.2), every team's roster, bye weeks,
playoff weeks, the league's acquisition rules (waiver type, add limits if any).

### Method

**Replacement level is a property of the league, not of the position.** Two baselines are
needed and they answer different questions:

1. **Starter baseline (draft / ROS valuation)** — Bryant's VBD [V Footballguys]: value =
   points above the "worst starter" at the position. With flex, the worst starter is found by
   allocation, not by counting: fill each fixed slot for all `N` teams from the sorted
   projections; then fill the flex slots by taking the best remaining player across the
   flex-eligible set; the replacement level for position `pos` is the projection of the best
   player *not* slotted. This makes replacement level for WR and RB depend on each other and
   on TE through the flex, which is the point. Use per-game projections over the weeks
   that matter (ROS, or the playoff weeks) — never season totals, which bake in byes.
2. **Streaming baseline (in-season decisions)** — the best player actually available in
   *this* league's free-agent pool at the position, this week or ROS. This is the honest
   baseline for waivers (§4), trades (§5) and drops, because it is the alternative the
   manager really has.

```
VOR_weekly(p)  = proj_week(p)  − stream_baseline(pos(p), week)
VOR_ROS(p)     = Σ_{w in remaining} [proj(p, w) − starter_baseline(pos(p), w)]  // bye weeks contribute 0 − baseline
xVBD(p)        = E[ max(proj(p) − baseline, 0) ]                                // Stuart's Expected VBD [V]: sub-baseline outcomes are worth 0, not negative, because a benched player costs nothing
```
`xVBD` needs the §1 distribution, and it is why upside players out-value equal-mean
low-variance players at the same baseline — a first-principles reason the product must carry
distributions.

**Bench effect on replacement level.** Bench players start during byes and injuries, so the
effective number of "starters" per position over a season is larger than the slot count:
`effective_starters(pos) = slots(pos) × N × (1 + expected_start_weeks_from_bench / weeks)`.
A 6-bench league with 2 IR needs fewer roster spots for injured players than a 6-bench/0-IR
league, so more bench goes to depth → the starter baseline for RB/WR sits deeper. This is a
computed quantity, not a rule of thumb: derive it from the league's historical transactions
(`league/{key}/transactions`) or, cold, from position injury rates.

**Positional scarcity = the shape of the drop-off curve**, not a positional adjective. Sort
each position's VOR; the value of the *k*-th player is the curve's height. Stuart's fit on
2000–2012 ADP [V]: RB has the steepest value drop-off (log-fit coefficient −32.5), WR gentler
(−24.8), QB/TE moderate, K and DEF nearly flat (DEF −2.5; the top-drafted K averaged under 5
VBD points). Tiers are the curve's plateaus; find them with a Gaussian mixture over the
projections (or over consensus ranks, Chen's method [V borischen.co]) rather than fixed
gaps.

**Streamable positions.** `streamability(pos, weeks) = mean_w [ best_FA_proj(pos, w) /
starter_proj(pos, w) ]`. When it is near 1, the roster spot is worth more than the player
(K and DEF nearly always; TE and QB often in 12-team 1-QB, where the QB replacement level is
high enough that late-round QB and streaming are documented community strategies
[S Zachariason; S PFF "case for QB streaming"]).

### Format sensitivity (this is the section formats change most)

| Format change | Effect on replacement level |
|---|---|
| 10-team (N=10) | fewer starters → every baseline rises → VOR compresses; scarcity flattens; streaming more viable |
| 14-team | the reverse; RB/WR baselines drop deep into low-usage players |
| Superflex / 2-QB | QB baseline falls from ~QB12 to ~QB20–24 → QB VOR jumps by an order of magnitude; QBs become the scarce position |
| TE premium | TE mean rises vs WR, so more TEs win flex slots → TE baseline effectively rises *and* elite-TE VOR grows; must be recomputed, not hand-adjusted |
| Full-PPR | WR/pass-catching-RB means rise relative to rushing RBs → flex allocation shifts to WR; RB baseline shifts |
| 2 flex vs 1 | RB/WR baselines drop by ~N players; bench value rises |
| 6-pt pass TD | QB mean and spread rise; in 1-QB, still streamable if replacement is close; in superflex, dominant |
| IR slots (2) | injured stashes cost no bench → bench baseline deepens; IR-eligibility rules matter (03 §D) |

### Pitfalls

- Static baselines ("RB24 is replacement") that ignore flex, bench and `N`.
- Baselines from consensus rankings not converted to this league's `S`.
- Using the starter baseline for in-season moves when the real alternative is the FA pool.
- Season totals as the basis (byes and missed games distort; per-game with availability).
- Ignoring that replacement level is time-varying: it drops as the season goes on (injuries
  thin the pool) and jumps after bye-heavy weeks.

### Output shape

Per position: `{starter_baseline_weekly[], starter_baseline_ROS, stream_baseline_weekly[],
curve: [(rank, VOR)], tiers[], streamability, effective_starters}`; per player: `VOR_weekly`,
`VOR_ROS` with an interval, `xVBD`, tier, and the flex-allocation trace (which slot the
player would fill on a league-average roster).

### Evaluation

Backtest: (1) does preseason `VOR_ROS` rank predict realised VOR (Spearman by position)?
(2) is the assumed stream baseline honest — compare the assumed best-available projection to
the best realised FA player each week; (3) does `xVBD` order players better than plain VOR
for end-of-season value (it should, when distributions are calibrated); (4) sensitivity:
recompute under the six format variants and confirm the baselines move in the directions
above — a regression test for the allocation logic.

---

## 3. Start/sit

### Inputs

§1 distributions for every rostered player (and, for §3.4, the opponent's), `R`, matchup
opponent's roster and lineup (`team/{key}/roster;week=N` — theirs is visible), game
kickoff times and lock rules (03 §D.2: default lock at the player's game start), injury
designations and practice trends, the correlation structure between started players (same
team, same game), the §11 win-probability state.

### Method

**3.1 Base problem — assignment, not a sorted list.** Maximise expected points subject to
slot eligibility. With ≤ 16 rostered players and one flex, exhaustive enumeration of legal
lineups is cheap; for superflex/multi-flex use a small assignment solve. This alone beats
"rank by consensus" only if §1 is calibrated to `S`.

**3.2 Objective under H2H — win probability, not points.** Let the lineup total be
`M ~ (μ_m, σ_m²)` and the opponent's `O ~ (μ_o, σ_o²)` (§11). Under a normal approximation
`P(win) = Φ( (μ_m − μ_o) / sqrt(σ_m² + σ_o² − 2ρσ_mσ_o) )`. The derivative of `P(win)` with
respect to `σ_m` has the sign of `−(μ_m − μ_o)`:

- **projected underdog → prefer variance** (higher-ceiling players, stacks);
- **projected favourite → prefer low variance** (higher-floor players, no stacks);
- **near even → maximise the mean**.

This is the H2H analogue of the DFS result that top-heavy contests reward variance and
double-ups reward the mean [V Hunter, Vielma & Zaman 2016: lineups as jointly Gaussian,
maximise mean subject to a variance lower bound and a correlation cap; S Haugh & Singal for
the double-up vs top-heavy framing]. Quantify before recommending: compute `ΔP(win)` for
every candidate swap; most swaps move it by under 2–3 points and the product should say so
rather than dramatise. "When floor beats ceiling" is therefore not a style — it is the sign
of `μ_m − μ_o` scaled by how much the swap changes `σ_m`.

**3.3 Correlation and lineup variance.** Measured same-team weekly correlations, 2022–2025
full-PPR [V RotoWire]: QB–WR1 +0.31, QB–TE +0.27, QB–RB +0.07, same-team WR–WR −0.02. A
QB–WR stack adds ≈ 1.8 points of weekly ceiling and removes ≈ 1.6 of floor; a
QB–WR–WR stack ≈ +2.2 / −2.0; season totals are unchanged ("bunches your good and bad weeks").
So: stacks are a variance instrument for §3.2, nothing more; the widely quoted "+0.6" QB–WR
correlation is not supported by that sample. Game stacks (your WR vs their QB, "bring-back")
rest on the game total and are folk practice in season-long formats [F]. Implement:
`σ_lineup² = Σσ_i² + 2Σ_{i<j} ρ_ij σ_i σ_j` with `ρ` from a small table (same team by
position pair; same game by a smaller constant; else 0).

**3.4 Thursday / Monday locking — an option-value problem.** Starting a Thursday player
forfeits the option to react to Sunday news. Rule: start the Thursday player at a slot only if
`E[pts_thu] ≥ E[pts_best_sunday_alt] + option_value`, where
`option_value ≈ P(adverse Sunday news on the alternative set) × E[loss avoided by re-slotting]`
— small for a bench with healthy depth, large when the alternatives are Questionable. Prefer
placing Thursday players in fixed slots and keeping the flex for Sunday. Monday players are
the mirror: they carry the option of being benched *after* seeing Sunday, so a Monday player
with a Sunday alternative of equal mean is worth slightly more to a favourite (can protect)
and less to an underdog who already knows Sunday went badly (cannot chase).

**3.5 Questionable tags.** Base rate: 71 % of players Questionable on the final report played,
2017–2023, > 2,000 injuries [V Footballguys Injury Index], with team-specific usage differing
materially; "limited" practice is undefined (10–90 % of reps) and the trend across
Wed/Thu/Fri carries more information than the tag [V FantasyIndex; S]. Method:
`P(active) = logistic(designation, Friday status, trend DNP→LP→FP, team base rate, injury
type/history)`, then `E[pts] = P(active) × E[pts | active]`. The decision also depends on
kickoff order: a Questionable player in a late game whose alternative plays early is a
*commitment* (if he is inactive, the slot is a zero) — treat as §3.4 with `option_value` on
the other side. Emit the conditional lineup: "if X inactive at 11:30 ET, start Y".

### Format sensitivity

- Full-PPR narrows floor/ceiling differences (lower CVs, §1) → §3.2 matters less; standard
  scoring widens them.
- 6-pt pass TD raises QB variance → QB–WR stacks move `σ_m` more; the QB becomes a larger
  share of the lineup's variance.
- Superflex: the QB slot decision joins the assignment; a second QB's lower variance (QB CV
  0.36–0.39 vs WR 0.58–0.67 [V Underdog]) makes "QB in the superflex" a floor play by
  construction.
- Points leagues (not H2H): §3.2 collapses to maximise the mean; variance preference vanishes.

### Pitfalls

Ranking by point estimate; ignoring the opponent's projection; "floor" and "ceiling" as
adjectives rather than quantiles; chasing DvP (§1 step 6); benching a Thursday player for a
worse Sunday one without computing the option value; stacking as a favourite; treating a
Questionable tag as 50/50 when the base rate is ~70/30 and the practice trend is known;
counting the same injury twice (in `P(active)` and again as a "risk discount" on the mean).

### Output shape

`{lineup, alternative_lineup_mode: protect|chase, per-slot: {player, E, p10, p90}, swaps[]:
{out, in, ΔE, ΔP(win), interval}, lock_schedule, conditionals[]: {if, then}, stack_flags,
P(win) before/after}` — plus the common contract.

### Evaluation

Log every recommended lineup and the alternative(s). Metrics: **regret** = realised points of
the recommended lineup minus the best alternative offered; **ΔP(win) calibration** — group
swaps by predicted `ΔP(win)` and check realised win-rate differences (Brier on `P(win)`);
**"did it matter"** — the share of swap recommendations that changed the H2H result (expect
this to be small; report it honestly); and comparison against "start by consensus rank"
and "start by §1 mean" baselines across ≥ 2 seasons of replayed leagues (§12 defines the
logging). "Working" = lower regret than the consensus baseline and `P(win)` calibrated within
±5 points across bins.

