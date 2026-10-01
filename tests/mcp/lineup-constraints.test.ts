// lineup-constraints.test.ts — E2's user constraints are honoured or refused VISIBLY (QA-1-010; plan
// 02 §5 strict argument validation; plan 07 E2 `compare` evaluates a legal swap): a force_start /
// exclude / compare key that is not on the target roster, a player both forced and excluded, a
// compare whose `out` is not a starter or whose `in` cannot play that slot are coded VALIDATION
// errors naming the argument; a legal comparison is reported in `comparisons[]`, apart from the
// recommended `swaps[]` that rec.action counts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitComparisons } from "../../src/mcp/tools/analytics.js";
import { TEAM_B, connect, makeWorld, type World } from "./helpers/env.js";

const ALLEN = "manual.p.00-0034857"; // QB, starter (Team A)
const CHASE = "manual.p.00-0036900"; // WR, starter (Team A)
const K_ALLEN = "manual.p.00-0030279"; // WR, bench (Team A)
const LOVE = "manual.p.00-0036264"; // QB, bench (Team A)
const COLLINS = "manual.p.00-0036554"; // WR, IR (Team A)
const LAMAR = "manual.p.00-0034796"; // QB, Team B
const UNKNOWN = "manual.p.00-9999999";

interface Err {
  error: { code: string; field?: string; reason?: string; hint: string };
}
interface Swap {
  out: string;
  in: string;
  slot: string;
}
interface Ok {
  data: { swaps: Swap[]; comparisons?: Swap[]; rec: { action: string } };
}

let world: World;
beforeAll(async () => {
  world = await makeWorld();
}, 60_000);
afterAll(() => {
  world.cleanup();
});

async function call(args: Record<string, unknown>): Promise<{ isError: boolean; b: unknown }> {
  const { client, close } = await connect(world);
  const r = await client.callTool({ name: "ff_analyze_lineup", arguments: { week: 4, ...args } });
  await close();
  return {
    isError: r.isError === true,
    b: JSON.parse((r.content as { text: string }[])[0]?.text ?? "{}"),
  };
}

describe("refused visibly (QA-1-010)", () => {
  const CASES: readonly [string, Record<string, unknown>, string, string][] = [
    [
      "force_start off the roster",
      { force_start: [LAMAR] },
      "force_start[0]",
      "not_on_target_roster",
    ],
    ["exclude an unknown key", { exclude: [ALLEN, UNKNOWN] }, "exclude[1]", "not_on_target_roster"],
    [
      "forced and excluded",
      { force_start: [ALLEN], exclude: [ALLEN] },
      "force_start[0]",
      "also_excluded",
    ],
    [
      "compare a WR into the QB slot",
      { compare: [{ out: ALLEN, in: COLLINS }] },
      "compare[0].in",
      "ineligible_for_slot",
    ],
    [
      "compare out of a bench player",
      { compare: [{ out: K_ALLEN, in: CHASE }] },
      "compare[0].out",
      "not_a_starter",
    ],
    [
      "compare in a current starter",
      { compare: [{ out: ALLEN, in: CHASE }] },
      "compare[0].in",
      "already_starting",
    ],
    [
      "compare a player with himself",
      { compare: [{ out: ALLEN, in: ALLEN }] },
      "compare[0].in",
      "same_player",
    ],
    [
      "compare off the roster",
      { compare: [{ out: ALLEN, in: LAMAR }] },
      "compare[0].in",
      "not_on_target_roster",
    ],
    [
      "another team's player for team B",
      { team_key: TEAM_B, exclude: [CHASE] },
      "exclude[0]",
      "not_on_target_roster",
    ],
  ];
  for (const [label, args, field, reason] of CASES)
    it(label, async () => {
      const r = await call(args);
      expect(r.isError, JSON.stringify(r.b).slice(0, 300)).toBe(true);
      expect((r.b as Err).error).toMatchObject({ code: "VALIDATION", field, reason });
    });
});

describe("honoured (QA-1-010)", () => {
  it("a legal comparison is in comparisons[], never in the recommended swaps", async () => {
    const r = await call({ compare: [{ out: CHASE, in: K_ALLEN }] });
    expect(r.isError).toBe(false);
    const d = (r.b as Ok).data;
    expect(d.comparisons).toEqual([expect.objectContaining({ out: CHASE, in: K_ALLEN })]);
    expect(d.swaps.some((s) => s.out === CHASE && s.in === K_ALLEN)).toBe(false);
    const m = /make (\d+) lineup change/.exec(d.rec.action);
    expect(d.swaps.length).toBe(m === null ? 0 : Number(m[1]));
  });
  it("a comparison that IS the recommended swap stays a swap (not duplicated)", async () => {
    const base = (await call({})).b as Ok;
    const s = base.data.swaps[0];
    expect(s).toBeDefined();
    if (s === undefined) return;
    const r = (await call({ compare: [{ out: s.out, in: s.in }] })).b as Ok;
    expect(r.data.swaps).toEqual(base.data.swaps);
    expect(r.data.comparisons ?? []).toEqual([]);
  });
  it("a valid force_start and exclude are applied", async () => {
    const r = (await call({ force_start: [LOVE], exclude: [ALLEN] })).b as Ok;
    expect(r.data.swaps.some((s) => s.out === ALLEN && s.in === LOVE)).toBe(true);
  });
});

describe("splitComparisons never hides a recommended swap (QA-1-010)", () => {
  const sw = (out: string, inn: string) => ({ out, in: inn });
  it("recommended first, then the asked pairs", () => {
    const rows = [sw("a", "b"), sw("c", "d")];
    expect(splitComparisons(rows, 1, [{ out: "c", in: "d" }])).toEqual({
      swaps: [sw("a", "b")],
      comparisons: [sw("c", "d")],
    });
  });
  it("a trailing row nobody asked for stays a swap", () => {
    const rows = [sw("a", "b"), sw("x", "y"), sw("c", "d")];
    expect(splitComparisons(rows, 1, [{ out: "c", in: "d" }])).toEqual({
      swaps: [sw("a", "b"), sw("x", "y")],
      comparisons: [sw("c", "d")],
    });
  });
  it("no compare argument: everything is a swap and no comparisons key", () => {
    expect(splitComparisons([sw("a", "b")], 0, undefined)).toEqual({ swaps: [sw("a", "b")] });
  });
});
