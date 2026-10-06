// skills-dry-run.test.ts — Skills Lane 1 item 7 (plan 09 §5.1; plan 10 A10) and the A9 chain: every
// Skill's evals/tool_sequence.json is replayed against the fixture-mode server (in-process client over
// the real modules, tests/mcp/helpers/env.ts), resolving `$ref` / `$source_calls` from the earlier
// steps' envelopes (scripts/skills/tool-sequences.mjs). Each resolved argument set must pass the
// tool's own zod input schema, each outcome must be one the step's `expect` allows, and every `$ref`
// must resolve — so each call returns what the Skill reads next. Fixture variants: `no-league-file`
// (the league file absent) and `two-slots-locked` (a Sunday clock at which week 4's early games have
// kicked off and the late ones have not). A9: start-sit's pre-game run on week 3, then retro's run
// on week 4 scores the logged call (regret, followed, per-player metrics, swap regret, Brier).
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, copyFileSync, utimesSync } from "node:fs";
import path from "node:path";
import { datasetDir, storePath } from "../../src/config/paths.js";
import { seededRng } from "../../src/domain/clock.js";
import { REGISTRY } from "../../src/mcp/registry.js";
import { NFLVERSE_SOURCES } from "../../src/sources/nflverse/index.js";
import { fsTempArea, runRefresh } from "../../src/sources/runner.js";
import { storeFactory } from "../../src/store/index.js";
import {
  loadToolSequences,
  outcomeAllowed,
  resolveArgs,
} from "../../scripts/skills/tool-sequences.mjs";
import {
  FIXTURE_LEAGUE,
  PUBLISHED,
  T0,
  body,
  connect,
  makeWorld,
  type World,
} from "../mcp/helpers/env.js";
import { fakeHttp, fixtureRoutes } from "../sources/nflverse/helpers/harness.js";

/** The scheduled jobs' refresh at the world's clock (the unchanged release check moves checked_at). */
async function refreshAtClock(world: World): Promise<void> {
  const publisher = storeFactory.openPublisher({
    storePath: storePath(world.cache),
    datasetDir: datasetDir(world.cache),
    clock: world.clock,
  });
  try {
    const { http } = fakeHttp(fixtureRoutes());
    for (const p of PUBLISHED) {
      const r = await runRefresh(
        { source: NFLVERSE_SOURCES[p.id], seasons: p.seasons, week: null },
        {
          http,
          clock: world.clock,
          rng: seededRng(2),
          publisher,
          refreshLog: world.store.repos.refreshLog,
          schedules: world.store.datasets.schedules,
          temp: fsTempArea(path.join(world.cache, "tmp")),
          sleep: () => Promise.resolve(),
        },
      );
      expect(["published", "unchanged"]).toContain(r.status);
    }
  } finally {
    publisher.close();
  }
  world.store.reattachIfChanged();
}

/** Sunday of week 4, after the 13:00 ET kickoffs and before the 16:05/16:25 ET ones. */
const SUNDAY_WEEK4 = "2026-10-04T18:00:00.000Z";
/** Wednesday before week 3 (its first kickoff is Thursday 2026-09-24). */
const BEFORE_WEEK3 = "2026-09-23T12:00:00.000Z";

interface StepResult {
  tool: string;
  result: Record<string, unknown>;
}
interface Step {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  expect: string[];
}

const worlds: World[] = [];

/**
 * A fixture world whose league file is a private copy at <config>/league.yaml (0600) with its mtime
 * set a day before the world's clock: the provider stamps as_of from the file's mtime, and a checkout
 * newer than the fixed clock would make every rec "in the future" for E12 (it did on CI, where the
 * clone is minutes old). `league: false` leaves it absent (the no-league-file variant).
 */
async function leagueWorld(clock: string, league: boolean): Promise<World> {
  const world = await makeWorld({ noLeague: true, clock });
  worlds.push(world);
  if (league) {
    const file = path.join(world.root, "config", "league.yaml");
    copyFileSync(FIXTURE_LEAGUE, file);
    chmodSync(file, 0o600);
    const before = new Date(Date.parse(clock) - 86_400_000);
    utimesSync(file, before, before);
  }
  return world;
}
afterEach(() => {
  for (const w of worlds.splice(0)) w.cleanup();
});

const inputOf = (tool: string) => {
  const def = REGISTRY.find((e) => e.tool.name === tool)?.tool;
  if (def === undefined) throw new Error(`unknown tool ${tool}`);
  return def.input;
};

/**
 * Replays `steps` on a connected client; returns the step results. `mutate` may rewrite resolved
 * arguments (the A9 chain re-dates a replayed week's rec — see redate()).
 */
async function replay(
  world: World,
  label: string,
  steps: readonly Step[],
  mutate: (step: Step, args: Record<string, unknown>) => Record<string, unknown> = (_, a) => a,
): Promise<Map<string, StepResult>> {
  const { client, close } = await connect(world);
  const results = new Map<string, StepResult>();
  try {
    for (const step of steps) {
      const args = mutate(step, resolveArgs(step.args, results) as Record<string, unknown>);
      const parsed = inputOf(step.tool).safeParse(args);
      expect(parsed.success, `${label}/${step.id}: args fail ${step.tool}'s input schema`).toBe(
        true,
      );
      const r = await client.callTool({ name: step.tool, arguments: args });
      const b = body(r);
      const outcome = r.isError === true ? (b as { error: { code: string } }).error.code : "ok";
      expect(
        outcomeAllowed(step, outcome),
        `${label}/${step.id} (${step.tool}) → ${outcome}: ${JSON.stringify(b).slice(0, 300)}`,
      ).toBe(true);
      if (outcome === "ok") results.set(step.id, { tool: step.tool, result: b });
    }
  } finally {
    await close();
  }
  return results;
}

const sequences = loadToolSequences();

describe("every Skill's tool sequence replays against the fixture-mode server", () => {
  it("loads the four 1a Skills' sequences", () => {
    expect(sequences.map((s) => s.skill).sort()).toEqual([
      "onboard",
      "retro",
      "start-sit",
      "stream-kdef",
    ]);
  });

  for (const skill of sequences) {
    for (const seq of skill.sequences) {
      it(`${skill.skill}/${seq.id} (${seq.fixture_variant ?? "base fixture"})`, async () => {
        const variant = seq.fixture_variant;
        const world = await leagueWorld(
          variant === "two-slots-locked" ? SUNDAY_WEEK4 : T0,
          variant !== "no-league-file",
        );
        if (variant !== null && !["no-league-file", "two-slots-locked"].includes(variant))
          throw new Error(`unknown fixture variant ${variant}`);
        const results = await replay(world, `${skill.skill}/${seq.id}`, seq.steps);
        if (variant === "two-slots-locked") {
          const roster = results.get("roster")?.result as {
            data: { lock_schedule: { lock_at: string | null }[] };
          };
          const now = Date.parse(SUNDAY_WEEK4);
          const locks = roster.data.lock_schedule
            .map((l) => l.lock_at)
            .filter((x): x is string => x !== null);
          expect(
            locks.some((l) => Date.parse(l) <= now),
            "some slot locked",
          ).toBe(true);
          expect(
            locks.some((l) => Date.parse(l) > now),
            "some slot still open",
          ).toBe(true);
        }
        // the logging step, when present, recorded (plan 09: record before answering)
        const rec = results.get("record");
        const logs = (seq.steps as Step[]).some((s) => s.tool === "ff_record_recommendation");
        if (logs) expect(rec?.result.data, "the record step succeeded").toBeDefined();
      }, 60_000);
    }
  }
});

describe("A9: start-sit on week N, retro on week N+1", () => {
  it("the logged week-3 call is scored: regret, followed, per-player metrics, swap regret, Brier", async () => {
    const world = await leagueWorld(BEFORE_WEEK3, true);
    const startSit = sequences.find((s) => s.skill === "start-sit")?.sequences[0];
    expect(startSit?.id).toBe("pre_game");
    // the pre-game sequence, replayed for week 3 (its fixture week is 4, which has no stats yet)
    const toWeek3 = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(toWeek3)
        : typeof v === "object" && v !== null
          ? Object.fromEntries(
              Object.entries(v).map(([k, x]) => [k, k === "week" && x === 4 ? 3 : toWeek3(x)]),
            )
          : v;
    const steps = (startSit?.steps ?? []).map((s) => ({
      ...s,
      args: toWeek3(s.args) as Record<string, unknown>,
    })) as Step[];
    // The fixture releases are dated 2026-09-30, after this replay's pre-week-3 clock, so a rec's
    // as_of (its newest input) would be "in the future" for E12 — an artefact of replaying a past
    // week on today's files (the MCP suite's retro.test.ts does the same). Re-date it to the clock.
    const redate = (step: Step, args: Record<string, unknown>) => {
      if (step.tool !== "ff_record_recommendation") return args;
      const now = world.clock.nowIso();
      const r = args.rec as { confidence: { inputs: { as_of: string }[] } };
      return {
        ...args,
        rec: {
          ...r,
          as_of: now,
          confidence: {
            ...r.confidence,
            inputs: r.confidence.inputs.map((i) => ({ ...i, as_of: now })),
          },
        },
      };
    };
    const pre = await replay(world, "start-sit/pre_game@w3", steps, redate);
    const logId = (pre.get("record")?.result.data as { log_id: string }).log_id;
    expect(logId).toMatch(/^rec-/);

    world.clock.set(T0); // Wednesday of week 4: week 3 is final
    await refreshAtClock(world); // the scheduled refresh jobs have run since
    const retroSeq = sequences.find((s) => s.skill === "retro")?.sequences[0];
    const post = await replay(world, "retro@w4", retroSeq?.steps ?? []);
    const retro = post.get("retro")?.result.data as {
      calls: { log_id: string; followed: boolean | null; regret: number | null }[];
      metrics: {
        per_player: Record<string, unknown>;
        swap_regret: Record<string, unknown>;
        brier: Record<string, unknown>;
      };
      sample_size_caveats: string[];
    };
    const call = retro.calls.find((c) => c.log_id === logId);
    expect(call, "the week-3 call is in the retrospective").toBeDefined();
    // start-sit logs the other side of the runner-up swap as a like-for-like alternative (QA-2-041),
    // so the week-3 call has a regret: a finite number, never null or missing
    expect(typeof call?.regret, JSON.stringify(call)).toBe("number");
    expect(Number.isFinite(call?.regret), JSON.stringify(call)).toBe(true);
    expect(call).toHaveProperty("followed");
    expect(retro.metrics.per_player).toBeDefined();
    expect(retro.metrics.swap_regret).toBeDefined();
    expect(retro.metrics.brier).toHaveProperty("p_active");
    expect(JSON.stringify(retro.metrics.brier.p_win)).toMatch(/n too small \(\d+ of 30\)/);
    expect(retro.sample_size_caveats.length).toBeGreaterThan(0);
    expect(retro).not.toHaveProperty("parameter_changes_proposed");
    expect(post.get("record")?.result.data).toBeDefined();
  }, 120_000);
});
