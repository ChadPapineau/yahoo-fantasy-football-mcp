// retro-followed.test.ts — QA-2-040 at the MCP surface: the manual league file holds only the CURRENT
// roster (ManualLeagueProvider.getRoster), so ff_analyze_retrospective may decide `followed` for a
// past week from it only while the file is unchanged since that week's last lock. Editing the file
// for the next week (what the Skills ask after every move) must never flip a past week's answer, and
// ff_analyze_retrospective and ff_list_recommendations report the same `followed` for every log_id.
import { chmodSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seededRng } from "../../src/domain/clock.js";
import { FIXTURE_LEAGUE, body, connect, makeWorld, type World } from "./helpers/env.js";

let dir: string;
let file: string;
let world: World;
let c: Awaited<ReturnType<typeof connect>>;
const FIXTURE = readFileSync(FIXTURE_LEAGUE, "utf8");

interface Env {
  data: Record<string, unknown>;
  meta: { request_id: string };
  warnings: string[];
}
interface Call {
  log_id: string;
  followed: boolean | null;
}
const ok = async (name: string, args: Record<string, unknown>): Promise<Env> => {
  const r = await c.client.callTool({ name, arguments: args });
  const b = body(r);
  if (r.isError === true) throw new Error(`${name}: ${JSON.stringify(b)}`);
  return b as unknown as Env;
};

/** The league file with its content and last-edit instant set (mode 0600 kept). */
function writeLeague(yaml: string, editedAt: string): void {
  writeFileSync(file, yaml, { mode: 0o600 });
  const t = new Date(editedAt);
  utimesSync(file, t, t);
}

/** Swaps the slots of two of my players (lines identified by their gsis id). */
function swapSlots(yaml: string, a: string, b: string): string {
  const slotOf = (g: string): string => {
    const m = new RegExp(`gsis_id: "${g}", slot: ([^ ,}]+)`).exec(yaml);
    if (m?.[1] === undefined) throw new Error(`no slot for ${g}`);
    return m[1];
  };
  const [sa, sb] = [slotOf(a), slotOf(b)];
  return yaml
    .replace(`gsis_id: "${a}", slot: ${sa}`, `gsis_id: "${a}", slot: @@`)
    .replace(`gsis_id: "${b}", slot: ${sb}`, `gsis_id: "${b}", slot: ${sa}`)
    .replace(`gsis_id: "${a}", slot: @@`, `gsis_id: "${a}", slot: ${sb}`);
}

const ALLEN = "00-0034857"; // QB
const LOVE = "00-0036264"; // BN (QB)
/** Same-position pairs of my players whose slots can be swapped without breaking the file. */
const SWAPPABLE: readonly (readonly [string, string])[] = [
  [ALLEN, LOVE],
  ["00-0037744", "00-0033090"], // McBride TE / Hunter Henry BN
  ["00-0039139", "00-0038134"], // Gibbs RB / Walker BN
  ["00-0036900", "00-0030279"], // Chase WR / Keenan Allen BN
  ["00-0038543", "00-0030279"], // Smith-Njigba W/R/T / Keenan Allen BN
];
const qb = (gsis: string, role: "start" | "sit") => ({
  player_key: `manual.p.${gsis}`,
  gsis_id: gsis,
  nfl_team: null,
  role,
  slot: "QB",
});

const logged: Record<string, string> = {};
/** The fixture releases are dated after this scenario's pre-week-3 clock: re-date the rec to it. */
const redate = (rec: unknown): Record<string, unknown> => {
  const now = world.clock.nowIso();
  const r = rec as { confidence: { inputs: object[] } } & Record<string, unknown>;
  return {
    ...r,
    as_of: now,
    confidence: { ...r.confidence, inputs: r.confidence.inputs.map((i) => ({ ...i, as_of: now })) },
  };
};
async function log(
  name: string,
  rec: Record<string, unknown>,
  requestId: string,
  hint = "unknown",
): Promise<void> {
  const r = await ok("ff_record_recommendation", {
    kind: "lineup",
    week: 3,
    rec,
    source_calls: [{ tool: "ff_analyze_lineup", request_id: requestId }],
    followed_hint: hint,
    client_ref: `qa2040-${name}`,
  });
  logged[name] = r.data.log_id as string;
}

async function retro(): Promise<{ calls: Map<string, boolean | null>; warnings: string[] }> {
  const e = await ok("ff_analyze_retrospective", { week: 3, allow_stale: true });
  const calls = new Map((e.data.calls as Call[]).map((x) => [x.log_id, x.followed]));
  // E14 lists the persisted outcome: it must say exactly what E13 just said, for every log_id
  const list = await ok("ff_list_recommendations", { week: 3 });
  const items = list.data.items as Call[];
  expect(items.length).toBe(calls.size);
  for (const i of items) expect(i.followed, i.log_id).toBe(calls.get(i.log_id));
  return { calls, warnings: e.warnings };
}
const followed = (r: { calls: Map<string, boolean | null> }, name: string) =>
  r.calls.get(logged[name] ?? "");
const EDITED = "league file was edited after week 3 locked";

let first: { calls: Map<string, boolean | null>; warnings: string[] };

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "ff-followed-"));
  chmodSync(dir, 0o700);
  file = path.join(dir, "league.yaml");
  // the lineup as set for week 3, saved on Tuesday before it
  writeLeague(FIXTURE, "2026-09-22T12:00:00.000Z");
  world = await makeWorld({ clock: "2026-09-23T12:00:00.000Z", env: { FF_LEAGUE_FILE: file } });
  c = await connect(world);
  const lineup = await ok("ff_analyze_lineup", { week: 3 });
  const rec = redate(lineup.data.rec);
  const id = lineup.meta.request_id;
  await log("lineup", rec, id);
  // a call the user followed (Allen stays at QB) and one they did not (Love never started)
  await log(
    "kept",
    { ...rec, action: "Start Josh Allen at QB", subjects: [qb(ALLEN, "start")] },
    id,
  );
  await log(
    "changed",
    {
      ...rec,
      action: "Start Jordan Love at QB over Josh Allen",
      subjects: [qb(LOVE, "start"), qb(ALLEN, "sit")],
    },
    id,
  );
  // a late-Sunday swap (Walker in for Gibbs) is still week 3's lineup: the week's last player
  // locks only at its LAST kickoff (Monday night), so the file is evidence until then
  writeLeague(swapSlots(FIXTURE, "00-0039139", "00-0038134"), "2026-09-27T15:00:00.000Z");
  // Tuesday after week 3: provisional scoring from the unchanged-since-lock file
  world.clock.set("2026-09-29T12:00:00.000Z");
  first = await retro();
}, 120_000);
afterAll(async () => {
  await c.close();
  world.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

describe("QA-2-040: a past week's followed never flips when league.yaml is edited later", () => {
  it("unchanged since the week's last lock, the file is the week's evidence", () => {
    expect(followed(first, "kept")).toBe(true);
    expect(followed(first, "changed")).toBe(false);
    expect(typeof followed(first, "lineup")).toBe("boolean");
    expect(first.warnings.some((w) => w.includes(EDITED))).toBe(false);
  });

  it("edited for week 5 (Allen benched, Love at QB), week 3's answers stand, final or not", async () => {
    // Wednesday: the user edits the file for the next week — every answer is carried forward
    writeLeague(swapSlots(FIXTURE, ALLEN, LOVE), "2026-09-30T12:00:00.000Z");
    const provisional = await retro();
    // Friday: week 3 is final — the frozen outcome holds the same answers
    world.clock.set("2026-10-02T15:00:00.000Z");
    const final = await retro();
    for (const r of [provisional, final]) {
      for (const name of ["kept", "changed", "lineup"])
        expect(followed(r, name), name).toBe(followed(first, name));
      expect(r.warnings.some((w) => w.includes(EDITED))).toBe(true);
    }
  });

  it("any later edit of the file leaves every answer as first decided (property over edits)", async () => {
    const rng = seededRng(2040);
    let yaml = FIXTURE;
    for (let run = 0; run < 6; run++) {
      const pair = SWAPPABLE[Math.floor(rng.next() * SWAPPABLE.length)] ?? SWAPPABLE[0]!;
      yaml = swapSlots(yaml, pair[0], pair[1]);
      const editedAt = new Date(
        Date.parse("2026-09-30T00:00:00.000Z") + Math.floor(rng.next() * 3 * 86_400_000),
      ).toISOString();
      writeLeague(yaml, editedAt);
      const r = await retro();
      for (const name of ["kept", "changed", "lineup"])
        expect(followed(r, name), `${name} after edit ${String(run)}`).toBe(followed(first, name));
    }
  });

  it("a call first scored after the edit is never settled from the edited file", async () => {
    writeLeague(swapSlots(FIXTURE, ALLEN, LOVE), "2026-10-01T09:00:00.000Z");
    const lineup = await ok("ff_analyze_lineup", { week: 3, allow_stale: true });
    const rec = { ...(lineup.data.rec as Record<string, unknown>) };
    const id = lineup.meta.request_id;
    // the edited file says Allen is benched: as evidence it would say "not followed"
    await log(
      "late",
      { ...rec, action: "Start Josh Allen at QB", subjects: [qb(ALLEN, "start")] },
      id,
    );
    await log(
      "late-yes",
      { ...rec, action: "Start Josh Allen at QB", subjects: [qb(ALLEN, "start")] },
      id,
      "user_said_yes",
    );
    const r = await retro();
    expect(followed(r, "late")).toBeNull();
    expect(followed(r, "late-yes")).toBe(true);
    for (const name of ["kept", "changed", "lineup"])
      expect(followed(r, name), name).toBe(followed(first, name));
  });
});
