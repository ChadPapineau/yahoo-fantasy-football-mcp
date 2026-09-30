// dedup.test.ts — src/domain/reclog/types.ts deduplication scope (plan 07 E12 `idempotentHint: true`,
// "dedup on client_ref"; critic C-04 "a manual league key spans seasons"; QA-1-061): a record
// resolves to an earlier row only when league, season, week, kind AND client_ref all match. Holds an
// in-memory reference repository built on sameRecordDedupScope to the port contract
// (dedup-contract.ts), and proves the contract is not vacuous by running it against the shipped-then
// defect — a (league_key, client_ref) scope — which it must reject.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { PageOf } from "../../../src/domain/league/types.js";
import {
  RECOMMENDATION_KINDS,
  RECORD_DEDUP_SCOPE,
  recordDedupParams,
  recordDedupScope,
  sameRecordDedupScope,
  type RecommendationListItem,
  type RecommendationLogRepository,
  type RecommendationRecord,
  type RecordRecommendationInput,
  type RecordResult,
} from "../../../src/domain/reclog/types.js";
import { checkRecordDedupContract, DEDUP_SCENARIOS } from "./dedup-contract.js";
import { input } from "./helpers.js";

/** An in-memory repository whose dedup lookup is `match(existing, incoming)`. */
function memoryLog(
  match: (a: RecordRecommendationInput, b: RecordRecommendationInput) => boolean,
): RecommendationLogRepository {
  const rows: RecommendationRecord[] = [];
  let n = 0;
  const notUsed = (): never => {
    throw new Error("not used by the dedup contract");
  };
  return {
    record(inp, recordedAt, settingsHash): Promise<RecordResult> {
      const prior = inp.client_ref === null ? undefined : rows.find((r) => match(r, inp));
      if (prior !== undefined)
        return Promise.resolve({
          log_id: prior.log_id,
          recorded_at: prior.recorded_at,
          week: prior.week,
          kind: prior.kind,
          deduplicated: true,
        });
      n += 1;
      const log_id = `rec-${String(n).padStart(26, "0")}`;
      rows.push({ ...inp, log_id, recorded_at: recordedAt, settings_hash: settingsHash });
      return Promise.resolve({
        log_id,
        recorded_at: recordedAt,
        week: inp.week,
        kind: inp.kind,
        deduplicated: false,
      });
    },
    get: (id) => rows.find((r) => r.log_id === id) ?? null,
    list(q): PageOf<RecommendationListItem> {
      const items = rows
        .filter(
          (r) =>
            r.league_key === q.league_key &&
            (q.season === null || r.season === q.season) &&
            (q.week === null || r.week === q.week) &&
            (q.kind === null || r.kind === q.kind),
        )
        .reverse()
        .map((r) => ({
          log_id: r.log_id,
          kind: r.kind,
          season: r.season,
          week: r.week,
          recorded_at: r.recorded_at,
          action_summary: r.rec.action,
          followed: null,
        }));
      return {
        items,
        limit: q.limit,
        offset: 0,
        count: items.length,
        has_more: false,
        next_offset: null,
        total: items.length,
      };
    },
    forWeek: (league, season, week) =>
      rows.filter((r) => r.league_key === league && r.season === season && r.week === week),
    recordOutcome: notUsed,
    outcome: notUsed,
  };
}

const open = (match: Parameters<typeof memoryLog>[0]) => () => ({
  repo: memoryLog(match),
  close: () => undefined,
});

describe("RECORD_DEDUP_SCOPE", () => {
  it("is league, season, week, kind and client_ref, in the store's column order, frozen", () => {
    expect(RECORD_DEDUP_SCOPE).toEqual(["league_key", "season", "week", "kind", "client_ref"]);
    expect(Object.isFrozen(RECORD_DEDUP_SCOPE)).toBe(true);
  });

  it("names only fields every record carries", () => {
    const rec = input({ client_ref: "x" });
    for (const f of RECORD_DEDUP_SCOPE) expect(Object.keys(rec)).toContain(f);
  });
});

describe("recordDedupScope / recordDedupParams", () => {
  it("is null without a client_ref, and the scope fields only (nothing else) with one", () => {
    expect(recordDedupScope(input({ client_ref: null }))).toBeNull();
    const s = recordDedupScope(input({ client_ref: "start-sit-w4-flex", season: 2027 }));
    expect(s).toEqual({
      league_key: "manual.l.example",
      season: 2027,
      week: 4,
      kind: "lineup",
      client_ref: "start-sit-w4-flex",
    });
    expect(Object.isFrozen(s)).toBe(true);
  });

  it("gives the parameters in RECORD_DEDUP_SCOPE order", () => {
    const s = recordDedupScope(input({ client_ref: "r", week: 9, kind: "stream", season: 2030 }));
    expect(s).not.toBeNull();
    if (s === null) return;
    const p = recordDedupParams(s);
    expect(p).toEqual(["manual.l.example", 2030, 9, "stream", "r"]);
    expect(Object.isFrozen(p)).toBe(true);
  });
});

describe("sameRecordDedupScope", () => {
  const ref = "start-sit-w4-flex";

  it("QA-1-061: the same client_ref in the next season is NOT the same record", () => {
    expect(
      sameRecordDedupScope(input({ client_ref: ref }), input({ client_ref: ref, season: 2027 })),
    ).toBe(false);
  });

  it("each scope field on its own separates two records", () => {
    const a = input({ client_ref: ref });
    expect(sameRecordDedupScope(a, input({ client_ref: ref }))).toBe(true);
    expect(sameRecordDedupScope(a, input({ client_ref: ref, week: 5 }))).toBe(false);
    expect(sameRecordDedupScope(a, input({ client_ref: ref, kind: "waiver" }))).toBe(false);
    expect(sameRecordDedupScope(a, input({ client_ref: ref, league_key: "manual.l.b" }))).toBe(
      false,
    );
    expect(sameRecordDedupScope(a, input({ client_ref: `${ref}-2` }))).toBe(false);
  });

  it("a null client_ref matches nothing, not even an identical record", () => {
    const a = input({ client_ref: null });
    expect(sameRecordDedupScope(a, a)).toBe(false);
    expect(sameRecordDedupScope(a, input({ client_ref: "x" }))).toBe(false);
    expect(sameRecordDedupScope(input({ client_ref: "x" }), a)).toBe(false);
  });

  it("ignores everything outside the scope (a retry may carry different numbers)", () => {
    const a = input({ client_ref: ref, note: "Wednesday", followed_hint: "unknown" });
    const b = input({ client_ref: ref, note: "Saturday", followed_hint: "user_said_yes" });
    expect(sameRecordDedupScope(a, b)).toBe(true);
  });

  it("property: same scope ⇔ every scope field equal and a client_ref present (symmetric)", () => {
    const arbIn = fc.record({
      league_key: fc.constantFrom("manual.l.example", "manual.l.other"),
      season: fc.integer({ min: 2025, max: 2028 }),
      week: fc.integer({ min: 1, max: 4 }),
      kind: fc.constantFrom(...RECOMMENDATION_KINDS.slice(0, 3)),
      client_ref: fc.option(fc.constantFrom("a", "b"), { nil: null }),
    });
    fc.assert(
      fc.property(arbIn, arbIn, (x, y) => {
        const a = input(x);
        const b = input(y);
        const expected =
          x.client_ref !== null &&
          x.client_ref === y.client_ref &&
          x.league_key === y.league_key &&
          x.season === y.season &&
          x.week === y.week &&
          x.kind === y.kind;
        return (
          sameRecordDedupScope(a, b) === expected &&
          sameRecordDedupScope(b, a) === sameRecordDedupScope(a, b)
        );
      }),
      { seed: 61, numRuns: 500 },
    );
  });
});

describe("the repository dedup contract (dedup-contract.ts)", () => {
  it("holds for a repository that deduplicates on sameRecordDedupScope", async () => {
    expect(await checkRecordDedupContract(open(sameRecordDedupScope))).toEqual([]);
  });

  it("rejects a (league_key, client_ref) scope — the QA-1-061 defect — with the season scenario named", async () => {
    const legacy = (a: RecordRecommendationInput, b: RecordRecommendationInput): boolean =>
      a.league_key === b.league_key && a.client_ref === b.client_ref;
    const v = await checkRecordDedupContract(open(legacy));
    expect(v.some((m) => m.startsWith("the same client_ref next season is a new row"))).toBe(true);
    expect(v.some((m) => m.startsWith("the same client_ref in another week"))).toBe(true);
    expect(v.some((m) => m.startsWith("the same client_ref under another kind"))).toBe(true);
    // what stays true under the defect stays green: retries, leagues, null refs, concurrency
    expect(v.some((m) => m.startsWith("a retry with the same scope"))).toBe(false);
    expect(v.some((m) => m.startsWith("the same client_ref in another league"))).toBe(false);
  });

  it("rejects a repository that never deduplicates (idempotency is part of the contract)", async () => {
    const v = await checkRecordDedupContract(open(() => false));
    expect(v.some((m) => m.startsWith("a retry with the same scope"))).toBe(true);
    expect(v.some((m) => m.startsWith("concurrent records of one scope"))).toBe(true);
  });

  it("reports a throwing repository instead of crashing, and covers every scenario", async () => {
    const v = await checkRecordDedupContract(() => ({
      repo: { ...memoryLog(sameRecordDedupScope), record: () => Promise.reject(new Error("busy")) },
      close: () => undefined,
    }));
    expect(v).toHaveLength(Object.keys(DEDUP_SCENARIOS).length);
    expect(v.every((m) => m.endsWith("threw busy"))).toBe(true);
  });
});
