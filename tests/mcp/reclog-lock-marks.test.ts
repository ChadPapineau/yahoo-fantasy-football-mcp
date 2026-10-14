// reclog-lock-marks.test.ts — recommendations logged under a lock time that later moved (season-fresh
// spec §5.4) over the fixture world and the real store: E14 items and E13 calls carry `lock_status`
// (current → moved once a kickoff change of the game that set the deadline is recorded), E13 warns
// with the moved calls' ids, and E12 warns when a cited analysis predates a schedule change of the
// logged week. Log rows stay immutable: the mark is derived at read time.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScheduleChange } from "../../src/domain/analytics/types.js";
import { body, connect, makeWorld, type World } from "./helpers/env.js";
import { recordArgs } from "./helpers/calls.js";

let world: World;
let client: Awaited<ReturnType<typeof connect>>["client"];
let close: () => Promise<void>;
beforeAll(async () => {
  world = await makeWorld();
  ({ client, close } = await connect(world));
}, 60_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

interface Game {
  game_id: string;
  away: string;
  home: string;
  week: number;
  kickoff_et: string | null;
}

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const r = await client.callTool({ name, arguments: args });
  const b = body(r);
  if (r.isError === true) throw new Error(`${name}: ${JSON.stringify(b)}`);
  return b as T;
}

/** A week-4 game of the fixture schedule with a kickoff (the first one). */
async function week4Game(): Promise<Game> {
  const sched = await call<{ data: { games: Game[] } }>("ff_get_schedule", { weeks: [4] });
  const g = sched.data.games.find((x) => x.kickoff_et !== null);
  if (g === undefined) throw new Error("no week-4 kickoff");
  return g;
}

/**
 * E2's week-4 rec, logged as a call to act before `game`'s kickoff (the fixture lineup may already
 * be optimal — no_move, no deadline — so the deadline is set to a real kickoff of the week).
 */
async function argsWithDeadline(game: Game): Promise<Record<string, unknown>> {
  const args = await recordArgs(client);
  const rec = args.rec as Record<string, unknown>;
  return {
    ...args,
    rec: {
      ...rec,
      no_move: false,
      latest_execution_time: new Date(Date.parse(game.kickoff_et ?? "")).toISOString(),
    },
  };
}

describe("lock marks", () => {
  it("E14 and E13 mark a call `moved` once the kickoff that set its deadline changes; E13 warns", async () => {
    const game = await week4Game();
    const args = await argsWithDeadline(game);
    const rec = args.rec as { latest_execution_time: string };
    const logged = await call<{ data: { log_id: string } }>("ff_record_recommendation", args);
    const logId = logged.data.log_id;

    const before = await call<{ data: { items: { log_id: string; lock_status: string }[] } }>(
      "ff_list_recommendations",
      { week: 4 },
    );
    expect(before.data.items.find((i) => i.log_id === logId)?.lock_status).toBe("current");

    // the game whose kickoff set the deadline is flexed: a change row with the deadline as old value
    const deadline = Date.parse(rec.latest_execution_time);
    const change: ScheduleChange = {
      detected_at: new Date(world.clock.nowMs() + 60_000).toISOString(),
      release_updated_at: null,
      season: 2026,
      week: 4,
      game_id: game.game_id,
      away: game.away as ScheduleChange["away"],
      home: game.home as ScheduleChange["home"],
      kind: "kickoff",
      old_value: new Date(deadline).toISOString(),
      new_value: new Date(deadline + 3 * 3_600_000).toISOString(),
    };
    expect(await world.store.repos.scheduleChanges.append([change])).toBe(1);

    const after = await call<{ data: { items: { log_id: string; lock_status: string }[] } }>(
      "ff_list_recommendations",
      { week: 4 },
    );
    expect(after.data.items.find((i) => i.log_id === logId)?.lock_status).toBe("moved");

    const retro = await call<{
      data: { calls: { log_id: string; lock_status: string }[] };
      warnings: string[];
    }>("ff_analyze_retrospective", { week: 4 });
    expect(retro.data.calls.find((c) => c.log_id === logId)?.lock_status).toBe("moved");
    expect(retro.warnings.some((w) => w.includes(logId) && w.includes("lock time"))).toBe(true);
  });

  it("E12 warns when a cited analysis predates a schedule change of the logged week", async () => {
    // a fresh analysis, then a change detected after it
    const args = await argsWithDeadline(await week4Game());
    const plain = await call<{ warnings: string[] }>("ff_record_recommendation", {
      ...args,
      client_ref: "lock-marks-before",
    });
    // the change of the previous test was detected a minute after the clock: after this call too
    expect(plain.warnings).toContain(
      "the 2026 week 4 schedule changed after the analysis you cite; re-run it before relying on its lock time",
    );
    // a call made after the change cites nothing stale
    world.clock.advance(5 * 60_000);
    const fresh = await argsWithDeadline(await week4Game());
    const ok = await call<{ warnings: string[] }>("ff_record_recommendation", {
      ...fresh,
      client_ref: "lock-marks-after",
    });
    expect(ok.warnings.filter((w) => w.includes("schedule changed"))).toEqual([]);
  });
});
