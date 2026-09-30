// single-flight.test.ts — two refreshes of one release never both publish (plan 01 §5.7 single-flight;
// plan 06 §1.2 per-job lock). Gate round 1 regression: `ff refresh` × 2 concurrently, under load, both
// printed "published" — each checked "unchanged" BEFORE the job lock, and the second reached the
// publisher only after the first had published and released it. The runner now asks the publisher to
// re-make the check under the lock (`skipIfCurrent`). The interleaving is forced here (the second
// refresh's fetch waits for the first to finish), against the REAL publisher and refresh log.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import {
  fsTempArea,
  runRefresh,
  type RefreshDeps,
  type RefreshResult,
} from "../../../src/sources/runner.js";
import type { HttpGet } from "../../../src/sources/source.js";
import {
  PUBLISH_ALREADY_CURRENT,
  type DatasetPublisher,
  type PublishOptions,
  type Store,
} from "../../../src/store/types.js";
import { injuryRows } from "../../store/helpers/datasets.js";
import { openPublisher, openStore, tempCache, type TempCache } from "../../store/helpers/env.js";
import { fakePublisher, fakeSchedules, fakeSource, game, STATS } from "./helpers.js";

const NOW = "2026-10-01T12:00:00.000Z";
const noHttp: HttpGet = () => Promise.reject(new Error("no network in this test"));

let t: TempCache;
let store: Store;
let pub: DatasetPublisher;
let root = "";
beforeEach(async () => {
  t = tempCache("ff-single-flight-");
  store = openStore(t);
  pub = openPublisher(t);
  root = await mkdtemp(join(tmpdir(), "ff-sf-tmp-"));
});
afterEach(async () => {
  pub.close();
  store.close();
  t.cleanup();
  await rm(root, { recursive: true, force: true });
});

function deps(publisher: DatasetPublisher): RefreshDeps {
  return {
    http: noHttp,
    clock: fixedClock(NOW),
    rng: seededRng(7),
    publisher,
    refreshLog: store.repos.refreshLog,
    schedules: fakeSchedules([game("2026_05_DAL_CLE", "2026-10-04T17:00:00.000Z")]),
    temp: fsTempArea(join(root, "tmp")),
    sleep: () => Promise.resolve(),
  };
}

/** An injuries source that fills the real contract tables, tagged so the file says who wrote it. */
function injuries(
  tag: string,
  beforeFetch: () => Promise<void> = () => Promise.resolve(),
  onVersion: () => void = () => undefined,
) {
  return fakeSource({
    version: () => {
      onVersion();
      return Promise.resolve({
        version: "2026-09-30T13:36:27Z",
        released_at: "2026-09-30T13:36:27.000Z",
      });
    },
    fetch: async (_v, ctx) => {
      await beforeFetch();
      return [{ path: join(ctx.tempDir ?? root, "x.parquet"), bytes: 1, season: 2026 }];
    },
    publish: (_files, w) => {
      let n = 0;
      for (const tr of injuryRows()) {
        w.createTable(tr.spec);
        n += w.insert(
          tr.spec.name,
          tr.rows.map((r) => ({ ...r, report_primary_injury: tag })),
        );
      }
      return Promise.resolve({ ...STATS, rows: n, tables: [{ name: "ds_injuries", rows: n }] });
    },
  });
}

const okRows = (): number => {
  const db = new DatabaseSync(t.storePath, { readOnly: true });
  const r = db
    .prepare("SELECT COUNT(*) AS n FROM refresh_log WHERE source = 'nflverse:injuries' AND ok = 1")
    .get() as { n: number };
  db.close();
  return r.n;
};
const writer = (): string[] => {
  const db = new DatabaseSync(join(t.datasetDir, "nflverse__injuries.sqlite"), { readOnly: true });
  const r = db.prepare("SELECT DISTINCT report_primary_injury AS t FROM ds_injuries").all() as {
    t: string;
  }[];
  db.close();
  return r.map((x) => x.t);
};

describe("two refreshes of one release: exactly one publishes", () => {
  it("the second, having checked 'unchanged' before the first published, reports unchanged — not a second publish", async () => {
    let firstDone!: () => void;
    const first = new Promise<void>((r) => (firstDone = r));
    // B checks the refresh log (nothing yet), then its fetch waits until A has published AND
    // released the job lock — the interleaving the loaded coverage run produced
    let bVersioned!: () => void;
    const versioned = new Promise<void>((r) => (bVersioned = r));
    const b = runRefresh(
      {
        source: injuries(
          "B",
          () => first,
          () => {
            bVersioned();
          },
        ),
        seasons: [2026],
        week: null,
      },
      deps(pub),
    );
    await versioned;
    await new Promise((r) => setImmediate(r)); // B's "unchanged" check (sync, after version) ran
    expect(okRows()).toBe(0); // …and saw nothing published
    const a = await runRefresh({ source: injuries("A"), seasons: [2026], week: null }, deps(pub));
    firstDone();
    const rb: RefreshResult = await b;
    expect(a.status).toBe("published");
    expect(rb.status).toBe("unchanged");
    expect(okRows()).toBe(1);
    expect(writer()).toEqual(["A"]);
  });

  it("--force still republishes the same release", async () => {
    await runRefresh({ source: injuries("A"), seasons: [2026], week: null }, deps(pub));
    const f = await runRefresh(
      { source: injuries("F"), seasons: [2026], week: null, force: true },
      deps(pub),
    );
    expect(f.status).toBe("published");
    expect(okRows()).toBe(2);
    expect(writer()).toEqual(["F"]);
  });
});

describe("the runner asks for the under-lock check exactly when 'unchanged' applies", () => {
  const spy = () => {
    const inner = fakePublisher();
    const seen: (PublishOptions | undefined)[] = [];
    const p: DatasetPublisher = {
      ...inner,
      publish(source, version, released, fill, options) {
        seen.push(options);
        return inner.publish(source, version, released, fill);
      },
    };
    return { p, seen };
  };

  it("release + no force → skipIfCurrent; --force or a time-bucket source → never", async () => {
    const { p, seen } = spy();
    await runRefresh({ source: fakeSource(), seasons: [2026], week: null }, deps(p));
    await runRefresh({ source: fakeSource(), seasons: [2026], week: null, force: true }, deps(p));
    await runRefresh(
      {
        source: fakeSource({
          id: "weather:open_meteo",
          versioning: "time_bucket",
          version: () => Promise.resolve({ version: "2026-10-01T12", released_at: null }),
        }),
        seasons: [2026],
        week: 5,
      },
      deps(p),
    );
    expect(seen).toEqual([
      { skipIfCurrent: true },
      { skipIfCurrent: false },
      { skipIfCurrent: false },
    ]);
  });

  it("a publisher answering already_current is an 'unchanged' result, a success, with temp cleaned", async () => {
    const r = await runRefresh(
      { source: fakeSource(), seasons: [2026], week: null },
      deps(fakePublisher(() => ({ ok: false, error: PUBLISH_ALREADY_CURRENT }))),
    );
    expect(r.status).toBe("unchanged");
    if (r.status === "unchanged") expect(r.version.version).toBe("2026-09-30T13:36:27Z");
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(join(root, "tmp")).catch(() => [])).toEqual([]);
  });

  it("an error that merely starts with already_current is not read as unchanged", async () => {
    const r = await runRefresh(
      { source: fakeSource(), seasons: [2026], week: null },
      deps(fakePublisher(() => ({ ok: false, error: `${PUBLISH_ALREADY_CURRENT}_x` }))),
    );
    expect(r.status).toBe("failed");
  });
});
