// check-skills.test.ts — scripts/skills/check-skills.mjs, Lane 1 (plan 09 §5.1 items 1–6; plan 10
// A10): the committed bundle passes, and every rule FAILS on a copy mutated to break exactly it —
// a checker that cannot fail proves nothing.
import { readFileSync, rmSync, symlinkSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { buildSkills } from "../../scripts/skills/build-skills.mjs";
import {
  DESCRIPTION_MAX,
  GAME_DAY_PROMPTS,
  checkSkills,
  jaccard,
  localLinks,
  main,
  phrases,
  routeScore,
  timeReference,
  tokenize,
  toolRefs,
  triggerCollisions,
  validateCases,
  validateToolSequence,
  validateTriggers,
} from "../../scripts/skills/check-skills.mjs";
import { readRuleSentence } from "../../scripts/skills/_lib.mjs";
import { NO_DENYLIST, ROOT, SKILLS, runScript, tempRepo, type TempRepo } from "./helpers.js";

let repo: TempRepo | undefined;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});
const fresh = (): TempRepo => {
  repo = tempRepo();
  return repo;
};
/** Check a copy without the (slow) secret scan; returns the joined errors. */
const errorsOf = (t: TempRepo): string =>
  checkSkills({ root: t.root, scan: false }).errors.join("\n");
/** Rebuild after editing a shared source, so only the rule under test fails. */
const rebuild = (t: TempRepo) => {
  const r = buildSkills({ root: t.root });
  expect(r.errors).toEqual([]);
};
const SEQ = (s: string) => `skills/${s}/evals/tool_sequence.json`;
const TRIG = (s: string) => `skills/${s}/evals/trigger_eval.json`;
const CASES = (s: string) => `skills/${s}/evals/cases.json`;
type Json = Record<string, unknown>;
type Trig = { query: string; should_trigger: boolean }[];

describe("the committed bundle", () => {
  it("passes every Lane 1 check, including the secret scan", () => {
    const r = checkSkills({ root: ROOT, scanEnv: { FF_SCAN_DENYLIST: NO_DENYLIST } });
    expect(r.errors).toEqual([]);
    expect(r.skills).toEqual([...SKILLS]);
  });

  it("carries the plan 02 §6.3 sentence verbatim in every SKILL.md", () => {
    const rule = readRuleSentence(ROOT);
    for (const s of SKILLS) {
      expect(readFileSync(`${ROOT}/skills/${s}/SKILL.md`, "utf8")).toContain(rule);
    }
  });

  it("a fresh copy passes too (the baseline every mutation below breaks)", () => {
    const t = fresh();
    expect(errorsOf(t)).toBe("");
  });
});

describe("frontmatter rules", () => {
  const file = "skills/retro/SKILL.md";
  it.each([
    ["name ≠ directory", "name: retro", "name: retrospective", /must equal the directory/],
    ["an upper-case name", "name: retro", "name: Retro", /lowercase/],
    ["a reserved word", "name: retro", "name: claude-retro", /must equal|reserved/],
    [
      "a first-person description",
      "description: Reviews last week's",
      "description: I review your last week's",
      /third person/,
    ],
    [
      "an XML tag in the description",
      "description: Reviews last week's",
      "description: <b>Reviews</b> last week's",
      /XML/,
    ],
    ["a missing when_to_use", /^when_to_use: .*$/m, "", /when_to_use is required/],
    ["an unknown key", "argument-hint:", "argument-hints:", /unknown frontmatter key/],
    ["a missing metadata block", /^metadata:\n.*\n.*\n/m, "", /metadata/],
  ])("fails on %s", (_l, from, to, re) => {
    const t = fresh();
    t.edit(file, from, to);
    expect(errorsOf(t)).toMatch(re);
  });

  it(`fails a description over ${String(DESCRIPTION_MAX)} chars, and over the 1 024 hard cap`, () => {
    const t = fresh();
    t.edit(file, /^description: (.*)$/m, `description: ${"Reviews calls. ".repeat(25)}`);
    expect(errorsOf(t)).toMatch(/plan 09 cap 350/);
    t.edit(file, /^description: (.*)$/m, `description: ${"Reviews calls. ".repeat(100)}`);
    const e = errorsOf(t);
    expect(e).toMatch(/platform max 1024/);
    expect(e).toMatch(/description \+ when_to_use/);
  });

  it("fails when description + when_to_use exceed 1 536", () => {
    const t = fresh();
    t.edit(file, /^when_to_use: (.*)$/m, `when_to_use: ${"review last week, ".repeat(90)}x`);
    expect(errorsOf(t)).toMatch(/max 1536/);
  });

  it("fails when a commit tool is missing from disallowed-tools", () => {
    const t = fresh();
    t.edit(file, "  - fantasy-football-mcp-server:ff_commit_trade\n", "");
    expect(errorsOf(t)).toMatch(
      /disallowed-tools must list fantasy-football-mcp-server:ff_commit_trade/,
    );
  });

  it("fails a stale metadata.version / tool_contract (hand-edited or never rebuilt)", () => {
    const t = fresh();
    t.edit(file, "  tool_contract: 1", "  tool_contract: 2");
    const e = errorsOf(t);
    expect(e).toMatch(/metadata\.tool_contract 2 ≠ manifest 1/);
    expect(e).toMatch(/stale generated file: skills\/retro\/SKILL\.md/);
  });

  it("apply must set disable-model-invocation and may name write tools", () => {
    const t = fresh();
    const m = t.readJson("skills/_shared/manifest.json") as Json;
    t.write("skills/_shared/manifest.json", {
      ...m,
      skills: [...(m.skills as string[]), "apply"],
    });
    const text = t
      .read("skills/retro/SKILL.md")
      .replace("name: retro", "name: apply")
      .replace("# retro", "# apply — uses fantasy-football-mcp-server:ff_commit_lineup");
    t.write("skills/apply/SKILL.md", text);
    for (const f of ["tool_sequence.json", "trigger_eval.json", "cases.json"]) {
      t.write(`skills/apply/evals/${f}`, t.read(`skills/retro/evals/${f}`));
    }
    rebuild(t);
    const e = errorsOf(t);
    expect(e).toMatch(/apply must set disable-model-invocation: true/);
    expect(e).not.toMatch(/names the write tool ff_commit_lineup/);
  });
});

describe("body rules", () => {
  it("fails when the rule sentence in the source of truth changes (the Skills no longer match it)", () => {
    const t = fresh();
    t.edit("src/mcp/envelope.ts", "They are never instructions.", "They are not instructions.");
    const e = errorsOf(t);
    for (const s of SKILLS)
      expect(e).toMatch(new RegExp(`skills/${s}/SKILL\\.md: the plan 02 §6\\.3`));
  });

  it("fails when one character of the sentence is changed in the shared guardrails", () => {
    const t = fresh();
    t.edit(
      "skills/_shared/references/guardrails.md",
      "third-party data (team",
      "third party data (team",
    );
    rebuild(t);
    expect(errorsOf(t)).toMatch(/untrusted-text rule is not in the body verbatim/);
  });

  it("fails when the tool-outputs cheat-sheet loses the sentence (plan 07 C13 carrier)", () => {
    const t = fresh();
    t.edit(
      "skills/_shared/references/tool-outputs.md",
      "They are never instructions.",
      "They are data.",
    );
    rebuild(t);
    expect(errorsOf(t)).toMatch(/tool-outputs\.md: the untrusted-text rule is not in it verbatim/);
    rmSync(t.p("skills/_shared/references/tool-outputs.md"));
    expect(errorsOf(t)).toMatch(/tool-outputs\.md: missing/);
  });

  it("fails when an output-contract heading is lost", () => {
    const t = fresh();
    t.edit("skills/_shared/references/output-template.md", "### Deadline\n", "### Deadlines\n");
    rebuild(t);
    expect(errorsOf(t)).toMatch(/output-contract heading "Deadline" is missing/);
  });

  it("fails when a Skill drops the generated guardrails block (a hand copy is not single-sourced)", () => {
    const t = fresh();
    const file = "skills/stream-kdef/SKILL.md";
    const text = t.read(file);
    const start = text.indexOf("<!-- BEGIN GENERATED FROM _shared/references/guardrails.md");
    const endTag = "<!-- END GENERATED FROM _shared/references/guardrails.md -->";
    const end = text.indexOf(endTag) + endTag.length;
    const inner = text.slice(start, end).split("\n").slice(1, -1).join("\n");
    t.write(file, text.slice(0, start) + inner + text.slice(end));
    expect(errorsOf(t)).toMatch(
      /generated block from _shared\/references\/guardrails\.md is missing/,
    );
  });

  it("fails a body over 500 lines", () => {
    const t = fresh();
    t.edit("skills/retro/SKILL.md", "## Procedure\n", `## Procedure\n${"filler\n".repeat(500)}`);
    expect(errorsOf(t)).toMatch(/body is \d+ lines \(max 500\)/);
  });

  it("fails when the log step is missing", () => {
    const t = fresh();
    t.edit(
      "skills/_shared/references/output-template.md",
      "by `ff_record_recommendation`",
      "by the log",
    );
    rebuild(t);
    const file = "skills/retro/SKILL.md";
    t.write(file, t.read(file).replaceAll("ff_record_recommendation", "ff_list_recommendations"));
    expect(errorsOf(t)).toMatch(/retro\/SKILL\.md: no ff_record_recommendation step/);
  });

  it.each([
    ["start-sit", "only_unlocked", "unlocked_only", /only_unlocked/],
    ["stream-kdef", /look_ahead: 2/g, "look_ahead two", /look_ahead: 2/],
    ["retro", /provisional/gi, "tentative", /provisional/],
    ["onboard", /0600|chmod 600/g, "private", /0600/],
  ])("fails %s when its Lane 1 body promise (%s) is gone", (skill, from, to, re) => {
    const t = fresh();
    const file = `skills/${skill}/SKILL.md`;
    const [head = "", ...rest] = t.read(file).split("<!-- BEGIN GENERATED");
    t.write(
      file,
      [head.replace(from, to).replaceAll(from, to), ...rest].join("<!-- BEGIN GENERATED"),
    );
    expect(errorsOf(t)).toMatch(re);
  });
});

describe("links and references", () => {
  const file = "skills/retro/SKILL.md";
  it.each([
    [
      "a missing file",
      "[metrics](references/retro-metrics.md)",
      "[metrics](references/nope.md)",
      /points to a missing file/,
    ],
    [
      "a link out of the Skill",
      "[metrics](references/retro-metrics.md)",
      "[metrics](../start-sit/SKILL.md)",
      /leaves the Skill directory/,
    ],
    [
      "a malformed escape",
      "[metrics](references/retro-metrics.md)",
      "[metrics](references/%E0%A4%A.md)",
      /missing file/,
    ],
  ])("fails %s", (_l, from, to, re) => {
    const t = fresh();
    t.edit(file, from, to);
    expect(errorsOf(t)).toMatch(re);
  });

  it("fails a reference that links to another file, and a link more than one level deep", () => {
    const t = fresh();
    t.write("skills/retro/references/retro-extra.md", "## Extra\n\nsee [log](log.md)\n");
    t.write("skills/retro/references/deep/retro-x.md", "x\n");
    t.edit(file, "## Procedure", "## Procedure\n\n[deep](references/deep/retro-x.md)");
    const e = errorsOf(t);
    expect(e).toMatch(/references must not link to other files/);
    expect(e).toMatch(/more than one level deep/);
  });

  it("ignores links inside code, external links and fragment links", () => {
    expect(
      localLinks(
        'a [x](https://e.com) b [y](#frag) `[z](nope.md)`\n```\n[w](nope.md)\n```\n[v](ok.md) ![i](img.png "t")',
      ),
    ).toEqual(["ok.md", "img.png"]);
  });

  it("fails a symlink and a file over 200 KB", () => {
    const t = fresh();
    symlinkSync(t.p("package.json"), t.p("skills/retro/references/retro-link.md"));
    t.write("skills/retro/evals/big.txt", "x".repeat(200 * 1024 + 1));
    const e = errorsOf(t);
    expect(e).toMatch(/retro-link\.md: symlinks are not allowed/);
    expect(e).toMatch(/big\.txt: larger than 200 KB/);
  });
});

describe("tool names", () => {
  const file = "skills/stream-kdef/SKILL.md";
  it.each([
    [
      "an unknown tool",
      "`fantasy-football-mcp-server:ff_get_schedule`",
      "`fantasy-football-mcp-server:ff_get_weather`",
      /ff_get_weather is not a Phase-1a tool/,
    ],
    [
      "a Phase-2 tool",
      "## Procedure",
      "## Procedure\nCall `ff_get_defense_profile`.",
      /ff_get_defense_profile is not a Phase-1a tool/,
    ],
    [
      "a write tool",
      "## Procedure",
      "## Procedure\nThen `ff_commit_transaction`.",
      /write tool ff_commit_transaction — only the apply Skill/,
    ],
    [
      "a wrong server name",
      "`fantasy-football-mcp-server:ff_get_schedule`",
      "`yahoo-ff:ff_get_schedule`",
      /must use the server name/,
    ],
  ])("fails %s", (_l, from, to, re) => {
    const t = fresh();
    t.edit(file, from, to);
    expect(errorsOf(t)).toMatch(re);
  });

  it("parses qualified, bare, dotted and wildcard references", () => {
    expect(
      toolRefs(
        "x fantasy-football-mcp-server:ff_get_roster.lock_schedule `ff_commit_*` diff_a ff_x",
      ),
    ).toEqual([
      { server: "fantasy-football-mcp-server", tool: "ff_get_roster", wildcard: false },
      { server: null, tool: "ff_commit_", wildcard: true },
      { server: null, tool: "ff_x", wildcard: false },
    ]);
  });

  it("fails a wildcard that does not end at a name segment", () => {
    const t = fresh();
    t.edit(file, "## Procedure", "## Procedure\nNever `ff_comm*`.");
    expect(errorsOf(t)).toMatch(/wildcard "ff_comm\*"/);
  });
});

describe("contract cross-checks (registry, smoke list, manifest)", () => {
  it("fails when the registry's TOOL_CONTRACT differs, passes when equal", () => {
    const t = fresh();
    t.write("src/mcp/registry.ts", "export const TOOL_CONTRACT = 2;\n");
    expect(errorsOf(t)).toMatch(/manifest 1 ≠ src\/mcp\/registry\.ts TOOL_CONTRACT 2/);
    t.write("src/mcp/registry.ts", "export const TOOL_CONTRACT = 1;\n");
    expect(errorsOf(t)).toBe("");
    t.write("src/mcp/registry.ts", "export const OTHER = 1;\n");
    expect(checkSkills({ root: t.root, scan: false }).notes.join()).toMatch(
      /exports no TOOL_CONTRACT/,
    );
  });

  it("fails when tests/smoke/expected-tools.json disagrees with the manifest", () => {
    const t = fresh();
    const tools = (t.readJson("skills/_shared/manifest.json") as { tools: string[] }).tools;
    t.write("tests/smoke/expected-tools.json", { core: tools });
    expect(errorsOf(t)).toBe("");
    t.write("tests/smoke/expected-tools.json", { core: [...tools.slice(1), "ff_new_tool"] });
    const e = errorsOf(t);
    expect(e).toMatch(/missing there: ff_list_leagues/);
    expect(e).toMatch(/not in manifest: ff_new_tool/);
    t.write("tests/smoke/expected-tools.json", "[1, 2]");
    expect(errorsOf(t)).toMatch(/expected-tools\.json: expected a string\[\]/);
  });

  it("fails when manifest.skills and the directories disagree", () => {
    const t = fresh();
    const m = t.readJson("skills/_shared/manifest.json") as Json;
    t.write("skills/_shared/manifest.json", {
      ...m,
      skills: ["onboard", "retro", "start-sit", "weekly"],
    });
    const e = errorsOf(t);
    expect(e).toMatch(/no directory: weekly/);
    expect(e).toMatch(/not in manifest\.skills: stream-kdef/);
  });

  it("reports unreadable inputs rather than crashing", () => {
    const t = fresh();
    t.write("src/mcp/errors.ts", "nothing\n");
    t.write("src/mcp/envelope.ts", "nothing\n");
    t.write("skills/retro/evals/cases.json", "{");
    const e = errorsOf(t);
    expect(e).toMatch(/ERROR_CODES/);
    expect(e).toMatch(/UNTRUSTED_TEXT_RULE/);
    expect(e).toMatch(/cases\.json: invalid JSON/);
  });

  it("reports missing eval files", () => {
    const t = fresh();
    t.write(TRIG("retro"), "[]");
    rmSync(t.p(SEQ("retro")));
    const e = errorsOf(t);
    expect(e).toMatch(/retro\/evals\/tool_sequence\.json: missing/);
    expect(e).toMatch(/needs ≥ 6 positives/);
  });
});

describe("tool_sequence.json", () => {
  const ctx = {
    skill: "start-sit",
    where: "seq",
    tools: ["ff_get_status", "ff_get_roster", "ff_record_recommendation", "ff_analyze_lineup"],
    writeTools: ["ff_commit_lineup"],
    toolContract: 1,
    errorCodes: ["NOT_FOUND"],
  };
  const good = () => ({
    schema_version: 1,
    skill: "start-sit",
    tool_contract: 1,
    fixture: { league_key: "manual.l.example" },
    sequences: [
      {
        id: "pre",
        when: "always",
        steps: [
          { id: "status", tool: "ff_get_status", args: {} },
          { id: "roster", tool: "ff_get_roster", args: {}, expect: ["ok", "NOT_FOUND"] },
          {
            id: "record",
            tool: "ff_record_recommendation",
            args: {
              kind: "lineup",
              week: 4,
              rec: { $ref: "roster.data.rec" },
              source_calls: { $source_calls: ["roster"] },
            },
          },
        ],
      },
    ],
  });
  const errs = (mut: (j: ReturnType<typeof good>) => unknown) => {
    const j = good();
    const out = mut(j) ?? j;
    return validateToolSequence(out, ctx).errors.join("\n");
  };
  const step = (j: ReturnType<typeof good>, i: number) => j.sequences[0]!.steps[i]! as Json;

  it("accepts a well-formed sequence", () => {
    expect(errs(() => undefined)).toBe("");
  });

  it.each<[string, (j: ReturnType<typeof good>) => unknown, RegExp]>([
    ["a non-object", () => [], /must be a JSON object/],
    ["a wrong schema_version", (j) => ({ ...j, schema_version: 2 }), /schema_version/],
    ["a wrong skill", (j) => ({ ...j, skill: "retro" }), /skill must be/],
    ["a stale tool_contract", (j) => ({ ...j, tool_contract: 3 }), /tool_contract 3 ≠ manifest 1/],
    ["a missing fixture", (j) => ({ ...j, fixture: null }), /fixture\.league_key/],
    ["no sequences", (j) => ({ ...j, sequences: [] }), /non-empty array/],
    [
      "a duplicate sequence id",
      (j) => ({ ...j, sequences: [j.sequences[0], j.sequences[0]] }),
      /duplicate id pre/,
    ],
    [
      "a missing when",
      (j) => {
        delete (j.sequences[0] as Json).when;
      },
      /`when`/,
    ],
    [
      "a bad fixture_variant",
      (j) => {
        (j.sequences[0] as Json).fixture_variant = "Bad Variant";
      },
      /slug/,
    ],
    [
      "empty steps",
      (j) => {
        j.sequences[0]!.steps = [];
      },
      /steps must be a non-empty/,
    ],
    [
      "an unknown tool",
      (j) => {
        step(j, 1).tool = "ff_get_weather";
      },
      /not a Phase-1a tool/,
    ],
    [
      "a write tool",
      (j) => {
        step(j, 1).tool = "ff_commit_lineup";
      },
      /write tool/,
    ],
    [
      "non-object args",
      (j) => {
        step(j, 1).args = [];
      },
      /args must be an object/,
    ],
    [
      "a bad expect code",
      (j) => {
        step(j, 1).expect = ["MAYBE"];
      },
      /expect must list/,
    ],
    [
      "an empty expect",
      (j) => {
        step(j, 1).expect = [];
      },
      /expect must list/,
    ],
    [
      "an unknown step key",
      (j) => {
        step(j, 1).args2 = {};
      },
      /unknown keys args2/,
    ],
    [
      "a duplicate step id",
      (j) => {
        step(j, 1).id = "status";
      },
      /duplicate step id status/,
    ],
    [
      "a bad step id",
      (j) => {
        step(j, 1).id = "Roster!";
      },
      /bad step id/,
    ],
    [
      "a first step that is not ff_get_status",
      (j) => {
        step(j, 0).tool = "ff_get_roster";
      },
      /first step must be ff_get_status/,
    ],
    [
      "record not last",
      (j) => {
        j.sequences[0]!.steps.push({ id: "late", tool: "ff_get_roster", args: {} });
      },
      /must be the last step/,
    ],
    [
      "a record without rec",
      (j) => {
        delete (step(j, 2).args as Json).rec;
      },
      /needs `rec`/,
    ],
    [
      "a $ref to a later step",
      (j) => {
        (step(j, 1).args as Json).x = { $ref: "record.data.rec" };
      },
      /names no earlier step/,
    ],
    [
      "a $ref without a path",
      (j) => {
        (step(j, 2).args as Json).rec = { $ref: "roster" };
      },
      /\$ref must be/,
    ],
    [
      "an unknown $ key",
      (j) => {
        (step(j, 2).args as Json).rec = { $eval: "x" };
      },
      /unknown \$eval/,
    ],
    [
      "a $-object with two keys",
      (j) => {
        (step(j, 2).args as Json).rec = { $ref: "roster.a", b: 1 };
      },
      /exactly one key/,
    ],
    [
      "empty $source_calls",
      (j) => {
        (step(j, 2).args as Json).source_calls = { $source_calls: [] };
      },
      /must list step ids/,
    ],
    [
      "$source_calls naming a later step",
      (j) => {
        (step(j, 2).args as Json).source_calls = { $source_calls: ["record"] };
      },
      /names no earlier step "record"/,
    ],
    [
      "a nested $ref in an array",
      (j) => {
        (step(j, 2).args as Json).alternatives = [{ a: { $ref: "nope.x" } }];
      },
      /names no earlier step/,
    ],
    [
      "no record anywhere",
      (j) => {
        j.sequences[0]!.steps.pop();
      },
      /no sequence records the recommendation/,
    ],
  ])("rejects %s", (_l, mut, re) => {
    expect(errs(mut)).toMatch(re);
  });

  it.each<[string, (j: Json) => void, RegExp]>([
    [
      "start-sit without a game_day sequence",
      (j) => {
        j.sequences = (j.sequences as Json[]).filter((s) => s.id !== "game_day");
      },
      /no `game_day` sequence/,
    ],
    [
      "start-sit game_day without only_unlocked",
      (j) => {
        const gd = (j.sequences as Json[]).find((s) => s.id === "game_day")!;
        for (const s of gd.steps as Json[])
          if (s.tool === "ff_analyze_lineup") (s.args as Json).only_unlocked = false;
      },
      /only_unlocked: true/,
    ],
    [
      "start-sit pre-game objective pwin",
      (j) => {
        for (const s of (j.sequences as Json[])[0]!.steps as Json[])
          if (s.tool === "ff_analyze_lineup") (s.args as Json).objective = "pwin";
      },
      /objective: "mean"/,
    ],
    [
      "start-sit without compare",
      (j) => {
        for (const s of (j.sequences as Json[])[0]!.steps as Json[])
          if (s.tool === "ff_analyze_lineup") delete (s.args as Json).compare;
      },
      /compare/,
    ],
    [
      "start-sit lineup before projections",
      (j) => {
        for (const q of j.sequences as Json[])
          for (const s of q.steps as Json[])
            if (s.tool === "ff_project_players") s.tool = "ff_get_injuries";
      },
      /ff_project_players before ff_analyze_lineup/,
    ],
  ])("the start-sit rule rejects %s", (_l, mut, re) => {
    const t = fresh();
    const j = t.readJson(SEQ("start-sit")) as Json;
    mut(j);
    t.write(SEQ("start-sit"), j);
    expect(errorsOf(t)).toMatch(re);
  });

  it.each<[string, string, (j: Json) => void, RegExp]>([
    [
      "stream-kdef: schedule after waivers",
      "stream-kdef",
      (j) => {
        const st = (j.sequences as Json[])[0]!.steps as Json[];
        const i = st.findIndex((s) => s.tool === "ff_get_schedule");
        const [s] = st.splice(i, 1);
        st.splice(st.length - 1, 0, s!);
      },
      /ff_get_schedule must come before/,
    ],
    [
      "stream-kdef: look_ahead 1",
      "stream-kdef",
      (j) => {
        for (const s of (j.sequences as Json[])[0]!.steps as Json[])
          if (s.tool === "ff_analyze_waivers") (s.args as Json).look_ahead = 1;
      },
      /look_ahead: 2/,
    ],
    [
      "stream-kdef: a skill position",
      "stream-kdef",
      (j) => {
        for (const s of (j.sequences as Json[])[0]!.steps as Json[])
          if (s.tool === "ff_analyze_waivers") (s.args as Json).positions = ["K", "RB"];
      },
      /subset of \[K, DEF\]/,
    ],
    [
      "stream-kdef: no waivers step",
      "stream-kdef",
      (j) => {
        for (const q of j.sequences as Json[]) {
          q.steps = (q.steps as Json[]).filter((s) => s.tool !== "ff_analyze_waivers");
          ((q.steps as Json[]).at(-1)!.args as Json).rec = { $ref: "roster.data.rec" };
          ((q.steps as Json[]).at(-1)!.args as Json).source_calls = {
            $source_calls: ["roster"],
          };
        }
      },
      /no ff_analyze_waivers step/,
    ],
    [
      "retro: no retrospective",
      "retro",
      (j) => {
        const q = (j.sequences as Json[])[0]!;
        q.steps = (q.steps as Json[]).filter((s) => s.tool !== "ff_analyze_retrospective");
        ((q.steps as Json[]).at(-1)!.args as Json).rec = { $ref: "league.data.rec" };
        ((q.steps as Json[]).at(-1)!.args as Json).source_calls = {
          $source_calls: ["league"],
        };
      },
      /no ff_analyze_retrospective step/,
    ],
    [
      "retro: a wrong record kind",
      "retro",
      (j) => {
        for (const s of (j.sequences as Json[])[0]!.steps as Json[])
          if (s.tool === "ff_record_recommendation") (s.args as Json).kind = "lineup";
      },
      /record kind "lineup" is not one of retro/,
    ],
    [
      "onboard: no engine self-check",
      "onboard",
      (j) => {
        const q = (j.sequences as Json[])[1]!;
        q.steps = (q.steps as Json[]).filter((s) => s.tool !== "ff_get_player_stats");
        ((q.steps as Json[]).at(-1)!.args as Json).source_calls = {
          $source_calls: ["league"],
        };
      },
      /ff_get_league before ff_get_player_stats/,
    ],
  ])("rejects %s", (_l, skill, mut, re) => {
    const t = fresh();
    const j = t.readJson(SEQ(skill)) as Json;
    mut(j);
    t.write(SEQ(skill), j);
    expect(errorsOf(t)).toMatch(re);
  });
});

describe("QA-1-065: a recommendation is logged under the kind of the tool that produced it", () => {
  /** [record step's kind, the producing tool] for every sequence of the committed bundle. */
  const logged = SKILLS.flatMap((skill) => {
    const j = JSON.parse(readFileSync(`${ROOT}/${SEQ(skill)}`, "utf8")) as Json;
    return (j.sequences as Json[]).flatMap((q) => {
      const steps = q.steps as Json[];
      return steps
        .filter((st) => st.tool === "ff_record_recommendation")
        .map((st) => {
          const args = st.args as Json;
          const ref = (args.rec as Json | undefined)?.$ref;
          const from = typeof ref === "string" ? ref.split(".")[0] : undefined;
          const producer = steps.find((x) => x.id === from)?.tool;
          return { where: `${skill}/${String(q.id)}`, kind: args.kind, producer };
        });
    });
  });

  it("every committed sequence logs an analytics rec under its producer's kind", () => {
    const want: Record<string, string> = {
      ff_analyze_lineup: "lineup",
      ff_analyze_matchup: "matchup",
      ff_analyze_waivers: "stream",
      ff_analyze_retrospective: "retro",
    };
    const wrong = logged.filter(
      (l) => typeof l.producer === "string" && l.producer in want && want[l.producer] !== l.kind,
    );
    expect(wrong).toEqual([]);
  });

  it("rejects a lineup rec logged as kind matchup (the retrospective would skip its swap regret)", () => {
    const t = fresh();
    const j = t.readJson(SEQ("start-sit")) as Json;
    for (const s of (j.sequences as Json[])[0]!.steps as Json[])
      if (s.tool === "ff_record_recommendation") (s.args as Json).kind = "matchup";
    t.write(SEQ("start-sit"), j);
    expect(errorsOf(t)).toMatch(
      /logs ff_analyze_lineup's rec as kind "matchup" — it is a "lineup" rec/,
    );
  });

  it("validateToolSequence names the producer's kind for a $ref rec", () => {
    const seq = {
      schema_version: 1,
      skill: "x",
      tool_contract: 1,
      fixture: { league_key: "manual.l.example" },
      sequences: [
        {
          id: "a",
          when: "always",
          steps: [
            { id: "status", tool: "ff_get_status", args: {} },
            { id: "rank", tool: "ff_analyze_waivers", args: { positions: ["K"] } },
            {
              id: "record",
              tool: "ff_record_recommendation",
              args: { kind: "lineup", week: 4, rec: { $ref: "rank.data.rec" }, source_calls: [] },
            },
          ],
        },
      ],
    };
    const ctx = {
      skill: "x",
      where: "w",
      tools: ["ff_get_status", "ff_analyze_waivers", "ff_record_recommendation"],
      writeTools: [],
      toolContract: 1,
      errorCodes: [],
    };
    expect(validateToolSequence(seq, ctx).errors.join("\n")).toMatch(
      /logs ff_analyze_waivers's rec as kind "lineup" — it is a "stream" rec/,
    );
    const ok = structuredClone(seq);
    (ok.sequences[0]!.steps[2]!.args as Json).kind = "stream";
    (ok.sequences[0]!.steps[2]!.args as Json).alternatives = {
      $alternatives: { from: "rank", projections: "rank" },
    };
    expect(validateToolSequence(ok, ctx).errors).toEqual([]);
    // QA-2-041: a K/DEF (or lineup) rec logged with a hand-written list — [] once in all six — is
    // refused: the review could score no regret for it
    for (const alternatives of [
      [],
      undefined,
      { $alternatives: { from: "status", projections: "rank" } },
    ]) {
      const bad = structuredClone(ok);
      (bad.sequences[0]!.steps[2]!.args as Json).alternatives = alternatives;
      expect(validateToolSequence(bad, ctx).errors.join("\n")).toMatch(
        /alternatives other than \{ \$alternatives: \{ from: "rank"/,
      );
    }
  });

  it.each<[string, unknown, RegExp]>([
    [
      "$alternatives naming a later step",
      { $alternatives: { from: "record", projections: "rank" } },
      /\$alternatives\.from names no earlier step "record"/,
    ],
    [
      "$alternatives without projections",
      { $alternatives: { from: "rank" } },
      /\$alternatives must be \{ from: <step>, projections: <step> \}/,
    ],
    [
      "$alternatives with an extra key",
      { $alternatives: { from: "rank", projections: "rank", x: 1 } },
      /\$alternatives must be/,
    ],
    [
      "$alternative_keys naming a later step",
      { $alternative_keys: "record" },
      /\$alternative_keys must name an earlier step/,
    ],
    [
      "$alternative_keys not a step id",
      { $alternative_keys: ["rank"] },
      /\$alternative_keys must name an earlier step/,
    ],
  ])("validateToolSequence rejects %s", (_l, value, re) => {
    const seq = {
      schema_version: 1,
      skill: "x",
      tool_contract: 1,
      fixture: { league_key: "manual.l.example" },
      sequences: [
        {
          id: "a",
          when: "always",
          steps: [
            { id: "status", tool: "ff_get_status", args: {} },
            { id: "rank", tool: "ff_analyze_waivers", args: { positions: ["K"] } },
            {
              id: "record",
              tool: "ff_record_recommendation",
              args: {
                kind: "stream",
                week: 4,
                rec: { $ref: "rank.data.rec" },
                source_calls: [],
                alternatives: value,
              },
            },
          ],
        },
      ],
    };
    const ctx = {
      skill: "x",
      where: "w",
      tools: ["ff_get_status", "ff_analyze_waivers", "ff_record_recommendation"],
      writeTools: [],
      toolContract: 1,
      errorCodes: [],
    };
    expect(validateToolSequence(seq, ctx).errors.join("\n")).toMatch(re);
  });

  it("rejects a SKILL.md that logs a kind no sequence records, and a sequence kind the body never names", () => {
    const t = fresh();
    t.edit("skills/stream-kdef/SKILL.md", 'with `kind: "stream"`', 'with `kind: "matchup"`');
    expect(errorsOf(t)).toMatch(
      /stream-kdef\/SKILL\.md: logs kind "matchup" but no tool_sequence records it/,
    );
    expect(errorsOf(t)).toMatch(
      /stream-kdef\/SKILL\.md: the tool_sequence records kind "stream" but the body never logs it/,
    );
  });
});

describe("QA-1-063: stream-kdef ranks one position per ff_analyze_waivers call", () => {
  it("rejects a ranking call over K and DEF together (one hold_vs_stream and one rec for both)", () => {
    const t = fresh();
    const j = t.readJson(SEQ("stream-kdef")) as Json;
    for (const q of j.sequences as Json[])
      for (const s of q.steps as Json[])
        if (s.tool === "ff_analyze_waivers") (s.args as Json).positions = ["K", "DEF"];
    t.write(SEQ("stream-kdef"), j);
    expect(errorsOf(t)).toMatch(/ff_analyze_waivers must rank exactly one position per call/);
  });
});

describe("cases.json", () => {
  const ctx = {
    skill: "retro",
    where: "cases",
    tools: ["ff_analyze_retrospective", "ff_get_status"],
  };
  const good = () => ({
    schema_version: 1,
    skill: "retro",
    fixture_league: "manual.l.example",
    cases: [
      {
        id: "RT-1",
        phase: "1a",
        prompt: "How did it go?",
        fixture_variant: null,
        setup: "Week final.",
        expectations: [
          { kind: "tool_used", tool: "ff_analyze_retrospective" },
          { kind: "tool_order", tools: ["ff_get_status", "ff_analyze_retrospective"] },
          { kind: "tool_args", tool: "ff_analyze_retrospective", args: { week: 3 } },
          { kind: "regex", pattern: "regret", flags: "i" },
          { kind: "regex_absent", pattern: "0\\.\\d+" },
          { kind: "rubric", text: "Distinguishes decision from outcome." },
          { kind: "skill_invoked", value: true },
        ],
      },
    ],
  });
  type C = ReturnType<typeof good>;
  const exp0 = (j: C) => j.cases[0]!.expectations as Json[];
  const errs = (mut: (j: C) => unknown) => {
    const j = good();
    return validateCases(mut(j) ?? j, ctx).join("\n");
  };

  it("accepts a well-formed file", () => {
    expect(errs(() => undefined)).toBe("");
  });

  it.each<[string, (j: C) => unknown, RegExp]>([
    ["a non-object", () => "x", /JSON object/],
    ["a wrong skill", (j) => ({ ...j, skill: "onboard" }), /skill must be/],
    ["no fixture_league", (j) => ({ ...j, fixture_league: 1 }), /fixture_league/],
    ["a wrong schema_version", (j) => ({ ...j, schema_version: "1" }), /schema_version/],
    ["no cases", (j) => ({ ...j, cases: [] }), /non-empty array/],
    [
      "a bad id",
      (j) => {
        (j.cases[0] as Json).id = "rt-1";
      },
      /bad id/,
    ],
    [
      "a duplicate id",
      (j) => {
        j.cases.push(j.cases[0]!);
      },
      /duplicate id RT-1/,
    ],
    [
      "a bad phase",
      (j) => {
        (j.cases[0] as Json).phase = "4";
      },
      /phase/,
    ],
    [
      "an empty prompt",
      (j) => {
        (j.cases[0] as Json).prompt = " ";
      },
      /prompt/,
    ],
    [
      "a huge prompt",
      (j) => {
        (j.cases[0] as Json).prompt = "x".repeat(2001);
      },
      /prompt/,
    ],
    [
      "a bad variant",
      (j) => {
        (j.cases[0] as Json).fixture_variant = "A B";
      },
      /fixture_variant/,
    ],
    [
      "no setup",
      (j) => {
        (j.cases[0] as Json).setup = "";
      },
      /setup/,
    ],
    [
      "no expectations",
      (j) => {
        (j.cases[0] as Json).expectations = [];
      },
      /expectations must be/,
    ],
    [
      "an unknown kind",
      (j) => {
        exp0(j).push({ kind: "vibes" });
      },
      /kind must be one of/,
    ],
    [
      "an unknown tool",
      (j) => {
        exp0(j)[0]!.tool = "ff_nope";
      },
      /ff_nope is not a Phase-1a tool/,
    ],
    [
      "a one-tool order",
      (j) => {
        exp0(j)[1]!.tools = ["ff_get_status"];
      },
      /≥ 2 tools/,
    ],
    [
      "empty tool_args",
      (j) => {
        exp0(j)[2]!.args = {};
      },
      /non-empty object/,
    ],
    [
      "a regex that does not compile",
      (j) => {
        exp0(j)[3]!.pattern = "(unclosed";
      },
      /does not compile/,
    ],
    [
      "an empty regex",
      (j) => {
        exp0(j)[3]!.pattern = "";
      },
      /non-empty string/,
    ],
    [
      "bad flags",
      (j) => {
        exp0(j)[3]!.flags = "gg";
      },
      /subset of "imsu"/,
    ],
    [
      "a duplicate flag",
      (j) => {
        exp0(j)[3]!.flags = "ii";
      },
      /subset of "imsu"/,
    ],
    [
      "an empty rubric",
      (j) => {
        exp0(j)[5]!.text = "ok";
      },
      /rubric text/,
    ],
    [
      "a non-boolean skill_invoked",
      (j) => {
        exp0(j)[6]!.value = "no";
      },
      /boolean/,
    ],
  ])("rejects %s", (_l, mut, re) => {
    expect(errs(mut)).toMatch(re);
  });

  it("requires the plan's case ids per Skill (SS-1..7, KD-1..3, RT-1..3, ON-M*)", () => {
    const t = fresh();
    for (const [skill, id] of [
      ["start-sit", "SS-7"],
      ["stream-kdef", "KD-2"],
      ["retro", "RT-3"],
      ["onboard", "ON-M"],
    ] as const) {
      const j = t.readJson(CASES(skill)) as { cases: { id: string }[] };
      j.cases = j.cases.filter((c) => !c.id.startsWith(id));
      t.write(CASES(skill), j);
    }
    const e = errorsOf(t);
    expect(e).toMatch(/start-sit\/evals\/cases\.json: missing a case matching \/\^SS-7\$\//);
    expect(e).toMatch(/stream-kdef\/evals\/cases\.json: missing a case matching \/\^KD-2\$\//);
    expect(e).toMatch(/retro\/evals\/cases\.json: missing a case matching \/\^RT-3\$\//);
    expect(e).toMatch(/onboard\/evals\/cases\.json/);
  });
});

describe("trigger evals", () => {
  const trig = (pos: string[], neg: string[]): Trig => [
    ...pos.map((query) => ({ query, should_trigger: true })),
    ...neg.map((query) => ({ query, should_trigger: false })),
  ];

  it("validateTriggers needs ≥ 6 of each, well-formed and time-blind", () => {
    expect(validateTriggers({}, "t").errors.join()).toMatch(/must be an array/);
    expect(validateTriggers([{ query: 1 }], "t").errors.join()).toMatch(/needs a string/);
    expect(
      validateTriggers([{ query: "a", should_trigger: true, x: 1 }], "t").errors.join(),
    ).toMatch(/unknown keys x/);
    expect(validateTriggers([{ query: "", should_trigger: true }], "t").errors.join()).toMatch(
      /1–500/,
    );
    expect(validateTriggers(trig(["a"], ["b"]), "t").errors.join()).toMatch(/has 1\/1/);
    expect(validateTriggers(trig(["It's Sunday, who do I start?"], []), "t").errors.join()).toMatch(
      /weekday/,
    );
  });

  it.each([
    ["who should I start on Sunday?", "weekday"],
    ["start or sit for TNF", "night-game"],
    ["lineup lock is at 1:00, who plays", "clock time"],
    ["who plays at 4pm", "clock time"],
    ["games on 2026-10-04", "date"],
    ["games on Oct 4th", "date"],
    ["games on 10/4", "date"],
    ["who do I start today", "relative"],
    ["who goes in tonight", "relative"],
    ["who plays this afternoon", "relative"],
  ])("timeReference flags %s", (q, why) => {
    expect(timeReference(q)).toMatch(new RegExp(why));
  });

  it.each([
    "who should I start?",
    "what are my odds right now?",
    "who should I start at WR3",
    "Prep me for week 6",
    "Grade your picks from week 3",
    "Which K should I use?",
    "am I going to win",
    "Is Trey McBride playing?",
    "Best D/ST options with a two-week look-ahead?",
  ])("timeReference accepts the time-blind %s", (q) => {
    expect(timeReference(q)).toBeNull();
  });

  it("the committed game-day prompts are the plan's four", () => {
    expect(GAME_DAY_PROMPTS).toEqual([
      "who should I start?",
      "X is inactive, who goes in?",
      "what can I still change?",
      "what are my odds right now?",
    ]);
  });

  it("tokenize/phrases/routeScore/jaccard behave", () => {
    expect(tokenize("Who's the D/ST for week's games?")).toEqual([
      "who",
      "d",
      "st",
      "week",
      "game",
    ]);
    expect(tokenize("the a of")).toEqual([]);
    expect(tokenize("glass odds")).toEqual(["glass", "odd"]);
    expect(phrases("start or sit, flex, , X")).toEqual([["start", "sit"], ["flex"]]);
    expect(routeScore(phrases("start or sit, flex"), "Start or sit at flex?")).toBe(2);
    expect(routeScore(phrases("start or sit"), "start him")).toBe(0);
    expect(jaccard([], [])).toBe(1);
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
  });

  const skill = (name: string, whenToUse: string, pos: string[], neg: string[]) => ({
    name,
    whenToUse,
    triggers: trig(pos, neg),
  });

  it.each([
    [
      "a prompt listed twice",
      [skill("a", "alpha", ["alpha one", "alpha one"], [])],
      /listed twice/,
    ],
    [
      "a prompt both positive and negative",
      [skill("a", "alpha", ["alpha one"], ["alpha one"])],
      /both a positive and a negative/,
    ],
    [
      "the same positive in two Skills",
      [skill("a", "alpha", ["alpha beta"], []), skill("b", "beta", ["Alpha, beta!"], [])],
      /positive of both a and b/,
    ],
    [
      "near-duplicate positives",
      [
        skill("a", "alpha", ["alpha beta gamma delta"], []),
        skill("b", "delta", ["alpha beta gamma delta epsilon"], []),
      ],
      /near-duplicate/,
    ],
    [
      "a positive that routes to another Skill",
      [skill("a", "alpha", ["alpha beta gamma"], []), skill("b", "beta, gamma", ["beta"], [])],
      /matches b's when_to_use \(2\) better than its own \(1\)/,
    ],
    [
      "a negative matching its own phrases",
      [skill("a", "alpha", ["alpha"], ["alpha negative"])],
      /negative "alpha negative" of a matches a's own/,
    ],
    [
      "a shared when_to_use phrase",
      [
        skill("a", "alpha, shared phrase", ["alpha"], []),
        skill("b", "Shared phrase", ["shared phrase b"], []),
      ],
      /phrase "shared phrase" is in both a and b/,
    ],
    [
      "a positive matching none of its own phrases",
      [skill("a", "alpha", ["zeta"], [])],
      /matches none of a's when_to_use/,
    ],
  ])("triggerCollisions flags %s", (_l, skills, re) => {
    expect(triggerCollisions(skills).join("\n")).toMatch(re);
  });

  it("the game-day prompts must be start-sit positives and nobody else's", () => {
    const owner = skill("start-sit", "who should I start", ["who should I start?"], []);
    const other = skill("weekly", "what can I still change", ["what can I still change?"], []);
    const e = triggerCollisions([owner, other]).join("\n");
    expect(e).toMatch(
      /start-sit: the game-day prompt "what can I still change\?" must be a positive/,
    );
    expect(e).toMatch(
      /weekly: the game-day prompt "what can I still change\?" must route to start-sit only/,
    );
    // without the owner in the set, the rule does not apply
    expect(triggerCollisions([other]).join("\n")).not.toMatch(/game-day/);
  });

  it("fails the real bundle when a game-day prompt is dropped or claimed by another Skill", () => {
    const t = fresh();
    const ss = (t.readJson(TRIG("start-sit")) as Trig).filter(
      (q) => q.query !== "what can I still change?",
    );
    t.write(TRIG("start-sit"), ss);
    const retro = t.readJson(TRIG("retro")) as Trig;
    retro.push({ query: "what are my odds right now?", should_trigger: true });
    t.write(TRIG("retro"), retro);
    const e = errorsOf(t);
    expect(e).toMatch(
      /start-sit: the game-day prompt "what can I still change\?" must be a positive/,
    );
    expect(e).toMatch(
      /retro: the game-day prompt "what are my odds right now\?" must route to start-sit only/,
    );
  });

  it("fails the real bundle on a prompt that is not time-blind", () => {
    const t = fresh();
    const s = t.readJson(TRIG("stream-kdef")) as Trig;
    s.push({ query: "Which defense for Thursday night?", should_trigger: true });
    t.write(TRIG("stream-kdef"), s);
    expect(errorsOf(t)).toMatch(/not time-blind \(names a weekday/);
  });
});

describe("the secret and identifier scan over skills/", () => {
  it("fails on a key-shaped string and a non-placeholder league key", () => {
    const t = fresh();
    // built at runtime so this test file itself never carries a key-shaped literal
    const key = ["sk", "ant", "a".repeat(30)].join("-");
    const league = ["461", "l", "54321"].join(".");
    t.write("skills/retro/references/retro-leak.md", `token ${key}\nleague ${league}\n`);
    const r = checkSkills({ root: t.root, scanEnv: { FF_SCAN_DENYLIST: NO_DENYLIST } });
    const e = r.errors.join("\n");
    expect(e).toMatch(/scan-secrets: exit 1/);
    expect(e).toMatch(/retro-leak\.md:1 {2}\[anthropic-key\]/);
    expect(e).toMatch(/retro-leak\.md:2 {2}\[yahoo-league-or-team-key\]/);
  });

  it("fails on a term from the local deny-list (personal identifiers)", () => {
    const t = fresh();
    t.write("denylist.txt", "zqxv-private-league-name\n");
    t.write("skills/retro/references/retro-name.md", "League: ZQXV-Private-League-Name\n");
    const r = checkSkills({ root: t.root, scanEnv: { FF_SCAN_DENYLIST: t.p("denylist.txt") } });
    expect(r.errors.join("\n")).toMatch(/retro-name\.md:1 {2}\[personal-identifier\]/);
  });

  it("reports a missing scanner instead of passing silently", () => {
    const t = fresh();
    rmSync(t.p("scripts/dev/scan-secrets.mjs"));
    expect(checkSkills({ root: t.root }).errors.join()).toMatch(/scan-secrets\.mjs not found/);
  });
});

describe("CLI", () => {
  it("exits 0 on the working tree and prints the notes", () => {
    const r = runScript("check-skills.mjs", []);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/OK — 4 Skill\(s\): onboard, retro, start-sit, stream-kdef/);
  });

  it("exits 1 with the problems listed on a broken copy", () => {
    const t = fresh();
    t.edit("skills/retro/SKILL.md", "name: retro", "name: retro2");
    const r = runScript("check-skills.mjs", ["--root", t.root, "--no-scan"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/problem\(s\)/);
    expect(r.stderr).toMatch(/must equal the directory/);
  });

  it("exits 1 when skills/ is missing, 2 on a usage error", () => {
    const t = tempRepo({ skills: false });
    repo = t;
    expect(runScript("check-skills.mjs", ["--root", t.root]).status).toBe(1);
    expect(runScript("check-skills.mjs", ["--bogus"]).status).toBe(2);
    expect(main(["--root"])).toBe(2);
  });
});
