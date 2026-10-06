// stream-kdef-contract.test.ts — QA-1-063: the stream-kdef Skill may tell the model to print only
// what ff_analyze_waivers returns (plan 09 §2: never re-derive; plan 07 E5 is the tool's contract),
// and may offer only arguments its tools accept. Checked against the real server on the fixture
// league by replaying the Skill's own tool_sequence.json. QA-2-005: the range the Skill gives for
// the gain over the current starter must be the interval the verdict was decided on — marginal_value's
// quantiles leave out the starter's own variance and disagreed with it (-4.2..12.9 vs -6.8..15.1).
// QA-2-006: the interval must also point the way the call goes — negated for a hold, as given for
// a stream — so the orientation is read from rec.no_move, never accepted either way.
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

describe("QA-2-005: stream-kdef's gain range is the verdict's own Δ interval", () => {
  const additions = section(skillText("stream-kdef"), "## Output additions");
  /** Each interval (a Dist or {p10, p90}) the Output additions present for the gain over the starter. */
  const gainRanges = [
    ...new Set(
      additions
        .split("\n")
        .filter((l) => /\bgain\b|Δ|\bmargin\b/i.test(l))
        .flatMap((l) => codeSpans(l))
        .filter((c) => FIELD.test(c) && /\.p(?:10|90)$/.test(c))
        .map((c) => c.replace(/\.p(?:10|90)$/, "")),
    ),
  ];
  /** The verdict's interval as the coin-flip assumption states it, when the call carries one. */
  const COIN_FLIP = /Δ interval against holding \((-?\d+(?:\.\d+)?) to (-?\d+(?:\.\d+)?) points\)/;

  it("marginal_value is shown by its mean only", () => {
    const named = codeSpans(additions).filter((c) => c.startsWith("marginal_value."));
    expect(named).toContain("marginal_value.mean");
    expect(named.filter((c) => !/^marginal_value\.(?:mean|basis)$/.test(c))).toEqual([]);
  });

  it("every gain range presented equals the interval the verdict was decided on", async () => {
    expect(gainRanges.length, "the Skill gives a range for the gain").toBeGreaterThan(0);
    const sw = await skillWorld(T0);
    const wrong: string[] = [];
    let checked = 0;
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
        const rec = data?.rec as { assumptions: { text: string }[] } | undefined;
        const m = rec?.assumptions.map((a) => COIN_FLIP.exec(a.text)).find((x) => x !== null);
        if (m === undefined) continue;
        const [lo, hi] = [Number(m[1]), Number(m[2])];
        const top = (data?.candidates as Json[] | undefined)?.[0];
        for (const g of gainRanges) {
          const end = (q: string) =>
            [...resolvePath(data, `${g}.${q}`), ...resolvePath(top, `${g}.${q}`)][0] as number;
          const [p10, p90] = [end("p10"), end("p90")];
          const near = (a: number, b: number) => Math.abs(a - b) <= 0.051;
          // a hold states the starter's margin over the best option: the verdict's interval,
          // negated (the Skill flips the signs back); a stream states the pick's gain as it is.
          // The orientation comes from the call, so a sign error in either branch is caught (QA-2-006).
          const hold = (data?.rec as { no_move?: boolean } | undefined)?.no_move === true;
          const same = hold ? near(-p90, lo) && near(-p10, hi) : near(p10, lo) && near(p90, hi);
          checked += 1;
          if (!same)
            wrong.push(
              `${seq.id}: ${g} is ${String(p10)}..${String(p90)}, the verdict's ${String(lo)}..${String(hi)}`,
            );
        }
      }
    } finally {
      await sw.close();
    }
    expect(checked, "a sequence whose verdict states its interval (control)").toBeGreaterThan(0);
    expect(wrong).toEqual([]);
  }, 60_000);
});
