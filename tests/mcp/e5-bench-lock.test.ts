// e5-bench-lock.test.ts — QA-2-033 through the tool: a locked K/DEF on the BENCH never freezes the
// position and is never the hold-vs-stream baseline; only a locked starter does. The engine decides
// that from each rostered K/DEF's `slot_class` (6ce75ec); ff_analyze_waivers must pass it, or every
// rostered K/DEF reads as a possible starter and the finding reproduces at the tool. The finding's
// reproduction: Friday of week 5, KC (on bye, unlocked) at DEF and DAL (played Thursday) on the bench.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_LEAGUE, body, connect, makeWorld, type World } from "./helpers/env.js";

/** Friday 2026-10-09 12:00 EDT: DAL's Thursday game has started; KC is on bye in week 5. */
const FRIDAY_WEEK5 = "2026-10-09T16:00:00.000Z";
const DEF_LINE = "    - { defense: DET, slot: DEF }";

interface E5 {
  data: {
    rec: { action: string; assumptions: { text: string }[] };
    hold_vs_stream: { position: string; current_starter_delta: number } | null;
  };
}

describe("a locked bench DEF never freezes the position (QA-2-033)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ff-e5-bench-"));
  chmodSync(dir, 0o700);
  const worlds = new Map<string, World>();
  const VARIANTS = [
    ["KC at DEF", "    - { defense: KC, slot: DEF }"],
    [
      "KC at DEF, DAL on the bench",
      "    - { defense: KC, slot: DEF }\n    - { defense: DAL, slot: BN }",
    ],
  ] as const;
  beforeAll(async () => {
    const src = readFileSync(FIXTURE_LEAGUE, "utf8");
    if (!src.includes(DEF_LINE)) throw new Error("fixture DEF line moved");
    for (const [label, lines] of VARIANTS) {
      const file = path.join(dir, `league-${String(worlds.size)}.yaml`);
      writeFileSync(file, src.replace(DEF_LINE, lines), { mode: 0o600 });
      worlds.set(label, await makeWorld({ clock: FRIDAY_WEEK5, env: { FF_LEAGUE_FILE: file } }));
    }
  }, 180_000);
  afterAll(() => {
    for (const w of worlds.values()) w.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  async function waivers(label: string): Promise<E5["data"]> {
    const world = worlds.get(label);
    if (world === undefined) throw new Error(`no world ${label}`);
    const { client, close } = await connect(world);
    try {
      const r = await client.callTool({
        name: "ff_analyze_waivers",
        arguments: { positions: ["DEF"] },
      });
      const b = body(r);
      expect(r.isError, JSON.stringify(b).slice(0, 400)).not.toBe(true);
      return (b as unknown as E5).data;
    } finally {
      await close();
    }
  }

  it("the call is the same with and without the locked bench DEF, and it streams", async () => {
    const alone = await waivers("KC at DEF");
    const benched = await waivers("KC at DEF, DAL on the bench");
    expect(alone.rec.action).toMatch(/^stream DEF /);
    expect(benched.rec.action).toBe(alone.rec.action);
    // the baseline is the starter the user can field (KC), never the benched DAL
    expect(benched.hold_vs_stream?.current_starter_delta).toBe(
      alone.hold_vs_stream?.current_starter_delta,
    );
    expect(benched.rec.assumptions.some((a) => a.text.includes("no DEF move this week"))).toBe(
      false,
    );
  });
});
