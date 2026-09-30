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

---

## 7. Bye-week and playoff-schedule planning

### Inputs

`bye_weeks` per player (Yahoo carries it on the player — 03 §B.4), the league's playoff
settings (`playoff_start_week`, `num_playoff_teams`, `has_multiweek_championship`,
reseeding — 03 §B.2), the NFL schedule (kind), my roster and §1 weekly projections, §2
stream baselines by week, opponent defences' aFPA (for the weak matchup term), standings
and §11 `P(playoffs)`.

### Method

**7.1 Stress-test the roster week by week.** For each remaining week run the §3 assignment
with byes and known absences applied; record `lineup_pts(w)`, the slots filled from the
stream baseline (holes), and the drop from the roster's no-bye lineup. A **bye cluster** is a
week where ≥ 2 starters are out; its cost is `Σ (starter proj − replacement proj)`, not a
count of players. Weight each week by whether it matters: `weight(w) = P(alive at w) ×
importance(w)` — a bye cluster in week 14 (playoffs) costs more than one in week 6, but only
if `P(playoffs)` is material.

**7.2 Strength of schedule — what predicts and what does not.** The evidence says
**preseason and early-season SOS by fantasy points allowed is close to noise**: YoY
correlation of points allowed by position QB 0.27, RB 0.22, WR ≈ 0.15, TE 0.16 over
2015–2025, with top-5 defences repeating only 20–30 % of the time [V 4for4/Eakins 2026, who
concludes SOS "shows weak predictive power across most positions" and recommends aFPA over
raw]. In-season aFPA on a rolling ~10-week window carries modest signal [V 4for4]. So:

- Do **not** rank players for the playoff weeks by "playoff schedule" in August or
  September; the product should say so.
- From roughly week 8–10, apply the §1 step-6 matchup multiplier with its shrinkage, as a
  tie-breaker between otherwise similar players, not as a driver.
- What *does* carry into December: the player's own role and health, the team's implied
  totals (the market re-prices weekly), weather for outdoor cold-weather venues (small, §1
  step 7 — cold favours RBs slightly), and known rest/eliminated-team dynamics (late-season
  benching of starters on eliminated teams is a real but unquantified risk [F]).

**7.3 Decision rules that follow.** Trade-target and waiver horizons (§4, §5) use
`weight(w)`; a bye-week hole in a week with `P(alive) ≈ 1` is worth solving only if the
cheapest fix (a one-week streamer) leaves a gap larger than the FAAB/priority cost; a roster
that has two starters on the same bye during the playoffs (possible only when the playoffs
overlap late byes; Yahoo `playoff_start_week` says whether they do) is the one case where
"schedule" should change a trade decision by itself.

### Format sensitivity

Bench size and IR slots set how many bye holes can be covered internally; 10-team leagues
make the stream baseline higher, so holes are cheaper; superflex makes QB byes expensive
(two QB slots to fill from a shallow pool); playoff format (weeks, reseeding, multi-week
championship) changes `importance(w)`.

### Pitfalls

Counting byes instead of costing them; treating SOS as a signal before the data supports it;
optimising for playoff weeks when `P(playoffs)` is low; forgetting that Yahoo's weekly
deadlines/lock rules define what "covering a bye" requires (a Thursday bye hole cannot be
fixed after Thursday); assuming defensive rankings from last year carry over.

### Output shape

`{weeks[]: {lineup_pts, holes[], bye_cluster_cost, weight}, worst_weeks[], fixes[]:
{action, cost, Δ}, playoff_weeks: {matchup_multipliers (with shrinkage shown), note on
evidence strength}}` plus the common contract.

### Evaluation

Backtest the SOS claim in the product's own data every season: correlation of the
week-`t` matchup multiplier with realised points over `t..t+4`, by position and by week of
season; the multiplier's tuned `β_pos` and `w(weeks)` should be re-fit yearly. Bye planning:
regret of the chosen fix versus the best fix in hindsight.

---

## 8. K and DEF streaming

### Inputs

Implied team totals and spreads; roof/dome and weather (wind); team red-zone trips and
third-down conversion; kicker FG attempt volume and long-FG history; opponent's sack rate
allowed, turnover rate, pressure rate; the DEF's own sack and takeaway rates; the league's
K and DEF scoring tiers from `S` (FG distance stat ids 19–23, PAT 29; DST points-allowed
brackets stat ids 50–56, sacks 32, INT 33, fumble recovery 34, TDs 35/49, safety 36, block
37 — 03 §B.5); the FA pool at K and DEF.

### Method

**8.1 Kickers.** What predicts: the **team's implied total** — kickers scored 10+ points more
than twice as often when the implied total was ≥ 27 than when ≤ 26 [V 4for4 2023]; **field-goal
volume and long-FG history** are the predictive components; **extra points** are highly
predictable; **missed kicks and "bad in the red zone" have little or no forward value**
[V Subvertadown]. So the kicker model is
`E[K pts] = E[FGA] × Σ_dist P(dist) × (S_dist × make_rate_dist) + E[XPA] × make_rate × S_PAT`,
with `E[FGA]` and `E[XPA]` driven by implied total, red-zone trips and third-down
efficiency (4for4 targets offences with 44 %+ third-down conversion [V]), and the distance
mix from the team's history. Dome/wind enter through `make_rate_dist` and the offence's
implied total; a separately quoted dome-vs-wind average was only in a search summary and is
not used [S, unverified]. The league's distance tiers in `S` decide whether long-FG kickers
are worth more (5 points at 50+ in the validation league).

**8.2 Team defence.** The most predictable component is **points allowed**, which is a
function of the *opponent's* implied total; sacks are moderately predictable from the DEF's
own sack rate and the opponent's sack rate allowed; fumble recoveries are the least
predictable; **return and defensive TDs are effectively random week to week** and should be
modelled as a small league-average constant [S community DST models: points-allowed bracket
from opponent implied total + 1 per expected sack + 2 per expected takeaway + ≈ 0.6 for
TDs/safeties/blocks; the shape is standard, the constants must be re-fit to this league's
`S`]. So:
```
E[DEF pts] = Σ_bracket P(opp points in bracket | opp implied total) × S_bracket
           + E[sacks] × S_sack + E[INT] × S_INT + E[FR] × S_FR + c_rare
```
where `P(opp points in bracket)` comes from a distribution around the implied total (fit on
history — a negative binomial around the implied total is adequate), and `c_rare` is the
league-average expected value of TDs/safeties/blocks under `S`.

**8.3 How far ahead, and hold vs stream.** Because both positions are dominated by the
opponent's implied total, planning further than the current week means forecasting lines —
use the closing line's persistence (team strength changes slowly) for a 2-week look-ahead
and treat anything longer as noise. Hold rather than stream only when `streamability` (§2)
is well below 1: an elite DEF whose own sack/takeaway rates put it above the FA pool in most
matchups, or a kicker on a top offence in a league with generous long-FG tiers. In drafts
the evidence for holding is weak: the top-drafted kicker averaged < 5 VBD and the DEF
value-by-ADP curve is nearly flat [V Stuart/Footballguys]; redraft leagues should stream
[V 4for4 2023].

### Format sensitivity

Distance tiers (e.g. 5 for 50+) raise the value of strong-legged kickers and of `E[FGA]`
from long range; DST brackets with steep negatives (−4 at 35+) increase the penalty of
streaming into a bad implied total; leagues that score DST yards allowed (stat ids exist
for it in Yahoo's universe) add a second implied-total-driven component; IDP leagues are out
of scope here.

### Pitfalls

Ranking DEFs by last week's sacks or a return TD; using the DEF's own points-allowed
history instead of the opponent's implied total; using kicker accuracy or "red-zone
struggles" as a predictor; streaming three weeks ahead on schedule; forgetting `S` tiers
when comparing kickers across leagues.

### Output shape

`{candidates[]: {player, E, p10, p90, drivers: {implied_total, brackets, sacks, takeaways,
rare}, next_week_look_ahead}, hold_vs_stream: streamability, current starter's Δ}` plus the
common contract.

### Evaluation

Weekly rank correlation and MAE against (a) "start whoever scored most last week" and (b)
"start the DEF facing the lowest implied total" — the product must beat (a) clearly and at
least match (b), or the extra features are not earning their complexity. Report the share
of DEF variance explained by the rare-event constant to keep expectations honest.

---

## 9. Rest-of-season roster construction

### Inputs

`R` (bench and IR counts), §2 baselines and streamability by position, §1 ROS projections
with distributions, injury priors, the FA pool depth by position, standings and §11
`P(playoffs)`, the league's acquisition limits and trade deadline.

### Method

**9.1 Bench allocation by marginal expected lineup points.** Each bench slot's value is the
expected lineup points it adds over the horizon through (a) bye coverage, (b) injury
coverage, (c) upside (a player who might become a starter — `xVBD`, §2), (d) blocking (a
handcuff that keeps a rival from the beneficiary — usually small). Allocate slots greedily by
marginal value: streamable positions (K, DEF; often QB and TE in 12-team 1-QB) get **zero**
bench slots; RB and WR compete for the rest based on the drop-off curve (§2) and the FA
pool. Two IR slots change the calculus: injured stashes are free, so the IR eligibility
rules (03 §D) should be surfaced with every stash recommendation.

**9.2 Handcuffs.** Value = `P(starter misses ≥ 1 week) × Σ_w P(out at w) × max(0,
proj(handcuff | starter out, w) − opportunity_cost(w))` minus the slot's alternative use.
This is positive when the starter carries high injury risk and the handcuff would be a
clear standalone starter when promoted (§6 redistribution), and negative for committee
backfields or when the bench slot could hold a player with standalone value. **No rigorous
published study on handcuffing was found; the community is divided** [S; F] — the product
should compute the number and never apply "always/never handcuff" as a rule.

**9.3 Stashing.** A stash is a bet on `P(role change) × weeks_of_value`; it beats a bye-cover
bench player only when the roster already covers byes internally. IR slots make stashes of
injured players nearly free.

**9.4 When to consolidate (2-for-1 trades that improve the starting lineup).** Consolidation
is right when the roster's marginal bench value is below the stream baseline (bench players
never start) — then two such players for one starter raises lineup points and frees a slot
(§5.2). It is wrong when byes/injuries make bench depth the binding constraint.

**9.5 Season-phase rules that fall out of the weights.** Early: upside and role bets (long
horizon). Mid: bye coverage. Late (post-deadline): the horizon is only the playoff weeks,
`weight(w)` for eliminated futures is 0, so `P(playoffs)` decides whether to hold stashes
(alive: hold high-ceiling players for the bracket; eliminated: nothing matters — the
product should say so rather than manufacture advice).

### Format sensitivity

Superflex: at least one QB on the bench is close to mandatory (QB baseline is deep); TE
premium: a second TE can have flex value; 10-team: shallower rosters relative to the pool
→ fewer stashes pay; deep benches (8+) lower the cost of handcuffs and stashes; 0 IR → IR
stashes compete with depth.

### Pitfalls

Rostering a backup K/DEF/QB in a 1-QB league; handcuffing as a rule; holding stashes when
eliminated or dropping them when alive; ignoring IR eligibility; consolidating while
byes/injuries make depth binding; benching the FA pool's depth from the calculation.

### Output shape

`{bench_plan: [{slot, role: bye_cover|injury_cover|upside|handcuff|stash, player, marginal
value}], handcuff_values[], stash_values[], consolidation_candidates[], phase_note}` plus the
common contract.

### Evaluation

Replayed seasons: realised lineup points of the recommended bench plan versus (a) the
manager's actual bench and (b) a "best available by ROS rank" bench; handcuff hit rate and
realised value versus computed value; the share of stashes that ever started. "Working" =
higher realised lineup points than (b) and handcuff value calibrated within its interval.

---

## 10. News-vs-stats disagreement

### Inputs

News and beat-report text with timestamps and source identity (kind); official injury
designations and practice participation by day; Yahoo's `has_recent_player_notes` /
`player_notes_last_timestamp` flags (a "something changed" trigger only — 03 §B.4); the
§1/§4 usage-based expectations (`xFP`, role shares); the market (line moves, player props
if available); the §6 cascade state.

### Method — treat news text as data with a reliability model, never as instructions

**10.1 Structure every item.** Extract `{player, claim_type, direction, magnitude,
source, time}` where `claim_type ∈ {availability, role/usage, health-detail, coaching
intent ("will get more work"), transaction}`. Text is untrusted input to a classifier; it
carries no authority of its own (the program's ground rule: news is data, not
instructions).

**10.2 Score the source and the claim type separately.** Maintain a per-source calibration
table: for each source and claim type, how often the claim was borne out (e.g. "will play"
→ played; "expanded role" → snap share up ≥ 10 points within two weeks). Official
designations get a base rate, not blind trust: Questionable → played 71 % (2017–2023
[V Footballguys]), with team-specific deviations that the table should learn; "limited"
practice is undefined and the Wed→Fri trend is more informative than the label
[V FantasyIndex; S]. Coaching-intent claims ("we want to get him more involved") are the
least reliable class and should start with a low prior [F — assumption to be measured].

**10.3 Flag disagreement in both directions.**
- **Narrative > numbers**: news says expanded role / breakout, but snaps, routes and
  target share are flat and the market has not moved → flag "unconfirmed narrative"; the
  recommendation keeps the usage-based projection and states what would confirm the news
  (a snap-share rise next game, a line move).
- **Numbers > narrative**: usage has risen for two games (§4 signals) with no news
  coverage and low `percent_owned.delta` → flag "quiet role change" — the highest-value
  waiver class because the crowd has not noticed.
- **Availability conflicts**: a positive beat report versus a DNP → weight by the source's
  table and the time ordering (later beats earlier; official beats unofficial for
  availability; usage beats everything for role).

**10.4 Merge.** `P(active)` and role shares are updated Bayesianly: prior from the numbers,
likelihood from each news item scaled by its source/claim reliability. Show the user the
prior, the evidence items, and the posterior — never a bare "reports say".

### Format sensitivity

None in the method; the *consequence* of a role claim scales with `S` (a "more targets"
claim matters more in full-PPR; a "goal-line role" claim in standard).

### Pitfalls

Acting on a claim as if the text were an instruction; trusting coaching intent; treating a
Questionable tag as a coin flip; letting the latest tweet overwrite two games of usage;
ignoring the source's track record; missing that a quiet usage change is the signal and
silence is the opportunity.

### Output shape

`{flag: unconfirmed_narrative | quiet_role_change | availability_conflict, prior, evidence[]:
{source, claim, reliability, time}, posterior, what_would_confirm[], recommendation
consequence}` plus the common contract.

### Evaluation

The per-source calibration table *is* the evaluation: Brier score of source claims by
type; precision of "quiet role change" flags at producing a top-24/12 finish within four
weeks; whether merging news improves `P(active)` Brier over designation-only. "Working" =
news-augmented `P(active)` beats designation-only, and flagged narratives that never
confirmed did not move the projection.

---

## 11. Head-to-head win probability

### Inputs

Both lineups' §1 distributions (means, variances, and the correlation table from §3.3),
kickoff schedule and which games are final / in progress, live box-score stats for players
whose games are under way (kind), Yahoo's own `win_probability` and `team_projected_points`
per matchup team (03 §B.2 — a cross-check, not an input to the model), lock rules.

### Method

**11.1 Pre-week.** With totals `M` and `O` and the covariance from shared games/teams,
`P(win) = Φ((μ_m − μ_o) / sqrt(σ_m² + σ_o² − 2 cov(M, O)))` under the normal approximation
of the sums; player distributions are right-skewed but sums of 9–10 of them are close
enough to normal for a first pass. **Prefer Monte Carlo** when correlation or skew matters:
draw each player from §1's simulated distribution with the §3.3 correlation structure
(jointly Gaussian copula is the standard device [V Hunter et al. model lineups as jointly
Gaussian]), score with the engine, and take the win frequency. Ties: `is_tied` exists in
Yahoo's matchup model; count half.

**11.2 Live in-week updates.** As games finish, replace a player's distribution with a
point mass at his actual (provisional) score; for games in progress, condition on the
partial score and time remaining (a simple model: remaining expectation = full-game
expectation × fraction of game remaining, variance scaled likewise; a better model uses the
live game state and the player's live usage). Recompute `P(win)` after each update. Yahoo's
weekly stats are provisional until the next week's first kickoff (03 §D.2), so the product
should label post-game numbers as provisional until then.

**11.3 What the number feeds.** §3.2 (variance preference), §5.5 (risk appetite), §7 and §9
(`P(alive at w)`, via a season simulation that chains weekly `P(win)` through the
schedule and the playoff format), and §12 (calibration).

**11.4 Season simulation.** For `P(playoffs)` and `P(alive at w)`: simulate the remaining
schedule with weekly `P(win)` from projected lineups (using a mean-reverting estimate of
each team's strength for weeks without projections), apply the league's tie-breakers and
playoff format (`num_playoff_teams`, reseeding — 03 §B.2). Run ≥ 10,000 paths.

### Format sensitivity

Points leagues (no H2H): `P(win)` is replaced by rank-in-week or season-points objectives.
Median-score leagues (`uses_median_score` — 03 §B.2) add a second "opponent": the league
median, whose distribution is the median of the other teams' simulated totals.
Multi-week championships: sum distributions across weeks.

### Pitfalls

Reporting `P(win)` without the interval that comes from projection uncertainty (the model's
own error is larger than the sampling error); ignoring covariance when both sides start
players from the same game; treating provisional scores as final; using Yahoo's
`win_probability` as ground truth (it is a cross-check whose method is unknown); forgetting
lineup lock (a live update cannot be acted on for locked slots).

### Output shape

`{P(win), interval, μ_m, σ_m, μ_o, σ_o, cov, method: normal|mc, live: {players_final,
players_live, players_pending}, yahoo_cross_check: {win_probability, team_projected_points},
actionable_slots[]}` plus the common contract.

### Evaluation

Brier score and reliability diagram of pre-week `P(win)` over all matchups in replayed
seasons, against Yahoo's `win_probability` and against a 50 % baseline; the same for live
updates at fixed checkpoints (after Thursday, after the 1 pm window, after Sunday night).
"Working" = Brier below Yahoo's and calibration within ±5 points per decile.

---

## 12. Post-week retrospective and calibration

### What to log (the enabling condition — nothing below works without it)

Every recommendation, at the moment it is made: `log_id`, decision type, the full output
contract (§0), the alternatives considered with their metrics, the inputs' `as_of`
timestamps and freshness, the league `S`/`R`/`N`, and **whether the user followed it**
(readable next week from the roster/transactions). After the week finalises (03 §D.2):
realised points per player, realised H2H result, realised transactions league-wide.

### Method

**12.1 Score probabilities with strictly proper rules** [V Gneiting & Raftery 2007]:
- `P(win)`, `P(active)`, `P(win | bid)`, `P(role holds)`: **Brier score**, with the
  reliability–resolution–uncertainty decomposition and a **reliability diagram** (predicted
  vs realised by decile). Propriety matters: the product must have no incentive to shade
  its own probabilities to look better.
- Full projection distributions: **CRPS** (the integral of Brier over all thresholds);
  quantiles: **pinball loss** at p10/p50/p90; **interval coverage** at 80 %.

**12.2 Score rankings.** Spearman rank correlation of projected vs realised points within
position per week; and the FantasyPros-style "accuracy gap" (expected points of the rank
slot minus realised) for comparability with public expert leaderboards [V FantasyPros
methodology].

**12.3 "Did the call matter?"** For each start/sit and waiver recommendation compute
`regret = realised(best alternative offered) − realised(recommended)` and the binary
"changed the H2H result". Aggregate: mean regret vs the consensus baseline; the share of
calls that were decisive (expect low; report it, do not hide it).

**12.4 Attribution.** Decompose projection error into the layers of §1: opportunity error
(expected vs realised targets/carries), efficiency error, TD error, matchup/weather
multiplier error, availability error. This tells the tuning loop *which* `k`, `β_pos`, `h`
to move, rather than "the projection was off".

**12.5 Feed lessons forward.** Re-fit the tuned parameters on a rolling window each week
(with a floor on window size to avoid overfitting the last week — the very pitfall the
product warns users about); update the per-source news table (§10); update FAAB
price-of-a-point and rival bid distributions (§4); re-estimate the correlation table
(§3.3) yearly; refresh the "does not predict" list (§18) with the product's own numbers.

**12.6 Report to the user.** A weekly retrospective: what was recommended, what happened,
the regret, the calibration state, and one-line "what changed in the model because of it".
Honest phrasing rules: a single week is one draw; the product should refuse to draw
conclusions from `n < ~30` calls of a type.

### Format sensitivity

None; every metric is computed under the league's `S`.

### Pitfalls

Scoring means with MAE only (ignores the distribution); scoring probabilities with accuracy
(not proper); judging a start/sit call by the outcome ("it worked") instead of by its
regret distribution; re-tuning on last week; scoring recommendations the user did not
follow as if they had; comparing against no baseline.

### Output shape

`{week, calls: [{log_id, type, followed, regret, decisive}], metrics: {brier by probability
type, crps, pinball, coverage, spearman by position, accuracy_gap}, attribution, parameter
changes[], sample-size caveats}`.

### Evaluation (of the evaluator)

The retrospective must reproduce known quantities on synthetic data: a perfectly calibrated
synthetic forecaster scores Brier = uncertainty term, a random one scores worse; CRPS of the
true distribution beats any misspecified one. These are unit tests for the metric code.

---

## 13. Draft assistance (lower priority)

### Inputs

`S`, `R`, `N`, `draft_type`, keeper/auction flags (`is_auction_draft` — 03 §B.2), preseason
§1 season projections with distributions (per-game × expected games, with injury priors),
ADP for the platform (Yahoo `draft_analysis {average_pick, average_round, percent_drafted,
average_cost}` — 03 §B.4), the live draft state (`draftresults` read-only — picks made,
rosters so far).

### Method

**13.1 VBD tiers under this league's baselines.** §2's starter baseline with flex
allocation and the bench effect, computed for `S`/`R`/`N`; `xVBD` (Stuart) rather than
plain VBD so upside is priced [V Footballguys]; tiers by Gaussian mixture on the projected
values (Chen's method applied to projections rather than expert ranks [V borischen.co]).

**13.2 ADP vs value.** For each player: `value − expected value at that ADP slot`, where the
expected value curve by ADP and position is fit on history (log fits, as Stuart did on
2000–2012 [V]: RB steepest decline, WR gentler, K/DEF flat). A positive gap is a target; the
size of the gap versus the pick's alternatives is the pick recommendation. Report
`P(available at my next pick)` from ADP spread (assume a normal around ADP with the
platform's observed SD).

**13.3 Positional runs.** Detect from the live draft (`draftresults`): if the last `k` picks
concentrated in one position and the next tier boundary at that position is within the
picks before my turn, the value of taking the position now rises by the drop across the
tier boundary — a computed number, not "a run is happening".

**13.4 Roster-construction targets for the format.** Derived, not asserted: from §2's
streamability, K and DEF go in the last two rounds (the top-drafted kicker averaged < 5 VBD
[V Stuart]); in 12-team 1-QB the QB baseline is high enough that late-round QB is the
documented default [S Zachariason; S PFF] unless a QB's `xVBD` clears the flex-eligible
alternatives; in superflex, QBs are the scarce asset and two starters are mandatory; TE
premium pulls elite TEs forward. Strategy labels the community uses — **Zero RB**
[V Siegele 2013: invest early picks in WRs, embrace RB fragility], **Hero RB**, **late-round
QB** — are *patterns* that fall out of the value curves in some formats and not others; the
product should show the curve and name the pattern it implies, never impose the label.
Weekly-variance evidence for construction [V Underdog]: QB is the least volatile position
(CV 0.36–0.39), TE the most (0.63–0.70); a roster of high-CV starters needs more bench
cover.

**13.5 Auction.** Value in dollars = `xVBD share of the total surplus × total budget`,
re-priced live as money leaves the room (remaining budget ÷ remaining surplus).

### Format sensitivity

The whole section is driven by §2's format table; 10-team compresses tiers; superflex makes
QBs round-1 picks; TE premium creates a TE tier gap; 6-pt pass TD raises QB values but not
enough to change the 1-QB conclusion unless `xVBD` says so.

### Pitfalls

Consensus rankings in a non-consensus format; VBD with a static baseline; ignoring
`P(available)`; drafting K/DEF early; treating strategy labels as rules; season totals
without injury/games-played priors; ADP from a different platform or scoring.

### Output shape

At each pick: `{best_available_by_xVBD[], tiers, ADP_gaps[], P(available at next pick),
run_alert: {position, Δ across tier}, roster_targets_so_far vs plan}` plus the common
contract.

### Evaluation

Replay historical drafts: realised season value of "xVBD-best-available" picks vs ADP-order
picks at the same slots; tier-boundary accuracy (do realised values cluster as predicted?);
`P(available)` calibration. "Working" = higher realised VBD than ADP order across ≥ 2
seasons under the league's `S`.

---

## 14. Decision types the brief did not list (added)

Each is small, but each has produced a bad recommendation in prior-art tools when missing:

1. **IR-slot management and roster-limit compliance.** Which designations are IR-eligible
   is a Yahoo rule (03 §D; help SLN28136); a player activated from IR forces a drop; a
   roster over the limit blocks lineup edits. Every stash/pickup recommendation must state
   the IR consequence and the drop it forces.
2. **Deadline and lock awareness.** `weekly_deadline`, `edit_key`, and per-game locks (03
   §B.2, §D.2) bound what is actionable; a recommendation that cannot be executed before
   lock is not a recommendation. Every action carries its latest execution time.
3. **Acquisition-limit budgeting.** If the league caps adds (`max_adds` / `max_weekly_adds`
   are unverified fields — 03 §B.2), treat each add like a FAAB dollar with its own λ.
4. **The no-op baseline.** Every move is compared against doing nothing, with the
   transaction's irreversibility priced (a drop is gone; a claim spends priority/FAAB).
   A recommendation whose `Δ` interval includes 0 is reported as "no move".
5. **Tiebreaker awareness.** Points-for is a common tiebreaker, so once seeding is at
   stake, maximising expected points can matter even when `P(win)` is saturated; the §3.2
   objective should switch to a blend the user can see.
6. **Trade-ratification risk.** `trade_ratify_type = vote` (03 §B.2) means a lopsided-looking
   but roster-fair trade may be vetoed; surface it as a risk, not a value term.

---

## 15. Scoring-engine spec (data-driven from Yahoo's stat-id model, 03 §B.5)

### Inputs

From `league/{key}/settings`: `stat_categories.stats[] {stat_id, name, position_type,
stat_position_types[{position_type, is_only_display_stat}], bonuses[{target, points}]?}`,
`stat_modifiers.stats[] {stat_id, value}`, `uses_fractional_points`, `uses_negative_points`.
From stat lines: `player_stats.stats[{stat_id, value}]` per player per week (03 §B.4), and —
for verification only — `player_points.total` in league context.

### Core rule

```
points(player, week) = Σ_{m ∈ stat_modifiers}  m.value × stat(player, week, m.stat_id)
                     + Σ_{c ∈ stat_categories, b ∈ c.bonuses}  b.points × [stat(c.stat_id) ≥ b.target]
```
- A category present in `stat_categories` but absent from `stat_modifiers` (the
  `is_only_display_stat = 1` ones: 8 Rush Att, 78 Targets, 31 Pts Allow in the sample)
  contributes **0**.
- A stat id in the stat line but not in the settings is **ignored** (but logged once, so a
  new category is noticed).
- A category in the settings but **absent from the stat line** is **0**, with the caveat
  that during a provisional week (03 §D.2) "absent" may mean "not yet reported"; the engine
  returns `{points, complete: bool}` and the product labels incomplete weeks.
- Stats count only for the position types the category lists in `stat_position_types`: a
  DEF touchdown is stat 35 (DT), not 13 (O); a player's slot (RB in flex) never changes his
  scoring.

### Families that need more than multiplication

| Family | Yahoo representation (03 §B.5) | Engine handling |
|---|---|---|
| Kicker distance tiers | ids 19–23 (0–19, 20–29, 30–39, 40–49, 50+), PAT 29; missed-FG / missed-PAT ids exist in the universe [U ids] | plain modifiers; for projection the distance mix is a distribution over the five ids (§8.1) |
| DST points-allowed brackets | ids 50–56, mutually exclusive indicators (0 / 1–6 / 7–13 / 14–20 / 21–27 / 28–34 / 35+); 31 is display-only | represent any family of mutually exclusive bracket stats as a **bracket table** `{lower, upper, stat_id}` derived from names; exactly one indicator is 1 per game; for projection `E = Σ P(points in bracket) × modifier` |
| DST yards-allowed brackets | analogous ids [U] | same bracket-table mechanism, keyed by the stat name pattern; never hard-code ids |
| Yardage bonuses | `bonuses[{target, points}]` on a stat (wire form unverified [U]) and/or extra stat ids | threshold indicator per bonus entry; multiple entries on one stat sum; for projection `E[bonus] = P(stat ≥ target) × points` — **requires the simulated distribution** (§1 step 9), because `E[max]` ≠ `max(E)` |
| Fumbles | 18 Fumbles Lost (−2 in sample); a total-fumbles id exists in the universe [U] | plain modifier; never assume which one a league uses |
| 2-pt conversions | 16 (O) | plain modifier |
| Return yards / return TDs | 15 Ret TD (O), 49 Ret TD (DT), return-yards ids [U] | plain modifiers; offensive players' return stats count under `O` ids, DST's under `DT` |
| Offensive fumble-return TD, XPR | 57, 82 | plain modifiers |
| Negative totals | `uses_negative_points` | if 0, floor the **player-week total** at 0 — this floor level is an assumption [U] to verify against `player_points.total` before shipping |
| Fractional | `uses_fractional_points` | compute exact; if 0, apply Yahoo's rounding **only once its rule is verified** against `player_points.total` [U]; never guess a rounding mode |

### Projection scoring

The same engine runs over (a) the expected stat line for the mean (`E[points]` is linear in
the stats except for bonuses and brackets, which use the distribution), and (b) each
simulated stat line for the distribution. Store a projection once as a **stat-line
expectation + simulated stat lines**, and score it per league on demand — this is what makes
one projection serve every league a user is in.

### Verification (the reference implementation is one call away)

- **Golden test per league per week**: recompute every rostered player's points and assert
  equality with `player_points.total` within 0.01. Any mismatch is a missing id, a
  bracket/bonus misread, or a flag semantic — and is a bug to fix, not tolerance to widen.
- **Mutation tests**: perturb one modifier and assert the total moves by exactly
  `Δvalue × stat`; remove a bracket row and assert the DST total changes only for games in
  that bracket.
- **Adversarial fixtures**: empty stat line; stat line with unknown ids; a K with a 0-yard
  category; a DST with 0 points allowed (bracket 50 = 10 points); a player with negative
  total in a `uses_negative_points = 0` league; a multi-target bonus; provisional week.

---

## 16. Data-needs list, ordered by analytic value per unit of ingestion complexity

Kinds only; `04-data-sources.md` maps kinds to sources. Complexity is ingestion + identity
crosswalk + freshness burden; value is recommendation lift across the sections that consume
it.

| # | Kind | Unlocks | Complexity | Value / complexity |
|---|---|---|---|---|
| 1 | **League settings, rosters, FA pool, matchups, transactions, standings** (Yahoo) | §2 baselines, §3 assignment, §4 competition + FAAB history, §5 partner rosters, §11 cross-check, §12 logging | low (one API, already specified in 03) | very high — nothing works without it |
| 2 | **Weekly player stat lines with stat ids** (Yahoo, league context) | §15 engine truth, §12 retrospective, trailing-window inputs | low | very high |
| 3 | **Game totals and spreads → implied team totals** | §1 step 1 anchor, §8 (dominant K/DEF driver), §7 | low (one small table per week) | very high — the single largest lift per effort |
| 4 | **Injury designations + practice participation by day** | `P(active)` (§1 step 8, §3.5, §10) | medium (daily cadence, name matching) | high |
| 5 | **NFL schedule, kickoff times, roof/dome, byes** | lock logic (§3.4), §7, §8 | low (Yahoo has byes; schedule is static) | high |
| 6 | **Per-game usage: snaps, targets, carries, red-zone/goal-line touches** | §1 opportunity, §4 detection, §6 | medium (needs an id crosswalk; weekly) | high |
| 7 | **Route participation, air yards / aDOT, TPRR** | WOPR-style detection, better WR/TE projection | medium-high (charting-derived) | medium-high |
| 8 | **Depth charts** | §6 beneficiaries, §9 handcuffs | medium (noisy, team-specific formats) | medium |
| 9 | **Weather (wind, precipitation, temperature)** | §1 step 7, §8 make rates | low | low-medium (small, evidenced effects; wind only really matters) |
| 10 | **Play-by-play** (historical + current) | expected-TD / expected-points models (§1 step 5), aFPA-style opponent adjustments, redistribution priors (§6), every backtest in §12 | high (volume, modelling) | high — the step change from "scaled averages" to a real projection, and the only way to evaluate honestly |
| 11 | **Team defence metrics** (pressure rate, EPA allowed, sack rate) | §1 step 6, §8.2 | medium (derivable from #10) | medium |
| 12 | **External projections / consensus ranks** | baseline and blend for §1; evaluation comparator | low for one source | medium (format-specific; use as a baseline, not as the product) |
| 13 | **News / beat-report text** | §10 | high to do well (source calibration, extraction) | medium |
| 14 | **Historical seasons of #2–#11** | tuning `h`, `k`, `β`, correlations; all backtests | medium-high (storage, crosswalk drift) | high for trust, zero for day-one features |
| 15 | **Player props** (if permissible) | direct usage/efficiency priors | medium; ToS-sensitive | medium-high, but conditional on 04's verdict |

**Honest MVP cut:** #1–#5 give a working start/sit (with Yahoo's lineup, a simple projection
from trailing stat lines scaled by implied totals, `P(active)`), K/DEF streaming, and H2H
win probability with logging. #6 adds usage-based waivers. #10 turns projections from
scaled averages into a model and makes §12 possible. #13 last.

---

## 17. What usually goes wrong (the pitfalls, consolidated)

1. **Over-fitting to last week** — one game is one draw from a distribution with CV ≈ 0.6
   [V Underdog]; use windows and change-point rules (§1 step 2).
2. **DvP without regression** — YoY 0.15–0.27 [V 4for4]; shrink toward 1 and ramp in with
   weeks played (§1 step 6).
3. **Trusting the point estimate** — the decision metric is `P(win)`, VOR, or regret, all
   of which need the distribution (§3, §12).
4. **Ignoring roster context** — value is the change in *my* lineup points (§2, §4, §5).
5. **Double counting** — the market already prices injuries, weather and matchups; add them
   once (§1 steps 1, 6, 7; §6).
6. **Player TD rate as an input** — R² 0.008 [V Sharp]; use location-based expected TDs.
7. **Efficiency as skill** — YPC, yards/target, catch rate are mostly noise [V Sumer, Sharp].
8. **Static baselines and trade charts** — format-blind, roster-blind, 2-for-1-blind (§2, §5).
9. **Season totals as ROS** — byes and missed games distort; per-game × `P(active)`.
10. **Treating the Questionable tag as 50/50** — 71 % play [V Footballguys]; use the trend.
11. **Stacking as a favourite / for season points** — stacks move variance, not totals
    [V RotoWire].
12. **Thursday sits without option value** — §3.4.
13. **Bidding season rank, not weeks of usable value; ignoring λ** — §4.
14. **Using `percent_owned.delta` as a buy signal** — it is the competition signal.
15. **Assuming 1:1 injury inheritance** — role affinity and reduced team volume (§6).
16. **Planning K/DEF or "playoff schedule" weeks ahead** — implied totals and matchups
    do not persist that far (§7, §8).
17. **Scoring the product by outcomes** — regret and proper scoring rules only (§12).
18. **Hard-coding stat ids, brackets, or rounding** — read them; verify against
    `player_points.total` (§15).
19. **Acting on news text as if it were an instruction** — §10; the program ground rule.
20. **Recommending something that cannot be executed before lock** — §14.

---

## 18. Clean negatives — what the evidence says does *not* predict (by name)

| Signal | Verdict | Reference |
|---|---|---|
| Preseason / early-season strength of schedule (fantasy points allowed by position) | near noise: YoY r QB 0.27, RB 0.22, WR ≈ 0.15, TE 0.16; top-5 repeat 20–30 % | [V 4for4 / Eakins 2026] |
| A player's own touchdown rate | noise: TD/target YoY R² 0.008 | [V Sharp Football] |
| Yards per carry / RB per-rush efficiency | noise: RB EPA/rush stability "virtually negligible"; YPC "almost entirely noise" | [V Sumer Sports; S FTN] |
| Yards per target, catch rate, YAC per reception | noise: R² 0.03 / 0.11 / 0.14 | [V Sharp Football] |
| Weather for running backs; temperature alone for anyone | no documented RB change from wind; cold slightly *helps* RB YPC; temperature alone small | [V PFF / Spratt 2018] |
| Kicker misses and "bad in the red zone" kicking | little or no forward predictive value | [V Subvertadown] |
| DST return / defensive touchdowns, fumble recoveries | not predictable week to week; model as a constant | [S community DST models; F] |
| The Questionable tag as a coin flip | wrong prior: 71 % play (2017–2023) | [V Footballguys Injury Index] |
| QB–WR1 correlation of "0.6+" | measured +0.31 (2022–2025); same-team WR–WR −0.02 | [V RotoWire] |
| Stacking to raise season-long points | totals unchanged; only variance moves | [V RotoWire] |
| Kicker and DEF draft position | flat value-by-ADP curves; top K < 5 VBD | [V Footballguys / Stuart] |
| PROE as a strong stabiliser of pass volume | claimed "a bit more stable", no numbers published | [V ETR — claim without evidence] |
| Handcuffing as a rule (either way) | no rigorous study found; compute it per case | [S; F] |
| `percent_owned.delta` as a leading indicator | lagging by construction | [F, from 03 §B.4 semantics] |
| Last week's points as a projection | one draw; CV 0.36 (QB) to 0.70 (TE) | [V Underdog] |

Not negatives but **unevidenced and flagged as such**: game stacks / "bring-back" in
season-long H2H [F]; coaching-intent quotes ("will get more work") [F]; the "15-point snap
jump held two games" threshold [F]; post-return role residuals for backups [F].

---

## 19. The three methodological choices that most shape the architecture

1. **Projections are distributions produced by simulation over stat lines, stored
   format-agnostically, and scored per league by the settings-driven engine.** Every
   downstream decision (win probability, xVBD, bonus thresholds, DST brackets, FAAB value)
   needs quantiles, not means; and one projection must serve many leagues. This forces a
   stat-line-level projection store and a pure scoring engine (§1 step 9, §15).
2. **Opportunity is modelled and efficiency is shrunk; the market is the scale anchor.**
   Usage data (#6–#7) plus implied totals (#3) are the inputs that matter; efficiency and
   DvP enter only through regressed multipliers; play-by-play (#10) is what makes the
   TD/expected-points layer real. This decides the ingestion order (§16) and where the
   tuning parameters (`h`, `k`, `β`, `w`) live.
3. **The objective is decision-specific and evaluated by regret and proper scoring rules,
   which requires logging every recommendation with its alternatives at decision time.**
   `P(win)` for start/sit, weeks-of-usable-value for waivers, roster-contextual `Δ` for
   trades, Brier/CRPS/regret for the product itself. This makes a recommendation log with
   `log_id`, alternatives and `as_of` timestamps a first-class store, not an afterthought
   (§0 contract, §12).
