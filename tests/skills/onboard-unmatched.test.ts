// onboard-unmatched.test.ts — QA-1-048: the onboard Skill and its guide tell the user where an
// unmatched rostered player is listed and how to fix the entry. Every surface the text names for
// that list must actually list the player, and the documented fix — find the player's NFL id,
// add it as `gsis_id` — must be followable with the tools the text names and must settle the match.
// A player entered with last season's NFL team (nflverse has him elsewhere) is the case.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectStatus } from "../../src/cli/status.js";
import { runDoctor } from "../../src/cli/doctor.js";
import { makeIo } from "../cli/helpers.js";
import { ROOT } from "./helpers.js";
import { T0, dataOf, sentences, skillWorld, type SkillWorld } from "./world.js";

const NAME = "Kenneth Walker III";
const GSIS = "00-0038134";
const NFLVERSE_TEAM = "KC";
/** The fixture line, and the same player as a user would enter him with a stale team and no id. */
const FIXTURE_LINE = `${NAME}, team: KC, position: RB, gsis_id: "${GSIS}"`;
const STALE_LINE = `${NAME}, team: SEA, position: RB`;

const TEXTS = ["skills/onboard/SKILL.md", "skills/onboard/references/onboard-league-yaml.md"].map(
  (f) => ({ file: f, text: readFileSync(path.join(ROOT, f), "utf8") }),
);
/** Sentences that tell the reader where unmatched players are listed or how to fix one. */
const remedy = TEXTS.flatMap(({ file, text }) =>
  sentences(text)
    .filter((s) => /\bunmatched\b|cannot match/i.test(s))
    .map((s) => ({ file, s })),
);

/** The surfaces a Skill may name for the unmatched list. */
const SURFACES = {
  "ff status": /\bff status\b/,
  "ff doctor": /\bff doctor\b/,
  ff_get_status: /\bff_get_status\b/,
} as const;
type Surface = keyof typeof SURFACES;

let stale: SkillWorld;
beforeAll(async () => {
  stale = await skillWorld(T0, [[FIXTURE_LINE, STALE_LINE]]);
}, 60_000);
afterAll(async () => {
  await stale.close();
});

/** What a surface shows on the stale-team world, as text. */
async function show(surface: Surface): Promise<string> {
  const w = stale.world;
  const sb = {
    dir: w.root,
    home: path.join(w.root, "home"),
    configDir: path.join(w.root, "config"),
    cacheDir: w.cache,
    cleanup: () => undefined,
  };
  switch (surface) {
    case "ff_get_status":
      return JSON.stringify(dataOf(await stale.call("ff_get_status")));
    case "ff status":
      return JSON.stringify(collectStatus(makeIo(sb, { clock: w.clock }), w.config, w.logger));
    case "ff doctor":
      return JSON.stringify(
        await runDoctor(makeIo(sb, { clock: w.clock }), {
          json: true,
          online: false,
          fix: false,
          yes: false,
        }),
      );
  }
}

describe("QA-1-048: the unmatched-player remedy in the onboard Skill can be followed", () => {
  it("the stale-team entry is unmatched on the server (control)", async () => {
    const cw = dataOf(await stale.call("ff_get_status")).crosswalk as {
      unmatched_rostered: { name: string }[];
    };
    expect(JSON.stringify(cw.unmatched_rostered)).toContain(NAME);
  });

  it("the text names at least one place where unmatched players are listed", () => {
    const named = Object.entries(SURFACES).filter(([, re]) => remedy.some((r) => re.test(r.s)));
    expect(named.length).toBeGreaterThan(0);
  });

  it("every place the text names for the unmatched list actually lists the player", async () => {
    const wrong: string[] = [];
    for (const [surface, re] of Object.entries(SURFACES) as [Surface, RegExp][]) {
      const where = remedy.filter((r) => re.test(r.s));
      if (where.length === 0) continue;
      if (!(await show(surface)).includes(NAME))
        wrong.push(`${surface} (named in ${where.map((r) => r.file).join(", ")})`);
    }
    expect(wrong).toEqual([]);
  });

  it("the guide says how to look up the NFL id, and that lookup returns it", async () => {
    const guide = remedy.filter((r) => r.file.endsWith("onboard-league-yaml.md")).map((r) => r.s);
    const lookup = guide.find((s) => s.includes("ff_project_players") && s.includes("nfl_team"));
    expect(
      lookup,
      "the guide's remedy names ff_project_players with an nfl_team selector",
    ).toBeDefined();
    const pp = dataOf(
      await stale.call("ff_project_players", {
        players: { nfl_team: NFLVERSE_TEAM },
        horizon: "week",
        week: 4,
      }),
    ) as { projections: { name: string; gsis_id: string | null }[] };
    expect(pp.projections.find((p) => p.name === NAME)?.gsis_id).toBe(GSIS);
  });

  it("the documented fix (a quoted gsis_id on the player's line) settles the match", async () => {
    const guide = TEXTS[1]?.text ?? "";
    expect(guide).toMatch(/gsis_id: "00-\d{7}"/);
    const fixed = await skillWorld(T0, [[FIXTURE_LINE, `${STALE_LINE}, gsis_id: "${GSIS}"`]]);
    try {
      const cw = dataOf(await fixed.call("ff_get_status")).crosswalk as {
        unmatched_rostered: { name: string }[];
      };
      expect(JSON.stringify(cw.unmatched_rostered)).not.toContain(NAME);
    } finally {
      await fixed.close();
    }
  }, 60_000);
});
