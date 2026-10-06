// log-alternatives.test.ts — QA-2-041, the Skills' side: what the Skills log as `alternatives[]`
// (skills/_shared/references/log.md) must be what the weekly review can score. E13 compares an
// alternative with the call like for like (src/domain/reclog/retrospective.ts counterpartOf,
// regretAgainst), so every alternative the log contract builds — the other side of each lineup swap
// row, each other shown K/DEF candidate, holding — must have a like-for-like counterpart whose
// regret is exactly "the player it brings in minus the one it takes out". The contract's reference
// builder is scripts/skills/tool-sequences.mjs (`$alternatives`), which the shipped tool sequences
// use; the chain at the end logs the Skills' week-3 calls and scores them on week 3's final stats.
import { readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  counterpartOf,
  pointsIndex,
  regretAgainst,
} from "../../src/domain/reclog/retrospective.js";
import type { RecSubject } from "../../src/domain/analytics/types.js";
import {
  alternativeMoves,
  alternativesFrom,
  loadToolSequences,
  resolveArgs,
} from "../../scripts/skills/tool-sequences.mjs";
import { ROOT } from "./helpers.js";
import { T0, dataOf, skillWorld, type SkillWorld } from "./world.js";

type Json = Record<string, unknown>;
const GAIN = new Set(["start", "add", "stream", "trade_in"]);

/** The call's gain subjects the alternative takes out, and the ones it brings in. */
function exchanged(rec: readonly RecSubject[], alt: readonly RecSubject[]) {
  const key = (s: RecSubject) => s.player_key ?? s.gsis_id ?? s.nfl_team ?? "";
  const recIn = new Set(rec.filter((s) => GAIN.has(s.role)).map(key));
  const counterpart = counterpartOf(rec, alt) ?? [];
  const altIn = new Set(counterpart.filter((s) => GAIN.has(s.role)).map(key));
  return {
    counterpart: counterpartOf(rec, alt),
    entering: [...altIn].filter((k) => !recIn.has(k)),
    leaving: [...recIn].filter((k) => !altIn.has(k)),
  };
}

// --- generated lineup and K/DEF results --------------------------------------------------------

const subject = (key: string, role: RecSubject["role"], slot: string | null): RecSubject => ({
  player_key: key,
  gsis_id: null,
  nfl_team: null,
  role,
  slot,
});

/**
 * A lineup result: the current lineup (slots may repeat) and bench, swap / comparison rows, and the
 * call — which makes some swap rows (their `in` started in the `out`'s seat, the `out` sat, as
 * ff_analyze_lineup's rec lists them) and leaves the rest. A few rows name two starters or two
 * bench players, or have no `out` (a fill of an empty seat).
 */
const lineupResult = fc
  .record({
    slots: fc.array(fc.constantFrom("QB", "WR", "RB", "TE", "W/R/T", "K", "DEF"), {
      minLength: 2,
      maxLength: 9,
    }),
    bench: fc.integer({ min: 1, max: 6 }),
    rows: fc.array(
      fc.record({
        a: fc.nat(),
        b: fc.nat(),
        kind: fc.constantFrom("swap", "comparison"),
        applied: fc.boolean(),
        outNull: fc.boolean(),
        odd: fc.constantFrom("none", "none", "none", "both_started", "both_bench"),
      }),
      { maxLength: 6 },
    ),
  })
  .map(({ slots, bench, rows }) => {
    const seats = slots.map((sl, i) => ({ key: `manual.p.s${String(i)}`, slot: sl }));
    const benchKeys = Array.from({ length: bench }, (_, i) => `manual.p.b${String(i)}`);
    const sits: RecSubject[] = [];
    const made = rows.map((r) => {
      const seat = seats[r.a % seats.length];
      const outKey = r.odd === "both_bench" ? (benchKeys[r.a % bench] ?? "") : (seat?.key ?? "");
      const inKey =
        r.odd === "both_started"
          ? (seats[r.b % seats.length]?.key ?? "")
          : (benchKeys[r.b % bench] ?? "");
      const row = {
        out: r.outNull ? null : outKey,
        in: inKey,
        slot: seat?.slot ?? "BN",
        kind: r.kind,
      };
      // the call makes this swap: the entrant takes the seat, the starter is sat
      const free = !seats.some((x) => x.key === inKey) && !sits.some((x) => x.player_key === inKey);
      if (r.kind === "swap" && r.applied && r.odd === "none" && seat?.key === outKey && free) {
        sits.push(subject(outKey, "sit", seat.slot));
        seat.key = inKey;
      }
      return row;
    });
    return {
      data: {
        rec: {
          subjects: [...seats.map((x) => subject(x.key, "start", x.slot)), ...sits],
        },
        swaps: made.filter((r) => r.kind === "swap"),
        comparisons: made.filter((r) => r.kind === "comparison"),
      },
    };
  });

/** A K/DEF result: a hold call or a stream call over up to five candidates. */
const kdefResult = fc
  .record({ n: fc.integer({ min: 0, max: 5 }), stream: fc.boolean(), withStarter: fc.boolean() })
  .map(({ n, stream, withStarter }) => {
    const candidates = Array.from({ length: n }, (_, i) => ({
      player_key: `manual.p.def-c${String(i)}`,
      gsis_id: null,
      nfl_team: null,
    }));
    const starter = "manual.p.def-cur";
    const pick = candidates[0];
    const subjects: RecSubject[] =
      stream && pick !== undefined
        ? [
            subject(pick.player_key, "stream", null),
            ...(withStarter ? [subject(starter, "drop", null)] : []),
          ]
        : withStarter
          ? [subject(starter, "start", null)]
          : [];
    return { data: { rec: { subjects }, candidates } };
  });

describe("QA-2-041: every alternative the log contract builds is scored like for like", () => {
  const check = (result: { data: { rec: { subjects: RecSubject[] } } }, pts: number[]) => {
    const rec = result.data.rec.subjects;
    for (const m of alternativeMoves(result)) {
      const alt = m.subjects as RecSubject[];
      const { counterpart, entering, leaving } = exchanged(rec, alt);
      // a counterpart of the call's shape exists, and it swaps exactly one player for one
      expect(counterpart, JSON.stringify({ rec, alt })).not.toBeNull();
      expect(entering).toEqual([m.entrant.player_key]);
      expect(leaving.length).toBe(1);
      // its regret is that player's points minus the points of the one it takes out
      const keys = [...new Set([...rec, ...alt].map((s) => s.player_key ?? ""))];
      const at = (k: string) => pts[keys.indexOf(k) % pts.length] ?? 0;
      const index = pointsIndex(
        keys.map((k) => ({ player_key: k, gsis_id: null, nfl_team: null, points: at(k) })),
      );
      const regret = regretAgainst(rec, counterpart ?? [], index);
      expect(regret).toBeCloseTo(at(entering[0] ?? "") - at(leaving[0] ?? ""), 9);
    }
  };
  const POINTS = fc.array(fc.double({ min: -5, max: 45, noNaN: true }), {
    minLength: 1,
    maxLength: 20,
  });

  /** "<brought in>><taken out>" of each move, by the call's own gain subjects. */
  const pairs = (r: { data: { rec: { subjects: RecSubject[] } } }) =>
    new Set(
      alternativeMoves(r).map((m) => {
        const { entering, leaving } = exchanged(r.data.rec.subjects, m.subjects as RecSubject[]);
        return `${entering[0] ?? ""}>${leaving[0] ?? ""}`;
      }),
    );

  it("lineup results: the other side of every swap and comparison row", () => {
    fc.assert(
      fc.property(lineupResult, POINTS, (r, pts) => {
        check(r, pts);
        // and every row that swaps a started player for one the call does not start is offered,
        // the way round the call did not take (a made swap is offered unmade, and the reverse)
        const started = new Set(
          r.data.rec.subjects.filter((s) => s.role === "start").map((s) => s.player_key),
        );
        const want = new Set(
          [...r.data.swaps, ...r.data.comparisons]
            .filter((x) => x.out !== null && started.has(x.in) !== started.has(x.out))
            .map((x) =>
              started.has(x.in) ? `${String(x.out)}>${x.in}` : `${x.in}>${String(x.out)}`,
            ),
        );
        if (want.size <= 10) expect(pairs(r)).toEqual(want);
      }),
      { numRuns: 300 },
    );
  });

  it("K/DEF results: each other shown candidate, and holding for a stream call", () => {
    fc.assert(
      fc.property(kdefResult, POINTS, (r, pts) => {
        check(r, pts);
        const subjects = r.data.rec.subjects;
        const pick = subjects.find((s) => s.role === "stream")?.player_key;
        const starter = subjects.find((s) => s.role !== "stream")?.player_key;
        const into = pick ?? starter;
        const want = new Set(
          into === undefined || into === null
            ? []
            : [
                ...r.data.candidates
                  .slice(0, 3)
                  .filter((c) => c.player_key !== pick)
                  .map((c) => `${c.player_key}>${into}`),
                ...(pick !== undefined && starter !== undefined
                  ? [`${String(starter)}>${pick ?? ""}`]
                  : []),
              ],
        );
        expect(pairs(r)).toEqual(want);
      }),
      { numRuns: 200 },
    );
  });

  it("a row the call already plays both ways, or whose sat player it does not start, offers nothing (control)", () => {
    const starters = [subject("manual.p.s0", "start", "WR"), subject("manual.p.s1", "start", "WR")];
    const moves = alternativeMoves({
      data: {
        rec: { subjects: starters },
        swaps: [
          { out: "manual.p.b0", in: "manual.p.b1", slot: "WR" }, // neither is started
          { out: null, in: "manual.p.b2", slot: "WR" }, // fills an empty seat
        ],
        comparisons: [{ out: "manual.p.s0", in: "manual.p.b3", slot: "WR" }],
      },
    });
    expect(moves.map((m) => m.subjects.map((s) => `${s.role}:${String(s.player_key)}`))).toEqual([
      ["start:manual.p.b3", "sit:manual.p.s0"],
    ]);
  });

  it("an alternative whose brought-in player was not projected is refused, never invented (control)", () => {
    const result = {
      data: {
        rec: { subjects: [subject("manual.p.s0", "start", "WR")] },
        swaps: [],
        comparisons: [{ out: "manual.p.s0", in: "manual.p.b0", slot: "WR" }],
      },
    };
    expect(() => alternativesFrom(result, { data: { projections: [] } })).toThrow(
      /no projection of manual\.p\.b0/,
    );
  });
});

describe("QA-2-041: the shipped sequences log alternatives the review can score", () => {
  const sequences = loadToolSequences();
  const SUNDAY_WEEK4 = "2026-10-04T18:00:00.000Z";

  it("no lineup or K/DEF record logs an empty list (the six steps once all did)", () => {
    const records = sequences
      .filter((s) => ["start-sit", "stream-kdef"].includes(s.skill))
      .flatMap((s) => s.sequences.flatMap((q) => q.steps))
      .filter((st) => st.tool === "ff_record_recommendation");
    expect(records.length).toBe(4);
    for (const r of records) expect(r.args.alternatives).toHaveProperty("$alternatives");
  });

  for (const skill of ["start-sit", "stream-kdef"]) {
    for (const seq of sequences.find((s) => s.skill === skill)?.sequences ?? []) {
      it(`${skill}/${seq.id}: alternatives are like for like and accepted by ff_record_recommendation`, async () => {
        const sw = await skillWorld(seq.fixture_variant === "two-slots-locked" ? SUNDAY_WEEK4 : T0);
        try {
          const results = new Map<string, { tool: string; result: unknown }>();
          for (const step of seq.steps) {
            const args = resolveArgs(step.args, results) as Json;
            const c = await sw.call(step.tool, args);
            if (step.tool === "ff_record_recommendation") {
              expect(c.ok, JSON.stringify(c.body).slice(0, 400)).toBe(true);
              const rec = (args.rec as { subjects: RecSubject[] }).subjects;
              const alts = args.alternatives as { subjects: RecSubject[] }[];
              expect(alts.length, "the fixture's result shows options (control)").toBeGreaterThan(
                0,
              );
              for (const a of alts) expect(counterpartOf(rec, a.subjects)).not.toBeNull();
            } else if (c.ok) results.set(step.id, { tool: step.tool, result: c.body });
          }
        } finally {
          await sw.close();
        }
      }, 60_000);
    }
  }
});

describe("QA-2-041: the Skills' week-3 calls get a regret, and it is like for like", () => {
  /** A replayed week's rec is re-dated to the clock (tests/mcp/retro.test.ts: the fixture files are newer). */
  const redate = (sw: SkillWorld, rec: unknown): unknown => {
    const now = sw.world.clock.nowIso();
    const r = rec as { confidence: { inputs: { as_of: string }[] } };
    return {
      ...r,
      as_of: now,
      confidence: {
        ...r.confidence,
        inputs: r.confidence.inputs.map((i) => ({ ...i, as_of: now })),
      },
    };
  };
  const toWeek3 = (v: unknown): unknown =>
    JSON.parse(
      JSON.stringify(v)
        .replaceAll('"week":4', '"week":3')
        .replaceAll('"weeks":[4,5]', '"weeks":[3,4]')
        .replaceAll("2026-w4", "2026-w3"),
    ) as unknown;

  it("start-sit and stream-kdef logged before week 3, scored after it", async () => {
    const sw = await skillWorld("2026-09-23T12:00:00.000Z"); // Wednesday before week 3
    try {
      const logged: {
        logId: string;
        rec: RecSubject[];
        alts: { action: string; subjects: RecSubject[] }[];
      }[] = [];
      const sequences = loadToolSequences();
      for (const [skill, id] of [
        ["start-sit", "pre_game"],
        ["stream-kdef", "kicker"],
        ["stream-kdef", "defense"],
      ] as const) {
        const seq = sequences.find((s) => s.skill === skill)?.sequences.find((q) => q.id === id);
        expect(seq, `${skill}/${id}`).toBeDefined();
        const results = new Map<string, { tool: string; result: unknown }>();
        for (const step of seq?.steps ?? []) {
          let args = resolveArgs(toWeek3(step.args), results) as Json;
          if (step.tool === "ff_record_recommendation")
            args = { ...args, rec: redate(sw, args.rec) };
          const c = await sw.call(step.tool, args);
          if (step.tool === "ff_record_recommendation") {
            const d = dataOf(c);
            logged.push({
              logId: d.log_id as string,
              rec: (args.rec as { subjects: RecSubject[] }).subjects,
              alts: args.alternatives as { action: string; subjects: RecSubject[] }[],
            });
          } else if (c.ok) results.set(step.id, { tool: step.tool, result: c.body });
        }
      }
      expect(logged).toHaveLength(3);

      sw.world.clock.set("2026-10-02T15:00:00.000Z"); // week 3 is final
      const retro = dataOf(
        await sw.call("ff_analyze_retrospective", { week: 3, min_n: 1, allow_stale: true }),
      ) as {
        calls: {
          log_id: string;
          regret: number | null;
          best_alternative: string | null;
        }[];
      };

      // the oracle: each alternative's points in, minus the points of the call's player it takes out
      for (const l of logged) {
        const call = retro.calls.find((c) => c.log_id === l.logId);
        expect(call, l.logId).toBeDefined();
        const swaps = l.alts.map((a) => ({ a, ...exchanged(l.rec, a.subjects) }));
        const keys = [...new Set(swaps.flatMap((s) => [...s.entering, ...s.leaving]))];
        const stats = dataOf(
          await sw.call("ff_get_player_stats", {
            player_keys: keys,
            type: "week",
            week: 3,
            allow_stale: true,
          }),
        ) as { players: { player_key: string; engine_points: number | null }[] };
        const pts = new Map(stats.players.map((p) => [p.player_key, p.engine_points ?? 0]));
        const value = (s: (typeof swaps)[number]) =>
          (pts.get(s.entering[0] ?? "") ?? NaN) - (pts.get(s.leaving[0] ?? "") ?? NaN);
        const best = swaps.reduce((x, y) => (value(y) > value(x) ? y : x));
        expect(call?.regret, `${l.logId} has a regret`).not.toBeNull();
        expect(Math.abs((call?.regret ?? NaN) - value(best))).toBeLessThanOrEqual(0.011);
        expect(call?.best_alternative).toBe(best.a.action);
      }
    } finally {
      await sw.close();
    }
  }, 120_000);
});

describe("QA-2-041: the log guide says what the builder does", () => {
  const log = readFileSync(path.join(ROOT, "skills/_shared/references/log.md"), "utf8");
  it("names each shape's roles, the projection the numbers come from, and when the list is empty", () => {
    for (const re of [
      /\*\*A lineup\*\*[^\n]*`swaps\[\]`[^\n]*`comparisons\[\]`[^\n]*role: "start"[^\n]*role: "sit"/,
      /\*\*A kicker or defense\*\*[^\n]*role: "stream"[^\n]*role: "drop"[^\n]*role: "start"/,
      /`distribution` is his projected `points` for the week from `ff_project_players`/,
      /logs `alternatives: \[\]`/,
    ])
      expect(log).toMatch(re);
  });
});
