// launchd-cadence.test.ts — the refresh jobs' launchd calendars (src/cli/launchd.ts) against the
// freshness classes their sources are judged by (src/config/freshness.ts; plan 01 §5.2 / §5.4, plan 06
// §1.2). The TTL follows the cadence or the cadence follows the TTL (QA-1-036, QA-2-035): the calendar
// is expanded minute by minute in local time, as launchd fires it, and every release-basis class a job
// feeds is judged at its next scheduled check.
//   * healthy job: a check is still fresh when the next scheduled check runs;
//   * one failed run: a check is never past its hard limit when the run after the failed one comes,
//     so a single network error never turns the analytics tools STALE_ONLY.
import { describe, expect, it } from "vitest";
import { JOBS, type CalendarEntry } from "../../src/cli/launchd.js";
import {
  freshnessClass,
  isDatasetSourceId,
  SOURCE_REGISTRY,
  stampState,
  type FreshnessClass,
  type FreshnessClassId,
} from "../../src/config/freshness.js";

const MIN = 60_000;
const H = 60 * MIN;

/** Classes a source's dataset is ALSO judged by (lines live in the schedules dataset). */
const DERIVED: Readonly<Record<string, readonly FreshnessClassId[]>> = {
  "nflverse:schedules": ["lines"],
};

/** Runs `f` with the process time zone set to `zone` (Node re-reads TZ on assignment), then restores it. */
function inZone<T>(zone: string, f: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = zone;
  try {
    return f();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

const matches = (c: CalendarEntry, d: Date): boolean =>
  (c.Weekday === undefined || c.Weekday === d.getDay()) &&
  (c.Hour === undefined || c.Hour === d.getHours()) &&
  (c.Minute === undefined || c.Minute === d.getMinutes());

/** Every instant in [fromMs, toMs) at which launchd fires `calendar` (local wall-clock minutes). */
function fires(calendar: readonly CalendarEntry[], fromMs: number, toMs: number): number[] {
  const out: number[] = [];
  for (let t = fromMs; t < toMs; t += MIN) {
    const d = new Date(t);
    if (calendar.some((c) => matches(c, d))) out.push(t);
  }
  return out;
}

const stamp = (checkedMs: number) => {
  const at = new Date(checkedMs).toISOString();
  return { as_of: at, fetched_at: at, checked_at: at };
};

/** Every (job, source, class) whose class is release-based: what a successful check keeps fresh. */
function judged(): { job: string; source: string; cls: FreshnessClass }[] {
  const out: { job: string; source: string; cls: FreshnessClass }[] = [];
  for (const j of JOBS)
    for (const s of j.sources) {
      if (!isDatasetSourceId(s)) continue;
      for (const id of [SOURCE_REGISTRY[s].freshness, ...(DERIVED[s] ?? [])]) {
        const cls = freshnessClass(id);
        if (cls.basis === "release") out.push({ job: j.name, source: s, cls });
      }
    }
  return out;
}

/** Local midnight `days` days after 2026-09-27 (a Sunday, weeks before any DST change). */
const localDay = (days: number): number => new Date(2026, 8, 27 + days).getTime();

describe("refresh cadence vs freshness classes (QA-1-036, QA-2-035)", () => {
  it("the table covers every 1a release-basis class a job feeds (non-vacuity)", () => {
    const ids = new Set(judged().map((x) => x.cls.id));
    for (const id of [
      "nflverse_schedules",
      "lines",
      "nflverse_injuries",
      "nflverse_roster_weekly",
      "nflverse_stats_player_week",
    ])
      expect(ids.has(id as FreshnessClassId), id).toBe(true);
  });

  for (const zone of ["America/New_York", "UTC", "Pacific/Auckland"])
    describe(zone, () => {
      it("a healthy job: every check is still fresh when the next scheduled check runs", () => {
        inZone(zone, () => {
          const bad: string[] = [];
          for (const { job, source, cls } of judged()) {
            const spec = JOBS.find((j) => j.name === job);
            const f = fires(spec?.calendar ?? [], localDay(0), localDay(21));
            expect(f.length, job).toBeGreaterThan(20);
            for (let i = 0; i + 1 < f.length; i++) {
              const a = f[i] ?? 0;
              const b = f[i + 1] ?? 0;
              if (stampState(cls, stamp(a), b).state !== "fresh")
                bad.push(
                  `${source}/${cls.id}: ${new Date(a).toString()} -> ${String((b - a) / H)} h`,
                );
            }
          }
          expect(bad.slice(0, 5)).toEqual([]);
        });
      });

      it("one failed run: no check is past its hard limit when the run after the failed one comes", () => {
        inZone(zone, () => {
          const bad: string[] = [];
          for (const { job, source, cls } of judged()) {
            const spec = JOBS.find((j) => j.name === job);
            const f = fires(spec?.calendar ?? [], localDay(0), localDay(21));
            for (let i = 0; i + 2 < f.length; i++) {
              const a = f[i] ?? 0;
              const c = f[i + 2] ?? 0;
              if (stampState(cls, stamp(a), c).state === "expired")
                bad.push(
                  `${source}/${cls.id}: ${new Date(a).toString()} -> ${String((c - a) / H)} h`,
                );
            }
          }
          expect(bad.slice(0, 5)).toEqual([]);
        });
      });
    });

  it("injuries across the autumn DST change (America/New_York): fresh between checks, never expired after one failure", () => {
    inZone("America/New_York", () => {
      const cls = freshnessClass("nflverse_injuries");
      const spec = JOBS.find((j) => j.sources.includes("nflverse:injuries"));
      // 2026-10-25 .. 2026-11-08 local: clocks go back on 2026-11-01
      const f = fires(
        spec?.calendar ?? [],
        new Date(2026, 9, 25).getTime(),
        new Date(2026, 10, 8).getTime(),
      );
      expect(f.length).toBeGreaterThan(14);
      for (let i = 0; i + 1 < f.length; i++) {
        const a = f[i] ?? 0;
        expect(stampState(cls, stamp(a), f[i + 1] ?? 0).state, new Date(a).toString()).toBe(
          "fresh",
        );
        if (i + 2 < f.length)
          expect(stampState(cls, stamp(a), f[i + 2] ?? 0).state, new Date(a).toString()).not.toBe(
            "expired",
          );
      }
    });
  });
});
