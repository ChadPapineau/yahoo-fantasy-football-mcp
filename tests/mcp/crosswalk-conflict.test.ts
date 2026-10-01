// crosswalk-conflict.test.ts — QA-1-042: a league.yaml entry whose gsis_id names another NFL player
// (Josh Allen written with Hunter Henry's id) is ambiguous in the crosswalk. Its key
// (manual.p.<that id>) must never be projected as the id's player through the key itself: the entry
// is unresolved, as ff_get_roster already treats it.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_LEAGUE, connect, makeWorld, type World } from "./helpers/env.js";

const HENRY = "00-0033090";
let dir: string;
let world: World;
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "ff-xw-"));
  chmodSync(dir, 0o700);
  const file = path.join(dir, "league.yaml");
  let yaml = readFileSync(FIXTURE_LEAGUE, "utf8");
  for (const [a, b] of [
    [`gsis_id: "00-0034857", slot: QB }`, `gsis_id: "${HENRY}", slot: QB }`],
    [`    - { name: Hunter Henry, team: NE, position: TE, gsis_id: "${HENRY}", slot: BN }\n`, ""],
  ] as const) {
    if (!yaml.includes(a)) throw new Error(`fixture league has no ${a}`);
    yaml = yaml.replace(a, b);
  }
  writeFileSync(file, yaml, { mode: 0o600 });
  world = await makeWorld({ env: { FF_LEAGUE_FILE: file } });
}, 60_000);
afterAll(() => {
  world.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

describe("a conflicting gsis_id never resolves through the key [QA-1-042]", () => {
  it("ff_project_players does not project the entry as the id's player", async () => {
    const { client, close } = await connect(world);
    const r = await client.callTool({
      name: "ff_project_players",
      arguments: { players: { player_keys: [`manual.p.${HENRY}`] }, horizon: "week", week: 4 },
    });
    await close();
    const text = (r.content as { text: string }[])[0]?.text ?? "";
    if (r.isError === true) {
      expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe("NOT_FOUND");
    } else {
      const d = JSON.parse(text) as { data: { projections: { gsis_id: string | null }[] } };
      expect(d.data.projections.map((p) => p.gsis_id)).not.toContain(HENRY);
    }
    expect(text).not.toContain("Hunter Henry");
  });

  it("ff_get_status surfaces the hint conflict by key and id; rosters name the unmatched entry", async () => {
    const { client, close } = await connect(world);
    const st = await client.callTool({ name: "ff_get_status", arguments: {} });
    const lu = await client.callTool({ name: "ff_analyze_lineup", arguments: { week: 4 } });
    await close();
    const status = JSON.parse((st.content as { text: string }[])[0]?.text ?? "{}") as {
      data: {
        crosswalk: {
          diagnostics: { code: string; platform_player_id: string | null; gsis_ids: string[] }[];
          unmatched_rostered: { player_key: string; candidate_players: { gsis_id: string }[] }[];
        };
      };
    };
    const conflict = status.data.crosswalk.diagnostics.find((d) => d.code === "hint_conflict");
    expect(conflict, JSON.stringify(status.data.crosswalk.diagnostics)).toBeDefined();
    expect(conflict?.gsis_ids).toContain(HENRY);
    expect(conflict?.platform_player_id).toBe(`manual.p.${HENRY}`);
    const lineup = JSON.parse((lu.content as { text: string }[])[0]?.text ?? "{}") as {
      warnings: string[];
    };
    expect(lineup.warnings.join("\n")).toContain(`unmatched in the crosswalk`);
    expect(lineup.warnings.join("\n")).toContain(`manual.p.${HENRY}`);
  });
});

describe("unmatched rostered players carry candidate summaries [QA-1-048]", () => {
  it("a rookie entered with an old team lists the NFL player he might be, name path-listed", async () => {
    const d = mkdtempSync(path.join(tmpdir(), "ff-xw2-"));
    chmodSync(d, 0o700);
    const file = path.join(d, "league.yaml");
    const line = "    - { name: Ashton Jeanty, team: LV, position: RB, slot: BN }";
    const yaml = readFileSync(FIXTURE_LEAGUE, "utf8");
    if (!yaml.includes(line)) throw new Error("fixture league changed");
    writeFileSync(file, yaml.replace(line, line.replace("team: LV", "team: KC")), { mode: 0o600 });
    const w = await makeWorld({ env: { FF_LEAGUE_FILE: file } });
    try {
      const { client, close } = await connect(w);
      const st = await client.callTool({ name: "ff_get_status", arguments: {} });
      await close();
      const b = JSON.parse((st.content as { text: string }[])[0]?.text ?? "{}") as {
        data: {
          crosswalk: {
            unmatched_rostered: {
              candidates: number;
              candidate_players: { nfl_team: string | null; position: string | null }[];
            }[];
          };
        };
        meta: { untrusted_fields: { path: string; source: string }[] };
      };
      const row = b.data.crosswalk.unmatched_rostered.find((u) => u.candidates > 0);
      expect(row, JSON.stringify(b.data.crosswalk.unmatched_rostered)).toBeDefined();
      expect(row?.candidate_players.length).toBe(Math.min(row?.candidates ?? 0, 3));
      expect(row?.candidate_players.some((c) => c.nfl_team === "LV" && c.position === "RB")).toBe(
        true,
      );
      expect(b.meta.untrusted_fields).toContainEqual({
        path: "data.crosswalk.unmatched_rostered[].candidate_players[].name",
        source: "nflverse.roster_weekly.name",
      });
    } finally {
      w.cleanup();
      rmSync(d, { recursive: true, force: true });
    }
  }, 60_000);
});
