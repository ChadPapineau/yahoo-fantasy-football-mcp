// status-blocks-parity.test.ts — G1 (`ff_get_status`) and `ff status` print the same `season` and
// `schedule` blocks and the same per-source timing (season-fresh spec §4.5, §8.11: both built by the
// same functions over the same store), for the same store and clock — across the season (preseason
// week, regular season, a game window, the postseason, the off-season), with kickoff changes, a
// provider pause and a season upstream has not published yet recorded.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectStatus } from "../../src/cli/status.js";
import type { ScheduleChange } from "../../src/domain/analytics/types.js";
import { makeIo, type Sandbox } from "../cli/helpers.js";
import { body, connect, makeWorld, type World } from "./helpers/env.js";

let world: World;
beforeAll(async () => {
  world = await makeWorld({ env: { FF_WEATHER_SOURCE: "off" } });
  const now = world.clock.nowMs();
  const change: ScheduleChange = {
    detected_at: new Date(now - 3_600_000).toISOString(),
    release_updated_at: null,
    season: 2026,
    week: 5,
    game_id: "2026_05_BUF_NE",
    away: "BUF",
    home: "NE",
    kind: "kickoff",
    old_value: "2026-10-04T17:00:00.000Z",
    new_value: "2026-10-05T00:20:00.000Z",
  };
  await world.store.repos.scheduleChanges.append([change]);
  await world.store.repos.seasonChecks.record({
    source: "nflverse:injuries",
    season: 2027,
    checked_at: new Date(now - 7_200_000).toISOString(),
    status: "not_published",
  });
  await world.store.repos.providerBackoff.set({
    provider: "nflverse",
    until_at: new Date(now + 1_800_000).toISOString(),
    reason: "rate_limited",
    set_at: new Date(now).toISOString(),
  });
}, 60_000);
afterAll(() => {
  world.cleanup();
});

interface G1 {
  season: unknown;
  schedule: unknown;
  sources: { id: string; next_check_at: string | null; backoff_until: string | null }[];
}

async function g1(): Promise<G1> {
  const c = await connect(world);
  try {
    const r = await c.client.callTool({ name: "ff_get_status", arguments: {} });
    expect(r.isError).not.toBe(true);
    return (body(r) as { data: G1 }).data;
  } finally {
    await c.close();
  }
}

function status() {
  const sb: Sandbox = {
    dir: world.root,
    home: world.env.HOME ?? "",
    configDir: world.config.configDir,
    cacheDir: world.config.cacheDir,
    cleanup: () => undefined,
  };
  return collectStatus(
    makeIo(sb, { clock: world.clock, env: { ...world.env } }),
    world.config,
    world.logger,
  );
}

const json = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

describe("G1 and ff status agree on the season and schedule blocks", () => {
  for (const at of [
    "2026-09-30T18:00:00.000Z", // Wednesday of week 4 (the fixture clock)
    "2026-10-04T15:00:00.000Z", // Sunday morning: a game window
    "2026-11-27T12:00:00.000Z", // the day after Thanksgiving
    "2027-01-20T12:00:00.000Z", // the postseason
    "2027-04-15T12:00:00.000Z", // the off-season
  ]) {
    it(at, async () => {
      world.clock.set(at);
      const a = await g1();
      const b = status();
      expect(json(b.season)).toEqual(json(a.season));
      expect(json(b.schedule)).toEqual(json(a.schedule));
      for (const s of a.sources) {
        const mine = b.sources.find((x) => x.source === s.id) as
          { next_check_at?: string | null; backoff_until?: string | null } | undefined;
        expect(mine?.next_check_at ?? null, `${s.id} next_check_at`).toBe(s.next_check_at);
        expect(mine?.backoff_until ?? null, `${s.id} backoff_until`).toBe(s.backoff_until);
      }
    });
  }
});
