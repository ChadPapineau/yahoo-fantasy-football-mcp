// matchup-hint.test.ts — QA-1-069 (reopened in round 2): ff_analyze_matchup's "no opponent" hint
// names what is actually missing. Under the manual league that is one of two things: the week's
// `opponents:` entry (the usual case — the opponent's roster is already under other_teams), or the
// players of the team that entry names. The hint used to open with "No opponent roster in
// league.yaml", false in the usual case, and read as an instruction to type the roster again.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_LEAGUE, connect, makeWorld, type World } from "./helpers/env.js";

interface Err {
  error: { code: string; hint: string };
}

/** The fixture league with one more `opponents:` line for week 4 (or none). */
function withWeek4(src: string, team: number | null): string {
  if (team === null) return src;
  const anchor = "  - { week: 3, team: 2 }\n";
  if (!src.includes(anchor)) throw new Error("fixture opponents anchor moved");
  return src.replace(anchor, `${anchor}  - { week: 4, team: ${String(team)} }\n`);
}

describe("ff_analyze_matchup names what is missing for the week (QA-1-069)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ff-e3hint-"));
  chmodSync(dir, 0o700);
  // [label, week-4 opponents entry (null = none), what is missing]
  const CASES = [
    ["no week-4 entry; Team B's roster is in the file", null, "entry"],
    ["a week-4 entry naming Team C, which lists no players", 3, "players"],
    ["a week-4 entry naming Team B, roster listed", 2, "nothing"],
  ] as const;
  const worlds = new Map<string, World>();
  beforeAll(async () => {
    const src = readFileSync(FIXTURE_LEAGUE, "utf8");
    for (const [label, team] of CASES) {
      const file = path.join(dir, `league-${String(team)}.yaml`);
      writeFileSync(file, withWeek4(src, team), { mode: 0o600 });
      worlds.set(label, await makeWorld({ env: { FF_LEAGUE_FILE: file } }));
    }
  }, 120_000);
  afterAll(() => {
    for (const w of worlds.values()) w.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  for (const [label, , missing] of CASES)
    it(label, async () => {
      const world = worlds.get(label);
      if (world === undefined) throw new Error("no world");
      const { client, close } = await connect(world);
      const r = await client.callTool({ name: "ff_analyze_matchup", arguments: { week: 4 } });
      await close();
      if (missing === "nothing") {
        expect(r.isError).not.toBe(true);
        return;
      }
      expect(r.isError).toBe(true);
      const e = (JSON.parse((r.content as { text: string }[])[0]?.text ?? "{}") as Err).error;
      expect(e.code).toBe("NOT_FOUND");
      // never the false claim, whichever piece is missing
      expect(e.hint).not.toMatch(/no opponent roster/i);
      if (missing === "entry") {
        // the one missing line, and the roster only "if not listed yet" — never re-typed as a rule
        expect(e.hint).toMatch(/\{ week: <week>, team: <id> \} under opponents/);
        expect(e.hint).toMatch(/if they are not listed yet/);
      } else {
        expect(e.hint).not.toMatch(/under opponents/);
        expect(e.hint).toMatch(/no players listed/);
        expect(e.hint).toMatch(/under other_teams/);
      }
    });
});
