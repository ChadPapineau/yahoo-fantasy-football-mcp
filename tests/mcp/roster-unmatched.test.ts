// roster-unmatched.test.ts — QA-2-039 (second half; round-1 Open items 4: "every tool that reads a
// roster warns with the unmatched keys"): ff_get_roster lists a rostered player the NFL data does not
// match (a typo, no gsis_id) with gsis_id null, and now says so in a warning that names his key, as
// ff_analyze_lineup and the other roster readers do. The property: the warning's count is the number
// of listed players (not team defences) with no gsis_id, and it names each of their keys (up to five);
// a fully matched roster carries no such warning.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_LEAGUE, body, connect, makeWorld, type World } from "./helpers/env.js";

interface B1 {
  data: { players: { player_key: string; gsis_id: string | null; position: string | null }[] };
  warnings: string[];
}

const TYPOS: readonly (readonly [string, string])[] = [
  [
    'name: Jaxon Smith-Njigba, team: SEA, position: WR, gsis_id: "00-0038543", slot: W/R/T',
    "name: Jaxon Smith-Njgba, team: SEA, position: WR, slot: W/R/T",
  ],
  [
    'name: Hunter Henry, team: NE, position: TE, gsis_id: "00-0033090", slot: BN',
    "name: Huntr Henry, team: NE, position: TE, slot: BN",
  ],
];

describe("ff_get_roster names the rostered players the NFL data does not match (QA-2-039)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ff-b1-unmatched-"));
  chmodSync(dir, 0o700);
  let typo: World;
  let clean: World;
  beforeAll(async () => {
    let src = readFileSync(FIXTURE_LEAGUE, "utf8");
    for (const [from, to] of TYPOS) {
      if (!src.includes(from)) throw new Error(`fixture line moved: ${from}`);
      src = src.replace(from, to);
    }
    const file = path.join(dir, "league.yaml");
    writeFileSync(file, src, { mode: 0o600 });
    typo = await makeWorld({ env: { FF_LEAGUE_FILE: file } });
    clean = await makeWorld();
  }, 180_000);
  afterAll(() => {
    typo.cleanup();
    clean.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  const roster = async (world: World): Promise<B1> => {
    const { client, close } = await connect(world);
    const r = await client.callTool({ name: "ff_get_roster", arguments: { week: 3 } });
    await close();
    expect(r.isError, JSON.stringify(r.content)).not.toBe(true);
    return body(r) as unknown as B1;
  };
  const unmatchedOf = (b: B1): string[] =>
    b.data.players
      .filter((p) => p.gsis_id === null && p.position !== "DEF")
      .map((p) => p.player_key);

  it("two typo'd lines: both listed with gsis_id null, both keys named, the count right", async () => {
    const b = await roster(typo);
    const keys = unmatchedOf(b);
    expect(keys).toHaveLength(TYPOS.length);
    const w = b.warnings.filter((x) => x.includes("unmatched"));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(new RegExp(`^${String(keys.length)} rostered players are unmatched`));
    for (const k of keys) expect(w[0]).toContain(k);
  });

  it("control: the fixture roster matches fully — no unmatched warning", async () => {
    const b = await roster(clean);
    expect(unmatchedOf(b)).toEqual([]);
    expect(b.warnings.filter((x) => x.includes("unmatched"))).toEqual([]);
  });
});
