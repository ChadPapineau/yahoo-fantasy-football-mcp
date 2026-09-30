// dedup-contract.ts — the RecommendationLogRepository deduplication contract (plan 07 E12
// `idempotentHint: true`; src/domain/reclog/types.ts RECORD_DEDUP_SCOPE; QA-1-061), framework-free
// so ANY implementation can be held to it: the in-memory reference (tests/domain/reclog/dedup.test.ts)
// and the SQLite store (tests/store). Returns every violation as a line of text; [] means it holds.
//
// The property: a record is deduplicated onto an earlier one only when their whole scope — league,
// season, week, kind AND client_ref — matches. A retry is idempotent; a new season, week or kind
// under the same client_ref is a new recommendation and must be stored (a manual league key spans
// seasons and the Skills reuse refs like `start-sit-w4-flex` every year).
import type {
  RecommendationLogRepository,
  RecordRecommendationInput,
  RecordResult,
} from "../../../src/domain/reclog/types.js";
import { input, rec } from "./helpers.js";

/** Opens a fresh, empty repository (and how to close it). */
export type OpenRepo = () =>
  | { repo: RecommendationLogRepository; close: () => void }
  | Promise<{ repo: RecommendationLogRepository; close: () => void }>;

const REF = "start-sit-w4-flex";
const t = (m: number): string =>
  new Date(Date.parse("2026-09-30T18:00:00.000Z") + m * 60_000).toISOString();

type Scenario = (
  repo: RecommendationLogRepository,
  fail: (msg: string) => void,
) => Promise<void> | void;

const base = (over: Partial<RecordRecommendationInput> = {}): RecordRecommendationInput =>
  input({ client_ref: REF, ...over });

async function expectNew(
  repo: RecommendationLogRepository,
  first: RecordResult,
  over: Partial<RecordRecommendationInput>,
  at: string,
  what: string,
  fail: (msg: string) => void,
): Promise<RecordResult> {
  const r = await repo.record(
    base({ rec: rec({ action: `the ${what} call` }), ...over }),
    at,
    null,
  );
  if (r.deduplicated) fail(`${what}: deduplicated onto an earlier row (log_id ${first.log_id})`);
  if (r.log_id === first.log_id) fail(`${what}: returned the earlier log_id`);
  if (r.recorded_at !== at) fail(`${what}: recorded_at ${r.recorded_at}, expected ${at}`);
  const got = repo.get(r.log_id);
  if (got?.rec.action !== `the ${what} call`)
    fail(`${what}: the new recommendation was not stored`);
  return r;
}

/** The named scenarios; each runs on a fresh repository. */
export const DEDUP_SCENARIOS: Readonly<Record<string, Scenario>> = Object.freeze({
  "a retry with the same scope returns the first row": async (repo, fail) => {
    const a = await repo.record(base(), t(0), null);
    const b = await repo.record(base({ rec: rec({ action: "a retried call" }) }), t(1), null);
    if (a.deduplicated) fail("retry: the first record reported deduplicated");
    if (!b.deduplicated || b.log_id !== a.log_id || b.recorded_at !== a.recorded_at)
      fail("retry: the second record did not resolve to the first row");
    if (repo.forWeek(base().league_key, 2026, 4).length !== 1)
      fail("retry: more than one row stored for one scope");
  },

  "the same client_ref next season is a new row (QA-1-061)": async (repo, fail) => {
    const a = await repo.record(base(), t(0), null);
    const at = "2027-09-29T18:00:00.000Z";
    const b = await expectNew(repo, a, { season: 2027 }, at, "next-season", fail);
    if (b.week !== 4) fail(`next-season: week ${String(b.week)}, expected 4`);
    const rows = repo.forWeek(base().league_key, 2027, 4);
    if (rows.length !== 1 || rows[0]?.season !== 2027)
      fail(`next-season: forWeek(2027, 4) holds ${String(rows.length)} rows, expected the new one`);
    const page = repo.list({
      league_key: base().league_key,
      season: 2027,
      week: null,
      kind: null,
      limit: 10,
      offset: 0,
    });
    if (page.items.length !== 1 || page.items[0]?.log_id !== b.log_id)
      fail("next-season: list(season 2027) does not show the new row");
    // and a retry of the 2027 call is idempotent onto the 2027 row, not the 2026 one
    const c = await repo.record(base({ season: 2027 }), "2027-09-29T18:05:00.000Z", null);
    if (!c.deduplicated || c.log_id !== b.log_id)
      fail("next-season: a retry of the 2027 call did not resolve to the 2027 row");
  },

  "the same client_ref in another week is a new row": async (repo, fail) => {
    const a = await repo.record(base(), t(0), null);
    const b = await expectNew(repo, a, { week: 5 }, t(1), "other-week", fail);
    if (b.week !== 5) fail(`other-week: result week ${String(b.week)}, expected 5`);
  },

  "the same client_ref under another kind is a new row": async (repo, fail) => {
    const a = await repo.record(base(), t(0), null);
    const b = await expectNew(repo, a, { kind: "stream" }, t(1), "other-kind", fail);
    if (b.kind !== "stream") fail(`other-kind: result kind ${b.kind}, expected stream`);
  },

  "the same client_ref in another league is a new row": async (repo, fail) => {
    const a = await repo.record(base(), t(0), null);
    await expectNew(repo, a, { league_key: "manual.l.other" }, t(1), "other-league", fail);
  },

  "a null client_ref is never deduplicated": async (repo, fail) => {
    const a = await repo.record(base({ client_ref: null }), t(0), null);
    const b = await repo.record(base({ client_ref: null }), t(1), null);
    if (a.deduplicated || b.deduplicated || a.log_id === b.log_id)
      fail("null client_ref: two records collapsed into one");
  },

  "concurrent records of one scope store exactly one row": async (repo, fail) => {
    const outs = await Promise.all(
      Array.from({ length: 12 }, (_, i) => repo.record(base({ season: 2028 }), t(i), null)),
    );
    if (
      new Set(outs.map((o) => o.log_id)).size !== 1 ||
      outs.filter((o) => !o.deduplicated).length !== 1
    )
      fail("concurrent: one scope produced more than one row");
  },
});

/** Runs every scenario on a fresh repository; returns the violations (`<scenario>: <what>`). */
export async function checkRecordDedupContract(open: OpenRepo): Promise<string[]> {
  const out: string[] = [];
  for (const [name, run] of Object.entries(DEDUP_SCENARIOS)) {
    const { repo, close } = await open();
    try {
      await run(repo, (msg) => out.push(`${name}: ${msg}`));
    } catch (e) {
      out.push(`${name}: threw ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      close();
    }
  }
  return out;
}
