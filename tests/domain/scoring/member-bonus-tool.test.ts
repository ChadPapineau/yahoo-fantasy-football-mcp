// member-bonus-tool.test.ts — QA-2-036 end to end: a league.yaml threshold bonus on a bracket-family
// stat (an FG-distance bin, a points-allowed bin) is listed by ff_get_league AND paid by the engine
// behind ff_get_player_stats, exactly like a bonus on any other stat (plan 08 §4.2; the onboard
// guide's `bonuses: [{ stat, target, points }]` has no stat restriction). Real fixture lines:
// Evan McPherson 2026 weeks 1–2 and the PIT defence, scored with and without the bonuses.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  body,
  connect,
  FIXTURE_LEAGUE,
  LEAGUE_KEY,
  makeWorld,
  type World,
} from "../../mcp/helpers/env.js";

const MARK = "  # no TE premium, no yardage bonuses";
const KICKER = "manual.p.00-0036854";
const DEF = "manual.p.def-pit";

let dir: string;
let plain: World;
let bonus: World;
beforeAll(async () => {
  const src = readFileSync(FIXTURE_LEAGUE, "utf8");
  expect(src).toContain(MARK);
  dir = mkdtempSync(path.join(tmpdir(), "ff-member-bonus-"));
  const file = path.join(dir, "league.yaml");
  writeFileSync(
    file,
    src.replace(
      MARK,
      [
        "  bonuses:",
        "    - { stat: fg_50p, target: 2, points: 3 }",
        "    - { stat: dst_pa_1_6, target: 1, points: 5 }",
        "    - { stat: dst_pa_7_13, target: 1, points: 5 }",
        "    - { stat: dst_pa_14_20, target: 1, points: 5 }",
        "    - { stat: dst_pa_21_27, target: 1, points: 5 }",
      ].join("\n"),
    ),
  );
  chmodSync(file, 0o600);
  plain = await makeWorld();
  bonus = await makeWorld({ env: { FF_LEAGUE_FILE: file } });
}, 240_000);
afterAll(() => {
  plain.cleanup();
  bonus.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

interface Stat {
  canonical: string;
  value: number;
}
interface PlayerStats {
  engine_points: number;
  stats: Stat[];
}

async function points(w: World, key: string, week: number): Promise<PlayerStats> {
  const { client, close } = await connect(w);
  try {
    const r = body(
      await client.callTool({
        name: "ff_get_player_stats",
        arguments: { league_key: LEAGUE_KEY, player_keys: [key], type: "week", week },
      }),
    );
    return (r.data as { players: PlayerStats[] }).players[0]!;
  } finally {
    await close();
  }
}

describe("a league.yaml bonus on a bracket member is listed and paid (QA-2-036)", () => {
  it("ff_get_league lists the member bonuses", async () => {
    const { client, close } = await connect(bonus);
    try {
      const lg = body(
        await client.callTool({ name: "ff_get_league", arguments: { league_key: LEAGUE_KEY } }),
      );
      const rules = (lg.data as { scoring: { rules: { canonical: string; bonuses: unknown[] }[] } })
        .scoring.rules;
      expect(rules.find((r) => r.canonical === "fg_50p")?.bonuses).toEqual([
        { target: 2, points: 3 },
      ]);
    } finally {
      await close();
    }
  });

  it("kicker: the bonus pays in exactly the weeks with two 50+ yard field goals", async () => {
    for (const week of [1, 2, 3]) {
      const a = await points(plain, KICKER, week);
      const b = await points(bonus, KICKER, week);
      const fg50 = a.stats.find((s) => s.canonical === "fg_50p")?.value ?? 0;
      expect(b.engine_points, `week ${String(week)}`).toBe(a.engine_points + (fg50 >= 2 ? 3 : 0));
    }
    // weeks 1 and 2 of the fixture: two 50+ yard FGs each (55 + 58, 51 + 57)
    expect((await points(bonus, KICKER, 1)).engine_points).toBe(22);
    expect((await points(bonus, KICKER, 2)).engine_points).toBe(15);
  });

  it("defence: a bonus on every points-allowed bin from 1 to 27 pays when the game falls in one", async () => {
    let fired = 0;
    for (const week of [1, 2, 3]) {
      const a = await points(plain, DEF, week);
      const b = await points(bonus, DEF, week);
      const pa = a.stats.find((s) => s.canonical === "dst_pa")?.value;
      expect(pa, `week ${String(week)}`).toBeTypeOf("number");
      const inBins = pa !== undefined && pa >= 1 && pa <= 27;
      if (inBins) fired++;
      expect(b.engine_points, `week ${String(week)} pa ${String(pa)}`).toBe(
        a.engine_points + (inBins ? 5 : 0),
      );
    }
    expect(fired).toBeGreaterThan(0);
  });
});
