// manual-league-claims.test.ts — QA-1-062: what the Skills say the manual league's scoreboard,
// transactions and standings return must be what the server returns (plan 09 §2 guardrail 7: repeat
// every warnings[] entry, never imply unavailable data; the status capabilities are the source of
// truth). Each claim the Skills' text may make is a pattern in the ledger below with the server fact
// that must hold wherever the pattern occurs; the facts are read from the real server on the fixture
// manual league (an opponent entered for weeks 1–3, none for week 4, one pasted transaction).
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseLeagueYaml } from "../../src/providers/manual/index.js";
import { FIXTURE_LEAGUE, TEAM_A, TEAM_B } from "../mcp/helpers/env.js";
import { ROOT } from "./helpers.js";
import { T0, dataOf, sentences, skillWorld, type Called, type SkillWorld } from "./world.js";
import { walkFiles } from "../../scripts/skills/_lib.mjs";

interface Matchup {
  teams: { team_key: string; points: number | null }[];
}
interface Facts {
  readFeatures: Record<string, boolean>;
  /** The scoreboard of a week the league file names an opponent for (week 3). */
  opp: { matchups: Matchup[]; warnings: string[] };
  /** The scoreboard of a week without one (week 4). */
  none: { matchups: Matchup[]; warnings: string[] };
  tx: { n: number; warnings: string[] };
  standings: { n: number; warnings: string[] };
  /** How many transactions the fixture league file lists. */
  fileTx: number;
}

const warn = (c: Called) => (c.body.warnings as string[] | undefined) ?? [];

/** [label, pattern, the fact that must hold where the pattern occurs]. */
const LEDGER: readonly (readonly [string, RegExp, (f: Facts) => boolean])[] = [
  [
    "matchups are unavailable",
    /matchups are unavailable/i,
    (f) => f.readFeatures.matchups !== true,
  ],
  [
    "standings/matchups/transactions are empty results with a warning",
    /empty results with a warning/i,
    (f) =>
      f.opp.matchups.length === 0 &&
      f.opp.warnings.length > 0 &&
      f.tx.n === 0 &&
      f.tx.warnings.length > 0,
  ],
  [
    "ff_get_scoreboard is empty under the manual league",
    /`ff_get_scoreboard`[^\n]*\(empty under the manual league\)/,
    (f) => f.opp.matchups.length === 0,
  ],
  [
    "ff_list_transactions is empty under the manual league",
    /`ff_list_transactions`[^\n]*\(empty under the manual league\)/,
    (f) => f.tx.n === 0,
  ],
  [
    "under the manual league transactions return nothing",
    /under the manual league it returns nothing/i,
    (f) => f.tx.n === 0,
  ],
  [
    "ff_get_standings is empty under the manual league",
    /`ff_get_standings`[^\n]*empty under the manual league/,
    (f) => f.standings.n === 0,
  ],
  [
    "standings are empty, with a warning",
    /standings[^.\n|]*\(?empty(?: under the manual league)?, with a warning/i,
    (f) => f.standings.n === 0 && f.standings.warnings.length > 0,
  ],
  [
    "the scoreboard holds the opponent entered for that week",
    /opponent entered for (?:that|this|the) week/i,
    (f) =>
      f.opp.matchups.length === 1 &&
      JSON.stringify(f.opp.matchups[0]?.teams.map((t) => t.team_key).sort()) ===
        JSON.stringify([TEAM_A, TEAM_B].sort()),
  ],
  [
    "the manual scoreboard carries no scores",
    /opponent entered for (?:that|this|the) week[^.\n|]*(?:without|no) (?:scores|points)/i,
    (f) => f.opp.matchups.every((m) => m.teams.every((t) => t.points === null)),
  ],
  [
    "a week without an opponent returns matchups []",
    /no entry returns `matchups: \[\]`/,
    (f) => f.none.matchups.length === 0,
  ],
  [
    "a week without an opponent: matchups empty and no warning",
    /`matchups` is empty and there is no warning/,
    (f) => f.none.matchups.length === 0 && f.none.warnings.length === 0,
  ],
  [
    "a week without an opponent: matchups [] and no warning",
    /`matchups: \[\]`,? (?:and |with )?no warning/,
    (f) => f.none.matchups.length === 0 && f.none.warnings.length === 0,
  ],
  [
    "transactions are the ones listed in the league file",
    /transactions listed in the league file/i,
    (f) => f.tx.n === f.fileTx && f.tx.warnings.length === 0,
  ],
];

/** Every Markdown file of the Skills bundle (sources and generated copies). */
const DOCS = walkFiles(path.join(ROOT, "skills"), path.join(ROOT, "skills"))
  .files.filter((f) => f.endsWith(".md"))
  .map((f) => ({ file: `skills/${f}`, text: readFileSync(path.join(ROOT, "skills", f), "utf8") }));

/**
 * Reopened QA-1-062: the ledger above matches set phrasings, so a paraphrase ("the manual league
 * cannot give … transactions") slipped through. This vocabulary reads every sentence that says
 * something is unavailable, in any wording, and names the read feature each item stands for.
 */
const FEATURE_TERMS: readonly (readonly [string, RegExp])[] = [
  ["transactions", /\btransactions?\b|\btransaction history\b/i],
  ["standings", /\bstandings\b/i],
  ["matchups", /\bmatchups?\b|\bscoreboard\b/i],
  ["other_rosters", /\bother teams'? rosters?\b|\bopponent(?:'s)? rosters?\b/i],
  ["free_agent_pool", /\bfree[- ]agent pool\b|\bfree agents\b|\bwaiver wire\b/i],
  ["player_stats", /\bplatform(?:'s own)? (?:fantasy )?points\b|\bplatform stat lines\b/i],
];
/** A sentence that says something is unavailable (any wording the Skills use or might use). */
const UNAVAILABLE =
  /\b(?:cannot (?:give|provide|offer|see|return)|can't (?:give|provide|offer|see|return)|not available|unavailable|never implied|there (?:is|are) no|(?:has|have|holds?|returns?|gives?) no|no (?:live|platform)|returns nothing|is empty|are empty|lacks?|missing)\b/i;
/** Guardrail 7's form: "never imply X when the result says it is unavailable" claims nothing. */
const CONDITIONED_ON_RESULT = /\bwhen the result says\b/i;
/** An item that is unavailable only until the user enters it ("unless entered", "if pasted"). */
const UNLESS_ENTERED =
  /\b(?:unless|until|except|but|if|when)\b[^,;]*?\b(?:enter(?:s|ed)?|paste[sd]?|list(?:s|ed)?|add(?:s|ed)?|type[sd]?)\b|\blisted in the league file\b/i;

/** Each (feature, conditional) an unavailability sentence claims, item by item. */
function unavailableClaims(
  sentence: string,
): { feature: string; conditional: boolean; item: string }[] {
  if (!UNAVAILABLE.test(sentence) || CONDITIONED_ON_RESULT.test(sentence)) return [];
  return sentence
    .replace(/\([^)]*\)/g, " ")
    .split(/[,;:]\s*|\s+(?:and|or|nor)\s+/)
    .flatMap((item) =>
      FEATURE_TERMS.filter(([, re]) => re.test(item)).map(([feature]) => ({
        feature,
        conditional: UNLESS_ENTERED.test(item),
        item: item.trim(),
      })),
    );
}

/** read_features with the league file's optional data entered, and without it. */
let entered: Facts["readFeatures"];
let bare: Facts["readFeatures"];

let sw: SkillWorld;
let facts: Facts;
beforeAll(async () => {
  sw = await skillWorld(T0);
  const st = dataOf(await sw.call("ff_get_status")) as {
    capabilities: { read_features: Record<string, boolean> };
  };
  const sb = async (week: number) => {
    const c = await sw.call("ff_get_scoreboard", { week });
    return { matchups: dataOf(c).matchups as Matchup[], warnings: warn(c) };
  };
  const tx = await sw.call("ff_list_transactions", { count: 40 });
  const stg = await sw.call("ff_get_standings");
  const file = parseLeagueYaml(readFileSync(FIXTURE_LEAGUE, "utf8")) as {
    transactions?: unknown[];
  };
  facts = {
    readFeatures: st.capabilities.read_features,
    opp: await sb(3),
    none: await sb(4),
    tx: { n: (dataOf(tx).transactions as unknown[]).length, warnings: warn(tx) },
    standings: { n: (dataOf(stg).teams as unknown[]).length, warnings: warn(stg) },
    fileTx: file.transactions?.length ?? 0,
  };
  entered = facts.readFeatures;
  // the same league file with every optional section cut: other_teams, opponents, free_agents,
  // waivers, transactions (they follow my_team, in that order, to the end of the file)
  const yaml = readFileSync(FIXTURE_LEAGUE, "utf8");
  const optional = yaml.slice(yaml.indexOf("\nother_teams:") + 1);
  const bw = await skillWorld(T0, [[optional, ""]]);
  try {
    bare = (
      dataOf(await bw.call("ff_get_status")) as {
        capabilities: { read_features: Record<string, boolean> };
      }
    ).capabilities.read_features;
  } finally {
    await bw.close();
  }
}, 60_000);
afterAll(async () => {
  await sw.close();
});

describe("QA-1-062: the Skills describe the manual league's scoreboard, transactions and standings as the server returns them", () => {
  it("the fixture exercises the cases (control)", () => {
    expect(facts.fileTx).toBeGreaterThan(0);
    expect(facts.opp.matchups.length).toBeGreaterThan(0);
    expect(facts.none.matchups).toEqual([]);
  });

  it("every ledger claim found in a Skill file holds on the server", () => {
    const wrong = new Set<string>();
    for (const { file, text } of DOCS) {
      for (const [label, re, holds] of LEDGER) {
        if (re.test(text) && !holds(facts)) wrong.add(`${file}: "${label}"`);
      }
    }
    expect([...wrong]).toEqual([]);
  });

  it("every 'not available' sentence, in any wording, agrees with the server with and without the data entered [QA-1-062]", () => {
    // control: the fixture's optional data switches the data-dependent features on, its absence off
    const dataDependent = ["transactions", "other_rosters", "matchups"];
    expect(dataDependent.map((k) => entered[k])).toEqual([true, true, true]);
    expect(dataDependent.map((k) => bare[k])).toEqual([false, false, false]);
    const wrong = new Set<string>();
    let seen = 0;
    for (const { file, text } of DOCS) {
      for (const s of sentences(text)) {
        for (const c of unavailableClaims(s)) {
          seen += 1;
          // unconditional: never available; "unless entered": unavailable without, available with
          const holds = c.conditional
            ? bare[c.feature] === false && entered[c.feature] === true
            : bare[c.feature] === false && entered[c.feature] === false;
          if (!holds) wrong.add(`${file}: "${c.item}" (${c.feature}) in: ${s}`);
        }
      }
    }
    expect(seen, "the Skills do say what the manual league lacks (control)").toBeGreaterThan(0);
    expect([...wrong]).toEqual([]);
  });

  it("the check reads any wording (control) [QA-1-062]", () => {
    const wrongClaims = [
      "Say what the manual league cannot give: a live free-agent pool, standings, transactions, and the platform's own points.",
      "Under the manual league there is no transaction history.",
      "The manual league has no transactions.",
      "Transactions are not available under the manual league.",
      "Matchups are unavailable under the manual league.",
      "The manual league lacks other teams' rosters.",
    ];
    for (const s of wrongClaims) {
      const bad = unavailableClaims(s).filter((c) =>
        c.conditional
          ? !(bare[c.feature] === false && entered[c.feature] === true)
          : !(bare[c.feature] === false && entered[c.feature] === false),
      );
      expect(bad.length, s).toBeGreaterThan(0);
    }
    const trueClaims = [
      "Say what the manual league cannot give: a live free-agent pool, other teams' rosters unless entered, standings, transactions unless listed in the league file, and the platform's own points.",
      "Never imply a live free-agent pool or an opponent roster when the result says they are unavailable.",
      "Standings are not available under the manual league.",
    ];
    for (const s of trueClaims) {
      const bad = unavailableClaims(s).filter((c) =>
        c.conditional
          ? !(bare[c.feature] === false && entered[c.feature] === true)
          : !(bare[c.feature] === false && entered[c.feature] === false),
      );
      expect(bad, s).toEqual([]);
    }
  });

  it("the shared text says what the manual scoreboard and transactions DO return", () => {
    const shared = DOCS.filter((d) => d.file.startsWith("skills/_shared/"))
      .map((d) => d.text)
      .join("\n");
    for (const label of [
      "the scoreboard holds the opponent entered for that week",
      "a week without an opponent returns matchups []",
      "transactions are the ones listed in the league file",
    ]) {
      const re = LEDGER.find(([l]) => l === label)?.[1];
      expect(re?.test(shared), label).toBe(true);
    }
  });
});
