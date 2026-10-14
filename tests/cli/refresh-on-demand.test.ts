// refresh-on-demand.test.ts — the flags the server's answer-time child runs with (season-fresh §6.5):
// several targets (de-duplicated, schedules first); `--on-demand` (≤ 2 attempts, ≤ 2 s between them,
// a self-deadline that aborts a hung download with the previous file intact and the temp directory
// removed, the due check re-made under the run lock, failure notifications suppressed);
// `--no-migrate` and `--expect-version` refusing with exit 2 before any request and any refresh_log
// row; a 429 recorded as rate_limited with the provider paused; the `--json` shape.
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/exit.js";
import { loadRuntime } from "../../src/cli/io.js";
import { main } from "../../src/cli/main.js";
import { OSASCRIPT } from "../../src/cli/notify.js";
import { refresh, type RefreshOptions } from "../../src/cli/refresh.js";
import { openStore } from "../../src/cli/store-access.js";
import { fixtureFetch } from "../../src/cli/fixture-fetch.js";
import { runTempDir, storePath } from "../../src/config/paths.js";
import { fixedClock, type FixedClock } from "../../src/domain/clock.js";
import type { FetchLike } from "../../src/http/client.js";
import { MIGRATIONS } from "../../src/store/migrations/index.js";
import { createStoreFactory } from "../../src/store/index.js";
import { VERSION } from "../../src/version.js";
import { easternClockOf } from "../../src/config/game-calendar.js";
import { loadFixtureGames } from "../helpers/season/fixture.js";
import { REL } from "../sources/nflverse/helpers/harness.js";
import { rewrite } from "../sources/nflverse/helpers/rewrite.js";
import {
  fakeExec,
  fixtureEnv,
  FIXTURES,
  makeIo,
  sandbox,
  type Sandbox,
  type TestIo,
} from "./helpers.js";

let sb: Sandbox | undefined;
afterEach(() => {
  sb?.cleanup();
  sb = undefined;
});

const NOW = "2026-10-01T12:00:00.000Z";
const MIN = 60_000;
const INJ_TS = `${REL}/injuries/timestamp.txt`;

type Handler = (url: string, init: RequestInit) => Promise<Response> | undefined;

/** A counting transport over the fixture tree; `handler` may answer a URL first. */
function spy(handler: Handler = () => undefined): { fetch: FetchLike; calls: string[] } {
  const base = fixtureFetch(FIXTURES);
  const calls: string[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push(url);
      return handler(url, init) ?? base(url, init);
    },
  };
}

async function run(
  s: Sandbox,
  clock: FixedClock,
  targets: string[],
  o: Partial<RefreshOptions> & {
    handler?: Handler;
    platform?: NodeJS.Platform;
    exec?: TestIo["exec"];
  } = {},
): Promise<{ code: number; io: TestIo; calls: string[]; sleeps?: number[] }> {
  const io = makeIo(s, {
    env: { ...fixtureEnv(), FF_WEATHER_SOURCE: "off" },
    clock,
    ...(o.platform === undefined ? {} : { platform: o.platform }),
    ...(o.exec === undefined ? {} : { exec: o.exec }),
  });
  const { config, log } = await loadRuntime(io);
  const t = spy(o.handler);
  const code = await refresh(
    io,
    config,
    log,
    {
      targets,
      force: o.force ?? false,
      notify: o.notify ?? false,
      json: o.json ?? true,
      onDemand: o.onDemand ?? false,
      noMigrate: o.noMigrate ?? false,
      expectVersion: o.expectVersion ?? null,
      dryRun: false,
      transport: t.fetch,
      ...(o.deadlineMs === undefined ? {} : { deadlineMs: o.deadlineMs }),
      ...(o.factory === undefined ? {} : { factory: o.factory }),
    },
    new AbortController().signal,
  );
  return { code, io, calls: t.calls };
}

const refreshRows = (s: Sandbox): { source: string; ok: number; error: string | null }[] => {
  const db = new DatabaseSync(storePath(s.cacheDir), { readOnly: true });
  try {
    return db.prepare("SELECT source, ok, error FROM refresh_log ORDER BY id").all() as unknown as {
      source: string;
      ok: number;
      error: string | null;
    }[];
  } finally {
    db.close();
  }
};

describe("several targets", () => {
  it("de-duplicated and run in refresh order (schedules first), one --json document", async () => {
    sb = sandbox();
    const r = await run(sb, fixedClock(NOW), [
      "nflverse:stats_player_week",
      "nflverse:injuries",
      "nflverse:schedules",
      "nflverse:injuries",
    ]);
    expect(r.code, r.io.err.text).toBe(EXIT.OK);
    const doc = JSON.parse(r.io.out.text) as {
      target: string;
      results: { source: string; status: string }[];
    };
    expect(doc.target).toBe("nflverse:stats_player_week nflverse:injuries nflverse:schedules");
    expect(doc.results.map((x) => x.source)).toEqual([
      "nflverse:schedules",
      "nflverse:injuries",
      "nflverse:stats_player_week",
    ]);
    expect(doc.results.every((x) => x.status === "published")).toBe(true);
  }, 60_000);

  it("`due` stands alone; unknown targets and --dry-run outside `due` are usage errors", async () => {
    sb = sandbox();
    for (const argv of [
      ["refresh", "due", "nflverse:injuries"],
      ["refresh", "nflverse:injuries", "--dry-run"],
      ["refresh", "due", "--seasons", "2026"],
      ["refresh", "due", "--on-demand"],
      ["refresh", "nflverse:injuries", "bogus"],
      ["refresh", "nflverse:injuries", "--expect-version"],
    ]) {
      const io = makeIo(sb, { env: fixtureEnv() });
      expect(await main(argv, io), argv.join(" ")).toBe(EXIT.USAGE);
      expect(existsSync(sb.cacheDir), argv.join(" ")).toBe(false);
    }
  });
});

describe("--expect-version and --no-migrate refuse before any request and any refresh_log row", () => {
  it("a different version → exit 2, stderr JSON line, nothing opened or fetched", async () => {
    sb = sandbox();
    for (const v of ["0.0.1", `${VERSION}-other`, "x".repeat(200)]) {
      const r = await run(sb, fixedClock(NOW), ["nflverse:injuries"], {
        onDemand: true,
        expectVersion: v,
      });
      expect(r.code).toBe(EXIT.USAGE);
      expect(r.calls).toEqual([]);
      const line = JSON.parse(r.io.err.text.trim().split("\n").at(-1) ?? "{}") as Record<
        string,
        unknown
      >;
      expect(line).toMatchObject({ event: "refresh.version_mismatch", version: VERSION });
      expect(String(line.expected).length).toBeLessThanOrEqual(32);
    }
    expect(existsSync(storePath(sb.cacheDir))).toBe(false);
    // the matching version runs
    const ok = await run(sb, fixedClock(NOW), ["nflverse:injuries"], {
      onDemand: true,
      expectVersion: VERSION,
    });
    expect(ok.code).toBe(EXIT.OK);
  }, 60_000);

  it("a store with a pending migration (or none at all) → exit 2, nothing fetched, nothing recorded", async () => {
    sb = sandbox();
    // no store yet: the server always creates it first, so the child never does
    const none = await run(sb, fixedClock(NOW), ["nflverse:injuries"], { noMigrate: true });
    expect(none.code).toBe(EXIT.USAGE);
    expect(none.calls).toEqual([]);
    expect(none.io.err.text).toContain('"event":"refresh.migration_pending"');
    // a store one migration behind (an older binary made it)
    const old = createStoreFactory({ migrations: MIGRATIONS.slice(0, -1) });
    const io = makeIo(sb, { env: fixtureEnv() });
    const { config, log } = await loadRuntime(io);
    openStore(config, io.clock, log, { migrate: true, factory: old }).close();
    const before = refreshRows(sb);
    const r = await run(sb, fixedClock(NOW), ["nflverse:injuries"], { noMigrate: true });
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.calls).toEqual([]);
    expect(r.io.err.text).toContain('"event":"refresh.migration_pending"');
    expect(refreshRows(sb)).toEqual(before);
  }, 60_000);
});

describe("--on-demand", () => {
  it("≤ 2 attempts, ≤ 2 s apart, on a flaky upstream; the failure is not notified", async () => {
    sb = sandbox();
    const fx = fakeExec();
    const r = await run(sb, fixedClock(NOW), ["nflverse:injuries"], {
      onDemand: true,
      notify: true,
      platform: "darwin",
      exec: fx.exec,
      handler: (url) =>
        url === INJ_TS ? Promise.resolve(new Response("", { status: 503 })) : undefined,
    });
    expect(r.code).toBe(EXIT.ERROR);
    expect(r.calls.filter((u) => u === INJ_TS)).toHaveLength(2);
    expect(fx.calls.filter((c) => c.file === OSASCRIPT)).toEqual([]);
    const doc = JSON.parse(r.io.out.text) as { results: Record<string, unknown>[] };
    expect(doc.results[0]).toMatchObject({ status: "failed", error: "network", attempts: 2 });
  }, 60_000);

  it("a hung download is aborted at the self-deadline: previous file intact, temp dir removed", async () => {
    sb = sandbox();
    const clock = fixedClock(NOW);
    expect((await run(sb, clock, ["nflverse:injuries"])).code).toBe(EXIT.OK);
    const db = new DatabaseSync(storePath(sb.cacheDir), { readOnly: true });
    const current = db
      .prepare("SELECT file_version FROM refresh_log WHERE source = 'nflverse:injuries' AND ok = 1")
      .get();
    db.close();
    clock.advance(30 * MIN);
    const r = await run(sb, clock, ["nflverse:injuries"], {
      onDemand: true,
      force: true,
      deadlineMs: 300,
      handler: (url, init) =>
        url.endsWith(".parquet")
          ? new Promise<Response>((_res, rej) => {
              init.signal?.addEventListener("abort", () => {
                rej(new DOMException("aborted", "AbortError"));
              });
            })
          : undefined,
    });
    expect(r.code).toBe(EXIT.ERROR);
    const doc = JSON.parse(r.io.out.text) as { results: Record<string, unknown>[] };
    expect(doc.results[0]).toMatchObject({ status: "failed", error: "aborted" });
    const db2 = new DatabaseSync(storePath(sb.cacheDir), { readOnly: true });
    expect(
      db2
        .prepare(
          "SELECT file_version FROM refresh_log WHERE source = 'nflverse:injuries' AND ok = 1 ORDER BY id DESC LIMIT 1",
        )
        .get(),
    ).toEqual(current);
    db2.close();
    expect(readdirSync(runTempDir(sb.cacheDir))).toEqual([]);
    expect(readdirSync(path.join(sb.cacheDir, "ds")).filter((n) => n.includes(".tmp"))).toEqual([]);
  }, 60_000);

  it("re-makes the decision under the run lock: a source just checked is skipped with zero requests", async () => {
    sb = sandbox();
    const clock = fixedClock(NOW);
    expect((await run(sb, clock, ["nflverse:injuries"])).code).toBe(EXIT.OK);
    clock.advance(MIN);
    const r = await run(sb, clock, ["nflverse:injuries"], { onDemand: true });
    expect(r.code).toBe(EXIT.OK);
    expect(r.calls).toEqual([]);
    const doc = JSON.parse(r.io.out.text) as { results: Record<string, unknown>[] };
    expect(doc.results).toEqual([
      { source: "nflverse:injuries", status: "skipped", reason: "min_gap", until: null },
    ]);
    // twenty minutes later it is due again
    clock.advance(20 * MIN);
    const r2 = await run(sb, clock, ["nflverse:injuries"], { onDemand: true });
    expect(r2.calls).toContain(INJ_TS);
  }, 60_000);
});

describe("a flex published by the answer-time child is recorded and shown once (as the tick's is)", () => {
  // The child often publishes a flex first (an answer revalidates schedules before the next tick):
  // its schedules publish must diff the kickoffs, store them and notify like the tick's.
  const GAMES = `${REL}/schedules/games.parquet`;
  const SCHED_TS = `${REL}/schedules/timestamp.txt`;
  async function inZone<T>(tz: string, fn: () => Promise<T>): Promise<T> {
    const prev = process.env.TZ;
    process.env.TZ = tz;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  }
  for (const tz of ["America/Los_Angeles", "Asia/Kolkata", "Pacific/Chatham"])
    it(`a Sunday-night game flexed 12 days out (${tz}): one schedule_change row, one notification`, async () => {
      await inZone(tz, async () => {
        const games = await loadFixtureGames();
        const snf = games.find((g) => {
          if (g.season !== 2026 || g.week !== 14 || g.kickoff === null) return false;
          const c = easternClockOf(Date.parse(g.kickoff));
          return c.weekday === "Sun" && c.hour === 20;
        });
        if (snf?.kickoff == null) throw new Error("no week-14 Sunday-night game in the fixture");
        const k = Date.parse(snf.kickoff);
        sb = sandbox();
        const clock = fixedClock(k - 12 * 86_400_000 - 2 * 3_600_000);
        expect((await run(sb, clock, ["nflverse:schedules"], { json: false })).code).toBe(EXIT.OK);
        clock.advance(61 * MIN);
        const bytes = await rewrite("schedules/games.excerpt.parquet", {
          rows: (rs) =>
            rs.map((r) => (r.game_id === snf.game_id ? { ...r, gametime: "16:25" } : r)),
        });
        const release: Handler = (url) =>
          url === GAMES
            ? Promise.resolve(new Response(bytes))
            : url === SCHED_TS
              ? Promise.resolve(new Response("2026-12-01 08:46:39 EST"))
              : undefined;
        const child = async (): Promise<string[]> => {
          const fx = fakeExec();
          const r = await run(sb!, clock, ["nflverse:schedules"], {
            onDemand: true,
            notify: true,
            noMigrate: true,
            handler: release,
            platform: "darwin",
            exec: fx.exec,
          });
          expect(r.code, r.io.err.text).toBe(EXIT.OK);
          return fx.calls.filter((c) => c.file === OSASCRIPT).map((c) => c.args[1] ?? "");
        };
        const shown = await child();
        const db = new DatabaseSync(storePath(sb.cacheDir), { readOnly: true });
        const changes = db
          .prepare("SELECT game_id, kind, old_value, new_value FROM schedule_change")
          .all();
        db.close();
        expect(changes).toEqual([
          {
            game_id: snf.game_id,
            kind: "kickoff",
            old_value: new Date(k).toISOString(),
            new_value: new Date(k - (3 * 60 + 55) * MIN).toISOString(),
          },
        ]);
        expect(shown).toHaveLength(1);
        expect(shown[0]).toMatch(
          new RegExp(`NFL schedule changed: ${snf.away}@${snf.home} Sun 20:20 → Sun 16:25 ET`),
        );
        // the same release again, 61 min later: no second row, no second notification
        clock.advance(61 * MIN);
        expect(await child()).toEqual([]);
        const again = new DatabaseSync(storePath(sb.cacheDir), { readOnly: true });
        expect(again.prepare("SELECT COUNT(*) AS n FROM schedule_change").get()).toEqual({ n: 1 });
        again.close();
      });
    }, 120_000);
});

describe("a rate limit", () => {
  it("a 429 + Retry-After → failed rate_limited, nflverse paused; the next run skips with until, zero requests", async () => {
    sb = sandbox();
    const clock = fixedClock(NOW);
    const r = await run(sb, clock, ["nflverse:injuries"], {
      handler: (url) =>
        url === INJ_TS
          ? Promise.resolve(new Response("", { status: 429, headers: { "retry-after": "3600" } }))
          : undefined,
    });
    expect(r.code).toBe(EXIT.ERROR);
    expect(r.calls.filter((u) => u === INJ_TS)).toHaveLength(1);
    expect(refreshRows(sb).at(-1)).toMatchObject({ ok: 0, error: "rate_limited" });
    const db = new DatabaseSync(storePath(sb.cacheDir), { readOnly: true });
    expect(db.prepare("SELECT provider, until_at, reason FROM provider_backoff").all()).toEqual([
      { provider: "nflverse", until_at: "2026-10-01T13:00:00.000Z", reason: "rate_limited" },
    ]);
    db.close();
    clock.advance(10 * MIN);
    const again = await run(sb, clock, ["nflverse:schedules"]);
    expect(again.calls).toEqual([]);
    const doc = JSON.parse(again.io.out.text) as { results: Record<string, unknown>[] };
    expect(doc.results[0]).toEqual({
      source: "nflverse:schedules",
      status: "skipped",
      reason: "provider_backoff",
      until: "2026-10-01T13:00:00.000Z",
    });
    // --force overrides the pause for a manual run
    const forced = await run(sb, clock, ["nflverse:schedules"], { force: true });
    expect(forced.calls.length).toBeGreaterThan(0);
  }, 60_000);
});
