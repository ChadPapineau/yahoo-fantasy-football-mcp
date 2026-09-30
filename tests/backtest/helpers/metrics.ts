// metrics.ts — the plan 10 A7/A8 backtest replays over the fixture league and fixture weeks 1–3,
// shared by tests/backtest/{lineup,kdef}.test.ts and the generated sections of
// docs/evals/1a-backtest.md (the tests fail when the doc's numbers drift from a fresh replay;
// `UPDATE_EVALS=1` rewrites the generated sections).
import { readFileSync, writeFileSync } from "node:fs";
import {
  analyzeKdef,
  analyzeLineup,
  bestLineup,
  type KdefOutcome,
  type LineupPlayer,
  type LineupRecommendation,
  projectPlayers,
  spearman,
} from "../../../src/domain/analytics/index.js";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import type { TeamRef, Week } from "../../../src/domain/league/types.js";
import type { ScoringSettings } from "../../../src/domain/scoring/types.js";
import { type FixtureData, REPO } from "./fixture.js";
import {
  beforeWeek,
  type FixtureLeague,
  kdefUniverse,
  lineupPlayersFor,
  realised,
  subjectOf,
  TEAM_A,
  TEAM_B,
  targetsFor,
} from "./league.js";
import { fixtureReaders } from "./fixture.js";

export const SEED = 20260930;
export const WEEKS: readonly Week[] = [1, 2, 3];
export const EVALS_DOC = `${REPO}docs/evals/1a-backtest.md`;

const r1 = (x: number): number => Math.round(x * 10) / 10;
const r3 = (x: number | null): number | null => (x === null ? null : Math.round(x * 1000) / 1000);

/** One team-week of the lineup replay. */
export interface LineupRow {
  readonly team: string;
  readonly week: Week;
  /** Realised points of the hindsight-best legal lineup. */
  readonly best: number;
  readonly mean: number;
  readonly mean_regret: number;
  readonly pwin: number;
  readonly pwin_regret: number;
  /** "Start by last week's points"; null in week 1 (no 2026 week 0; the prior season is not in the fixtures). */
  readonly last_week: number | null;
  readonly last_week_regret: number | null;
  readonly mode: string;
  readonly mode_consistent: boolean;
}

export interface LineupReplay {
  readonly rows: readonly LineupRow[];
  readonly recs: readonly LineupRecommendation[];
  /** Every Dist-bearing object produced along the way (E1 projections, E2 recs). */
  readonly outputs: readonly unknown[];
}

const TEAMS: readonly [string, TeamRef, TeamRef][] = [
  ["Team A", TEAM_A, TEAM_B],
  ["Team B", TEAM_B, TEAM_A],
];

function starterPoints(rec: LineupRecommendation, truth: ReadonlyMap<string, number>): number {
  return rec.recommended_lineup
    .filter((s) => s.slot !== "BN" && s.slot !== "IR")
    .reduce((s, x) => s + (truth.get(x.player_key) ?? 0), 0);
}

/** A7: replays both fixture rosters over weeks 1–3 with mean and pwin objectives. */
export async function replayLineups(data: FixtureData, lg: FixtureLeague): Promise<LineupReplay> {
  const rows: LineupRow[] = [];
  const recs: LineupRecommendation[] = [];
  const outputs: unknown[] = [];
  for (const week of WEEKS) {
    const nowMs = beforeWeek(data, week);
    const clock = fixedClock(nowMs);
    const rosters = new Map<string, Awaited<ReturnType<typeof lg.provider.getRoster>>["value"]>();
    for (const [, me] of TEAMS)
      rosters.set(me.team_key, (await lg.provider.getRoster(me, week)).value);
    const players = new Map<string, LineupPlayer[]>();
    for (const [key, roster] of rosters) {
      const out = projectPlayers({
        targets: targetsFor(roster.entries),
        season: 2026,
        weeks: [week],
        settings: lg.settings,
        readers: fixtureReaders(data),
        clock,
        rng: seededRng(SEED),
        n_sims: 4000,
      });
      outputs.push(out.result);
      players.set(key, lineupPlayersFor(roster.entries, out, week));
    }
    for (const [label, me, opp] of TEAMS) {
      const mine = players.get(me.team_key) ?? [];
      const theirs = players.get(opp.team_key) ?? [];
      const entries = rosters.get(me.team_key)?.entries ?? [];
      const truth = new Map<string, number>();
      const last = new Map<string, number>();
      for (const e of entries) {
        const subj = subjectOf(e);
        truth.set(e.player.ref.id, realised(data, lg.settings, subj, week));
        if (week > 1) last.set(e.player.ref.id, realised(data, lg.settings, subj, week - 1));
      }
      const withMeans = (m: ReadonlyMap<string, number>): LineupPlayer[] =>
        mine.map((p) => ({ ...p, points: { ...p.points, mean: m.get(p.player_key) ?? 0 } }));
      const sum = (ps: readonly LineupPlayer[]): number =>
        ps.reduce((s, p) => s + (truth.get(p.player_key) ?? 0), 0);
      const best = sum(bestLineup(lg.slots, withMeans(truth), nowMs));
      const base = { slots: lg.slots, players: mine, opponent: theirs, clock };
      const mean = analyzeLineup({ ...base, objective: "mean" });
      const pwin = analyzeLineup({ ...base, objective: "pwin" });
      recs.push(mean, pwin);
      outputs.push(mean, pwin);
      const lw = week > 1 ? sum(bestLineup(lg.slots, withMeans(last), nowMs)) : null;
      const d = pwin.mode_basis.mu_m - pwin.mode_basis.mu_o;
      const consistent = pwin.mode === "protect" ? d > 0 : pwin.mode === "chase" ? d < 0 : true;
      rows.push({
        team: label,
        week,
        best: r1(best),
        mean: r1(starterPoints(mean, truth)),
        mean_regret: r1(best - starterPoints(mean, truth)),
        pwin: r1(starterPoints(pwin, truth)),
        pwin_regret: r1(best - starterPoints(pwin, truth)),
        last_week: lw === null ? null : r1(lw),
        last_week_regret: lw === null ? null : r1(best - lw),
        mode: pwin.mode,
        mode_consistent: consistent,
      });
    }
  }
  return { rows, recs, outputs };
}

/** One position-week of the K/DEF replay. */
export interface KdefRow {
  readonly position: "K" | "DEF";
  readonly week: Week;
  /** Subjects with a realised line that week (the rank-correlation sample). */
  readonly n: number;
  readonly candidates: number;
  readonly implied_total_populated: boolean;
  readonly rho_model: number | null;
  readonly rho_last_week: number | null;
  /** DEF: minus the opponent's implied total; K: the own team's implied total. */
  readonly rho_implied: number | null;
}

export interface KdefReplay {
  readonly rows: readonly KdefRow[];
  readonly outcomes: readonly KdefOutcome[];
}

/** A8: E5 on the full universe per week, plus rank correlations of the model vs both baselines. */
export function replayKdef(data: FixtureData, settings: ScoringSettings): KdefReplay {
  const universe = kdefUniverse(data);
  const rows: KdefRow[] = [];
  const outcomes: KdefOutcome[] = [];
  for (const week of WEEKS) {
    const clock = fixedClock(beforeWeek(data, week));
    const out = analyzeKdef({
      positions: ["K", "DEF"],
      season: 2026,
      week,
      universe,
      current: [],
      availability_known: false,
      settings,
      readers: fixtureReaders(data),
      clock,
      rng: seededRng(SEED),
    });
    outcomes.push(out);
    // the model's ranking over the WHOLE universe (E5 returns the top of it)
    const all = projectPlayers({
      targets: universe.map((u) => ({
        player_key: u.player_key,
        subject: u.subject,
        name: u.name,
        position: u.position,
        nfl_team: u.nfl_team,
      })),
      season: 2026,
      weeks: [week],
      settings,
      readers: fixtureReaders(data),
      clock,
      rng: seededRng(SEED),
      n_sims: 1000,
    });
    for (const pos of ["K", "DEF"] as const) {
      const model: number[] = [];
      const lastWk: number[] = [];
      const implied: number[] = [];
      const truth: number[] = [];
      universe.forEach((u, i) => {
        if (u.position !== pos) return;
        const played =
          u.subject.kind === "defense"
            ? data.defense.some(
                (d) => d.season === 2026 && d.week === week && d.nfl_team === u.nfl_team,
              )
            : data.lines.some(
                (l) =>
                  l.season === 2026 &&
                  l.week === week &&
                  l.gsis_id === (u.subject.kind === "player" ? u.subject.gsis_id : ""),
              );
        if (!played) return;
        const w = all.players[i]?.weeks[0];
        model.push(w?.dist.mean ?? 0);
        truth.push(realised(data, settings, u.subject, week));
        lastWk.push(week > 1 ? realised(data, settings, u.subject, week - 1) : 0);
        implied.push(pos === "DEF" ? -(w?.opp_implied_total ?? 0) : (w?.implied_total ?? 0));
      });
      const cands = out.analysis.candidates.filter((c) => c.position === pos);
      rows.push({
        position: pos,
        week,
        n: truth.length,
        candidates: cands.length,
        implied_total_populated: cands.every((c) => c.kdef?.implied_total != null),
        rho_model: r3(spearman(model, truth)),
        rho_last_week: week > 1 ? r3(spearman(lastWk, truth)) : null,
        rho_implied: r3(spearman(implied, truth)),
      });
    }
  }
  return { rows, outcomes };
}

// --- the generated doc sections ------------------------------------------------------------------

const fmt = (x: number | null): string => (x === null ? "n/a" : String(x));

export function lineupSection(rows: readonly LineupRow[]): string {
  const lines = [
    "| team | week | best (hindsight) | `mean` realised | `mean` regret | `pwin` realised | `pwin` regret | last-week baseline regret | mode | mode = sign(μ_m − μ_o) |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.team} | ${String(r.week)} | ${String(r.best)} | ${String(r.mean)} | ${String(r.mean_regret)} | ${String(r.pwin)} | ${String(r.pwin_regret)} | ${fmt(r.last_week_regret)} | ${r.mode} | ${r.mode_consistent ? "yes" : "NO"} |`,
    ),
  ];
  const w23 = rows.filter((r) => r.week > 1);
  const sum = (xs: readonly number[]): number => r1(xs.reduce((s, x) => s + x, 0));
  lines.push(
    "",
    `Totals, weeks 2–3 (both teams): \`mean\` regret **${String(sum(w23.map((r) => r.mean_regret)))}**, \`pwin\` regret **${String(sum(w23.map((r) => r.pwin_regret)))}**, last-week baseline regret **${String(sum(w23.map((r) => r.last_week_regret ?? 0)))}**.`,
    `Totals, weeks 1–3: \`mean\` regret **${String(sum(rows.map((r) => r.mean_regret)))}**, \`pwin\` regret **${String(sum(rows.map((r) => r.pwin_regret)))}**.`,
  );
  return lines.join("\n");
}

export function kdefSection(rows: readonly KdefRow[]): string {
  return [
    "| position | week | n (played) | candidates | implied_total populated | ρ model | ρ last week's points | ρ implied total |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.position} | ${String(r.week)} | ${String(r.n)} | ${String(r.candidates)} | ${r.implied_total_populated ? "yes" : "NO"} | ${fmt(r.rho_model)} | ${fmt(r.rho_last_week)} | ${fmt(r.rho_implied)} |`,
    ),
  ].join("\n");
}

const markers = (name: string): [string, string] => [
  `<!-- generated:${name}:begin -->`,
  `<!-- generated:${name}:end -->`,
];

/** The doc's current generated section `name` (between its markers), or null. */
export function docSection(name: string): string | null {
  const doc = readFileSync(EVALS_DOC, "utf8");
  const [b, e] = markers(name);
  const i = doc.indexOf(b);
  const j = doc.indexOf(e);
  if (i < 0 || j < i) return null;
  return doc.slice(i + b.length, j).trim();
}

/** Rewrites section `name` in the doc (UPDATE_EVALS=1 only). */
export function writeDocSection(name: string, body: string): void {
  const doc = readFileSync(EVALS_DOC, "utf8");
  const [b, e] = markers(name);
  const i = doc.indexOf(b);
  const j = doc.indexOf(e);
  if (i < 0 || j < i) throw new Error(`evals doc: markers for ${name} missing`);
  writeFileSync(EVALS_DOC, `${doc.slice(0, i + b.length)}\n${body}\n${doc.slice(j)}`);
}

/** Every `basis` value and every `delta_pwin` value anywhere in a result tree. */
export function walk(v: unknown, visit: (key: string, value: unknown) => void, depth = 0): void {
  if (depth > 40 || typeof v !== "object" || v === null) return;
  if (Array.isArray(v)) {
    for (const x of v) walk(x, visit, depth + 1);
    return;
  }
  for (const [k, x] of Object.entries(v)) {
    visit(k, x);
    walk(x, visit, depth + 1);
  }
}
