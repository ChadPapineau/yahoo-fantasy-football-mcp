// injuries-report-state.test.ts — QA-2-034 / QA-1-021 through D2: ff_get_injuries reads the official
// report the way E1 does. A team's rows appear with its first PRACTICE report; designations only with
// its game-status report. Until that is out, "not designated" is not "cleared to play": the newest
// designation on an earlier game-status report is carried (for at most INJURY_REPORT.carryWeeks
// weeks; past that, availability is unknown), and a new did-not-practise is not cleared either. D2
// used to treat "his team has any row this week" as published and looked one week back only, so it
// showed p_active 1 mid-week, and for look-ahead weeks, where E1 showed 0.
//
// The property: for every player and every week he plays, D2's p_active and basis are E1's.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { datasetDir, storePath } from "../../src/config/paths.js";
import { INJURY_REPORT, P_ACTIVE } from "../../src/domain/analytics/constants.js";
import { DS_INJURIES } from "../../src/store/datasets/tables.js";
import { storeFactory } from "../../src/store/index.js";
import { publishTables, row } from "../store/helpers/datasets.js";
import { FIXTURE_LEAGUE, body, connect, makeWorld, type World } from "./helpers/env.js";

interface D2 {
  data: {
    week: number;
    players: { gsis_id: string | null; p_active: number | null; p_active_basis: string }[];
  };
  warnings: string[];
}
interface E1 {
  data: {
    projections: {
      gsis_id: string | null;
      weeks: { week: number; p_active: number | null; opponent: string | null }[];
    }[];
  };
}

const COLLINS = "00-0036554"; // HOU WR: Out on the week 2 and 3 game-status reports
const NACUA = "00-0039075"; // LA WR: Doubtful in week 3
const BOWERS = "00-0039338"; // LV TE: Questionable in week 3, did not practise
const ALLEN = "00-0034857"; // BUF QB
const GIBBS = "00-0039139"; // DET RB
const JSN = "00-0038543"; // SEA WR
const HENRY = "00-0032764"; // BAL RB

/** A league file: the fixture's, each [from, to] line replaced (the fixture must still hold `from`). */
function leagueVariant(dir: string, edits: readonly (readonly [string, string])[]): string {
  let src = readFileSync(FIXTURE_LEAGUE, "utf8");
  for (const [from, to] of edits) {
    if (!src.includes(from)) throw new Error(`fixture line moved: ${from}`);
    src = src.replace(from, to);
  }
  const file = path.join(dir, `league-${String(Math.random()).slice(2)}.yaml`);
  writeFileSync(file, src, { mode: 0o600 });
  return file;
}

// The league file's own statuses would decide these players first (plan 07 D2 order): drop them, so
// the official report is what is read.
const NO_STATUS: readonly (readonly [string, string])[] = [
  ['gsis_id: "00-0036554", slot: IR, status: O }', 'gsis_id: "00-0036554", slot: BN }'],
  ['gsis_id: "00-0039075", slot: BN, status: D }', 'gsis_id: "00-0039075", slot: BN }'],
];

async function d2(world: World, week: number, ids: readonly string[]): Promise<D2> {
  const { client, close } = await connect(world);
  const r = await client.callTool({
    name: "ff_get_injuries",
    arguments: { players: { gsis_ids: [...ids] }, week },
  });
  await close();
  expect(r.isError, JSON.stringify(r.content)).not.toBe(true);
  return body(r) as unknown as D2;
}

async function e1(world: World, week: number, ids: readonly string[]): Promise<E1> {
  const { client, close } = await connect(world);
  const r = await client.callTool({
    name: "ff_project_players",
    arguments: { players: { gsis_ids: [...ids] }, horizon: "week", week, seed: 1 },
  });
  await close();
  expect(r.isError, JSON.stringify(r.content)).not.toBe(true);
  return body(r) as unknown as E1;
}

/** Every player-week he plays: D2's p_active equals E1's. Returns D2's value per `${id}:${week}`. */
async function parity(
  world: World,
  weeks: readonly number[],
  ids: readonly string[],
): Promise<Map<string, number | null>> {
  const seen = new Map<string, number | null>();
  for (const week of weeks) {
    const [inj, proj] = [await d2(world, week, ids), await e1(world, week, ids)];
    for (const id of ids) {
      const pw = proj.data.projections.find((x) => x.gsis_id === id)?.weeks[0];
      const r = inj.data.players.find((x) => x.gsis_id === id);
      if (pw === undefined || r === undefined) throw new Error(`${id} week ${String(week)}`);
      if (pw.opponent === null) continue; // a bye: E1 projects zero whatever his availability
      expect(r.p_active, `${id} week ${String(week)}`).toBe(pw.p_active);
      seen.set(`${id}:${String(week)}`, r.p_active);
    }
  }
  return seen;
}

const dir = mkdtempSync(path.join(tmpdir(), "ff-d2-state-"));
chmodSync(dir, 0o700);
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("QA-1-021 — D2 carries the newest designation into look-ahead weeks, as E1 does (fixture reports)", () => {
  let world: World;
  beforeAll(async () => {
    world = await makeWorld({ env: { FF_LEAGUE_FILE: leagueVariant(dir, NO_STATUS) } });
  }, 180_000);
  afterAll(() => {
    world.cleanup();
  });

  it("property: D2's p_active equals E1's for every player-week he plays (weeks 4–8)", async () => {
    const ids = [COLLINS, NACUA, BOWERS, ALLEN, GIBBS, JSN];
    const seen = await parity(world, [4, 5, 6, 7, 8], ids);
    // Collins: Out in week 3, carried while young enough, then unknown — never cleared
    let carried = 0;
    let unknown = 0;
    for (let week = 4; week <= 8; week++) {
      const p = seen.get(`${COLLINS}:${String(week)}`);
      if (p === undefined) continue;
      if (week - 3 <= INJURY_REPORT.carryWeeks) {
        expect(p, `week ${String(week)}`).toBe(0);
        carried += 1;
      } else {
        expect(p, `week ${String(week)}`).toBeNull();
        unknown += 1;
      }
    }
    expect(carried).toBeGreaterThanOrEqual(1);
    expect(unknown).toBeGreaterThanOrEqual(2);
    expect(seen.size).toBeGreaterThanOrEqual(24);
  });

  it("the carry and the expiry are named in warnings (team codes, fixed text)", async () => {
    const w5 = (await d2(world, 5, [COLLINS])).warnings.join("\n");
    expect(w5).toMatch(/week 5 game-status report not out yet for [A-Z, ]*HOU/);
    const w7 = (await d2(world, 7, [COLLINS])).warnings.join("\n");
    expect(w7).toMatch(/week 7 availability unknown for [A-Z, ]*HOU/);
  });
});

describe("QA-2-034 — D2 does not read a practice-only row as cleared (a release of practice reports)", () => {
  // Week 3: final game-status reports. Week 4: practice reports only — rows, no designations — as the
  // NFL publishes them Wednesday. The release is stamped more than 24 h before every week-4 kickoff.
  const R = (
    week: number,
    team: string,
    gsis: string,
    status: string | null,
    practice: string | null,
    injury = "Hamstring",
  ) =>
    row(DS_INJURIES, {
      season: 2026,
      game_type: "REG",
      week,
      team,
      gsis_id: gsis,
      full_name: "Player",
      report_status: status,
      report_primary_injury: status === null ? null : injury,
      practice_status: practice,
      practice_primary_injury: practice === null ? null : injury,
    });
  const DNP = "Did Not Participate In Practice";
  const LP = "Limited Participation in Practice";
  const FP = "Full Participation in Practice";
  const ROWS = [
    R(3, "DET", GIBBS, "Out", DNP),
    R(3, "BUF", ALLEN, "Questionable", LP),
    R(3, "SEA", "00-0099998", "Out", DNP), // SEA's week-3 report is out; JSN not on it
    R(4, "DET", GIBBS, null, DNP), // Out last week, practice report only now: carried Out
    R(4, "BUF", ALLEN, null, FP), // Questionable last week, full practice now: Q refined by FP
    R(4, "SEA", JSN, null, DNP), // not designated last week, did not practise now: not cleared
    R(4, "BAL", HENRY, null, DNP, "Not injury related - resting player"), // a rest day
  ];
  let world: World;
  beforeAll(async () => {
    world = await makeWorld({ env: { FF_LEAGUE_FILE: leagueVariant(dir, NO_STATUS) } });
    const pub = storeFactory.openPublisher({
      storePath: storePath(world.cache),
      datasetDir: datasetDir(world.cache),
      clock: world.clock,
    });
    try {
      const out = await publishTables(
        pub,
        "nflverse:injuries",
        "practice-wednesday",
        [{ spec: DS_INJURIES, rows: ROWS }],
        [2026],
        "2026-09-30T09:40:10.000Z",
      );
      if (!out.ok) throw new Error(`publish: ${JSON.stringify(out)}`);
    } finally {
      pub.close();
    }
    world.store.reattachIfChanged();
  }, 180_000);
  afterAll(() => {
    world.cleanup();
  });

  it("Wednesday of week 4: the carried designation, the practice trend — never p 1 for a carried Out or a new DNP", async () => {
    const ids = [GIBBS, ALLEN, JSN, HENRY];
    const seen = await parity(world, [4], ids);
    expect(seen.get(`${GIBBS}:4`)).toBe(P_ACTIVE.out);
    expect(seen.get(`${ALLEN}:4`)).toBe(P_ACTIVE.questionableByPractice.full);
    expect(seen.get(`${JSN}:4`)).toBe(P_ACTIVE.questionableByPractice.dnp);
    // a rest day is not an injury: no designation pending is a reason to doubt him
    expect(seen.get(`${HENRY}:4`)).toBe(P_ACTIVE.noDesignation);
    const text = (await d2(world, 4, ids)).warnings.join("\n");
    expect(text).toMatch(/week 4 game-status report not out yet for [A-Z, ]*DET/);
  });
});
