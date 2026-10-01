// datasets.ts — the Yahoo-free dataset tools (plan 07 §3.D): D2 ff_get_injuries (official
// designation, practice trend, platform status, first-cut p_active with its basis — game day per
// OBJ-16) and D3 ff_get_schedule (kickoffs in ET and venue time, byes, lines → implied totals, roof,
// weather). Third-party text is wrapped or path-listed; practice rows become fixed codes (plan 02
// §6.4: news/injury text feeds analytics only as extracted structured features).
import { z } from "zod/v4";
import { freshnessClass, stampState } from "../../config/freshness.js";
import { GAME_DAY_WINDOW_MS } from "../../domain/analytics/constants.js";
import { pActive } from "../../domain/analytics/availability.js";
import type { InjuryReport } from "../../domain/analytics/types.js";
import { byeWeeks, kickoffMs, teamGame } from "../../domain/league/schedule.js";
import { isIrEligibleStatus } from "../../domain/league/slots.js";
import { STATUS_CODE_RE, codeOrNull, type Week } from "../../domain/league/types.js";
import { LeagueFileError } from "../../providers/platform.js";
import { NFL_TEAMS } from "../../config/schema.js";
import {
  BOUNDS,
  analyticsFreshnessShape,
  leagueShape,
  nflTeamSchema,
  playerSelectorSchema,
  weekSchema,
} from "../bounds.js";
import { defineTool, type ToolContext } from "../define.js";
import {
  RESULT_BUDGET_CHARS,
  TRUNCATION_HINTS,
  bareUntrusted,
  type BudgetTrim,
  wrapUntrustedOrNull,
  type InputStamp,
  type UntrustedField,
} from "../envelope.js";
import {
  bare,
  inputOf,
  leagueContext,
  optionalDataset,
  requiredSource,
  rosterRows,
  seasonGames,
  seasonOfInstant,
  textSource,
  weekOf,
  type LeagueContext,
} from "./common.js";
import { rosterStatusFor, rosterTargets, selectTargets, type Target } from "./select.js";
import {
  bareName,
  code,
  gsisId,
  iso,
  nflTeam,
  playerKey,
  position,
  statusCode,
  utOrNull,
  week,
} from "./schemas.js";

// --- D2 ff_get_injuries ------------------------------------------------------------------------------------

/** A practice participation line as a fixed code. */
export function practiceCode(status: string): "full" | "limited" | "dnp" | "other" {
  const v = status.toLowerCase();
  if (v.includes("did not") || v === "dnp") return "dnp";
  if (v.includes("limited")) return "limited";
  if (v.includes("full")) return "full";
  return "other";
}

/** A practice day as a fixed code (`mon`…`sun`), or null. */
export function dayCode(day: string): string | null {
  const m = /^(mon|tue|wed|thu|fri|sat|sun)/i.exec(day.trim());
  if (m !== null) return (m[1] ?? "").toLowerCase();
  const ms = Date.parse(day);
  if (!Number.isFinite(ms)) return null;
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(ms).getUTCDay()] ?? null;
}

const LEVEL = { dnp: 0, limited: 1, full: 2 } as const;

/** Practice trend from the first to the last coded day; null with fewer than two coded days. */
export function practiceTrend(r: InjuryReport | null): "improving" | "flat" | "worsening" | null {
  if (r === null) return null;
  const levels = r.practice
    .map((p) => practiceCode(p.status))
    .filter((c): c is "full" | "limited" | "dnp" => c !== "other")
    .map((c) => LEVEL[c]);
  const first = levels[0];
  const last = levels.at(-1);
  if (levels.length < 2 || first === undefined || last === undefined) return null;
  return last > first ? "improving" : last < first ? "worsening" : "flat";
}

/** The status code an official designation corresponds to (for `sources_agree`). */
function designationCode(s: string | null): string | null {
  const v = (s ?? "").trim().toLowerCase();
  if (v === "out") return "O";
  if (v === "doubtful") return "D";
  if (v === "questionable") return "Q";
  return null;
}

const d2Player = z.strictObject({
  gsis_id: gsisId.nullable(),
  player_key: playerKey.nullable(),
  name: bareName,
  position: position.nullable(),
  nfl_team: nflTeam.nullable(),
  official: z
    .strictObject({
      report_status: z.string().max(200).nullable(),
      practice: z.array(z.strictObject({ day: code.nullable(), status: code })).max(10),
      primary_injury: utOrNull,
      secondary_injury: utOrNull,
      report_week: week,
      as_of: iso,
    })
    .nullable(),
  platform: z
    .strictObject({
      source: code,
      status: statusCode.nullable(),
      status_full: utOrNull,
      injury_note: utOrNull,
    })
    .nullable(),
  p_active: z.number().min(0).max(1).nullable(),
  p_active_basis: z.enum(["designation_base_rate", "trend_model", "yahoo_gameday_status", "none"]),
  trend: z.enum(["improving", "flat", "worsening"]).nullable(),
  ir_eligible: z.boolean(),
  sources_agree: z.boolean().nullable(),
  game_day: z.boolean(),
});

const d2Data = z.strictObject({
  week,
  players: z.array(d2Player).max(60),
  base_rates_note: z.string().max(200),
});

/** D3's warning when the schedule's betting lines are past their hard limit (QA-1-004). */
export const LINES_EXPIRED_WARNING =
  "betting lines omitted: older than 24 h (run `ff refresh nflverse:schedules` in a terminal)";

/** The fixed base-rate note (plan 07 D2). */
export const BASE_RATES_NOTE = "Q → played 71 % 2017–2023 (05 §3.5)";

export const getInjuries = defineTool({
  name: "ff_get_injuries",
  family: "external",
  description:
    "Injury designations, practice trend, platform status and p_active with its basis (default: my roster).",
  input: z.strictObject({
    ...leagueShape,
    players: playerSelectorSchema.optional(),
    only_flagged: z.boolean().default(false),
    week: weekSchema.optional(),
    ...analyticsFreshnessShape,
  }),
  data: d2Data,
  budget: "list",
  run: async (args, ctx) => {
    const lc = await leagueContext(ctx, args);
    const inputs: InputStamp[] = [lc.input];
    const warnings: string[] = [];
    const w = weekOf(lc, args.week);
    const season = lc.league.season;
    const targets: Target[] =
      args.players === undefined
        ? await rosterTargets(ctx, lc, undefined, w, inputs, warnings)
        : await selectTargets(ctx, lc, args.players, w, inputs, warnings);
    const gsis = targets.flatMap((t) => (t.subject.kind === "player" ? [t.subject.gsis_id] : []));
    const reports = ctx.services.datasets.injuries.reports(season, w, gsis);
    const rIn = requiredSource(ctx, "nflverse:injuries", reports, lc.allowStale);
    if (rIn !== null) inputs.push(rIn);
    const byGsis = new Map(reports.rows.map((r) => [r.gsis_id, r]));
    const games = seasonGames(ctx, season);
    const gIn = optionalDataset(games, ctx.nowMs, lc.allowStale);
    if (gIn !== null) inputs.push(gIn);
    const weekRows = games.rows.filter((g) => g.week === w);
    // the NFL roster status (RES, INA, CUT …) feeds p_active as the projection does (QA-1-035)
    const rr = rosterRows(ctx, season);
    const rrIn = optionalDataset(rr, ctx.nowMs, lc.allowStale);
    if (rrIn !== null && !inputs.some((i) => i.source === rrIn.source)) inputs.push(rrIn);
    const roster = new Map(rr.rows.map((r) => [r.gsis_id, r]));
    // reports are published team by team (QA-1-021): "not listed" means cleared only once his team's
    // report is out; before that, last week's designation carries — as the projection judges it
    const teamsReported = (rows: readonly InjuryReport[], wk: Week): ReadonlySet<string> =>
      new Set(rows.filter((r) => r.season === season && r.week === wk).map((r) => r.nfl_team));
    const nowTeams =
      reports.stamp === null
        ? new Set<string>()
        : teamsReported(ctx.services.datasets.injuries.reports(season, w, null).rows, w);
    const prior = w - 1;
    const priorReports =
      prior >= 1 ? ctx.services.datasets.injuries.reports(season, prior, gsis) : null;
    const priorTeams =
      prior >= 1 && priorReports !== null && priorReports.stamp !== null
        ? teamsReported(ctx.services.datasets.injuries.reports(season, prior, null).rows, prior)
        : new Set<string>();
    const priorByGsis = new Map(
      (priorReports?.rows ?? [])
        .filter((r) => r.season === season && r.week === prior)
        .map((r) => [r.gsis_id, r]),
    );
    const src = (f: string): string => textSource(lc.ref.platform, f);
    const rows = targets.map((t) => {
      const report = t.subject.kind === "player" ? (byGsis.get(t.subject.gsis_id) ?? null) : null;
      const g = t.nfl_team === null ? null : teamGame(t.nfl_team, weekRows);
      const kick = g === null ? null : kickoffMs(g.kickoff);
      const platformStatus = codeOrNull(t.platform?.status ?? null, STATUS_CODE_RE);
      const rosterStatus =
        t.subject.kind === "player" ? rosterStatusFor(roster.get(t.subject.gsis_id), w) : null;
      const avail = pActive({
        rosterStatus,
        report,
        injuriesLoaded: reports.stamp !== null,
        reportPublished: t.nfl_team !== null && nowTeams.has(t.nfl_team),
        priorPublished: t.nfl_team !== null && priorTeams.has(t.nfl_team),
        priorReport:
          t.subject.kind === "player" ? (priorByGsis.get(t.subject.gsis_id) ?? null) : null,
        platformStatus,
        kickoffMs: kick,
        nowMs: ctx.nowMs,
      });
      const official =
        report === null
          ? null
          : {
              report_status:
                report.report_status === null
                  ? null
                  : bareUntrusted(report.report_status, "dataset_text"),
              practice: report.practice.slice(0, 10).map((p) => ({
                day: dayCode(p.day),
                status: practiceCode(p.status),
              })),
              primary_injury: wrapUntrustedOrNull(
                report.primary_injury,
                "dataset_text",
                "nflverse.injuries.primary_injury",
              ),
              secondary_injury: wrapUntrustedOrNull(
                report.secondary_injury,
                "dataset_text",
                "nflverse.injuries.secondary_injury",
              ),
              report_week: report.week,
              as_of: new Date(Date.parse(report.as_of)).toISOString(),
            };
      const oc = designationCode(report?.report_status ?? null);
      const gameDay = kick !== null && ctx.nowMs >= kick - GAME_DAY_WINDOW_MS;
      return {
        gsis_id: t.subject.kind === "player" ? t.subject.gsis_id : null,
        player_key: t.player_key,
        name: bareUntrusted(t.name, "player_name"),
        position: codeOrNull(t.position, /^[A-Z]{1,4}$/),
        nfl_team: t.nfl_team,
        official,
        platform:
          t.platform === null
            ? null
            : {
                source: lc.ref.platform,
                status: platformStatus,
                status_full: wrapUntrustedOrNull(
                  t.platform.status_full,
                  "status_full",
                  src("player.status_full"),
                ),
                injury_note: wrapUntrustedOrNull(
                  t.platform.injury_note,
                  "injury_note",
                  src("player.injury_note"),
                ),
              },
        p_active: avail.p,
        p_active_basis: avail.basis,
        trend: practiceTrend(report),
        // an NFL reserve-list player (RES) is IR-eligible whatever the report says (QA-1-030)
        ir_eligible:
          isIrEligibleStatus(platformStatus ?? oc) || rosterStatus?.trim().toUpperCase() === "RES",
        sources_agree:
          gameDay || report === null || platformStatus === null ? null : oc === platformStatus,
        game_day: gameDay,
      };
    });
    const players = args.only_flagged
      ? rows.filter((r) => r.official !== null || r.platform?.status != null)
      : rows;
    const sources = [...new Set(targets.map((t) => t.name_source))];
    const bareFields: UntrustedField[] = [
      ...sources.map((s) => bare("data.players[].name", s)),
      bare("data.players[].official.report_status", "nflverse.injuries.report_status"),
    ];
    return {
      data: { week: w, players, base_rates_note: BASE_RATES_NOTE },
      inputs,
      warnings,
      bareFields,
      estimate: true,
      listKey: "players",
    };
  },
});

// --- D3 ff_get_schedule ------------------------------------------------------------------------------------

/** An instant rendered in an IANA zone as ISO-8601 with its offset (`2026-09-13T13:00:00-04:00`). */
export function isoInZone(ms: number, tz: string): string | null {
  try {
    const f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    });
    const parts = Object.fromEntries(f.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
    const off = /^GMT([+-]\d{2}:\d{2})?$/.exec(parts.timeZoneName ?? "");
    if (off === null) return null;
    const offset = off[1] ?? "+00:00";
    return `${parts.year ?? ""}-${parts.month ?? ""}-${parts.day ?? ""}T${parts.hour ?? ""}:${parts.minute ?? ""}:${parts.second ?? ""}${offset}`;
  } catch {
    return null;
  }
}

const TZ_RE = /^[A-Za-z_]{1,32}(?:\/[A-Za-z0-9_+-]{1,32}){1,2}$/;
const codeOf = (v: string | null): string | null => {
  if (v === null) return null;
  const c = v
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return /^[a-z][a-z0-9_]{0,23}$/.test(c) ? c : null;
};

const d3Game = z.strictObject({
  game_id: z.string().regex(/^[A-Za-z0-9_]{1,40}$/),
  week,
  kickoff_et: iso.nullable(),
  kickoff_local: iso.nullable(),
  away: nflTeam,
  home: nflTeam,
  roof: code.nullable(),
  surface: code.nullable(),
  divisional: z.boolean().nullable(),
  rest_days: z.strictObject({ away: z.number().nullable(), home: z.number().nullable() }),
  lines: z
    .strictObject({
      spread_line: z.number().nullable(),
      total_line: z.number().nullable(),
      implied: z.strictObject({ away: z.number().nullable(), home: z.number().nullable() }),
      moneyline: z.strictObject({ away: z.number().nullable(), home: z.number().nullable() }),
      as_of: iso,
      source: z.literal("nflverse:schedules"),
      secondary: z.null(),
    })
    .nullable(),
  weather: z
    .strictObject({
      temp_f: z.number().nullable(),
      wind_mph: z.number().nullable(),
      gust_mph: z.number().nullable(),
      precip_prob: z.number().nullable(),
      as_of: iso,
      source: z.enum(["weather:open_meteo", "weather:nws"]),
    })
    .nullable(),
  is_final: z.boolean(),
  score: z.strictObject({ away: z.number(), home: z.number() }).nullable(),
});

const d3Data = z.strictObject({
  games: z.array(d3Game).max(120),
  byes: z.record(z.string().regex(/^\d{1,2}$/), z.array(nflTeam).max(32)),
});

/** The season a D3 call means: the league's, or — with no league configured — the clock's NFL season. */
async function scheduleSeason(
  ctx: ToolContext,
  args: { readonly league_key?: string | undefined; readonly allow_stale?: boolean | undefined },
): Promise<{ lc: LeagueContext | null; season: number }> {
  try {
    const lc = await leagueContext(ctx, args);
    return { lc, season: lc.league.season };
  } catch (e) {
    if (args.league_key === undefined && e instanceof LeagueFileError && e.kind === "missing")
      return { lc: null, season: seasonOfInstant(ctx.nowMs) };
    throw e;
  }
}

/**
 * D3's budget step (QA-1-006, QA-1-034): over budget, the LAST requested week's games go whole —
 * never part of a week — and the warning names every dropped week. The first week is always kept
 * (a single over-budget week falls back to halving, with the fewer-weeks hint). Byes stay for every
 * requested week.
 */
function scheduleTrim(weeks: readonly Week[]): BudgetTrim {
  return (raw) => {
    const d = raw as { games: readonly { week: number }[] };
    const present = weeks.filter((w) => d.games.some((g) => g.week === w));
    const last = present.at(-1);
    if (last === undefined || present.length < 2) return null;
    const kept = present.slice(0, -1);
    const dropped = weeks.filter((w) => !kept.includes(w));
    return {
      data: { ...d, games: d.games.filter((g) => g.week !== last) },
      warning: `games for week(s) ${dropped.join(", ")} cut to fit the ${String(RESULT_BUDGET_CHARS)}-character budget (byes are kept for every week); request fewer weeks (e.g. weeks [${dropped.slice(0, 2).join(", ")}]) or filter by nfl_team`,
    };
  };
}

export const getSchedule = defineTool({
  name: "ff_get_schedule",
  family: "external",
  description:
    "NFL games for 1-6 weeks (about 2 fit; later weeks are cut whole, with a warning): kickoffs (ET, venue), byes, lines and implied totals (+spread = home favoured), roof, weather.",
  input: z.strictObject({
    ...leagueShape,
    weeks: z
      .array(weekSchema)
      .min(BOUNDS.weeksList.min)
      .max(BOUNDS.weeksList.max)
      .refine((a) => new Set(a).size === a.length, { message: "duplicate_values" })
      .optional(),
    nfl_team: nflTeamSchema.optional(),
    include_weather: z.boolean().default(true),
    include_lines: z.boolean().default(true),
    ...analyticsFreshnessShape,
  }),
  data: d3Data,
  budget: "list",
  hint: TRUNCATION_HINTS.schedule,
  run: async (args, ctx) => {
    const allowStale = args.allow_stale === true;
    const { lc, season } = await scheduleSeason(ctx, args);
    const inputs: InputStamp[] = lc === null ? [] : [lc.input];
    const warnings: string[] = [];
    const weeks: Week[] = [...(args.weeks ?? [lc === null ? 1 : weekOf(lc, undefined)])].sort(
      (a, b) => a - b,
    );
    if (lc === null && args.weeks === undefined)
      warnings.push("no league configured: week 1 of the current NFL season is shown");
    const all = seasonGames(ctx, season);
    const sIn = requiredSource(ctx, "nflverse:schedules", all, allowStale);
    if (sIn !== null) inputs.push(sIn);
    // betting lines past their hard limit (24 h) are not served, as the projections omit them (QA-1-004)
    const linesExpired =
      all.stamp !== null &&
      stampState(freshnessClass("lines"), all.stamp, ctx.nowMs).state === "expired";
    const wanted = new Set(weeks);
    const games = all.rows
      .filter((g) => wanted.has(g.week))
      .filter(
        (g) => args.nfl_team === undefined || g.away === args.nfl_team || g.home === args.nfl_team,
      );
    const wx = new Map<
      string,
      {
        temp_f: number | null;
        wind_mph: number | null;
        gust_mph: number | null;
        precip_prob: number | null;
        as_of: string;
        source: "weather:open_meteo" | "weather:nws";
      }
    >();
    if (args.include_weather && ctx.options.weatherSource !== "off" && games.length > 0) {
      const w = ctx.services.datasets.weather.forGames(games.map((g) => g.game_id));
      const wIn = w.stamp === null ? null : inputOf(w.stamp, ctx.nowMs, allowStale);
      if (wIn !== null) {
        inputs.push(wIn);
        for (const o of w.rows) {
          if (o.source !== "weather:open_meteo" && o.source !== "weather:nws") continue;
          wx.set(o.game_id, {
            temp_f: o.temp_f,
            wind_mph: o.wind_mph,
            gust_mph: o.gust_mph,
            precip_prob: o.precip_prob,
            as_of: new Date(Date.parse(o.as_of)).toISOString(),
            source: o.source,
          });
        }
      }
    }
    const out = games.map((g) => {
      const k = kickoffMs(g.kickoff);
      const tz = g.venue_tz !== null && TZ_RE.test(g.venue_tz) ? g.venue_tz : null;
      return {
        game_id: g.game_id,
        week: g.week,
        kickoff_et: k === null ? null : isoInZone(k, "America/New_York"),
        kickoff_local: k === null || tz === null ? null : isoInZone(k, tz),
        away: g.away,
        home: g.home,
        roof: codeOf(g.roof),
        surface: codeOf(g.surface),
        divisional: g.divisional,
        rest_days: { away: g.rest_days.away, home: g.rest_days.home },
        lines:
          !args.include_lines || g.lines === null || linesExpired
            ? null
            : {
                spread_line: g.lines.spread_line,
                total_line: g.lines.total_line,
                implied: { away: g.lines.implied.away, home: g.lines.implied.home },
                moneyline: { away: g.lines.moneyline.away, home: g.lines.moneyline.home },
                as_of: new Date(Date.parse(g.lines.as_of)).toISOString(),
                source: "nflverse:schedules" as const,
                secondary: null,
              },
        weather: wx.get(g.game_id) ?? null,
        is_final: g.is_final,
        score: g.score === null ? null : { away: g.score.away, home: g.score.home },
      };
    });
    if (args.include_lines && linesExpired && games.some((g) => g.lines !== null))
      warnings.push(LINES_EXPIRED_WARNING);
    const byesAll = byeWeeks(all.rows, season, NFL_TEAMS);
    const byes: Record<string, (typeof NFL_TEAMS)[number][]> = {};
    for (const w of weeks) {
      const teams = NFL_TEAMS.filter((t) => (byesAll.get(t) ?? []).includes(w)).filter(
        (t) => args.nfl_team === undefined || t === args.nfl_team,
      );
      byes[String(w)] = teams;
    }
    return {
      data: { games: out, byes },
      inputs,
      warnings,
      trims: [scheduleTrim(weeks)],
      listKey: "games",
    };
  },
});
