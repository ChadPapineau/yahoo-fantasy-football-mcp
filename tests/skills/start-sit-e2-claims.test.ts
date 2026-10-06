// start-sit-e2-claims.test.ts — QA round 2 (QA-2-038, QA-2-039, QA-2-043, QA-1-010, QA-1-020): what
// start-sit and the tool cheat-sheet say about `ff_analyze_lineup` (E2) and `ff_analyze_matchup`
// (E3) must be what the server does on the fixture league (plan 09 §2 guardrail 7; plan 07 E2/E3).
// Each claim is read from the real server, never from a paraphrase: every refusal reason the server
// gives a `force_start` is named, every clause of every `rec.action` it returns is a phrase the
// cheat-sheet quotes, an excluded starter scores 0, a points-only league gets no win probability,
// and an unmatched starter's seat is kept, named and withholds P(win).
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROOT } from "./helpers.js";
import { T0, dataOf, sentences, skillWorld, type Called, type SkillWorld } from "./world.js";

const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const START_SIT = read("skills/start-sit/SKILL.md");
const CHEAT = read("skills/_shared/references/tool-outputs.md");
/** A table row of the cheat-sheet, by tool. */
const rowOf = (tool: string): string =>
  new RegExp(`^\\| \`${tool}\` \\|.*$`, "m").exec(CHEAT)?.[0] ?? "";
const E2_ROW = rowOf("ff_analyze_lineup");
const E3_ROW = rowOf("ff_analyze_matchup");
/** The `ff_analyze_lineup` text of the cheat-sheet: its table row and the paragraph about it. */
const E2_TEXT = [E2_ROW, /^\*\*`ff_analyze_lineup`[^\n]*$/m.exec(CHEAT)?.[0] ?? ""].join("\n");

/** Sunday of week 4, after the 13:00 ET kickoffs and before the 16:05/16:25 ET ones. */
const SUNDAY_WEEK4 = "2026-10-04T18:00:00.000Z";

type Json = Record<string, unknown>;
interface RosterRow {
  player_key: string;
  slot: string;
  name: unknown;
  lock_at: string | null;
  is_editable: boolean;
}
const nameOf = (r: RosterRow): string => JSON.stringify(r.name);
const errorOf = (c: Called): { code: string; field?: string; reason?: string; hint?: string } =>
  (c.body as { error: { code: string; field?: string; reason?: string; hint?: string } }).error;

describe("E2 force_start refusals (QA-1-010): every reason the server gives is named", () => {
  let sw: SkillWorld;
  let sunday: SkillWorld;
  const reasons = new Map<string, string>();
  beforeAll(async () => {
    sw = await skillWorld(T0);
    sunday = await skillWorld(SUNDAY_WEEK4);
    const roster = dataOf(await sw.call("ff_get_roster", { week: 4 })).players as RosterRow[];
    const key = (n: string): string => {
      const r = roster.find((p) => nameOf(p).includes(n));
      if (r === undefined) throw new Error(`no ${n} on the fixture roster`);
      return r.player_key;
    };
    const refusal = async (w: SkillWorld, args: Json): Promise<void> => {
      const c = await w.call("ff_analyze_lineup", { week: 4, ...args });
      expect(c.code, JSON.stringify(args)).toBe("VALIDATION");
      const e = errorOf(c);
      reasons.set(e.reason ?? "", JSON.stringify(args));
    };
    // on IR: the fixture's IR slot holds an Out receiver
    await refusal(sw, { force_start: [key("Nico Collins")] });
    // four running backs for two RB seats and one flex
    await refusal(sw, {
      force_start: [key("Gibbs"), key("Henry"), key("Walker"), key("Jeanty")],
    });
    // forced and excluded at once
    await refusal(sw, { force_start: [key("Gibbs")], exclude: [key("Gibbs")] });
    // a reserve whose game has started (Sunday, after the early kickoffs)
    const sRoster = dataOf(await sunday.call("ff_get_roster", { week: 4 })).players as RosterRow[];
    const lockedReserve = sRoster.find(
      (p) =>
        p.slot === "BN" && p.lock_at !== null && Date.parse(p.lock_at) <= Date.parse(SUNDAY_WEEK4),
    );
    expect(lockedReserve, "a reserve whose game has started on the Sunday clock").toBeDefined();
    await refusal(sunday, { force_start: [lockedReserve?.player_key] });
  }, 120_000);
  afterAll(async () => {
    await sw.close();
    await sunday.close();
  });

  it("the server refuses the four cases with four distinct reasons", () => {
    expect(reasons.size, JSON.stringify([...reasons])).toBe(4);
  });

  it("the cheat-sheet's ff_analyze_lineup text names each reason", () => {
    expect(E2_ROW).not.toBe("");
    for (const [reason, args] of reasons)
      expect(E2_TEXT, `${reason} (${args})`).toContain(`\`${reason}\``);
  });
});

describe("E3 in a league without head-to-head matchups (QA-2-043)", () => {
  let sw: SkillWorld;
  let e3: Called;
  let e2: Json;
  beforeAll(async () => {
    sw = await skillWorld(T0, [["scoring_type: head", "scoring_type: point"]]);
    e3 = await sw.call("ff_analyze_matchup", { week: 3 });
    e2 = dataOf(await sw.call("ff_analyze_lineup", { week: 3, objective: "pwin" }));
  }, 120_000);
  afterAll(async () => {
    await sw.close();
  });

  it("the server refuses E3 with NOT_FOUND and E2 withholds P(win), objective mean", () => {
    expect(e3.code).toBe("NOT_FOUND");
    expect(errorOf(e3).hint).toMatch(/head-to-head/);
    expect(e2.objective_used).toBe("mean");
    expect(e2.p_win_before).toBeNull();
  });

  it("the cheat-sheet's ff_analyze_matchup row says so", () => {
    expect(E3_ROW).toMatch(/`NOT_FOUND`[^|]*head-to-head|head-to-head[^|]*`NOT_FOUND`/);
  });

  it("start-sit reports P(win) only in a head-to-head league", () => {
    const pwin = sentences(START_SIT).filter((s) => s.includes("P(win) before and after"));
    expect(pwin.length).toBeGreaterThan(0);
    for (const s of pwin) expect(s).toMatch(/head-to-head/);
  });
});

describe("E2 and E3 with a starter the NFL data does not match (QA-2-039, QA-2-046)", () => {
  let sw: SkillWorld;
  let e2: Json;
  let e3: Called;
  beforeAll(async () => {
    // week 3 has an opponent in the fixture, so only the unmatched seat can withhold P(win)
    sw = await skillWorld(T0, [
      [
        `{ name: Jaxon Smith-Njigba, team: SEA, position: WR, gsis_id: "00-0038543", slot: W/R/T }`,
        `{ name: Jaxon Smith-Njgba, team: SEA, position: WR, slot: W/R/T }`,
      ],
    ]);
    e2 = dataOf(await sw.call("ff_analyze_lineup", { week: 3 }));
    e3 = await sw.call("ff_analyze_matchup", { week: 3 });
  }, 120_000);
  afterAll(async () => {
    await sw.close();
  });

  it("the server keeps the seat, names it in rec.assumptions and withholds P(win)", () => {
    expect(e2.p_win_before).toBeNull();
    const rec = e2.rec as { assumptions: { text: string }[] };
    expect(
      rec.assumptions.some((a) => a.text.includes("W/R/T") && a.text.includes("does not match")),
    ).toBe(true);
  });

  it("E3 refuses with NOT_FOUND rather than score the seat 0, and the cheat-sheet and start-sit say so", () => {
    expect(e3.code).toBe("NOT_FOUND");
    expect(errorOf(e3).hint).toMatch(/matches no NFL player/);
    expect(E3_ROW).toMatch(/`NOT_FOUND`[^|]*does not match/);
    const claim = sentences(START_SIT).find(
      (s) => s.includes("ff_analyze_matchup") && /does not match|unmatched/.test(s),
    );
    expect(claim).toBeDefined();
    expect(claim).toMatch(/NOT_FOUND|refuses/);
  });

  it("start-sit and the cheat-sheet say the seat is kept, named in rec.assumptions, P(win) withheld", () => {
    for (const [label, text] of [
      ["start-sit", START_SIT],
      ["cheat-sheet", E2_TEXT],
    ] as const) {
      const claim = sentences(text).find(
        (s) =>
          /does not match|unmatched/i.test(s) &&
          s.includes("seat") &&
          s.includes("rec.assumptions"),
      );
      expect(claim, label).toBeDefined();
      expect(claim, label).toMatch(/P\(win\)/);
      expect(claim, label).toMatch(/not filled|never filled|kept/);
    }
  });
});

/** A `rec.action` clause as a form: numbers to N, plurals to the singular. */
const formOf = (clause: string): string =>
  clause
    .trim()
    .toLowerCase()
    .replace(/\d+/g, "N")
    .replace(/\b(change|flip|slot|starter)s\b/g, "$1")
    .replace(/\bthat gain\b/g, "that gains");
/** The clauses of an action: "a, b and c" → [a, b, c]. */
const clausesOf = (action: string): string[] => action.split(/, | and /).filter((c) => c !== "");

describe("E2 rec.action (QA-1-020, QA-2-038): every clause the server returns is a form the cheat-sheet quotes", () => {
  const observed = new Map<string, string>();
  beforeAll(async () => {
    const sw = await skillWorld(T0);
    try {
      const roster = dataOf(await sw.call("ff_get_roster", { week: 4 })).players as RosterRow[];
      const key = (n: string): string =>
        roster.find((p) => nameOf(p).includes(n))?.player_key ?? `missing ${n}`;
      const cases: [string, Json][] = [
        ["week 3", { week: 3 }],
        ["week 4", { week: 4 }],
        ["week 6, Boswell excluded (no other kicker)", { week: 6, exclude: [key("Boswell")] }],
        ["week 7 (Allen on bye)", { week: 7 }],
        ["week 8", { week: 8 }],
        ["week 4, Gibbs excluded", { week: 4, exclude: [key("Gibbs")] }],
        ["week 4, Henry and Gibbs excluded", { week: 4, exclude: [key("Henry"), key("Gibbs")] }],
        ["week 4, Walker forced", { week: 4, force_start: [key("Walker")] }],
      ];
      for (const [label, args] of cases) {
        const c = await sw.call("ff_analyze_lineup", args);
        const action = (dataOf(c).rec as { action: string }).action;
        for (const clause of clausesOf(action)) observed.set(formOf(clause), `${label}: ${action}`);
      }
    } finally {
      await sw.close();
    }
  }, 180_000);

  it("the fixture cases reach a move, a held coin flip and no move", () => {
    const forms = [...observed.keys()];
    expect(
      forms.some((f) => f.startsWith("make N")),
      forms.join(" | "),
    ).toBe(true);
    expect(
      forms.some((f) => f.startsWith("hold N")),
      forms.join(" | "),
    ).toBe(true);
    expect(forms).toContain("keep the current lineup");
  });

  it("plan 07 E2's implementation rules quote a form for each outcome the server returned", () => {
    const rules =
      /^- \*\*Implementation rules \(QA round 2[^\n]*$/m.exec(
        read("docs/plan/07-tool-catalog.md"),
      )?.[0] ?? "";
    const quoted = new Set(
      [...rules.matchAll(/"([^"]+)"/g)].flatMap((m) => clausesOf(m[1] ?? "").map(formOf)),
    );
    for (const verb of ["make", "hold", "skip"])
      if ([...observed.keys()].some((f) => f.startsWith(`${verb} N`)))
        expect(
          [...quoted].some((q) => q.startsWith(`${verb} N`)),
          verb,
        ).toBe(true);
  });

  it("the cheat-sheet quotes each form the server returned", () => {
    const quoted = new Set(
      [...E2_TEXT.matchAll(/"([^"]+)"/g)].flatMap((m) => clausesOf(m[1] ?? "").map(formOf)),
    );
    for (const [form, where] of observed) expect([...quoted], where).toContain(form);
  });
});

describe("E2 exclude (QA-2-038): an excluded player is read as one ruled out (status O)", () => {
  const STARTERS = [
    ["Gibbs", `{ name: Jahmyr Gibbs, team: DET, position: RB, gsis_id: "00-0039139", slot: RB }`],
    ["Chase", `{ name: Ja'Marr Chase, team: CIN, position: WR, gsis_id: "00-0036900", slot: WR }`],
  ] as const;

  it.each(STARTERS)(
    "%s: exclude and status O give the same call",
    async (name, line) => {
      const plain = await skillWorld(T0);
      const out = await skillWorld(T0, [[line, line.replace(" }", ", status: O }")]]);
      try {
        const roster = dataOf(await plain.call("ff_get_roster", { week: 4 }))
          .players as RosterRow[];
        const k = roster.find((p) => nameOf(p).includes(name))?.player_key;
        const ex = dataOf(await plain.call("ff_analyze_lineup", { week: 4, exclude: [k] }));
        const o = dataOf(await out.call("ff_analyze_lineup", { week: 4 }));
        const call = (d: Json) => {
          const rec = d.rec as { action: string; lineup: unknown; no_move: boolean };
          return { action: rec.action, lineup: rec.lineup, no_move: rec.no_move };
        };
        expect(call(ex)).toEqual(call(o));
      } finally {
        await plain.close();
        await out.close();
      }
    },
    120_000,
  );

  it("the cheat-sheet and start-sit say an excluded player scores 0, as status O does", () => {
    for (const [label, text] of [
      ["cheat-sheet", E2_TEXT],
      ["start-sit", START_SIT],
    ] as const) {
      const claim = sentences(text).find((s) => /exclude/i.test(s) && s.includes("scores 0"));
      expect(claim, label).toBeDefined();
      expect(claim, label).toMatch(/status: O|Out designation/);
    }
  });
});

describe("E2 with a starter who will not play and no one to replace him (QA-2-038)", () => {
  let e2: Json;
  beforeAll(async () => {
    const sw = await skillWorld(T0);
    try {
      const roster = dataOf(await sw.call("ff_get_roster", { week: 4 })).players as RosterRow[];
      const k = roster.find((p) => nameOf(p).includes("Boswell"))?.player_key;
      // the fixture rosters one kicker: excluded, his seat has no replacement
      e2 = dataOf(await sw.call("ff_analyze_lineup", { week: 6, exclude: [k] }));
    } finally {
      await sw.close();
    }
  }, 120_000);

  it("the server leaves him out of rec.lineup and names the seat, pointing at streaming", () => {
    const rec = e2.rec as {
      lineup: { slot: string }[];
      assumptions: { text: string; revisit_trigger: string }[];
    };
    expect(rec.lineup.some((r) => r.slot === "K")).toBe(false);
    const note = rec.assumptions.find((a) => /\bK\b/.test(a.text) && /scores? 0/.test(a.text));
    expect(note, JSON.stringify(rec.assumptions)).toBeDefined();
    expect(note?.revisit_trigger).toMatch(/ff_analyze_waivers/);
  });

  it("start-sit says such a seat scores 0, is named, and a K or DEF seat is streamed", () => {
    const claim = sentences(START_SIT).find(
      (s) => s.includes("rec.lineup") && s.includes("scores 0"),
    );
    expect(claim).toBeDefined();
    expect(claim).toMatch(/stream/);
  });
});
