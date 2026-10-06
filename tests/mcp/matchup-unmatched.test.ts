// matchup-unmatched.test.ts — QA-2-046: a starter whose league.yaml line matches no NFL player (a
// typo, no gsis_id) holds his seat, so my total is unknown. ff_analyze_matchup used to drop him and
// score the seat 0 — P(win) 0.525 instead of about 0.75 on the fixture, naming nothing. E2 withholds
// P(win) for the same file (QA-2-039); E3's whole answer is P(win), so it refuses, as it does for an
// opponent whose listed players leave a seat empty (QA-1-043), with a hint that names the fix. An
// unmatched BENCH player changes no seat and never refuses.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MATCHUP_UNMATCHED_STARTER_HINT } from "../../src/mcp/tools/analytics.js";
import { FIXTURE_LEAGUE, body, connect, makeWorld, type World } from "./helpers/env.js";

/** Tuesday of week 3: the fixture lists an opponent for week 3. */
const TUESDAY_WEEK3 = "2026-09-22T12:00:00.000Z";

/** [label, the exact fixture line fragment, its replacement (a typo, no gsis_id)]. */
const CASES = [
  [
    "the W/R/T starter",
    'name: Jaxon Smith-Njigba, team: SEA, position: WR, gsis_id: "00-0038543", slot: W/R/T',
    "name: Jaxon Smith-Njgba, team: SEA, position: WR, slot: W/R/T",
  ],
  [
    "the QB",
    'name: Josh Allen, team: BUF, position: QB, gsis_id: "00-0034857", slot: QB',
    "name: Josh Alen, team: BUF, position: QB, slot: QB",
  ],
  [
    "a bench WR",
    "name: Denzel Boston, team: CLE, position: WR, slot: BN",
    "name: Denzel Bostn, team: CLE, position: WR, slot: BN",
  ],
] as const;

interface ErrorBody {
  error: { code: string; hint: string };
}

describe("an unmatched starter makes my total unknown: E3 refuses (QA-2-046)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ff-e3-unmatched-"));
  chmodSync(dir, 0o700);
  const worlds = new Map<string, World>();
  beforeAll(async () => {
    const src = readFileSync(FIXTURE_LEAGUE, "utf8");
    worlds.set("matched", await makeWorld({ clock: TUESDAY_WEEK3 }));
    for (const [label, from, to] of CASES) {
      if (!src.includes(from)) throw new Error(`fixture line moved: ${label}`);
      const file = path.join(dir, `league-${String(worlds.size)}.yaml`);
      writeFileSync(file, src.replace(from, to), { mode: 0o600 });
      worlds.set(label, await makeWorld({ clock: TUESDAY_WEEK3, env: { FF_LEAGUE_FILE: file } }));
    }
  }, 240_000);
  afterAll(() => {
    for (const w of worlds.values()) w.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  async function matchup(label: string): Promise<{ isError: boolean; body: unknown }> {
    const world = worlds.get(label);
    if (world === undefined) throw new Error(`no world ${label}`);
    const { client, close } = await connect(world);
    try {
      const r = await client.callTool({ name: "ff_analyze_matchup", arguments: { week: 3 } });
      return { isError: r.isError === true, body: body(r) };
    } finally {
      await close();
    }
  }

  it("the matched fixture gets a win probability (the control)", async () => {
    const r = await matchup("matched");
    expect(r.isError).toBe(false);
    expect(typeof (r.body as { data: { p_win: unknown } }).data.p_win).toBe("number");
  });

  for (const [label] of CASES.slice(0, 2))
    it(`${label} unmatched: NOT_FOUND with the hint, never a P(win) that scores his seat 0`, async () => {
      const r = await matchup(label);
      expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(true);
      const e = (r.body as ErrorBody).error;
      expect(e.code).toBe("NOT_FOUND");
      expect(e.hint).toBe(MATCHUP_UNMATCHED_STARTER_HINT);
    });

  it("an unmatched bench player changes no seat: the win probability is still reported", async () => {
    const r = await matchup("a bench WR");
    expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
    expect(typeof (r.body as { data: { p_win: unknown } }).data.p_win).toBe("number");
  });

  it("the hint is a fixed, printable server hint that names the fix", () => {
    expect(MATCHUP_UNMATCHED_STARTER_HINT).toMatch(/^[\x20-\x7e]{1,300}$/);
    expect(MATCHUP_UNMATCHED_STARTER_HINT).toMatch(/ff_get_status/);
    expect(MATCHUP_UNMATCHED_STARTER_HINT).toMatch(/ff_analyze_lineup/);
  });
});
