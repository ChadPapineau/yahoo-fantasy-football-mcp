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

---

## 4. Waiver wire and FAAB

### Inputs

Weekly usage and its week-over-week deltas (snap share, route participation, target share,
TPRR, air-yards share, carry share, red-zone/goal-line shares); depth-chart changes; injury
news with expected duration (§6); the league's free-agent pool and each player's
`percent_owned {value, delta}` (03 §B.4 — the crowd's attention, hence the competition);
my roster and §2 baselines; league waiver settings (`uses_faab`, `waiver_type`,
`waiver_rule`, `waiver_time`, per-team `faab_balance`, `waiver_priority` — 03 §B.2);
this league's transaction history including `faab_bid` on completed claims (03 §B.2);
schedule (byes, playoff weeks); acquisition limits if the league has them (03: tolerate
absence).

### Method

**4.1 Detect opportunity before it shows in points.** Signals, ordered by lead time:

1. **Injury / depth-chart change** on the player's team (immediate; §6 sizes it).
2. **Snap share / route participation jump** — a rise of ≥ 15 points held for two straight
   games is the community threshold for "the role changed" [S; F — heuristic, not evidenced;
   tune it in evaluation]. Snap increases tend to precede production by 1–2 weeks [S].
3. **Target share / TPRR jump** — target share is the stickiest receiving metric (r ≈ 0.70
   YoY [V Sumer]); a rising share is the strongest single leading indicator.
4. **Under-produced opportunity** — WOPR = 1.5 × target share + 0.7 × air-yards share
   [V Hermsmeyer, via Action Network]; high WOPR with low points is the classic buy signal.
   Generalise it: compute **expected fantasy points from usage** (`xFP`, §1 steps 3–5 and 9,
   under this league's `S`) and the gap `xFP − actual`. Positive gap = opportunity that has
   not paid yet (target); negative gap = TD- or efficiency-inflated production (avoid, or
   sell).
5. **Red-zone / goal-line share shifts** and **committee shifts in carry share**.

Every signal is filtered by `P(role holds)`: a jump caused by a teammate's one-week absence
is not a role change. Yahoo's `percent_owned.delta` is *not* a detection signal — by the
time it moves, the crowd has moved — but it is the best available **competition** signal
for 4.3.

**4.2 Value a pickup in weeks of usable value on *my* roster, not by season rank.**
```
value(p) = Σ_{w ∈ horizon} P(role holds at w) × max(0, proj(p, w) − opportunity_cost(w))
```
where the horizon is the weeks that matter (ROS, weighted toward playoff weeks by
`P(I reach w)`), and `opportunity_cost(w)` is what the slot would otherwise produce for me
that week: the §3 assignment run with and without `p`, so a WR4 who never starts on my
roster is worth only his bye-coverage weeks plus trade value, while the same WR4 is a
starter for a WR-thin roster. This is the "roster fit" term, computed rather than felt.
The marginal value is `value(p) − value(drop candidate)` (4.5).

**4.3 FAAB bid sizing.** FAAB is a first-price sealed-bid auction, in which bidding one's full
value is dominated and **shading** is rational [V Wikipedia FPSB]. Three quantities:

- **Price of a point in this league** — regress historical winning `faab_bid`s (from the
  transaction history) on the acquired player's then-current value (xFP, `percent_owned`
  delta, position); this gives `$/point` and its spread. Cold start: a league-wide prior
  from public leagues, then update.
- **Competition** — for each rival: `P(rival bids)` from whether `p` improves *their*
  lineup (run 4.2 on their roster), their remaining `faab_balance`, and their history;
  their bid distribution from the price-of-a-point model plus shading. Combine into
  `P(win | my bid b)`.
- **The marginal value of a FAAB dollar**, `λ(t, budget)` — rising as budget shrinks and as
  the remaining season shortens the chance of a better target, falling to ≈ 0 by the last
  waiver run before the playoffs (unspent FAAB is worthless).

Bid: `b* = argmax_b P(win | b) × (value(p) − λ × b)`, reported with the whole curve
(`P(win)` at 25/50/75 %). Heuristics the community uses, which the model should reproduce
rather than hard-code [F]: spend early on genuine role changes (more weeks of value); bid
just above round numbers; keep a reserve only if the team is playoff-bound. The Yahoo
`percent_owned.delta` and the number of teams for whom `p` is a lineup upgrade are the
inputs the heuristics are proxies for.

**4.4 Waiver priority instead of FAAB.** Priority is a one-shot resource. Rolling priority
(you drop to last after a claim): claim if `value(p) ≥ E[best claimable value over the
horizon you would otherwise hold priority] × P(you would win that future claim)`. Weekly
reset by standings: the cost is a week, so claim more freely. Free agents after the
waiver period clear first-come, so `waiver_time` and the clearing time are part of the
recommendation. All of this is decision logic, not evidence [F].

**4.5 Drop candidates.** Lowest `value_ROS` on my roster after roster fit, **excluding**
handcuffs and stashes justified in §9, and excluding players whose `xFP − actual` is
strongly positive (about to regress upward). Show the re-add risk: `percent_owned` and how
many rivals would claim the dropped player.

### Format sensitivity

Full-PPR raises the value of receiving-role pickups and pass-down backs; standard raises
goal-line backs. TE premium makes TE role changes claim-worthy. Superflex makes any starting
QB change a top claim. 10-team: the FA pool is deeper, so the stream baseline is higher and
fewer pickups clear it — and FAAB prices per point should be lower. Deep benches lower the
drop cost, raising the value of speculative adds.

### Pitfalls

Chasing last week's points (a TD is one draw); valuing by season rank rather than roster
fit; ignoring `P(role holds)` (the starter returns in two weeks); forgetting byes and
playoff weeks in the horizon; bidding without modelling remaining budget (λ); treating
`percent_owned.delta` as a signal to buy rather than a signal of competition; counting an
injury both in the beneficiary's role and again as "upside"; dropping the player whose
opportunity just rose because his points have not.

### Output shape

Ranked candidates: `{player, signal(s) fired, weeks_of_value, P(role_holds)[], marginal_value
vs drop candidate, xFP_gap, competition {rivals for whom it is an upgrade, expected bids},
bid {b*, P(win) curve, λ}, drop {who, re-add risk}, invalidators[]}` plus the common
contract. In priority leagues: `claim | wait` with the option-value comparison shown.

### Evaluation

Detection backtest: for each week `t` and signal, precision/recall of "signal fires → player
finishes top-24 (RB/WR) / top-12 (TE/QB) at position over `t+1..t+4`" versus a points-only
detector (top scorer among FAs last week). FAAB: realised value per FAAB dollar; calibration
of `P(win | b)` against actual claim outcomes (Brier); regret against the best FA available
that week. Drops: the dropped player's subsequent value versus the added player's.
"Working" = the usage detector beats the points detector on precision at equal recall in ≥ 2
seasons, and `P(win | b)` is calibrated within ±10 points.

---

## 5. Trade evaluation

### Inputs

Both rosters (mine and the partner's; all rosters are readable — 03 §B.3), §1 ROS
projections with distributions, §2 baselines for this league, schedule (byes, playoff
weeks, games remaining), injury risk priors (expected games missed by position/age/injury
history), the league's trade rules (`trade_end_date`, `trade_ratify_type`,
`trade_reject_time` — 03 §B.2), standings (mine and theirs), the league's trade history.

### Method

**5.1 Value is the change in expected lineup points over the horizon, for each side.**
```
Δ_side = Σ_{w ∈ horizon} weight(w) × [ lineup_pts(roster_after, w) − lineup_pts(roster_before, w) ]
weight(w) = P(side is alive at w) × importance(w)     // playoff weeks weighted higher
```
`lineup_pts` is the §3 assignment on the actual roster, so a WR3 arriving on a WR-rich
roster adds little and the same WR3 on a WR-poor roster adds a lot. A trade is proposable
when `Δ_me > 0` and **`Δ_partner > 0` under their roster** — positive-sum trades exist
precisely because value is roster-contextual, which is the whole argument against static
charts.

**5.2 Roster spots are priced, not hand-waved.** In a 2-for-1 the side receiving two must
drop a player; its `Δ` includes losing that player's value (≈ the stream baseline if the
drop is marginal, more if not). Public charts apply a 5–20 % haircut to the multi-player
side and disagree on the number [V FantasyPros chart; S others] — the method computes it
from the actual drop.

**5.3 Schedule terms.** Byes: two acquired players sharing a bye with my starters cost a
week each; playoff weeks: use §7's (weak) matchup signal only as a tie-breaker; games
remaining after the trade deadline.

**5.4 Injury risk.** `proj(p, w) × P(active, w)` with `P(active)` from a simple
position/age/injury-history prior (RBs carry more risk than WRs; no strong published
per-player model is assumed). Reported separately so the user can see how much of `Δ` is
"health-adjusted".

**5.5 Uncertainty and risk appetite.** Simulate `Δ` (both sides). A team that is 1–3 should
prefer a positive-mean, high-variance trade; a 4–0 team the reverse — the §3.2 logic
applied to the season (standings → `P(playoffs)` as the objective, §11).

**5.6 Why static trade charts fail** — stated so the product never falls back to them: one
number per player; a format baked in (usually PPR); no roster context; no roster-spot
cost; no schedule; a "public sentiment" component that is not value in *this* league; and
additive arithmetic on 2-for-1s [V FantasyPros describes charts as ROS value plus public
sentiment, 1-for-1 oriented].

**5.7 Negotiation framing.** Compute the partner's weakest starting slot (largest gap to the
§2 starter baseline) and propose the package that maximises `Δ_me` subject to `Δ_partner ≥
ε`; show the partner's `Δ` in *their* terms. Offers with `Δ_partner < 0` are not proposed
[F — the acceptance model in Evaluation will test whether `Δ_partner` predicts acceptance].

### Format sensitivity

Entirely via §1/§2: superflex makes QBs the currency; TE premium makes elite TEs trade
targets; full-PPR shifts RB-for-WR balances. The only trade-specific format term is the
roster-spot price, which depends on bench size and IR slots.

### Pitfalls

Consensus charts; season totals as ROS; ignoring byes/playoffs/deadline; ignoring the drop
implied by uneven trades; ignoring the partner's roster (unacceptable offers); double
counting a "best player" premium (it is already in `Δ` through lineup points); treating
injury risk as a vibe instead of a multiplier; ignoring veto/ratification rules.

### Output shape

`{Δ_me, Δ_partner (each: mean, p10, p90), weekly_impact[], playoff_weeks_impact,
implied_drop, health_adjustment, bye_conflicts, why_they_accept, counter_offers[]}` plus the
common contract.

### Evaluation

Replay historical trades from this and other leagues (transactions expose trades, 03 §B.2):
predicted `Δ` for each side versus realised lineup-point change over the rest of that
season; rank correlation and sign accuracy; compare against a chart-based evaluator on the
same trades. Acceptance model: whether `Δ_partner > 0` predicts acceptance of proposed
trades. "Working" = sign accuracy above a chart evaluator and `Δ` intervals covering
realised outcomes at nominal rates.

---

## 6. Injury-cascade analysis

### Inputs

Depth charts (kind), injury reports with expected duration (kind: injury database with
return timelines), the team's own historical usage in games the starter missed (this and
last season), league-wide redistribution priors by position built from play-by-play, the
backups' recent snap/route/carry data, the market's reaction (implied total change).

### Method

**6.1 Beneficiaries by role affinity, not by depth-chart line.** Vacated opportunity is the
community method [S ESPN, Yahoo "vacated targets"]: sum the injured player's targets,
air yards, carries and red-zone touches, then redistribute by **role similarity**: the
outside WR's targets go mostly to the other outside receivers and the TE, not the slot; a
RB1's carries go to the RB2 but his targets go to the pass-down back. Represent each player
as a usage vector (alignment share, depth of target, formation) and allocate vacated volume
proportionally to similarity × availability.

**6.2 Historical redistribution.** Prefer the team's own evidence (games without the
starter) when ≥ 2 games exist; otherwise a league-wide prior table by position pair,
estimated from play-by-play history ("when a RB1 misses, the RB2's carry share rises by X
and target share by Y, on average, with spread") — **no rigorous published redistribution
study was found in this pass; the plan should build this table** rather than assume 1:1
inheritance. Illustrative community evidence: DeVonta Smith's TPRR 20 % → 30 % without A.J.
Brown [S ESPN]. Remember the offence usually gets worse without the star — total volume and
the implied total fall — so the beneficiary's absolute gain is less than the vacated share
suggests.

**6.3 Timing.** `P(role holds at w)` = P(starter still out at w) from the injury-duration
prior × P(no committee forms) — the latter from the team's history. After the starter
returns, a backup who performed sometimes keeps a share [F]; represent as a small residual.

**6.4 Confidence sizing.** Report: number of games of team-specific evidence; whether the
beneficiary already shows the role (§4 signals fired); whether the market moved; the
spread of the prior. A cascade with no team evidence, no usage confirmation and no market
move is a hypothesis, and the recommendation must say so.

### Format sensitivity

Full-PPR elevates the pass-down back and slot receivers among beneficiaries; standard
elevates the goal-line back; TE premium the TE; superflex a backup QB (whose value is
otherwise near zero in 1-QB).

### Pitfalls

1:1 inheritance; ignoring the team's efficiency drop; ignoring committees; counting the
injury twice (market already moved and the role already includes it); trusting the listed
depth chart over snaps; assuming the timeline in the first report (durations are
revised); ignoring that the returning starter's own projection needs a ramp.

### Output shape

`{injured, expected_weeks (p25/p50/p75), beneficiaries[]: {player, Δopportunity {targets,
carries, rz}, Δproj by week, P(role), evidence: {team_games, usage_confirmed, market_move}},
returning-starter ramp}` plus the common contract.

### Evaluation

For every starter absence of ≥ 2 games in history: predicted beneficiary opportunity shares
versus realised over the next 1–4 weeks (MAE), hit rate of the top predicted beneficiary
being the top realised, and calibration of `P(role holds)`. "Working" = MAE below the naive
depth-chart-next-man-up rule and top-beneficiary hit rate above it.

