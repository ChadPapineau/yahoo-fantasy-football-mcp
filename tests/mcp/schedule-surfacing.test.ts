// schedule-surfacing.test.ts — kickoff changes and tentative kickoffs where the user sees them
// (season-fresh spec §5.2, §5.3): a flexed kickoff appears in G1 `schedule.recent_changes`, as a
// fixed-vocabulary warning (new ET kickoff, "lock times use the new kickoff") in roster, lineup,
// matchup, waivers, projections and schedule results, and the roster's lock times use the new
// kickoff; the final regular week's placeholder kickoffs are flagged in D3 (`kickoff_tentative`) with
// a warning until the NFL sets them; and Saturday, Wednesday, Christmas and international 09:30 ET
// games of synthetic 2026–2030 seasons carry correct Eastern and venue-local kickoffs.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NflTeam } from "../../src/config/schema.js";
import type {
  DatasetReaders,
  NflGame,
  ScheduleChange,
  ScheduleReader,
} from "../../src/domain/analytics/types.js";
import { scheduleView } from "../../src/domain/league/calendar.js";
import { easternLabel } from "../../src/domain/league/kickoff-status.js";
import type { McpServices } from "../../src/mcp/services.js";
import { isoInZone } from "../../src/mcp/tools/datasets.js";
import { scheduleReaderOf } from "../helpers/season/reader.js";
import {
  INTERNATIONAL_VENUES,
  SYNTHETIC_SEASONS,
  etMs,
  setWeek18,
  syntheticSeasons,
} from "../helpers/season/synthetic.js";
import { body, connect, makeWorld, TEAM_A, type World } from "./helpers/env.js";

const H = 3_600_000;

/** A reader over `real` whose games pass through `map` (a flex, the final week set). */
function mapped(real: ScheduleReader, map: (gs: readonly NflGame[]) => NflGame[]): ScheduleReader {
  return {
    games: (s, w) => {
      const r = real.games(s, w);
      return {
        rows: map(r.rows),
        stamp: r.stamp === null ? null : { ...r.stamp, file_version: `${r.stamp.file_version}-m` },
      };
    },
    firstKickoff: (s, w) => {
      const ks = map(real.games(s, [w]).rows)
        .map((g) => (g.kickoff === null ? Number.NaN : Date.parse(g.kickoff)))
        .filter(Number.isFinite);
      return ks.length === 0 ? null : new Date(Math.min(...ks)).toISOString();
    },
  };
}

describe("a flexed kickoff in the fixture league's week (2026)", () => {
  let world: World;
  beforeAll(async () => {
    world = await makeWorld();
  }, 60_000);
  afterAll(() => {
    world.cleanup();
  });

  interface Env {
    data: Record<string, unknown>;
    warnings: string[];
  }

  it("G1, the tools' warnings and the roster's lock times all carry the new kickoff", async () => {
    const real = world.services.datasets.schedules;
    const now = world.clock.nowMs();
    // Team A's QB plays for BUF: flex BUF's week-4 game (and a week-3 game, for the matchup)
    const roster = (
      await (async () => {
        const c = await connect(world);
        try {
          return body(
            await c.client.callTool({ name: "ff_get_roster", arguments: { week: 4 } }),
          ) as {
            data: { players: { team_abbr: string | null; lock_at: string | null }[] };
          };
        } finally {
          await c.close();
        }
      })()
    ).data.players;
    const teams = new Set(roster.map((p) => p.team_abbr).filter((t): t is string => t !== null));
    const w4 = real.games(2026, [4]).rows.find((g) => teams.has(g.home) || teams.has(g.away));
    const w3 = real.games(2026, [3]).rows.find((g) => teams.has(g.home) || teams.has(g.away));
    expect(w4?.kickoff).toBeTruthy();
    expect(w3?.kickoff).toBeTruthy();
    const newKick = new Date(Date.parse(w4?.kickoff ?? "") + 4 * H + 25 * 60_000).toISOString();
    const new3 = new Date(Date.parse(w3?.kickoff ?? "") + 3 * H).toISOString();
    const flex = (gs: readonly NflGame[]): NflGame[] =>
      gs.map((g) =>
        g.game_id === w4?.game_id
          ? { ...g, kickoff: newKick }
          : g.game_id === w3?.game_id
            ? { ...g, kickoff: new3 }
            : g,
      );
    const change = (g: NflGame, to: string, detected: number): ScheduleChange => ({
      detected_at: new Date(detected).toISOString(),
      release_updated_at: null,
      season: 2026,
      week: g.week,
      game_id: g.game_id,
      away: g.away,
      home: g.home,
      kind: "kickoff",
      old_value: g.kickoff,
      new_value: to,
    });
    const changes = [change(w4!, newKick, now - H), change(w3!, new3, now - 2 * H)];
    const schedules = mapped(real, flex);
    const datasets: DatasetReaders = { ...world.services.datasets, schedules };
    const svc: McpServices = {
      ...world.services,
      datasets,
      scheduleView: (ms) => scheduleView(schedules, ms),
      scheduleChanges: {
        recent: (since) => changes.filter((c) => c.detected_at >= since),
        forWeek: (s, w) => changes.filter((c) => c.season === s && c.week === w),
      },
    };
    const line4 = `kickoff changed for ${w4?.away ?? ""}@${w4?.home ?? ""} (week 4): ${easternLabel(w4?.kickoff ?? null)} → ${easternLabel(newKick)}`;
    const c = await connect({ services: svc, options: world.options });
    try {
      const call = async (name: string, args: Record<string, unknown>): Promise<Env> => {
        const r = await c.client.callTool({ name, arguments: args });
        const b = body(r) as unknown as Env;
        expect(r.isError, `${name} ${JSON.stringify(b).slice(0, 400)}`).not.toBe(true);
        return b;
      };
      const g1 = await call("ff_get_status", { include_checks: true });
      const sched = g1.data.schedule as { recent_changes: { game: string; new: string }[] };
      expect(sched.recent_changes.map((x) => x.new)).toEqual([newKick, new3]);
      for (const [name, args] of [
        ["ff_get_roster", { week: 4 }],
        ["ff_analyze_lineup", { week: 4 }],
        [
          "ff_project_players",
          { players: { team_key: TEAM_A }, horizon: "week", week: 4, seed: 1 },
        ],
        ["ff_analyze_waivers", { positions: ["K", "DEF"], look_ahead: 1 }],
        ["ff_get_schedule", { weeks: [4] }],
        ["ff_get_league", {}],
      ] as const) {
        const b = await call(name, args);
        expect(
          b.warnings.some(
            (w) => w.startsWith(line4) && w.endsWith("lock times use the new kickoff"),
          ),
          `${name}: ${JSON.stringify(b.warnings)}`,
        ).toBe(true);
      }
      const m = await call("ff_analyze_matchup", { week: 3 });
      expect(
        m.warnings.some((w) =>
          w.startsWith(`kickoff changed for ${w3?.away ?? ""}@${w3?.home ?? ""} (week 3)`),
        ),
      ).toBe(true);
      // the roster's lock times come from the flexed schedule
      const after = (await call("ff_get_roster", { week: 4 })).data as {
        players: { team_abbr: string | null; lock_at: string | null; kickoff: string | null }[];
      };
      const moved = after.players.filter(
        (p) => p.team_abbr === w4?.home || p.team_abbr === w4?.away,
      );
      expect(moved.length).toBeGreaterThan(0);
      for (const p of moved) expect(p.kickoff).toBe(newKick);
    } finally {
      await c.close();
    }
  });
});

describe("the final regular week's placeholder kickoffs (2026 fixture release)", () => {
  let world: World;
  beforeAll(async () => {
    world = await makeWorld();
  }, 60_000);
  afterAll(() => {
    world.cleanup();
  });

  it("tentative with a warning while placeholders; cleared once the NFL sets the times", async () => {
    const real = world.services.datasets.schedules;
    const last = Math.max(
      ...real
        .games(
          2026,
          Array.from({ length: 30 }, (_, i) => i + 1),
        )
        .rows.filter((g) => g.game_type === "REG")
        .map((g) => g.week),
    );
    const before = await connect(world);
    try {
      const r = await before.client.callTool({
        name: "ff_get_schedule",
        arguments: { weeks: [last] },
      });
      const b = body(r) as {
        data: { games: { kickoff_tentative: boolean; tentative_reason: string | null }[] };
        warnings: string[];
      };
      expect(r.isError).not.toBe(true);
      expect(b.data.games.length).toBeGreaterThan(0);
      expect(
        b.data.games.every((g) => g.kickoff_tentative && g.tentative_reason === "placeholder_week"),
      ).toBe(true);
      expect(b.warnings).toContain(
        `week ${String(last)} kickoff times are placeholders until the NFL sets them; lock times may move`,
      );
    } finally {
      await before.close();
    }
    const set = mapped(real, (gs) => setWeek18(gs));
    const svc: McpServices = {
      ...world.services,
      datasets: { ...world.services.datasets, schedules: set },
      scheduleView: (ms) => scheduleView(set, ms),
    };
    const after = await connect({ services: svc, options: world.options });
    try {
      const r = await after.client.callTool({
        name: "ff_get_schedule",
        arguments: { weeks: [last] },
      });
      const b = body(r) as {
        data: { games: { tentative_reason: string | null }[] };
        warnings: string[];
      };
      expect(b.data.games.some((g) => g.tentative_reason === "placeholder_week")).toBe(false);
      expect(b.warnings.some((w) => w.includes("placeholders"))).toBe(false);
    } finally {
      await after.close();
    }
  });
});

describe("unusual kickoffs of synthetic seasons 2026–2030: Eastern and venue-local times", () => {
  let world: World;
  beforeAll(async () => {
    world = await makeWorld({ noLeague: true, publish: false });
  }, 60_000);
  afterAll(() => {
    world.cleanup();
  });

  const TZ: Readonly<Record<string, string>> = {
    [INTERNATIONAL_VENUES.london]: "Europe/London",
    [INTERNATIONAL_VENUES.berlin]: "Europe/Berlin",
    [INTERNATIONAL_VENUES.saoPaulo]: "America/Sao_Paulo",
  };
  const WEST: ReadonlySet<NflTeam> = new Set(["SEA", "SF", "LA", "LAC", "LV"] as NflTeam[]);
  const withTz = (g: NflGame): NflGame => ({
    ...g,
    venue_tz:
      (g.stadium_id === null ? undefined : TZ[g.stadium_id]) ??
      (WEST.has(g.home) ? "America/Los_Angeles" : "America/New_York"),
  });
  const et = (k: string): { weekday: string; date: string; hhmm: string } => {
    const label = easternLabel(k); // `Sat 2026-12-19 20:20 ET`
    const [weekday = "", date = "", hhmm = ""] = label.split(" ");
    return { weekday, date, hhmm };
  };

  for (const y of SYNTHETIC_SEASONS) {
    it(`${String(y)}: Saturday, Wednesday, Christmas and 09:30 ET international games`, async () => {
      const games = syntheticSeasons([y], { opener: "wed" }).map(withTz);
      const pick = (f: (g: NflGame) => boolean): NflGame => {
        const g = games.find((x) => x.kickoff !== null && f(x));
        if (g === undefined) throw new Error(`no such game in ${String(y)}`);
        return g;
      };
      const special = [
        pick((g) => et(g.kickoff ?? "").weekday === "Sat"),
        pick((g) => et(g.kickoff ?? "").weekday === "Wed"),
        pick((g) => et(g.kickoff ?? "").date === `${String(y)}-12-25`),
        pick((g) => et(g.kickoff ?? "").hhmm === "09:30"),
      ];
      // a clock inside season y: the D3 call names the weeks explicitly
      world.clock.set(`${String(y)}-10-14T16:00:00.000Z`);
      const reader = scheduleReaderOf(games, {
        checkedAt: new Date(world.clock.nowMs() - 600_000).toISOString(),
        fileVersion: `syn-${String(y)}`,
      });
      const svc: McpServices = {
        ...world.services,
        datasets: { ...world.services.datasets, schedules: reader },
        scheduleView: (ms) => scheduleView(reader, ms),
      };
      const c = await connect({ services: svc, options: world.options });
      try {
        for (const g of special) {
          const r = await c.client.callTool({
            name: "ff_get_schedule",
            arguments: { weeks: [g.week], nfl_team: g.home, include_weather: false },
          });
          const b = body(r) as {
            data: {
              games: { game_id: string; kickoff_et: string | null; kickoff_local: string | null }[];
            };
          };
          expect(r.isError, JSON.stringify(b).slice(0, 300)).not.toBe(true);
          const row = b.data.games.find((x) => x.game_id === g.game_id);
          const k = Date.parse(g.kickoff ?? "");
          expect(row?.kickoff_et).toBe(isoInZone(k, "America/New_York"));
          expect(row?.kickoff_local).toBe(isoInZone(k, g.venue_tz ?? ""));
          // the Eastern wall time is the scheduled one (DST-aware)
          const { date, hhmm } = et(g.kickoff ?? "");
          expect(Date.parse(row?.kickoff_et ?? "")).toBe(etMs(date, hhmm));
        }
      } finally {
        await c.close();
      }
    });
  }
});
