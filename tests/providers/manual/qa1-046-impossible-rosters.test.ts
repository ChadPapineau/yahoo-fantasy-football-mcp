// qa1-046-impossible-rosters.test.ts — Stage C QA round 1 regression: QA-1-046 league.yaml rosters no platform could hold (an over-full starter/flex/IR slot, a
// position seated where it cannot play) and duplicates keyed off the player, not the spelling (name vs
// gsis id, apostrophe variants) are file issues (plan 01 §8 X1; plan 02 §5).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { edit, loadIssues, loadLeague, tempLeague, type TempLeague } from "./helpers.js";

let t: TempLeague;
beforeEach(() => {
  t = tempLeague();
});
afterEach(() => {
  t.cleanup();
});

const issues = (text: string): Promise<string> => loadIssues(t, text);
const valid = async (text: string): Promise<void> => {
  await loadLeague(t, text);
};

const LOVE_BN =
  '    - { name: Jordan Love, team: GB, position: QB, gsis_id: "00-0036264", slot: BN }';
const COLLINS = "    - { name: Nico Collins";

describe("QA-1-046: rosters no platform could hold, and duplicates by player", () => {
  it("two players in a one-seat starter slot", async () => {
    expect(await issues(edit(LOVE_BN, LOVE_BN.replace("slot: BN", "slot: QB")))).toMatch(
      /my_team\.players\[9\]\.slot: slot has more players than its count/,
    );
  });

  it("a QB seated in the K slot, and a TE in a W/R flex", async () => {
    expect(await issues(edit(LOVE_BN, LOVE_BN.replace("slot: BN", "slot: K")))).toMatch(
      /my_team\.players\[9\]\.slot: position cannot fill this slot/,
    );
    const wr = edit("{ name: W/R/T, count: 1 }", "{ name: W/R, count: 1 }");
    const moved = edit("slot: W/R/T }", "slot: W/R }", wr);
    const te = edit(
      '    - { name: Hunter Henry, team: NE, position: TE, gsis_id: "00-0033090", slot: BN }',
      '    - { name: Hunter Henry, team: NE, position: TE, gsis_id: "00-0033090", slot: W/R }',
      moved,
    );
    const r = await issues(te);
    expect(r).toMatch(/position cannot fill this slot/);
  });

  it("an over-full IR slot is an issue; a healthy player in IR and an over-full bench stay valid (flags)", async () => {
    const ir = edit(LOVE_BN, LOVE_BN.replace("slot: BN", "slot: IR, status: O"));
    const ir2 = edit(
      '    - { name: Keenan Allen, team: IND, position: WR, gsis_id: "00-0030279", slot: BN }',
      '    - { name: Keenan Allen, team: IND, position: WR, gsis_id: "00-0030279", slot: IR, status: O }',
      ir,
    );
    expect(await issues(ir2)).toMatch(/slot has more players than its count/);
    await valid(edit(LOVE_BN, LOVE_BN.replace("slot: BN", "slot: IR")));
    await valid(
      edit(COLLINS, "    - { name: Tank Bigsby, team: PHI, position: RB, slot: BN }\n" + COLLINS),
    );
  });

  it("the same player by name and by gsis id is listed twice", async () => {
    expect(
      await issues(
        edit(
          COLLINS,
          '    - { name: Josh Allen, team: BUF, position: QB, gsis_id: "00-0034857", slot: BN }\n' +
            COLLINS,
          edit(
            '{ name: Josh Allen, team: BUF, position: QB, gsis_id: "00-0034857", slot: QB }',
            "{ name: Josh Allen, team: BUF, position: QB, slot: QB }",
          ),
        ),
      ),
    ).toMatch(/my_team\.players\[15\]: player listed twice on this team/);
  });

  it("apostrophe / punctuation / case variants of one player are listed twice, across teams and pools too", async () => {
    for (const variant of ["JaMarr Chase", "Ja’Marr Chase", "ja'marr  chase"]) {
      expect(
        await issues(
          edit(
            COLLINS,
            `    - { name: ${variant}, team: CIN, position: WR, slot: BN }\n${COLLINS}`,
          ),
        ),
      ).toMatch(/my_team\.players\[15\]: player listed twice on this team/);
    }
    expect(
      await issues(
        edit(
          "      - { name: Deebo Samuel Sr., team: SF, position: WR, slot: BN }",
          "      - { name: Amon Ra St Brown, team: DET, position: WR, slot: BN }",
        ),
      ),
    ).toMatch(/other_teams\[0\]\.players\[14\]: player is on more than one team/);
    expect(
      await issues(
        edit(
          "  - { name: Jeremiyah Love, team: ARI, position: RB }",
          "  - { name: Jahmyr  Gibbs, team: DET, position: RB }",
        ),
      ),
    ).toMatch(/free_agents\[0\]: player is also on a roster/);
  });

  it("different players stay distinct: same name on another team, or two different gsis ids", async () => {
    await valid(
      edit(
        "  - { name: Jeremiyah Love, team: ARI, position: RB }",
        "  - { name: Josh Allen, team: JAX, position: QB }",
      ),
    );
    await valid(
      edit(
        "  - { name: Jeremiyah Love, team: ARI, position: RB }",
        '  - { name: Josh Allen, team: BUF, position: QB, gsis_id: "00-0099999" }',
      ),
    );
  });
});
