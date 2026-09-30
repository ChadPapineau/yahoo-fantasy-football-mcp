// types.test.ts — the shared contract layer's type-level and runtime invariants: the FantasyPlatform
// seam (plan 01 §8: writes optional, all false today), the DataSource amendment (round 2 OBJ-27:
// publish into a dataset file, never load into the store), the scoring types (plan 08 §2), analytics
// (`Dist.basis`, coarse `delta_pwin` — OBJ-04), reclog (no `parameter_changes_proposed` — OBJ-05;
// "n too small (k of 30)"), crosswalk, and the store (STORE_BUSY via `ffCode` across layers).
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  CoarseDelta,
  DeltaPwin,
  Dist,
  LineupRecommendation,
  MatchupWinProb,
  Rec,
  StreamingCandidate,
} from "../../src/domain/analytics/types.js";
import type { CrosswalkPair, MatchDecision } from "../../src/domain/crosswalk/types.js";
import type { League, PageOf, PlayerRef, RosterSlot } from "../../src/domain/league/types.js";
import {
  DEFAULT_MIN_N,
  RECLOG_UNTRUSTED_SOURCE,
  RECOMMENDATION_KINDS,
  nTooSmall,
  type BrierMetric,
  type NTooSmall,
  type Retrospective,
} from "../../src/domain/reclog/types.js";
import {
  CANONICAL_NAME_RE,
  KNOWN_CANONICAL,
  POSITION_TYPES,
  type ScoreResult,
  type ScoringSettings,
  type StatLine,
} from "../../src/domain/scoring/types.js";
import { toToolError } from "../../src/mcp/errors.js";
import { SOURCE_TAG_RE } from "../../src/mcp/envelope.js";
import {
  NO_WRITES,
  readOnlyCapabilities,
  type FantasyPlatform,
  type PlatformCapabilities,
} from "../../src/providers/platform.js";
import { ALLOWED_PARQUET_CODECS, type DataSource } from "../../src/sources/source.js";
import {
  BUSY_TIMEOUT_MS,
  MIGRATION_001_TABLES,
  NEVER_PRUNED_TABLES,
  PRUNABLE_TABLES,
  REATTACH_BUDGET_MS,
  REQUIRED_WRITE_BUDGET_MS,
  StoreBusyError,
  StoreVersionError,
  WRITE_CLASS,
  type Store,
} from "../../src/store/types.js";

describe("FantasyPlatform seam (plan 01 §8)", () => {
  it("writes are optional methods; reads are required", () => {
    expectTypeOf<
      undefined extends FantasyPlatform["setLineup"] ? true : false
    >().toEqualTypeOf<true>();
    expectTypeOf<
      undefined extends FantasyPlatform["addDrop"] ? true : false
    >().toEqualTypeOf<true>();
    type Req = {
      [K in keyof FantasyPlatform]-?: undefined extends FantasyPlatform[K] ? never : K;
    }[keyof FantasyPlatform];
    expectTypeOf<Req>().toEqualTypeOf<
      | "id"
      | "capabilities"
      | "listMyLeagues"
      | "getLeague"
      | "getScoringSettings"
      | "getRosterSlots"
      | "getRoster"
      | "listPlayers"
      | "getPlayerWeekStats"
      | "getMatchups"
      | "getStandings"
      | "listTransactions"
    >();
  });

  it("a read-only implementation type-checks without any write method", () => {
    const stub: Pick<FantasyPlatform, "id" | "capabilities"> = {
      id: "manual",
      capabilities: () =>
        Promise.resolve(
          readOnlyCapabilities(
            {
              player_stats: false,
              transactions: false,
              free_agent_pool: false,
              other_rosters: false,
              matchups: false,
            },
            "2026-09-30T00:00:00.000Z",
          ),
        ),
    };
    expect(stub.id).toBe("manual");
  });

  it("every write capability is false today, frozen", async () => {
    expect(NO_WRITES).toEqual({ lineup: false, add_drop: false, waiver: false, trade: false });
    expect(Object.isFrozen(NO_WRITES)).toBe(true);
    const caps = readOnlyCapabilities(
      {
        player_stats: true,
        transactions: true,
        free_agent_pool: true,
        other_rosters: true,
        matchups: true,
      },
      "2026-09-30T00:00:00.000Z",
    );
    expect(caps.read).toBe(true);
    expect(caps.write).toBe(NO_WRITES);
    expect(Object.isFrozen(caps)).toBe(true);
    expect(Object.isFrozen(caps.read_features)).toBe(true);
    expectTypeOf<PlatformCapabilities["read"]>().toEqualTypeOf<true>();
    await Promise.resolve();
  });

  it("player refs are opaque {platform, id}: no universal player id on the seam", () => {
    expectTypeOf<keyof PlayerRef>().toEqualTypeOf<"platform" | "id">();
    expectTypeOf<RosterSlot["class"]>().toEqualTypeOf<
      "starter" | "flex" | "bench" | "ir" | "other"
    >();
    expectTypeOf<League["rules"]["capabilities"]["tradeReviewMode"]>().toEqualTypeOf<
      "none" | "commissioner" | "league_vote" | "unknown"
    >();
    expectTypeOf<PageOf<number>["next_offset"]>().toEqualTypeOf<number | null>();
  });
});

describe("DataSource (plan 01 §8 amended by round 2 OBJ-27)", () => {
  it("publishes into a dataset writer and has no load-into-store method", () => {
    expectTypeOf<DataSource>().toHaveProperty("publish");
    expectTypeOf<DataSource>().toHaveProperty("assertSchema");
    expectTypeOf<DataSource>().toHaveProperty("license");
    expectTypeOf<DataSource>().toHaveProperty("attribution");
    expectTypeOf<DataSource>().not.toHaveProperty("load");
  });
  it("only snappy and uncompressed parquet codecs are allowed (plan 01 D7)", () => {
    expect([...ALLOWED_PARQUET_CODECS].sort()).toEqual(["SNAPPY", "UNCOMPRESSED"]);
  });
});

describe("scoring types (plan 08 §2)", () => {
  it("results carry points, complete and unmapped; lines are plain serialisable data", () => {
    expectTypeOf<ScoreResult>().toHaveProperty("points").toEqualTypeOf<number>();
    expectTypeOf<ScoreResult>().toHaveProperty("complete").toEqualTypeOf<boolean>();
    expectTypeOf<ScoreResult["unmapped"]>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<StatLine["present"]>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<ScoringSettings["rounding"]["verified"]>().toEqualTypeOf<boolean>();
    expectTypeOf<ScoringSettings["negative_floor"]["verified"]>().toEqualTypeOf<boolean>();
    const line: StatLine = {
      values: { pass_yd: 312 },
      present: ["pass_yd"],
      position_type: "O",
      provisional: false,
      source: "nflverse",
    };
    expect(JSON.parse(JSON.stringify(line))).toEqual(line);
  });
  it("the canonical seed is well-formed and unique", () => {
    expect(new Set(KNOWN_CANONICAL).size).toBe(KNOWN_CANONICAL.length);
    for (const c of KNOWN_CANONICAL) expect(CANONICAL_NAME_RE.test(c)).toBe(true);
    for (const bad of ["Pass_yd", "1st", "", "pass-yd", "a".repeat(41)])
      expect(CANONICAL_NAME_RE.test(bad)).toBe(false);
    expect(POSITION_TYPES).toEqual(["O", "K", "DT", "D"]);
  });
});

describe("analytics types (plan 07 legend, E1–E5)", () => {
  it("every Dist carries its basis", () => {
    expectTypeOf<Dist["basis"]>().toEqualTypeOf<"position_cv" | "player_sim">();
    expectTypeOf<keyof Dist>().toEqualTypeOf<
      "mean" | "p10" | "p25" | "p50" | "p75" | "p90" | "p_zero" | "basis"
    >();
  });
  it("delta_pwin is a number or the coarse {sign, band} (OBJ-04)", () => {
    expectTypeOf<DeltaPwin>().toEqualTypeOf<number | CoarseDelta>();
    expectTypeOf<CoarseDelta["band"]>().toEqualTypeOf<"small" | "medium" | "large">();
    expectTypeOf<LineupRecommendation["objective_used"]>().toEqualTypeOf<
      "mean" | "pwin" | "blend"
    >();
  });
  it("Rec.log_id is null until recorded; availability includes unknown for the manual league", () => {
    expectTypeOf<Rec["log_id"]>().toEqualTypeOf<string | null>();
    expectTypeOf<StreamingCandidate["availability"]>().toEqualTypeOf<
      "FA" | "W" | "T" | "unknown"
    >();
    expectTypeOf<MatchupWinProb["yahoo_cross_check"]>().toExtend<object | null>();
  });
});

describe("recommendation log (plan 07 E12–E14; OBJ-05, OBJ-15)", () => {
  it("the v1 retrospective has no parameter_changes_proposed", () => {
    expectTypeOf<Retrospective>().not.toHaveProperty("parameter_changes_proposed");
    expectTypeOf<Retrospective>().toHaveProperty("n_by_metric");
  });
  it("a Brier metric is a value or the literal n-too-small string", () => {
    expectTypeOf<BrierMetric>().toExtend<{ value: number; n: number } | NTooSmall>();
    expect(nTooSmall(14)).toBe("n too small (14 of 30)");
    expect(nTooSmall(3, 50)).toBe("n too small (3 of 50)");
    expect(nTooSmall(-2)).toBe("n too small (0 of 30)");
    expect(nTooSmall(NaN, NaN)).toBe("n too small (0 of 30)");
    expect(nTooSmall(2.9, 0)).toBe("n too small (2 of 30)");
    expect(DEFAULT_MIN_N).toBe(30);
  });
  it("thirteen kinds; read-back text is tagged with a valid provenance tag", () => {
    expect(RECOMMENDATION_KINDS).toHaveLength(13);
    expect(new Set(RECOMMENDATION_KINDS).size).toBe(13);
    expect(RECLOG_UNTRUSTED_SOURCE).toBe("store.recommendation_log");
    expect(SOURCE_TAG_RE.test(RECLOG_UNTRUSTED_SOURCE)).toBe(true);
  });
});

describe("crosswalk types (research 04 §D)", () => {
  it("a persisted pair is never 'none'; a decision is a tagged union", () => {
    expectTypeOf<CrosswalkPair["method"]>().toEqualTypeOf<"id" | "match" | "override">();
    expectTypeOf<MatchDecision["status"]>().toEqualTypeOf<"matched" | "ambiguous" | "unmatched">();
  });
});

describe("store contract (plan 01 §5.3, §8.2)", () => {
  it("bounded waits: 100 ms busy timeout, 1 s required-write budget, 50 ms re-attach", () => {
    expect(BUSY_TIMEOUT_MS).toBe(100);
    expect(REQUIRED_WRITE_BUDGET_MS).toBe(1000);
    expect(REATTACH_BUDGET_MS).toBe(50);
  });
  it("migration 001 lists the store tables and no ds_* dataset table", () => {
    expect(MIGRATION_001_TABLES).toHaveLength(15);
    expect(MIGRATION_001_TABLES.some((t) => t.startsWith("ds_"))).toBe(false);
    for (const t of [...NEVER_PRUNED_TABLES, ...PRUNABLE_TABLES])
      expect(MIGRATION_001_TABLES).toContain(t);
    expect(NEVER_PRUNED_TABLES.filter((t) => PRUNABLE_TABLES.includes(t))).toEqual([]);
    expect(Object.keys(WRITE_CLASS).sort()).toEqual(
      MIGRATION_001_TABLES.filter((t) => t !== "schema_version").sort(),
    );
    for (const t of NEVER_PRUNED_TABLES)
      expect(WRITE_CLASS[t as keyof typeof WRITE_CLASS]).toBe("required");
    expect(WRITE_CLASS.yahoo_cache).toBe("best_effort");
  });
  it("StoreBusyError maps to the STORE_BUSY tool error without leaking table details", () => {
    const e = new StoreBusyError("recommendation_log", 1000);
    expect(e.ffCode).toBe("STORE_BUSY");
    expect(e.table).toBe("recommendation_log");
    expect(e.waitedMs).toBe(1000);
    const r = toToolError(e, "r-0123456789ab");
    expect(r.structuredContent.error.code).toBe("STORE_BUSY");
    expect(r.content[0].text).not.toContain("recommendation_log");
  });
  it("StoreVersionError exits 1 and maps to INTERNAL", () => {
    const e = new StoreVersionError(3, 2);
    expect(e.exitCode).toBe(1);
    expect(e.message).toMatch(/newer than this binary/);
    expect(toToolError(e, "r-0123456789ab").structuredContent.error.code).toBe("INTERNAL");
  });
  it("the store exposes the domain's dataset ports and never a dataset write", () => {
    expectTypeOf<Store>().toHaveProperty("datasets");
    expectTypeOf<Store>().toHaveProperty("reattachIfChanged");
    expectTypeOf<Store>().not.toHaveProperty("load");
  });
});
