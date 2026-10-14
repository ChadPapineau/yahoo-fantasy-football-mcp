// season-fresh-types.test.ts — the season-fresh port contract (season-fresh spec §8.7) agrees with
// the store's migration 003: every schedule-change kind, season-check status and backoff reason the
// domain types allow is exactly what the table CHECKs admit, and the optional NflGame/DatasetStamp
// additions stay optional (existing literals keep compiling).
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  GAME_ID_RE,
  SCHEDULE_CHANGE_KINDS,
  type DatasetStamp,
  type NflGame,
  type ProviderBackoffRow,
  type ScheduleChangeKind,
  type SeasonCheckStatus,
} from "../../src/domain/analytics/types.js";
import { MIGRATION_003_SQL } from "../../src/store/migrations/003_season_fresh.js";

/** The values a `CHECK (<column> IN (...))` of migration 003 admits. */
function checkValues(column: string): string[] {
  const sql = MIGRATION_003_SQL.join("\n");
  const m = new RegExp(`${column} TEXT NOT NULL CHECK \\(${column} IN \\(([^)]*)\\)\\)`).exec(sql);
  if (m === null) throw new Error(`no CHECK for ${column}`);
  return (m[1] ?? "").split(",").map((v) => v.trim().replace(/^'|'$/g, ""));
}

describe("migration 003 admits exactly the domain's vocabulary", () => {
  it("schedule_change.kind = SCHEDULE_CHANGE_KINDS", () => {
    expect(checkValues("kind").sort()).toEqual([...SCHEDULE_CHANGE_KINDS].sort());
  });
  it("season_check.status and provider_backoff.reason", () => {
    const statuses: SeasonCheckStatus[] = ["not_published", "published"];
    expect(checkValues("status").sort()).toEqual(statuses.sort());
    const reasons: ProviderBackoffRow["reason"][] = ["rate_limited", "server_error"];
    expect(checkValues("reason").sort()).toEqual(reasons.sort());
  });
});

describe("the additive fields stay optional", () => {
  it("NflGame.game_type/gameday and DatasetStamp.seasons may be absent", () => {
    expectTypeOf<undefined extends NflGame["game_type"] ? true : false>().toEqualTypeOf<true>();
    expectTypeOf<undefined extends NflGame["gameday"] ? true : false>().toEqualTypeOf<true>();
    expectTypeOf<undefined extends DatasetStamp["seasons"] ? true : false>().toEqualTypeOf<true>();
    expectTypeOf<ScheduleChangeKind>().toEqualTypeOf<(typeof SCHEDULE_CHANGE_KINDS)[number]>();
  });
  it("GAME_ID_RE is nflverse's game-id grammar (regular and postseason weeks)", () => {
    for (const ok of ["2026_15_CHI_BUF", "2025_22_SEA_NE", "2030_01_LA_SF"])
      expect(ok).toMatch(GAME_ID_RE);
    for (const bad of [
      "2026_15_CHI_BUF\n",
      "2026_5_CHI_BUF",
      "26_15_CHI_BUF",
      "2026_15_chi_BUF",
      "2026_15_<b>_BUF",
    ])
      expect(bad).not.toMatch(GAME_ID_RE);
  });
});
