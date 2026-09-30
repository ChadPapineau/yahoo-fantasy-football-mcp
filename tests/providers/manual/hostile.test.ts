// hostile.test.ts — hostile league.yaml content must fail as LeagueFileError(invalid) with
// value-free issues, in bounded time, without printing anything (plan 02 §5; critic C-13b): alias
// bombs, deep nesting, oversized files, prototype keys, duplicate keys, collection keys, custom
// tags, multiple documents, wrong types, unknown slots/positions/keys, impossible scoring values,
// control/bidi characters, and cross-field contradictions. A canary planted at the offending spot
// must never appear in the error message, its issues, or on stderr.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeagueFileError, LEAGUE_FILE_INVALID_HINT } from "../../../src/providers/platform.js";
import { MAX_LEAGUE_FILE_BYTES, parseLeagueYaml } from "../../../src/providers/manual/parse.js";
import { edit, FIXTURE_TEXT, provider, tempLeague, type TempLeague } from "./helpers.js";

const CANARY = "CANARY7f3aZq";

let t: TempLeague;
let stderr: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  t = tempLeague();
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
});
afterEach(() => {
  t.cleanup();
  expect(stderr).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
});

/** Loads `text` through the provider and returns the LeagueFileError (fails when none). */
async function invalid(text: string): Promise<LeagueFileError> {
  t.write(text);
  const started = performance.now();
  const err = await provider(t.file)
    .getLeague({ platform: "manual", league_key: "manual.l.example" })
    .catch((e: unknown) => e);
  expect(performance.now() - started).toBeLessThan(2000);
  expect(err).toBeInstanceOf(LeagueFileError);
  const e = err as LeagueFileError;
  expect(e).toMatchObject({
    kind: "invalid",
    ffCode: "INTERNAL",
    ffHint: LEAGUE_FILE_INVALID_HINT,
  });
  expect(e.issues.length).toBeGreaterThan(0);
  expect(e.issues.length).toBeLessThanOrEqual(50);
  const blob = JSON.stringify({ m: e.message, s: e.stack, i: e.issues });
  expect(blob).not.toContain(CANARY);
  return e;
}

const reasons = (e: LeagueFileError): string =>
  e.issues.map((i) => `${i.path}: ${i.reason}`).join("\n");

describe("YAML-level attacks", () => {
  it("alias bomb (billion laughs) is rejected without expansion", async () => {
    let bomb = `version: 1\nx: &a ["${CANARY}","${CANARY}","${CANARY}","${CANARY}","${CANARY}","${CANARY}","${CANARY}","${CANARY}","${CANARY}"]\n`;
    let prev = "a";
    for (const n of "bcdefghij") {
      bomb += `${n}: &${n} [${Array(9).fill(`*${prev}`).join(",")}]\n`;
      prev = n;
    }
    const e = await invalid(bomb);
    expect(reasons(e)).toMatch(/aliases are not allowed/);
  });

  it("a single alias is rejected too (no aliases at all)", async () => {
    const e = await invalid(
      edit("  name: Team A\n  manager: Manager A", "  name: &n Team A\n  manager: *n"),
    );
    expect(reasons(e)).toMatch(/aliases/);
  });

  it("deep nesting (flow and block) is rejected", async () => {
    await invalid(`version: 1\nx: ${"[".repeat(5000)}"${CANARY}"${"]".repeat(5000)}\n`);
    let block = "version: 1\nx:\n";
    for (let i = 1; i < 40; i++) block += `${"  ".repeat(i)}k:\n`;
    block += `${"  ".repeat(40)}k: ${CANARY}\n`;
    const e = await invalid(block);
    expect(reasons(e)).toMatch(/nested too deeply/);
  });

  it("a huge sequence is rejected at the CST, before composition", async () => {
    const items = Array.from({ length: 60_000 }, () => "0").join(",");
    const e = await invalid(`version: 1\nx: [${items}]\n`);
    expect(reasons(e)).toMatch(/sequence has more than 600 entries/);
  });

  it("a huge mapping is rejected before the quadratic duplicate-key check runs (was 62 s)", async () => {
    const keys = Array.from({ length: 10_000 }, (_, i) => `k${String(i)}: 1`).join("\n");
    const e = await invalid(`${keys}\n`);
    expect(reasons(e)).toMatch(/mapping has more than 100 entries/);
    const flow = await invalid(
      `{${Array.from({ length: 5000 }, (_, i) => `k${String(i)}: 1`).join(",")}}\n`,
    );
    expect(reasons(flow)).toMatch(/mapping has more than 100 entries/);
  });

  it("many medium collections are bounded by the total node count", async () => {
    const list = `[${Array.from({ length: 500 }, () => "0").join(",")}]`;
    const e = await invalid(
      `version: 1\nx: [${Array.from({ length: 120 }, () => list).join(",")}]\n`,
    );
    expect(reasons(e)).toMatch(/too many YAML nodes/);
  });

  it("files over the parser's byte cap are rejected by parseLeagueYaml itself", () => {
    const text = `x: "${"a".repeat(MAX_LEAGUE_FILE_BYTES)}"\n`;
    expect(() => parseLeagueYaml(text)).toThrow(LeagueFileError);
  });

  it("__proto__, constructor and prototype keys are rejected wherever they appear", async () => {
    for (const k of ["__proto__", "constructor", "prototype"]) {
      const e = await invalid(edit("league:\n", `league:\n  ${k}: { polluted: ${CANARY} }\n`));
      expect(reasons(e)).toMatch(/reserved key/);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    }
    const nested = await invalid(
      edit(
        "  - { name: QB, count: 1 }",
        `  - { name: QB, count: 1, "__proto__": { x: ${CANARY} } }`,
      ),
    );
    expect(reasons(nested)).toMatch(/reserved key/);
  });

  it("duplicate keys are rejected", async () => {
    const e = await invalid(edit("  season: 2026\n", `  season: 2026\n  season: ${CANARY}\n`));
    expect(reasons(e)).toMatch(/DUPLICATE_KEY/);
  });

  it("collection and non-string keys are rejected before conversion (no stringify warning)", async () => {
    const e = await invalid(`version: 1\n? [${CANARY}]\n: 1\n`);
    expect(reasons(e)).toMatch(/plain string/);
    const n = await invalid(`version: 1\n1: ${CANARY}\n`);
    expect(reasons(n)).toMatch(/plain string/);
    const nul = await invalid(`version: 1\n~: ${CANARY}\n`);
    expect(reasons(nul)).toMatch(/plain string/);
  });

  it("custom tags, multiple documents and syntax errors are rejected by code, not message", async () => {
    expect(reasons(await invalid(`version: 1\nx: !!js/function "${CANARY}"\n`))).toMatch(
      /YAML (warning|error) \(/,
    );
    expect(reasons(await invalid(`version: 1\n---\nx: ${CANARY}\n`))).toMatch(/MULTIPLE_DOCS/);
    expect(reasons(await invalid(`version: 1\nx: ${CANARY}: 3\n`))).toMatch(/YAML error \(/);
    expect(reasons(await invalid(`version: 1\nx: "${CANARY}\n`))).toMatch(/line \d+|YAML error/);
  });

  it("YAML directives (%YAML 1.1 schema switch, %TAG handles) are rejected", async () => {
    expect(reasons(await invalid(`%YAML 1.1\n---\nversion: 1\nx: ${CANARY}\n`))).toMatch(
      /directives are not allowed/,
    );
    expect(reasons(await invalid(`%TAG !e! tag:${CANARY},2026:\n---\nversion: 1\n`))).toMatch(
      /directives are not allowed/,
    );
  });

  it("an empty file, a comment-only file and a non-mapping root are rejected", async () => {
    expect(reasons(await invalid(""))).toMatch(/empty/);
    expect(reasons(await invalid(`# ${CANARY}\n`))).toMatch(/empty/);
    expect(reasons(await invalid(`- ${CANARY}\n`))).toMatch(/wrong type/);
    expect(reasons(await invalid(`${CANARY}\n`))).toMatch(/wrong type/);
  });

  it("binary garbage and invalid UTF-8 are rejected", async () => {
    t.write("");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(t.file, Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x81, 0xc3, 0x28]), {
      mode: 0o600,
    });
    const err = await provider(t.file)
      .listMyLeagues()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LeagueFileError);
  });
});

describe("schema-level attacks and mistakes", () => {
  it("wrong types", async () => {
    expect(reasons(await invalid(edit("season: 2026", `season: "${CANARY}"`)))).toMatch(
      /league\.season: wrong type/,
    );
    expect(reasons(await invalid(edit("num_teams: 12", "num_teams: 12.5")))).toMatch(
      /league\.num_teams/,
    );
    expect(
      reasons(await invalid(edit("  - { name: WR, count: 2 }", "  - { name: WR, count: [2] }"))),
    ).toMatch(/roster_slots\[1\]\.count/);
    expect(reasons(await invalid(edit("version: 1", "version: 2")))).toMatch(
      /version: not an allowed value/,
    );
  });

  it("unknown keys are reported by count, never by name", async () => {
    const e = await invalid(edit("league:\n", `${CANARY}: 1\nleague:\n  ${CANARY}x: 2\n`));
    expect(reasons(e)).toMatch(/unknown key\(s\) \(1\)/);
  });

  it("unknown slots: an undefinable slot type, and a player seated in a slot the league lacks", async () => {
    expect(
      reasons(await invalid(edit("{ name: W/R/T, count: 1 }", "{ name: SUPERFLEX, count: 1 }"))),
    ).toMatch(/roster_slots\[4\]: invalid slot \(unknown_slot\)/);
    expect(reasons(await invalid(edit("slot: W/R/T }", "slot: Q/W/R/T }")))).toMatch(
      /my_team\.players\[6\]\.slot: slot is not in roster_slots/,
    );
    expect(reasons(await invalid(edit("slot: QB }", `slot: "${CANARY}" }`)))).toMatch(
      /not a slot name/,
    );
    expect(
      reasons(
        await invalid(
          edit("{ name: K, count: 1 }", "{ name: K, count: 1 }\n  - { name: K, count: 1 }"),
        ),
      ),
    ).toMatch(/duplicate slot name/);
    expect(
      reasons(
        await invalid(edit("{ name: BN, count: 6 }", "{ name: BN, count: 6, eligible: [QB] }")),
      ),
    ).toMatch(/eligible_not_allowed/);
  });

  it("unknown positions and teams", async () => {
    expect(
      reasons(
        await invalid(
          edit('position: QB, gsis_id: "00-0034857"', 'position: LB, gsis_id: "00-0034857"'),
        ),
      ),
    ).toMatch(/my_team\.players\[0\]\.position: not an allowed value/);
    expect(
      reasons(
        await invalid(
          edit("{ name: W/R/T, count: 1 }", "{ name: FLX, count: 1, eligible: [WR, DL] }"),
        ),
      ),
    ).toMatch(/eligible\[1\]/);
    expect(
      reasons(
        await invalid(edit("team: BUF, position: QB", `team: ${CANARY.slice(0, 3)}, position: QB`)),
      ),
    ).toMatch(/not an nflverse team/);
    expect(
      reasons(await invalid(edit("{ defense: DET, slot: DEF }", "{ defense: OAK, slot: DEF }"))),
    ).toMatch(/my_team\.players\[8\]\.defense: not an nflverse team/);
    expect(reasons(await invalid(edit('gsis_id: "00-0034857"', `gsis_id: "${CANARY}"`)))).toMatch(
      /my_team\.players\[0\]\.gsis_id: not a gsis id/,
    );
  });

  it("impossible scoring values", async () => {
    expect(reasons(await invalid(edit("pass_td: 4", "pass_td: 1000000000")))).toMatch(
      /scoring\.overrides\.pass_td: too large/,
    );
    expect(reasons(await invalid(edit("pass_td: 4", "pass_td: -51")))).toMatch(/too small/);
    expect(reasons(await invalid(edit("pass_td: 4", "pass_td: .inf")))).toMatch(
      /scoring\.overrides\.pass_td/,
    );
    expect(reasons(await invalid(edit("pass_td: 4", "pass_td: .nan")))).toMatch(
      /scoring\.overrides\.pass_td/,
    );
    expect(reasons(await invalid(edit("pass_td: 4", `${CANARY}: 4`)))).toMatch(
      /scoring\.overrides: unknown key/,
    );
    expect(reasons(await invalid(edit("preset: half_ppr", "preset: superflex_ppr")))).toMatch(
      /scoring\.preset: not an allowed value/,
    );
    expect(
      reasons(
        await invalid(
          edit(
            "preset: half_ppr",
            "preset: half_ppr\n  bonuses: [{ stat: pass_yd, target: 0, points: 3 }]",
          ),
        ),
      ),
    ).toMatch(/bonuses\[0\]\.target: too small/);
  });

  it("names: control, zero-width and bidi characters, blank and overlong names", async () => {
    expect(
      reasons(await invalid(edit("  name: Team A\n", `  name: "Team\\u0007${CANARY}"\n`))),
    ).toMatch(/control, zero-width or bidi/);
    expect(
      reasons(await invalid(edit("  name: Team A\n", `  name: "Team\\u202e${CANARY}"\n`))),
    ).toMatch(/control, zero-width or bidi/);
    expect(
      reasons(await invalid(edit("  name: Team A\n", `  name: "A\\u200b${CANARY}"\n`))),
    ).toMatch(/control, zero-width or bidi/);
    expect(reasons(await invalid(edit("  name: Team A\n", '  name: "   "\n')))).toMatch(
      /must not be empty/,
    );
    expect(
      reasons(await invalid(edit("  name: Team A\n", `  name: ${CANARY.repeat(10)}\n`))),
    ).toMatch(/my_team\.name: too large/);
    expect(
      reasons(await invalid(edit("  manager: Manager A\n", `  manager: ${CANARY.repeat(3)}\n`))),
    ).toMatch(/my_team\.manager: too large/);
  });

  it("status codes must match the grammar (no prose in a code field)", async () => {
    expect(reasons(await invalid(edit("status: O }", `status: "Out - ${CANARY}" }`)))).toMatch(
      /not a status code/,
    );
  });

  it("huge lists are bounded", async () => {
    const many = Array.from(
      { length: 61 },
      (_, i) => `    - { name: P${String(i)}, team: BUF, position: WR }`,
    ).join("\n");
    const text = edit(
      "  players:\n    - { name: Josh Allen",
      `  players:\n${many}\n    - { name: Josh Allen`,
    );
    expect(reasons(await invalid(text))).toMatch(/my_team\.players: too large/);
  });

  it("the issue list is capped at 50", async () => {
    const bad = Array.from(
      { length: 60 },
      (_, i) => `    - { name: P${String(i)}, team: XXX, position: WR }`,
    ).join("\n");
    const e = await invalid(
      edit("  players:\n    - { name: Josh Allen", `  players:\n${bad}\n    - { name: Josh Allen`),
    );
    expect(e.issues).toHaveLength(50);
  });
});

describe("cross-field contradictions", () => {
  const cases: [string, string, string, RegExp][] = [
    ["end before start", "  end_week: 17\n", "  end_week: 0\n", /league\.end_week/],
    [
      "end before start (in range)",
      "  start_week: 1\n",
      "  start_week: 18\n",
      /end_week: must not be before start_week/,
    ],
    [
      "current week out of range",
      "  end_week: 17\n",
      "  end_week: 17\n  current_week: 18\n",
      /current_week: must be within/,
    ],
    [
      "playoffs out of range",
      "    start_week: 15\n",
      "    start_week: 18\n",
      /playoffs\.start_week/,
    ],
    [
      "playoff teams > league",
      "    num_teams: 6\n",
      "    num_teams: 16\n  uses_median_score: true\n",
      /playoffs\.num_teams: must not exceed/,
    ],
    [
      "my team id > num_teams",
      "my_team:\n  id: 1\n",
      "my_team:\n  id: 13\n",
      /my_team\.id: must not exceed/,
    ],
    [
      "duplicate team id",
      "  - { id: 3, name: Team C",
      "  - { id: 2, name: Team C",
      /other_teams\[1\]\.id: duplicate team id/,
    ],
    [
      "other team id > num_teams",
      "  - { id: 12, name: Team L",
      "  - { id: 14, name: Team L",
      /must not exceed league\.num_teams/,
    ],
    [
      "opponent is me",
      "  - { week: 1, team: 2 }",
      "  - { week: 1, team: 1 }",
      /opponents\[0\]\.team/,
    ],
    [
      "opponent unknown",
      "  - { week: 1, team: 2 }",
      "  - { week: 1, team: 30 }",
      /opponents\[0\]\.team/,
    ],
    [
      "opponent week twice",
      "  - { week: 2, team: 2 }",
      "  - { week: 1, team: 2 }",
      /opponents\[1\]\.week: week listed twice/,
    ],
    [
      "opponent week out of range",
      "  - { week: 3, team: 2 }",
      "  - { week: 20, team: 2 }",
      /opponents\[2\]\.week: must be within/,
    ],
    [
      "player on two teams",
      '      - { name: Jalen Hurts, team: PHI, position: QB, gsis_id: "00-0036389", slot: BN }',
      '      - { name: Josh Allen, team: BUF, position: QB, gsis_id: "00-0034857", slot: BN }',
      /on more than one team/,
    ],
    [
      "player twice on a team",
      '    - { name: Jordan Love, team: GB, position: QB, gsis_id: "00-0036264", slot: BN }',
      '    - { name: Josh Allen, team: BUF, position: QB, gsis_id: "00-0034857", slot: BN }',
      /listed twice on this team/,
    ],
    [
      "free agent also rostered",
      "  - { name: Jeremiyah Love, team: ARI, position: RB }",
      "  - { name: Ashton Jeanty, team: LV, position: RB }",
      /free_agents\[0\]: player is also on a roster/,
    ],
    [
      "transaction team unknown",
      "    team: 1\n    faab_bid: 7",
      "    team: 20\n    faab_bid: 7",
      /transactions\[0\]\.team/,
    ],
    [
      "trade without tradee",
      "  - type: waiver",
      "  - type: trade",
      /tradee_team: a trade needs tradee_team/,
    ],
    [
      "tradee unknown",
      "    team: 1\n    faab_bid: 7",
      "    team: 1\n    tradee_team: 25\n    faab_bid: 7",
      /tradee_team: not a team id/,
    ],
    [
      "timestamp not ISO",
      'timestamp: "2026-09-16T10:00:00Z"',
      'timestamp: "yesterday"',
      /timestamp: invalid format/,
    ],
    [
      "too many roster spots",
      "  - { name: BN, count: 6 }",
      "  - { name: BN, count: 20 }\n  - { name: W/R, count: 20 }\n  - { name: W/T, count: 20 }",
      /more than 60 roster spots/,
    ],
  ];
  for (const [name, from, to, re] of cases) {
    it(name, async () => {
      expect(reasons(await invalid(edit(from, to)))).toMatch(re);
    });
  }

  it("a league with no starting slot is rejected", async () => {
    const text = FIXTURE_TEXT.replace(
      /roster_slots:\n(?: {2}- .*\n)+/,
      "roster_slots:\n  - { name: BN, count: 6 }\n  - { name: IR, count: 2 }\n",
    );
    const e = await invalid(text);
    expect(reasons(e)).toMatch(/no starting slot|slot is not in roster_slots/);
  });
});
