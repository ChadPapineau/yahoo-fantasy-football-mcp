// projection-persistence.test.ts — QA-1-031/QA-1-081: the never-pruned projection table grows with
// what the caller and the retrospective can use. (a) E1 persists only the projections it returns —
// a result cut to its budget stores no cut player; (b) each row keeps the retrospective's sample cap,
// not n_sims; (c) a re-run whose only change is a league.yaml status edit (which moves p_active) is
// a new row, not collapsed into the earlier run.
import { chmodSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { storePath } from "../../src/config/paths.js";
import { SIMS } from "../../src/domain/analytics/constants.js";
import { subjectKey } from "../../src/store/repos/projection.js";
import { RETRO_SAMPLE_CAP } from "../../src/mcp/tools/reclog.js";
import { FIXTURE_LEAGUE, T0, connect, makeWorld, type World } from "./helpers/env.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

async function e1(w: World, args: Record<string, unknown>) {
  const { client, close } = await connect(w);
  const r = await client.callTool({ name: "ff_project_players", arguments: args });
  await close();
  const text = (r.content as { text: string }[])[0]?.text ?? "";
  expect(r.isError, text.slice(0, 300)).not.toBe(true);
  return JSON.parse(text) as {
    data: { projections: { player_key: string | null; gsis_id: string | null }[] };
    truncated: boolean;
  };
}

/** Stored rows per subject key (the store's own file, read-only). */
function rows(w: World): Map<string, number> {
  const db = new DatabaseSync(storePath(w.cache), { readOnly: true });
  try {
    const r = db
      .prepare("SELECT subject_key AS k, COUNT(*) AS n FROM projection GROUP BY subject_key")
      .all() as unknown as { k: string; n: number }[];
    return new Map(r.map((x) => [x.k, x.n]));
  } finally {
    db.close();
  }
}

describe("E1 persists what it returns, at the retrospective's sample cap [QA-1-031, QA-1-081]", () => {
  it("a result cut to its budget stores no cut player", async () => {
    const w = await makeWorld();
    cleanups.push(() => {
      w.cleanup();
    });
    const out = await e1(w, {
      players: { pool: { status: "A", position: "WR", top: 50 } },
      horizon: "ros",
    });
    expect(out.truncated).toBe(true); // control: the budget really cut the list
    const returned = out.data.projections
      .map((p) => p.gsis_id)
      .filter((g): g is string => g !== null)
      .map((g) => subjectKey({ kind: "player", gsis_id: g }))
      .sort();
    expect(returned.length).toBeGreaterThan(0);
    expect([...rows(w).keys()].sort()).toEqual(returned);
  }, 60_000);

  it("each stored projection keeps RETRO_SAMPLE_CAP samples, whatever n_sims", async () => {
    expect(SIMS.stored).toBe(RETRO_SAMPLE_CAP);
    const w = await makeWorld();
    cleanups.push(() => {
      w.cleanup();
    });
    await e1(w, {
      players: { player_keys: ["manual.p.00-0034857"] },
      horizon: "week",
      week: 4,
      n_sims: 4000,
    });
    const p = w.services.projections.latest(
      { kind: "player", gsis_id: "00-0034857" },
      2026,
      4,
      "v1-trailing",
    );
    expect(p?.samples.length).toBe(RETRO_SAMPLE_CAP);
  }, 60_000);

  it("a league.yaml status edit alone is a new stored row, not collapsed into the earlier run", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ff-proj-"));
    chmodSync(dir, 0o700);
    const file = path.join(dir, "league.yaml");
    const line =
      '    - { name: Josh Allen, team: BUF, position: QB, gsis_id: "00-0034857", slot: QB }';
    const yaml = readFileSync(FIXTURE_LEAGUE, "utf8");
    if (!yaml.includes(line)) throw new Error("fixture league changed");
    const at = (minutes: number): Date => new Date(Date.parse(T0) + minutes * 60_000);
    writeFileSync(file, yaml, { mode: 0o600 });
    utimesSync(file, at(-60), at(-60));
    const w = await makeWorld({ env: { FF_LEAGUE_FILE: file } });
    cleanups.push(() => {
      w.cleanup();
      rmSync(dir, { recursive: true, force: true });
    });
    const args = { players: { player_keys: ["manual.p.00-0034857"] }, horizon: "week", week: 4 };
    const ALLEN = subjectKey({ kind: "player", gsis_id: "00-0034857" });
    await e1(w, args);
    expect(rows(w).get(ALLEN)).toBe(1);
    writeFileSync(file, yaml.replace(line, line.replace(" slot: QB }", " slot: QB, status: Q }")));
    utimesSync(file, at(-30), at(-30));
    w.clock.set(at(1).toISOString());
    await e1(w, args);
    expect(rows(w).get(ALLEN)).toBe(2);
  }, 60_000);
});
