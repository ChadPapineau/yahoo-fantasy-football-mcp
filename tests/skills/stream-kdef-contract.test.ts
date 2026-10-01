// stream-kdef-contract.test.ts — QA-1-063: the stream-kdef Skill may tell the model to print only
// what ff_analyze_waivers returns (plan 09 §2: never re-derive; plan 07 E5 is the tool's contract),
// and may offer only arguments its tools accept. Checked against the real server on the fixture
// league by replaying the Skill's own tool_sequence.json.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "../../scripts/skills/_lib.mjs";
import { resolveArgs } from "../../scripts/skills/tool-sequences.mjs";
import { ROOT, SKILLS } from "./helpers.js";
import { T0, codeSpans, dataOf, resolvePath, section, skillWorld, stringsDeep } from "./world.js";

type Json = Record<string, unknown>;
interface Step {
  id: string;
  tool: string;
  args: Json;
}
const seqOf = (skill: string) =>
  JSON.parse(readFileSync(path.join(ROOT, `skills/${skill}/evals/tool_sequence.json`), "utf8")) as {
    sequences: { id: string; steps: Step[] }[];
  };
const skillText = (skill: string) =>
  readFileSync(path.join(ROOT, `skills/${skill}/SKILL.md`), "utf8");

/** A code span that names a result field (`a`, `a[]`, `a.b`), as opposed to a value or a call. */
const FIELD = /^[a-z_][a-z0-9_]*(?:\[\])?(?:\.[a-z_][a-z0-9_]*(?:\[\])?)*$/;

describe("QA-1-063: every Skill's argument-hint offers only what its analytics tools accept", () => {
  for (const skill of SKILLS) {
    it(`${skill}: a [week] argument is accepted by every analytics call`, async () => {
      const fm = parseFrontmatter(skillText(skill));
      const raw = fm.data["argument-hint"];
      const hint = typeof raw === "string" ? raw : "";
      if (!/\bweek\b/.test(hint)) return;
      const tools = [
        ...new Set(
          seqOf(skill)
            .sequences.flatMap((s) => s.steps)
            .map((s) => s.tool)
            .filter((t) => t.startsWith("ff_analyze_")),
        ),
      ];
      expect(tools.length).toBeGreaterThan(0);
      const sw = await skillWorld(T0);
      try {
        const without: string[] = [];
        for (const t of tools) if (!(await sw.inputKeys(t)).includes("week")) without.push(t);
        expect(without).toEqual([]);
      } finally {
        await sw.close();
      }
    }, 60_000);
  }
});

describe("QA-1-063: stream-kdef's output additions name fields ff_analyze_waivers returns", () => {
  it("each ranking call covers one position, so each has its own hold_vs_stream and rec", () => {
    const ranks = seqOf("stream-kdef")
      .sequences.flatMap((s) => s.steps)
      .filter((s) => s.tool === "ff_analyze_waivers");
    expect(ranks.length).toBeGreaterThan(0);
    for (const r of ranks) expect(r.args.positions).toHaveLength(1);
  });

  it("every field named under Output additions resolves on the result or on a candidate", async () => {
    const additions = section(skillText("stream-kdef"), "## Output additions");
    const fields = codeSpans(additions).filter((c) => FIELD.test(c) && !c.startsWith("ff_"));
    expect(fields.length).toBeGreaterThan(0);
    const sw = await skillWorld(T0);
    const unresolved = new Set<string>();
    try {
      for (const seq of seqOf("stream-kdef").sequences) {
        const results = new Map<string, { tool: string; result: unknown }>();
        let data: Json | null = null;
        for (const step of seq.steps) {
          if (step.tool === "ff_record_recommendation") continue;
          const c = await sw.call(step.tool, resolveArgs(step.args, results) as Json);
          if (c.ok) results.set(step.id, { tool: step.tool, result: c.body });
          if (step.tool === "ff_analyze_waivers") data = dataOf(c);
        }
        expect(data, `${seq.id} ranks`).not.toBeNull();
        const candidate = (data?.candidates as Json[] | undefined)?.[0];
        const values = stringsDeep(data);
        for (const f of fields) {
          const found =
            resolvePath(data, f).length > 0 ||
            resolvePath(candidate, f).length > 0 ||
            values.has(f);
          if (!found) unresolved.add(f);
        }
      }
    } finally {
      await sw.close();
    }
    expect([...unresolved]).toEqual([]);
  }, 60_000);
});
