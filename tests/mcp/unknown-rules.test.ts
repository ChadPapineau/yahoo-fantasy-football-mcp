// unknown-rules.test.ts — QA-1-045: a rule league.yaml does not state is unknown (null), never a
// silent "no". A file silent on waivers and playoffs serves uses_faab null, uses_playoff null, a
// null playoff line, and scoreboard matchups with is_playoffs null.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_LEAGUE, connect, makeWorld, type World } from "./helpers/env.js";

let dir: string;
let world: World;
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "ff-rules-"));
  chmodSync(dir, 0o700);
  const file = path.join(dir, "league.yaml");
  let yaml = readFileSync(FIXTURE_LEAGUE, "utf8");
  for (const cut of [
    "  playoffs:\n    start_week: 15\n    num_teams: 6\n",
    "  waiver_type: faab\n",
    "  faab_budget: 100\n",
  ]) {
    if (!yaml.includes(cut)) throw new Error(`fixture league has no ${cut}`);
    yaml = yaml.replace(cut, "");
  }
  writeFileSync(file, yaml, { mode: 0o600 });
  world = await makeWorld({ env: { FF_LEAGUE_FILE: file } });
}, 60_000);
afterAll(() => {
  world.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

async function data(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { client, close } = await connect(world);
  const r = await client.callTool({ name, arguments: args });
  await close();
  const text = (r.content as { text: string }[])[0]?.text ?? "";
  expect(r.isError, text.slice(0, 300)).not.toBe(true);
  return (JSON.parse(text) as { data: Record<string, unknown> }).data;
}

describe("rules the file does not state are unknown, not false [QA-1-045]", () => {
  it("A2: uses_faab and playoffs.uses_playoff are null", async () => {
    const d = await data("ff_get_league", { include: ["rules"] });
    const rules = d.rules as { uses_faab: unknown; playoffs: { uses_playoff: unknown } };
    expect(rules.uses_faab).toBeNull();
    expect(rules.playoffs.uses_playoff).toBeNull();
  });
  it("A3: the playoff line is null; A4: is_playoffs is null", async () => {
    const s = await data("ff_get_standings", {});
    expect(s.playoff_line).toEqual({ num_playoff_teams: null, start_week: null });
    const b = await data("ff_get_scoreboard", { week: 3 });
    const m = b.matchups as { is_playoffs: unknown }[];
    expect(m.length).toBeGreaterThan(0); // control: week 3 has an opponent
    for (const x of m) expect(x.is_playoffs).toBeNull();
  });
});
