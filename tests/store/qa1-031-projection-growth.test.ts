// qa1-031-projection-growth.test.ts — [QA-1-031, QA-1-081] the never-pruned projection table grows
// with what the retrospective can use, not with how often a tool is called. Plan 01 §5.1/§5.6 (the
// store is bounded: < 100 MB a season), plan 02 §5 (per-call resource bounds), plan 08 §5 (samples
// stored "compressed"). Two properties:
//  1. A run whose recorded inputs (inputs_as_of + expectation, per subject/season/week/model) equal
//     the newest earlier row's adds NO row: getAsOf(before) still answers with a projection made
//     from exactly those inputs, so the retrospective's pre-lock read is unchanged (critic C-03).
//  2. The samples column is losslessly compressed: an engine-shaped batch of count stats (K/DEF)
//     is many times smaller than the raw f64 matrix, and nothing round-trips inexactly.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StatLine, StoredProjection } from "../../src/domain/scoring/types.js";
import { decodeSamples, encodeSamples } from "../../src/store/repos/samples-codec.js";
import type { Store } from "../../src/store/types.js";
import { openStore, tempCache, type TempCache } from "./helpers/env.js";

let t: TempCache;
let s: Store;
beforeEach(() => {
  t = tempCache();
  s = openStore(t);
});
afterEach(() => {
  s.close();
  t.cleanup();
});

const iso = (min: number): string =>
  new Date(Date.parse("2026-10-04T12:00:00.000Z") + min * 60_000).toISOString();
const AS_OF = "2026-10-04T09:00:00.000Z";

/** A seeded LCG, so every "call" draws fresh but reproducible samples. */
function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}
const poisson = (r: () => number, mean: number): number => {
  const l = Math.exp(-mean);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= r();
  } while (p > l);
  return k - 1;
};
const DEF_KEYS = [
  "dst_blk",
  "dst_fum_rec",
  "dst_int",
  "dst_pa",
  "dst_ret_td",
  "dst_sack",
  "dst_safety",
  "dst_td",
  "dst_ya",
];
/** A defence batch shaped like the engine's: integer counts, one shared `present`. */
function defenseLines(seed: number, n = 1000): StatLine[] {
  const r = rng(seed);
  return Array.from({ length: n }, () => ({
    values: {
      dst_blk: poisson(r, 0.1),
      dst_fum_rec: poisson(r, 0.6),
      dst_int: poisson(r, 0.8),
      dst_pa: Math.round(21 * (0.5 + r())),
      dst_ret_td: poisson(r, 0.05),
      dst_sack: poisson(r, 2.4),
      dst_safety: poisson(r, 0.03),
      dst_td: poisson(r, 0.15),
      dst_ya: Math.round(330 * (0.6 + 0.8 * r())),
    },
    present: DEF_KEYS,
    position_type: "DT" as const,
    provisional: false,
    source: "projection:v1-trailing",
  }));
}
const PLAYER_KEYS = ["rec", "rec_td", "rec_yd", "targets"];
/** A player batch shaped like the engine's: mean × one gamma-ish multiplier, some inactive lines. */
function playerLines(seed: number, n = 1000): StatLine[] {
  const r = rng(seed);
  const empty: StatLine = {
    values: {},
    present: [],
    position_type: "O",
    provisional: false,
    source: "projection:v1-trailing",
  };
  return Array.from({ length: n }, () => {
    if (r() < 0.05) return empty;
    const g = -Math.log(1 - r());
    return {
      values: { rec: 5.1 * g, rec_td: 0.42 * g, rec_yd: 61.7 * g, targets: 7.3 * g },
      present: PLAYER_KEYS,
      position_type: "O" as const,
      provisional: false,
      source: "projection:v1-trailing",
    };
  });
}

const DEF = { kind: "defense", nfl_team: "DET" } as const;
const run = (
  made: number,
  seed: number,
  over: Partial<StoredProjection> = {},
): StoredProjection => ({
  subject: DEF,
  season: 2026,
  week: 5,
  model_version: "v1-trailing",
  made_at: iso(made),
  inputs_as_of: AS_OF,
  expectation: { dst_pa: 21, dst_sack: 2.4, dst_ya: 330 },
  samples: defenseLines(seed),
  ...over,
});

const table = (): { n: number; bytes: number } => {
  const db = new DatabaseSync(t.storePath, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(samples_json)), 0) AS bytes FROM projection",
      )
      .get() as { n: number; bytes: number };
  } finally {
    db.close();
  }
};

describe("[QA-1-031/QA-1-081] identical runs do not grow the projection table", () => {
  it("the same call repeated 20× (fresh random samples each time) stores one row", () => {
    expect(s.repos.projections.put(run(0, 1))).toEqual({ written: true });
    const once = table();
    for (let i = 1; i <= 20; i++)
      expect(s.repos.projections.put(run(i, 1 + i))).toEqual({ written: true });
    expect(table()).toEqual(once);
  });

  it("getAsOf after a collapsed repeat answers from a run made with exactly those inputs", () => {
    const p = s.repos.projections;
    p.put(run(0, 1));
    p.put(run(30, 2)); // same inputs: collapsed
    const got = p.getAsOf(DEF, 2026, 5, "v1-trailing", iso(45));
    expect(got?.made_at).toBe(iso(0));
    expect(got?.inputs_as_of).toBe(AS_OF);
    expect(got?.expectation).toEqual(run(0, 1).expectation);
    expect(got?.samples).toEqual(run(0, 1).samples);
    expect(p.getAsOf(DEF, 2026, 5, "v1-trailing", iso(0))).toBeNull(); // nothing before the first run
  });

  it("new inputs (a refresh) or a new expectation append a row; getAsOf still never sees a later run", () => {
    const p = s.repos.projections;
    p.put(run(0, 1));
    p.put(run(10, 2, { inputs_as_of: "2026-10-04T11:00:00.000Z" }));
    p.put(
      run(20, 3, {
        inputs_as_of: "2026-10-04T11:00:00.000Z",
        expectation: { dst_pa: 24, dst_sack: 2.1, dst_ya: 345 },
      }),
    );
    expect(table().n).toBe(3);
    expect(p.getAsOf(DEF, 2026, 5, "v1-trailing", iso(5))?.made_at).toBe(iso(0));
    expect(p.getAsOf(DEF, 2026, 5, "v1-trailing", iso(15))?.made_at).toBe(iso(10));
    expect(p.getAsOf(DEF, 2026, 5, "v1-trailing", iso(25))?.made_at).toBe(iso(20));
  });

  it("only CONSECUTIVE duplicates collapse: A, B, then A's inputs again appends (getAsOf must see the change back)", () => {
    const p = s.repos.projections;
    p.put(run(0, 1));
    p.put(run(10, 2, { expectation: { dst_pa: 30, dst_sack: 1, dst_ya: 400 } }));
    p.put(run(20, 3));
    expect(table().n).toBe(3);
    expect(p.getAsOf(DEF, 2026, 5, "v1-trailing", iso(25))?.expectation).toEqual(
      run(0, 1).expectation,
    );
    expect(p.getAsOf(DEF, 2026, 5, "v1-trailing", iso(25))?.made_at).toBe(iso(20));
  });

  it("a run made BEFORE the newest row (clock skew) is compared with its own predecessor, never a later row", () => {
    const p = s.repos.projections;
    p.put(run(20, 1));
    p.put(run(10, 2)); // same inputs as the LATER row, but nothing precedes it: kept
    expect(table().n).toBe(2);
    expect(p.getAsOf(DEF, 2026, 5, "v1-trailing", iso(15))?.made_at).toBe(iso(10));
  });

  it("other subjects, weeks, seasons and model versions never collapse into each other", () => {
    const p = s.repos.projections;
    p.put(run(0, 1));
    p.put(run(1, 1, { subject: { kind: "defense", nfl_team: "GB" } }));
    p.put(run(2, 1, { week: 6 }));
    p.put(run(3, 1, { season: 2025 }));
    p.put(run(4, 1, { model_version: "v2-opportunity" }));
    expect(table().n).toBe(5);
  });
});

describe("[QA-1-031/QA-1-081] the samples column is compressed losslessly", () => {
  it("a 1 000-line defence batch (integer counts) stores in under 1/5 of its raw f64 matrix", () => {
    const lines = defenseLines(7);
    const text = encodeSamples(lines);
    const raw = lines.length * DEF_KEYS.length * 8;
    expect(text.length).toBeLessThan(raw / 5);
    expect(decodeSamples(text)).toEqual(lines);
  });

  it("a continuous player batch round-trips exactly and is never larger than the raw f64 matrix as base64", () => {
    const lines = playerLines(11);
    const text = encodeSamples(lines);
    expect(decodeSamples(text)).toEqual(lines);
    expect(text.length).toBeLessThanOrEqual(
      Math.ceil((lines.length * PLAYER_KEYS.length * 8 * 4) / 3) + 400,
    );
  });

  it("the stored table: 32 defence-weeks over 6 identical calls stay under 1 MB (was ~3 MB per call)", () => {
    const teams = ["ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE"] as const;
    for (let call = 0; call < 6; call++)
      for (const [i, team] of teams.entries())
        for (const week of [5, 6, 7, 8])
          s.repos.projections.put(
            run(call, 1000 * call + 10 * i + week, {
              subject: { kind: "defense", nfl_team: team },
              week,
            }),
          );
    const { n, bytes } = table();
    expect(n).toBe(32);
    expect(bytes).toBeLessThan(1_000_000);
  });
});
