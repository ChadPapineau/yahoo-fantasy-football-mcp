// normalize.ts — a schema-valid league.yaml → the static manual-league model (plan 01 §8 X1: one
// league, my roster, optional other rosters / opponents / FA pool / transactions; plan 10 D5 FAAB
// budget and acquisition limits) plus the cross-field checks zod cannot express (week order, team
// ids, opponents, slot names, duplicate players). Player keys follow `manualPlayerKeyFor` (critic
// C-13); an entry without a gsis id gets a deterministic `manual.p.n-<hash>` key and resolves later
// through the crosswalk's name + team + position match (plan 10 A5a).
import { createHash } from "node:crypto";
import type { NflTeam } from "../../config/schema.js";
import { MANUAL_KEY_RE } from "../../config/schema.js";
import { ruleCapabilities } from "../../domain/league/rules.js";
import type { LockMode } from "../../domain/league/schedule.js";
import {
  BENCH_SLOT,
  buildRosterSlots,
  defineSlot,
  MAX_ROSTER_SIZE,
  slotByName,
} from "../../domain/league/slots.js";
import type { ScoringSettings } from "../../domain/scoring/types.js";
import { manualPlayerKeyFor } from "../../domain/league/types.js";
import {
  type LeagueRef,
  type LeagueRules,
  type PlayerKey,
  type RosterSlot,
  type RosterSlots,
  type TeamRef,
  type Transaction,
  type TransactionPlayer,
  type Week,
  type LeagueFileIssue,
} from "../platform.js";
import type { LeagueFile, RosterEntryInput } from "./schema.js";
import { buildScoringSettings } from "./scoring.js";

/** Default league slug when the file names none. */
export const DEFAULT_LEAGUE_SLUG = "league";
/** Default weeks when the file names none (a 17-week fantasy season). */
export const DEFAULT_START_WEEK = 1;
export const DEFAULT_END_WEEK = 17;

/** One player (or team defence) as the manual league knows it. */
export interface ManualPlayer {
  readonly key: PlayerKey;
  readonly name: string;
  readonly nfl_team: NflTeam;
  /** Display position (`DEF` for a team defence). */
  readonly position: string;
  /** Every position the player may fill (the display position first). */
  readonly positions: readonly string[];
  readonly gsis_id: string | null;
  readonly is_defense: boolean;
  readonly status: string | null;
  readonly jersey: number | null;
  /** The slot the file seats them in (`BN` when omitted). */
  readonly slot: string;
}

/** One fantasy team. */
export interface ManualTeam {
  readonly ref: TeamRef;
  readonly id: number;
  readonly name: string;
  readonly manager: string | null;
  readonly is_mine: boolean;
  /** Null when the file has no roster for the team. */
  readonly players: readonly ManualPlayer[] | null;
}

/** The whole static manual-league model (everything that does not depend on the clock). */
export interface ManualLeagueData {
  readonly ref: LeagueRef;
  readonly slug: string;
  readonly name: string;
  readonly season: number;
  readonly num_teams: number;
  readonly scoring_type: string;
  readonly start_week: Week;
  readonly end_week: Week;
  readonly current_week_override: Week | null;
  readonly lock_mode: LockMode;
  readonly rules: LeagueRules;
  readonly scoring: ScoringSettings;
  readonly slots: RosterSlots;
  readonly my_team: ManualTeam;
  /** Every team in id order (mine included). */
  readonly teams: readonly ManualTeam[];
  /** Week → opponent team key. */
  readonly opponents: ReadonlyMap<Week, string>;
  readonly free_agents: readonly ManualPlayer[];
  readonly waivers: readonly ManualPlayer[];
  /** Newest first. */
  readonly transactions: readonly Transaction[];
  /** Operator-identifying strings to register with the logger (league/team/manager names, keys). */
  readonly identifiers: readonly string[];
}

/** Collapses whitespace and case for a stable name hash (display names are kept raw). */
function normName(s: string): string {
  return s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The key of a roster entry: `manualPlayerKeyFor` for a gsis id or a defence; otherwise
 * `manual.p.n-<16 hex of sha256(name|team|position)>` — stable for the same entry, and inside the
 * MANUAL_KEY_RE.player grammar.
 */
export function entryKey(e: RosterEntryInput): PlayerKey {
  if ("defense" in e) return manualPlayerKeyFor({ kind: "defense", nfl_team: e.defense });
  if (e.gsis_id !== undefined) return manualPlayerKeyFor({ kind: "player", gsis_id: e.gsis_id });
  const h = createHash("sha256")
    .update(`${normName(e.name)}|${e.team}|${e.position}`)
    .digest("hex")
    .slice(0, 16);
  return `manual.p.n-${h}`;
}

/** Converts a roster entry. `slot` defaults to BN. */
export function toManualPlayer(e: RosterEntryInput): ManualPlayer {
  if ("defense" in e) {
    const team = e.defense;
    return Object.freeze({
      key: entryKey(e),
      name: team,
      nfl_team: team,
      position: "DEF",
      positions: Object.freeze(["DEF"]),
      gsis_id: null,
      is_defense: true,
      status: null,
      jersey: null,
      slot: e.slot ?? BENCH_SLOT,
    });
  }
  return Object.freeze({
    key: entryKey(e),
    name: e.name,
    nfl_team: e.team,
    position: e.position,
    positions: Object.freeze([...new Set([e.position, ...(e.eligible ?? [])])]),
    gsis_id: e.gsis_id ?? null,
    is_defense: false,
    status: e.status ?? null,
    jersey: e.jersey ?? null,
    slot: e.slot ?? BENCH_SLOT,
  });
}

/** Result of normalisation: the model, or the cross-field issues. */
export type NormalizeResult =
  | { readonly ok: true; readonly data: ManualLeagueData }
  | { readonly ok: false; readonly issues: readonly LeagueFileIssue[] };

/** Normalises a schema-valid file. Never throws for any schema-valid input. */
export function normalizeLeague(f: LeagueFile): NormalizeResult {
  const issues: LeagueFileIssue[] = [];
  const issue = (path: string, reason: string): void => {
    issues.push({ path, reason });
  };

  // --- league ---
  const slug = f.league.key ?? DEFAULT_LEAGUE_SLUG;
  const league_key = `manual.l.${slug}`;
  if (!MANUAL_KEY_RE.league.test(league_key)) issue("league.key", "not a valid league slug");
  const start = f.league.start_week ?? DEFAULT_START_WEEK;
  const end = f.league.end_week ?? DEFAULT_END_WEEK;
  if (end < start) issue("league.end_week", "must not be before start_week");
  const cw = f.league.current_week ?? null;
  if (cw !== null && (cw < start || cw > end))
    issue("league.current_week", "must be within start_week..end_week");
  const po = f.league.playoffs;
  if (po !== undefined) {
    if (po.start_week < start || po.start_week > end)
      issue("league.playoffs.start_week", "must be within start_week..end_week");
    if (po.num_teams > f.league.num_teams)
      issue("league.playoffs.num_teams", "must not exceed league.num_teams");
  }

  // --- slots ---
  const defs: RosterSlot[] = [];
  const names = new Set<string>();
  f.roster_slots.forEach((s, i) => {
    const r = defineSlot(s);
    if (typeof r === "string") issue(`roster_slots[${String(i)}]`, `invalid slot (${r})`);
    else if (names.has(r.name)) issue(`roster_slots[${String(i)}].name`, "duplicate slot name");
    else {
      names.add(r.name);
      defs.push(r);
    }
  });
  const slots = buildRosterSlots(defs);
  if (slots.total > MAX_ROSTER_SIZE)
    issue("roster_slots", `more than ${String(MAX_ROSTER_SIZE)} roster spots`);
  if (slots.starters === 0 && defs.length === f.roster_slots.length)
    issue("roster_slots", "no starting slot");

  // --- teams ---
  const myId = f.my_team.id ?? 1;
  const teamRef = (id: number): TeamRef =>
    Object.freeze({ platform: "manual", league_key, team_key: `${league_key}.t.${String(id)}` });
  const ids = new Set<number>([myId]);
  const allKeys = new Map<PlayerKey, string>();
  const players = (
    list: readonly RosterEntryInput[] | undefined,
    path: string,
    seatCheck: boolean,
  ): ManualPlayer[] | null => {
    if (list === undefined) return null;
    const out: ManualPlayer[] = [];
    const local = new Set<PlayerKey>();
    list.forEach((e, i) => {
      const p = toManualPlayer(e);
      const at = `${path}[${String(i)}]`;
      if (local.has(p.key)) issue(at, "player listed twice on this team");
      else if (seatCheck && allKeys.has(p.key)) issue(at, "player is on more than one team");
      local.add(p.key);
      if (seatCheck) allKeys.set(p.key, path);
      if (slotByName(slots, p.slot) === null) issue(`${at}.slot`, "slot is not in roster_slots");
      out.push(p);
    });
    return out;
  };
  if (myId > f.league.num_teams) issue("my_team.id", "must not exceed league.num_teams");
  const mine: ManualTeam = Object.freeze({
    ref: teamRef(myId),
    id: myId,
    name: f.my_team.name,
    manager: f.my_team.manager ?? null,
    is_mine: true,
    players: Object.freeze(players(f.my_team.players, "my_team.players", true) ?? []),
  });
  const teams: ManualTeam[] = [mine];
  (f.other_teams ?? []).forEach((t, i) => {
    const at = `other_teams[${String(i)}]`;
    if (ids.has(t.id)) issue(`${at}.id`, "duplicate team id");
    if (t.id > f.league.num_teams) issue(`${at}.id`, "must not exceed league.num_teams");
    ids.add(t.id);
    const ps = players(t.players, `${at}.players`, true);
    teams.push(
      Object.freeze({
        ref: teamRef(t.id),
        id: t.id,
        name: t.name,
        manager: t.manager ?? null,
        is_mine: false,
        players: ps === null ? null : Object.freeze(ps),
      }),
    );
  });
  teams.sort((a, b) => a.id - b.id);

  // --- opponents ---
  const opponents = new Map<Week, string>();
  (f.opponents ?? []).forEach((o, i) => {
    const at = `opponents[${String(i)}]`;
    if (opponents.has(o.week)) issue(`${at}.week`, "week listed twice");
    else if (o.week < start || o.week > end)
      issue(`${at}.week`, "must be within start_week..end_week");
    if (o.team === myId || !ids.has(o.team))
      issue(`${at}.team`, "must be the id of an other_teams entry");
    else opponents.set(o.week, teamRef(o.team).team_key);
  });

  // --- pools ---
  const pool = (list: readonly RosterEntryInput[] | undefined, path: string): ManualPlayer[] => {
    const out: ManualPlayer[] = [];
    (list ?? []).forEach((e, i) => {
      const p = toManualPlayer(e);
      if (allKeys.has(p.key)) issue(`${path}[${String(i)}]`, "player is also on a roster");
      else {
        allKeys.set(p.key, path);
        out.push(p);
      }
    });
    return out;
  };
  const free_agents = pool(f.free_agents, "free_agents");
  const waivers = pool(f.waivers, "waivers");

  // --- transactions ---
  const txns: Transaction[] = [];
  (f.transactions ?? []).forEach((t, i) => {
    const at = `transactions[${String(i)}]`;
    if (!ids.has(t.team)) issue(`${at}.team`, "not a team id in this file");
    if (t.tradee_team !== undefined && !ids.has(t.tradee_team))
      issue(`${at}.tradee_team`, "not a team id in this file");
    if (t.type === "trade" && t.tradee_team === undefined)
      issue(`${at}.tradee_team`, "a trade needs tradee_team");
    const team = teamRef(t.team).team_key;
    const tradee = t.tradee_team === undefined ? null : teamRef(t.tradee_team).team_key;
    const tps: TransactionPlayer[] = t.players.map((tp) => {
      const p = toManualPlayer(tp.player);
      const isAdd = tp.action === "add";
      const isTrade = tp.action === "trade";
      return Object.freeze({
        player: Object.freeze({ platform: "manual" as const, id: p.key }),
        name: p.name,
        position: p.position,
        team_abbr: p.nfl_team,
        action: tp.action,
        source_type: isAdd ? (t.type === "waiver" ? "waivers" : "freeagents") : "team",
        source_team_key: isAdd ? null : team,
        destination_type: isAdd || isTrade ? "team" : "waivers",
        destination_team_key: isAdd ? team : isTrade ? tradee : null,
      });
    });
    txns.push(
      Object.freeze({
        transaction_key: `${league_key}.tr.${String(i + 1)}`,
        type: t.type,
        status: "successful",
        timestamp: new Date(Date.parse(t.timestamp)).toISOString(),
        faab_bid: t.faab_bid ?? null,
        waiver_priority: null,
        players: Object.freeze(tps),
        trader_team_key: t.type === "trade" ? team : null,
        tradee_team_key: tradee,
        note: null,
      }),
    );
  });
  txns.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

  if (issues.length > 0) return { ok: false, issues };

  // --- rules ---
  const r = f.rules ?? {};
  const uses_faab =
    r.waiver_type === "faab" || (r.waiver_type === undefined && r.faab_budget !== undefined);
  const trade_ratify_type = r.trade_review ?? null;
  const rules: LeagueRules = Object.freeze({
    waiver_type: r.waiver_type ?? null,
    waiver_rule: null,
    waiver_time_days: r.waiver_time_days ?? null,
    uses_faab,
    faab_budget: r.faab_budget ?? null,
    trade_end_date: r.trade_end_date ?? null,
    trade_ratify_type,
    trade_reject_time_days: r.trade_reject_time_days ?? null,
    can_trade_draft_picks: r.can_trade_draft_picks ?? null,
    max_adds: r.max_adds ?? null,
    max_weekly_adds: r.max_weekly_adds ?? null,
    uses_median_score: f.league.uses_median_score ?? null,
    playoffs: Object.freeze({
      uses_playoff: po !== undefined,
      start_week: po?.start_week ?? null,
      num_teams: po?.num_teams ?? null,
      reseeding: po?.reseeding ?? null,
      multiweek_championship: po?.multiweek_championship ?? null,
      consolation_teams: po?.consolation_teams ?? null,
    }),
    player_pool: null,
    cant_cut_list: null,
    allow_add_to_dl_extra_pos: null,
    unverified_fields: Object.freeze([]),
    capabilities: ruleCapabilities({
      uses_faab,
      waiver_time_days: r.waiver_time_days ?? null,
      trade_ratify_type,
    }),
  });

  // The full `manual.l.<slug>` key, not the bare slug: the default slug is the word "league",
  // and redacting every "league" in every log line would shred them (platform.ts obligation).
  const identifiers = new Set<string>([f.league.name, league_key]);
  for (const t of teams) {
    identifiers.add(t.name);
    if (t.manager !== null) identifiers.add(t.manager);
  }

  return {
    ok: true,
    data: Object.freeze({
      ref: Object.freeze({ platform: "manual" as const, league_key }),
      slug,
      name: f.league.name,
      season: f.league.season,
      num_teams: f.league.num_teams,
      scoring_type: f.league.scoring_type ?? "head",
      start_week: start,
      end_week: end,
      current_week_override: cw,
      lock_mode: f.league.lineup_lock ?? "per_game",
      rules,
      scoring: buildScoringSettings(f.scoring),
      slots,
      my_team: mine,
      teams: Object.freeze(teams),
      opponents,
      free_agents: Object.freeze(free_agents),
      waivers: Object.freeze(waivers),
      transactions: Object.freeze(txns),
      identifiers: Object.freeze([...identifiers]),
    }),
  };
}
