// lineup-unmatched.test.ts — QA-2-039 through the tool: a starter whose league.yaml line matches no
// NFL player (a typo, no gsis_id) still holds his seat. ff_analyze_lineup used to report the seat as
// empty and advise "filling" it (`out: null`), which in the app benches him. The seat is kept as it
// is — never filled — the unmatched key is named in a warning, and P(win) is withheld.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_LEAGUE, body, connect, makeWorld, type World } from "./helpers/env.js";

interface E2 {
  data: {
    swaps: { out: string | null; in: string; slot: string }[];
    current_lineup: { slot: string; player_key: string }[];
    p_win_before: number | null;
    rec: { action: string; assumptions: { text: string }[] };
  };
  warnings: string[];
}

/** [label, the exact fixture line fragment, its typo'd replacement (no gsis_id), the seat]. */
const CASES = [
  [
    "the W/R/T starter",
    'name: Jaxon Smith-Njigba, team: SEA, position: WR, gsis_id: "00-0038543", slot: W/R/T',
    "name: Jaxon Smith-Njgba, team: SEA, position: WR, slot: W/R/T",
    "W/R/T",
  ],
  [
    "the QB",
    'name: Josh Allen, team: BUF, position: QB, gsis_id: "00-0034857", slot: QB',
    "name: Josh Alen, team: BUF, position: QB, slot: QB",
    "QB",
  ],
  [
    "an RB",
    'name: Jahmyr Gibbs, team: DET, position: RB, gsis_id: "00-0039139", slot: RB',
    "name: Jahmyr Gibs, team: DET, position: RB, slot: RB",
    "RB",
  ],
] as const;

describe("a starter the NFL data does not match keeps his seat (QA-2-039)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ff-unmatched-"));
  chmodSync(dir, 0o700);
  const worlds = new Map<string, World>();
  beforeAll(async () => {
    const src = readFileSync(FIXTURE_LEAGUE, "utf8");
    for (const [label, from, to] of CASES) {
      if (!src.includes(from)) throw new Error(`fixture line moved: ${label}`);
      const file = path.join(dir, `league-${String(worlds.size)}.yaml`);
      writeFileSync(file, src.replace(from, to), { mode: 0o600 });
      worlds.set(label, await makeWorld({ env: { FF_LEAGUE_FILE: file } }));
    }
  }, 180_000);
  afterAll(() => {
    for (const w of worlds.values()) w.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  for (const [label, , , seat] of CASES)
    it(`${label}: no fill of the ${seat} seat, the key named, P(win) withheld`, async () => {
      const world = worlds.get(label);
      if (world === undefined) throw new Error("no world");
      const { client, close } = await connect(world);
      // week 3 has an opponent: P(win) would be reported for a fully matched lineup
      const r = await client.callTool({ name: "ff_analyze_lineup", arguments: { week: 3 } });
      await close();
      expect(r.isError).not.toBe(true);
      const b = body(r) as unknown as E2;
      // every seat of the fixture lineup is held: nothing is ever "filled"
      expect(b.data.swaps.filter((s) => s.out === null)).toEqual([]);
      expect(b.data.p_win_before).toBeNull();
      expect(
        b.data.rec.assumptions.some(
          (a) => a.text.includes("NFL data does not match") && a.text.includes(seat),
        ),
      ).toBe(true);
      expect(b.warnings.join(" ")).toMatch(/unmatched/);
    });
});
