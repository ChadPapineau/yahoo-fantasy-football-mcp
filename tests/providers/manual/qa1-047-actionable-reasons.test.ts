// qa1-047-actionable-reasons.test.ts — Stage C QA round 1 regression: QA-1-047 the reasons for common copied spellings are actionable and still value-free (plan 02
// §5; plan 03 doctor "a path and a reason"; critic C-13b).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NFL_TEAMS } from "../../../src/config/schema.js";
import { edit, loadIssues, tempLeague, type TempLeague } from "./helpers.js";

const CANARY = "CANARY7f3aZq";

let t: TempLeague;
beforeEach(() => {
  t = tempLeague();
});
afterEach(() => {
  t.cleanup();
});

const issues = (text: string): Promise<string> => loadIssues(t, text, CANARY);

describe("QA-1-047: actionable, value-free reasons for copied spellings", () => {
  const JEANTY = "Ashton Jeanty, team: LV";
  it.each([
    ["JAC", "JAX"],
    ["WSH", "WAS"],
    ["LAR", "LA"],
    ["OAK", "LV"],
    ["lv", "LV"],
    ["Jax", "JAX"],
  ])("team %s names the nflverse code %s", async (spelled, canonical) => {
    const r = await issues(edit(JEANTY, `Ashton Jeanty, team: ${spelled}`));
    expect(r).toMatch(
      new RegExp(
        `my_team\\.players\\[13\\]\\.team: not an nflverse team abbreviation \\(use ${canonical}\\)`,
      ),
    );
  });

  it("an unknown team lists the accepted codes, and never the value", async () => {
    const r = await issues(edit(JEANTY, "Ashton Jeanty, team: XQZ"));
    expect(r).toMatch(/not an nflverse team abbreviation/);
    for (const code of NFL_TEAMS) expect(r).toContain(code);
    expect(r).not.toContain("XQZ");
  });

  it("FLEX and D/ST slot names point at W/R/T and DEF", async () => {
    const flex = await issues(edit("W/R/T", "FLEX"));
    expect(flex).toMatch(/roster_slots\[4\]: invalid slot \(unknown_slot\).*W\/R\/T/);
    expect(flex).toMatch(/roster_slots\[4\]: .*DEF/);
    const dst = await issues(edit("{ name: DEF, count: 1 }", "{ name: D/ST, count: 1 }"));
    expect(dst).toMatch(/roster_slots\[6\]: invalid slot \(unknown_slot\).*DEF/);
  });

  it("a defence written as a player points at the { defense: TEAM } form and names the positions", async () => {
    const r = await issues(
      edit("{ defense: DET, slot: DEF }", "{ name: Detroit, team: DET, position: DEF, slot: DEF }"),
    );
    expect(r).toMatch(/my_team\.players\[8\]\.position: not an allowed value/);
    expect(r).toMatch(/QB, RB, WR, TE, K/);
    expect(r).toMatch(/defense: TEAM/);
  });

  it("a misspelled key reports the real key as missing", async () => {
    expect(await issues(edit("team: SEA, position: WR,", "team: SEA, postion: WR,"))).toMatch(
      /my_team\.players\[6\]\.position: required field is missing/,
    );
    expect(
      await issues(edit("{ defense: DET, slot: DEF }", "{ defence: DET, slot: DEF }")),
    ).toMatch(/my_team\.players\[8\]\.defense: required field is missing/);
    expect(await issues(edit("  season: 2026\n", ""))).toMatch(
      /league\.season: required field is missing/,
    );
    // a present-but-wrong value is still a wrong value, not "missing"
    const wrong = await issues(edit("  season: 2026\n", `  season: "${CANARY}"\n`));
    expect(wrong).toMatch(/league\.season: wrong type/);
    expect(wrong).not.toMatch(/missing/);
  });
});
