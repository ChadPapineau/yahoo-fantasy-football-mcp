// league-position-type.test.ts — QA-1-018: a stat line is scored as the player's LEAGUE position.
// nflverse types a line by its own roster position; a two-way player the league lists at WR (Travis
// Hunter: a cornerback in nflverse's week-1 row) must earn his receiving points, not 0 under the
// defensive-player rules. ff_get_player_stats (the onboarding engine self-check) is the surface.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeStatLine } from "../../src/domain/scoring/nflverse.js";
import { leagueTypedLine } from "../../src/mcp/tools/common.js";
import { FIXTURE_LEAGUE, connect, makeWorld, type World } from "./helpers/env.js";

const HUNTER = "00-0040718";
let dir: string;
let world: World;
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "ff-pos-"));
  chmodSync(dir, 0o700);
  const file = path.join(dir, "league.yaml");
  const anchor =
    '    - { name: Hunter Henry, team: NE, position: TE, gsis_id: "00-0033090", slot: BN }\n';
  const yaml = readFileSync(FIXTURE_LEAGUE, "utf8");
  if (!yaml.includes(anchor)) throw new Error("fixture league changed");
  writeFileSync(
    file,
    yaml.replace(
      anchor,
      `${anchor}    - { name: Travis Hunter, team: JAX, position: WR, gsis_id: "${HUNTER}", slot: BN }\n`,
    ),
    { mode: 0o600 },
  );
  const w = await makeWorld({ env: { FF_LEAGUE_FILE: file } });
  // the fixture's roster_weekly excerpt lacks him: add his nflverse roster row (a cornerback there)
  const base = w.services.rosterWeekly;
  world = {
    ...w,
    services: {
      ...w.services,
      rosterWeekly: {
        ...base,
        latest: (season: number) => {
          const r = base.latest(season);
          const like = r.rows[0];
          if (like === undefined) return r;
          return {
            ...r,
            rows: [
              ...r.rows,
              {
                ...like,
                gsis_id: HUNTER,
                full_name: "Travis Hunter",
                team: "JAX",
                position: "CB",
                week: 4,
                status: "ACT",
              },
            ],
          };
        },
      },
    },
  };
}, 60_000);
afterAll(() => {
  world.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

describe("stat lines are typed by the league position [QA-1-018]", () => {
  it("ff_get_player_stats scores a league WR's week-1 line under the offence rules", async () => {
    const { client, close } = await connect(world);
    const r = await client.callTool({
      name: "ff_get_player_stats",
      arguments: { player_keys: [`manual.p.${HUNTER}`], type: "week", week: 1 },
    });
    await close();
    const text = (r.content as { text: string }[])[0]?.text ?? "";
    expect(r.isError, text.slice(0, 300)).not.toBe(true);
    const p = (
      JSON.parse(text) as {
        data: { players: { engine_points: number | null; stats: { canonical: string }[] }[] };
      }
    ).data.players[0];
    // control: the week-1 line carries receiving stats
    expect(p?.stats.map((s) => s.canonical)).toContain("rec");
    // half-PPR fixture league: 0.5 × 1 rec + 0.1 × 8 rec yd + 0.1 × 3 rush yd
    expect(p?.engine_points).toBe(1.6);
  });
});

describe("leagueTypedLine [QA-1-018]", () => {
  const cb = makeStatLine({ rec: 1, rec_yd: 8 }, "D");
  it("retypes to the league position; keeps the line when the league names none", () => {
    expect(leagueTypedLine(cb, "WR").position_type).toBe("O");
    expect(leagueTypedLine(cb, "WR").values).toEqual(cb.values);
    expect(leagueTypedLine(cb, "K").position_type).toBe("K");
    expect(leagueTypedLine(cb, "DEF").position_type).toBe("DT");
    expect(leagueTypedLine(cb, null)).toBe(cb);
    expect(leagueTypedLine(cb, undefined)).toBe(cb);
    expect(leagueTypedLine(cb, "??")).toBe(cb);
    const wr = makeStatLine({ rec: 1 }, "O");
    expect(leagueTypedLine(wr, "WR")).toBe(wr);
  });
});
