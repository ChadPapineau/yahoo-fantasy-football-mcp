// synthetic.ts — a deterministic synthetic NFL season generator (season-fresh spec §12 B1 helpers),
// so the season model, the game calendar, the cadence and the surfacing are tested over any season
// and schedule shape, never one year's values: 18, 19 or 20 regular-season weeks; a Wednesday,
// Thursday or Friday opener between late August and mid September; byes; Thanksgiving (the fourth
// Thursday of November) and its Friday; Christmas Day games on whatever weekday 25 December falls;
// Saturday games in the last three regular weeks; international games (Sunday 09:30 ET, a Friday
// opener abroad, a Thursday 20:35 ET game); a Monday doubleheader at 22:00 ET; a TBD-time game;
// WC/DIV/CON/SB with the Super Bowl in February; and an optional placeholder final week (every game
// at Sunday 13:00 ET, as nflverse publishes it before the NFL sets the times).
//
// Kickoffs are computed with the store's own Eastern conversion (src/store/datasets/derive.ts), not
// the code under test. Every helper is pure; `seed` drives the team order and the opener date.
import fc from "fast-check";
import { NFL_TEAMS, type NflTeam } from "../../../src/config/schema.js";
import type { NflGame } from "../../../src/domain/analytics/types.js";
import { kickoffUtcFromEastern } from "../../../src/store/datasets/derive.js";

/** The opener's weekday. */
export type Opener = "wed" | "thu" | "fri";

/** Generator options. */
export interface SyntheticOptions {
  readonly season: number;
  readonly regWeeks?: 18 | 19 | 20;
  readonly opener?: Opener;
  /** The last regular week's games all at Sunday 13:00 ET (nflverse's pre-announcement release). */
  readonly week18Placeholder?: boolean;
  readonly seed?: number;
}

/** The seasons the properties sweep by default. */
export const SYNTHETIC_SEASONS = [2026, 2027, 2028, 2029, 2030] as const;

const DOME: ReadonlySet<string> = new Set(["DET", "LV", "MIN", "NO", "LA", "LAC"]);
const RETRACTABLE: ReadonlySet<string> = new Set(["ATL", "DAL", "HOU", "IND", "ARI"]);
/** Venue ids of the international games (fixed-vocabulary ids, never names). */
export const INTERNATIONAL_VENUES = Object.freeze({
  london: "LON00",
  saoPaulo: "SAO00",
  berlin: "BER00",
});

// --- dates (UTC calendar arithmetic on YYYY-MM-DD; no local-zone methods) ----------------------------

/** `date` shifted by `days`. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday of a calendar date. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** The first date on or after `date` falling on `weekday`. */
export function nextWeekday(date: string, weekday: number): string {
  return addDays(date, (weekday - weekdayOf(date) + 7) % 7);
}

/** The fourth Thursday of November of `year` (Thanksgiving). */
export function thanksgiving(year: number): string {
  return addDays(nextWeekday(`${String(year)}-11-01`, 4), 21);
}

const kickoffCache = new Map<string, string | null>();

/** kickoffUtcFromEastern, memoised (the generator asks for the same slots over and over). */
function eastern(date: string, hhmm: string): string | null {
  const key = `${date} ${hhmm}`;
  let v = kickoffCache.get(key);
  if (v === undefined) {
    v = kickoffUtcFromEastern(date, hhmm);
    kickoffCache.set(key, v);
  }
  return v;
}

/** Epoch ms of an Eastern wall time (`HH:MM`) on `date`. */
export function etMs(date: string, hhmm: string): number {
  const iso = eastern(date, hhmm);
  if (iso === null) throw new Error(`synthetic: bad Eastern time ${date} ${hhmm}`);
  return Date.parse(iso);
}

/** The ISO instant of an Eastern wall time. */
export function etIso(date: string, hhmm: string): string {
  return new Date(etMs(date, hhmm)).toISOString();
}

const easternDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The Eastern date of an instant. */
export function easternDateOfMs(ms: number): string {
  return easternDay.format(new Date(ms));
}

// --- the generator --------------------------------------------------------------------------------

/** mulberry32: a tiny deterministic PRNG. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffled<T>(xs: readonly T[], next: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** Round `r` of a circle-method round robin over an even list. */
function roundPairs(teams: readonly NflTeam[], r: number): [NflTeam, NflTeam][] {
  const n = teams.length;
  const fixed = teams[0]!;
  const rest = teams.slice(1);
  const rot = rest.map((_, i) => rest[(i + r) % rest.length]!);
  const line = [fixed, ...rot];
  const out: [NflTeam, NflTeam][] = [];
  for (let i = 0; i < n / 2; i++) {
    const a = line[i]!;
    const b = line[n - 1 - i]!;
    out.push(r % 2 === 0 ? [a, b] : [b, a]);
  }
  return out;
}

/** The week-1 Sunday: the first Sunday on or after 7 September, or the one before (by seed). */
export function week1Sunday(season: number, seed: number): string {
  const base = nextWeekday(`${String(season)}-09-07`, 0);
  return seed % 2 === 0 ? base : addDays(base, -7);
}

const pad2 = (n: number): string => String(n).padStart(2, "0");
const venueOf = (home: NflTeam): string => `${home.padEnd(3, "X")}00`;

interface Slot {
  readonly date: string;
  readonly time: string | null;
  readonly venue?: string;
  readonly roof?: string;
}

function game(
  season: number,
  week: number,
  type: string,
  away: NflTeam,
  home: NflTeam,
  slot: Slot,
): NflGame {
  const venue = slot.venue ?? venueOf(home);
  const international = slot.venue !== undefined;
  const roof =
    slot.roof ??
    (international
      ? "outdoors"
      : DOME.has(home)
        ? "dome"
        : RETRACTABLE.has(home)
          ? "closed"
          : "outdoors");
  return {
    game_id: `${String(season)}_${pad2(week)}_${away}_${home}`,
    season,
    week,
    kickoff: slot.time === null ? null : eastern(slot.date, slot.time),
    away,
    home,
    stadium_id: venue,
    stadium: null,
    venue_tz: null,
    roof,
    surface: null,
    divisional: null,
    rest_days: { away: null, home: null },
    lines: null,
    is_final: false,
    score: null,
    game_type: type,
    gameday: slot.date,
  };
}

/** The slots of an ordinary regular week (index → slot), Sunday = `sun`. */
function ordinarySlots(sun: string, n: number): Slot[] {
  const out: Slot[] = [];
  for (let i = 0; i < n; i++) {
    if (i === 0) out.push({ date: addDays(sun, -3), time: "20:15" });
    else if (i === 1) out.push({ date: sun, time: "20:20" });
    else if (i === 2) out.push({ date: addDays(sun, 1), time: "20:15" });
    else if (i <= 4) out.push({ date: sun, time: "16:05" });
    else if (i <= 7) out.push({ date: sun, time: "16:25" });
    else out.push({ date: sun, time: "13:00" });
  }
  return out;
}

/** The set times of a final regular week (Saturday games, Sunday early/late, Sunday night). */
function finalWeekSlots(sun: string, n: number): Slot[] {
  const out: Slot[] = [];
  const sat = addDays(sun, -1);
  for (let i = 0; i < n; i++) {
    if (i === 0) out.push({ date: sat, time: "16:30" });
    else if (i === 1) out.push({ date: sat, time: "20:00" });
    else if (i === 2) out.push({ date: sun, time: "20:20" });
    else if (i <= 8) out.push({ date: sun, time: "16:25" });
    else out.push({ date: sun, time: "13:00" });
  }
  return out;
}

/** The pairings of one regular week, with byes removed and the bye teams' opponents re-paired. */
function weekPairs(
  teams: readonly NflTeam[],
  week: number,
  byes: ReadonlySet<NflTeam>,
): [NflTeam, NflTeam][] {
  const pairs = roundPairs(teams, (week - 1) % (teams.length - 1));
  if (byes.size === 0) return pairs;
  const keep: [NflTeam, NflTeam][] = [];
  const orphans: NflTeam[] = [];
  for (const [a, h] of pairs) {
    if (byes.has(a) && byes.has(h)) continue;
    if (byes.has(a)) orphans.push(h);
    else if (byes.has(h)) orphans.push(a);
    else keep.push([a, h]);
  }
  for (let i = 0; i + 1 < orphans.length; i += 2) keep.push([orphans[i]!, orphans[i + 1]!]);
  return keep;
}

/**
 * One synthetic season's games (regular season + postseason), ordered by week. Deterministic in
 * its options.
 */
export function syntheticSeason(o: SyntheticOptions): NflGame[] {
  const season = o.season;
  const regWeeks = o.regWeeks ?? 18;
  const opener = o.opener ?? "thu";
  const seed = o.seed ?? 0;
  const next = rng(seed * 7919 + season);
  const teams = shuffled(NFL_TEAMS, next);
  const sun1 = week1Sunday(season, seed);
  const sunday = (w: number): string => addDays(sun1, 7 * (w - 1));
  const tg = thanksgiving(season);
  const xmas = `${String(season)}-12-25`;
  const games: NflGame[] = [];

  // byes: weeks 5–12, four teams each
  const byeWeek = new Map<number, Set<NflTeam>>();
  teams.forEach((t, i) => {
    const w = 5 + Math.floor(i / 4);
    const s = byeWeek.get(w) ?? new Set<NflTeam>();
    s.add(t);
    byeWeek.set(w, s);
  });

  for (let w = 1; w <= regWeeks; w++) {
    const sun = sunday(w);
    const pairs = weekPairs(teams, w, byeWeek.get(w) ?? new Set());
    const last = w === regWeeks;
    const slots: Slot[] = last
      ? o.week18Placeholder === true
        ? pairs.map(() => ({ date: sun, time: "13:00" }))
        : finalWeekSlots(sun, pairs.length)
      : ordinarySlots(sun, pairs.length);
    if (w === 1) {
      const openerDate = addDays(sun, opener === "wed" ? -4 : opener === "thu" ? -3 : -2);
      slots[0] =
        opener === "fri"
          ? { date: openerDate, time: "20:00", venue: INTERNATIONAL_VENUES.saoPaulo }
          : { date: openerDate, time: "20:20" };
    }
    if (w === 2) {
      slots[2] = { date: addDays(sun, 1), time: "19:15" };
      slots[3] = { date: addDays(sun, 1), time: "22:00" };
    }
    if (w === 3) slots[0] = { date: addDays(sun, -3), time: "20:35" };
    if (w === 5) slots[3] = { date: sun, time: "09:30", venue: INTERNATIONAL_VENUES.london };
    if (w === 10) slots[4] = { date: sun, time: "09:30", venue: INTERNATIONAL_VENUES.berlin };
    if (!last && addDays(tg, 3) === sun) {
      slots[0] = { date: tg, time: "12:30" };
      slots[3] = { date: tg, time: "16:30" };
      slots[4] = { date: tg, time: "20:20" };
      slots[5] = { date: addDays(tg, 1), time: "15:00" };
    }
    if (!last && w >= regWeeks - 2) {
      slots[6] = { date: addDays(sun, -1), time: "16:30" };
      slots[7] = { date: addDays(sun, -1), time: "20:00" };
    }
    if (!last && w === regWeeks - 1) slots[8] = { date: sun, time: null };
    // Christmas: three games on 25 December in the week (Tuesday..Monday) that holds it
    if (xmas >= addDays(sun, -5) && xmas <= addDays(sun, 1) && !(last && o.week18Placeholder)) {
      slots[9] = { date: xmas, time: "13:00" };
      slots[10] = { date: xmas, time: "16:30" };
      slots[11] = { date: xmas, time: "20:15" };
    }
    pairs.forEach(([a, h], i) => {
      const slot = slots[i] ?? { date: sun, time: "13:00" };
      games.push(game(season, w, "REG", a, h, slot));
    });
  }

  // postseason: 14 teams, the top two seeds rest in the wild-card round
  const seeds = teams.slice(0, 14);
  const wc = regWeeks + 1;
  const wcSun = sunday(wc);
  const wcPairs: [NflTeam, NflTeam][] = [];
  for (let i = 0; i < 6; i++) wcPairs.push([seeds[13 - i]!, seeds[2 + i]!]);
  const wcSlots: Slot[] = [
    { date: addDays(wcSun, -1), time: "16:30" },
    { date: addDays(wcSun, -1), time: "20:00" },
    { date: wcSun, time: "13:00" },
    { date: wcSun, time: "16:30" },
    { date: wcSun, time: "20:15" },
    { date: addDays(wcSun, 1), time: "20:15" },
  ];
  wcPairs.forEach(([a, h], i) => games.push(game(season, wc, "WC", a, h, wcSlots[i]!)));
  const div = wc + 1;
  const divSun = sunday(div);
  const winners = wcPairs.map(([, h]) => h);
  const divPairs: [NflTeam, NflTeam][] = [
    [winners[0]!, seeds[0]!],
    [winners[1]!, seeds[1]!],
    [winners[2]!, winners[3]!],
    [winners[4]!, winners[5]!],
  ];
  const divSlots: Slot[] = [
    { date: addDays(divSun, -1), time: "16:30" },
    { date: addDays(divSun, -1), time: "20:00" },
    { date: divSun, time: "15:00" },
    { date: divSun, time: "18:30" },
  ];
  divPairs.forEach(([a, h], i) => games.push(game(season, div, "DIV", a, h, divSlots[i]!)));
  const con = div + 1;
  const conSun = sunday(con);
  const conAway = [winners[2]!, winners[4]!] as const;
  games.push(game(season, con, "CON", conAway[0], seeds[0]!, { date: conSun, time: "15:00" }));
  games.push(game(season, con, "CON", conAway[1], seeds[1]!, { date: conSun, time: "18:30" }));
  const sb = con + 1;
  const sbDate = addDays(conSun, 14);
  games.push(
    game(season, sb, "SB", seeds[1]!, seeds[0]!, {
      date: sbDate,
      time: "18:30",
      venue: "SBX00",
      roof: "dome",
    }),
  );
  return games;
}

/** Several seasons in one schedule file. */
export function syntheticSeasons(
  seasons: readonly number[],
  o: Omit<SyntheticOptions, "season"> = {},
): NflGame[] {
  return seasons.flatMap((season) => syntheticSeason({ ...o, season }));
}

/** The games with one game moved to a new kickoff (a flex), gameday following the Eastern date. */
export function flexMove(
  games: readonly NflGame[],
  gameId: string,
  newKickoffIso: string,
): NflGame[] {
  const ms = Date.parse(newKickoffIso);
  if (!Number.isFinite(ms)) throw new Error("flexMove: bad kickoff");
  if (!games.some((g) => g.game_id === gameId)) throw new Error(`flexMove: no game ${gameId}`);
  return games.map((g) =>
    g.game_id === gameId
      ? { ...g, kickoff: new Date(ms).toISOString(), gameday: easternDateOfMs(ms) }
      : g,
  );
}

/** The last regular week of each season present (from `game_type`). */
export function lastRegWeekOf(games: readonly NflGame[], season: number): number {
  let w = 0;
  for (const g of games) if (g.season === season && g.game_type === "REG") w = Math.max(w, g.week);
  return w;
}

/**
 * The games with every season's final regular week set from its placeholders to real times
 * (Saturday 16:30 and 20:00, Sunday 16:25 ×6, Sunday night, the rest Sunday 13:00).
 */
export function setWeek18(games: readonly NflGame[]): NflGame[] {
  const seasons = [...new Set(games.map((g) => g.season))];
  const out = [...games];
  for (const s of seasons) {
    const w = lastRegWeekOf(games, s);
    const idx = out
      .map((g, i) => [g, i] as const)
      .filter(([g]) => g.season === s && g.week === w && g.game_type === "REG");
    const first = idx[0]?.[0];
    if (first === undefined) continue;
    const sun = first.gameday ?? easternDateOfMs(Date.parse(first.kickoff ?? ""));
    const slots = finalWeekSlots(weekdayOf(sun) === 0 ? sun : nextWeekday(sun, 0), idx.length);
    idx.forEach(([g, i], j) => {
      const slot = slots[j]!;
      out[i] = {
        ...g,
        kickoff: slot.time === null ? null : eastern(slot.date, slot.time),
        gameday: slot.date,
      };
    });
  }
  return out;
}

/** The games with a game removed and re-added in another week (nflverse renames the id). */
export function moveToWeek(
  games: readonly NflGame[],
  gameId: string,
  week: number,
  kickoffIso: string,
): NflGame[] {
  const g = games.find((x) => x.game_id === gameId);
  if (g === undefined) throw new Error(`moveToWeek: no game ${gameId}`);
  const ms = Date.parse(kickoffIso);
  const moved: NflGame = {
    ...g,
    week,
    game_id: `${String(g.season)}_${pad2(week)}_${g.away}_${g.home}`,
    kickoff: new Date(ms).toISOString(),
    gameday: easternDateOfMs(ms),
  };
  return [...games.filter((x) => x.game_id !== gameId), moved];
}

/** Arbitrary synthetic season options, seasons 2026 and later. */
export const arbSeasonOptions: fc.Arbitrary<Required<SyntheticOptions>> = fc.record({
  season: fc.integer({ min: 2026, max: 2040 }),
  regWeeks: fc.constantFrom(18 as const, 19 as const, 20 as const),
  opener: fc.constantFrom<Opener>("wed", "thu", "fri"),
  week18Placeholder: fc.boolean(),
  seed: fc.nat({ max: 1_000_000 }),
});

/** Arbitrary synthetic seasons with their options (fast-check). */
export const arbSeasonSchedule: fc.Arbitrary<{
  readonly options: Required<SyntheticOptions>;
  readonly games: readonly NflGame[];
}> = arbSeasonOptions.map((options) => ({ options, games: syntheticSeason(options) }));
