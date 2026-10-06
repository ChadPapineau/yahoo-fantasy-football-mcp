// stream-kdef-contract.test.ts — QA-1-063: the stream-kdef Skill may tell the model to print only
// what ff_analyze_waivers returns (plan 09 §2: never re-derive; plan 07 E5 is the tool's contract),
// and may offer only arguments its tools accept. Checked against the real server on the fixture
// league by replaying the Skill's own tool_sequence.json. QA-2-005: the range the Skill gives for
// the gain over the current starter must be the interval the verdict was decided on — marginal_value's
// quantiles leave out the starter's own variance and disagreed with it (-4.2..12.9 vs -6.8..15.1).
// QA-2-006: the interval must also point the way the call goes — negated for a hold, as given for
// a stream — so the orientation is read from rec.no_move, never accepted either way.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseFrontmatter, walkFiles } from "../../scripts/skills/_lib.mjs";
import { resolveArgs } from "../../scripts/skills/tool-sequences.mjs";
import { ROOT, SKILLS } from "./helpers.js";
import {
  T0,
  codeSpans,
  dataOf,
  resolvePath,
  section,
  sentences,
  skillWorld,
  stringsDeep,
} from "./world.js";

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

/**
 * The whole text the stream-kdef Skill hands the model: SKILL.md (every section, the generated
 * blocks included) and every reference file it ships. Any line of it is an instruction, so the
 * QA-2-005 checks read all of it, never one section (the reopened QA-2-005: a defective line under
 * "## Guardrails" passed a check that read only "## Output additions").
 */
const corpusOf = (skill: string): readonly { file: string; text: string }[] => {
  const refs = path.join(ROOT, "skills", skill, "references");
  return [
    { file: `skills/${skill}/SKILL.md`, text: skillText(skill) },
    ...readdirSync(refs)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => ({
        file: `skills/${skill}/references/${f}`,
        text: readFileSync(path.join(refs, f), "utf8"),
      })),
  ];
};

/** Each interval (a Dist or {p10, p90}) a text presents for the gain over the starter. */
const gainRangesIn = (text: string): string[] => [
  ...new Set(
    text
      .split("\n")
      .filter((l) => /\bgain\b|Δ|\bmargin\b/i.test(l))
      .flatMap((l) => codeSpans(l))
      .filter((c) => FIELD.test(c) && /\.p(?:10|90)$/.test(c))
      .map((c) => c.replace(/\.p(?:10|90)$/, "")),
  ),
];

/** A quantile of marginal_value named in prose ("marginal_value's p10 to p90"). */
const MARGINAL_QUANTILE =
  /\bmarginal_value(?:\.|'s\s+)p\d\d\b|\bmarginal_value\b[^.;]*?\b(?:p\d\d|quantiles?|percentiles?|range|interval)\b|\b(?:p\d\d|quantiles?|percentiles?|range|interval)\b[^.;]*?\bmarginal_value\b/i;
const PROHIBITION = /\b(?:never|not|no|don't|do not)\b/i;

/**
 * Where a text presents marginal_value by more than its mean: a `marginal_value.<field>` span
 * other than mean/basis, or a sentence naming its quantiles that does not forbid presenting them.
 */
const marginalBeyondMean = (text: string): string[] => [
  ...codeSpans(text).filter(
    (c) => c.startsWith("marginal_value.") && !/^marginal_value\.(?:mean|basis)$/.test(c),
  ),
  ...sentences(text).filter((s) => MARGINAL_QUANTILE.test(s) && !PROHIBITION.test(s)),
];

describe("QA-2-005: stream-kdef's gain range is the verdict's own Δ interval", () => {
  const corpus = corpusOf("stream-kdef");
  const whole = corpus.map((c) => c.text).join("\n");
  const gainRanges = gainRangesIn(whole);
  /** The verdict's interval as the coin-flip assumption states it, when the call carries one. */
  const COIN_FLIP = /Δ interval against holding \((-?\d+(?:\.\d+)?) to (-?\d+(?:\.\d+)?) points\)/;

  it("marginal_value is shown by its mean only, anywhere in the Skill's text", () => {
    expect(codeSpans(whole)).toContain("marginal_value.mean");
    expect(corpus.flatMap((c) => marginalBeyondMean(c.text).map((m) => `${c.file}: ${m}`))).toEqual(
      [],
    );
  });

  // The checks' scope is the whole text: a defective instruction planted after ANY heading of
  // SKILL.md (the generated blocks included) or of any reference file, or at the end of a file, in
  // code-span or prose form, is seen. This is what the reopened QA-2-005 variant slipped past.
  const DEFECTS = [
    "- Give each candidate's gain over the current starter as the range `marginal_value.p10` to `marginal_value.p90`.",
    "- The gain's range for a candidate: `marginal_value.p25` to `marginal_value.p75`.",
    "Show each candidate's gain over the starter as marginal_value's p10 to p90.",
  ] as const;
  const plantings = corpus.flatMap(({ file, text }) => {
    const lines = text.split("\n");
    const at = [...lines.keys()].filter((i) => /^#{1,6}\s/.test(lines[i] ?? ""));
    return [...at.map((i) => i + 1), lines.length].map((pos) => ({
      where: `${file}:${String(pos)}`,
      file,
      plant: (defect: string) => [...lines.slice(0, pos), defect, ...lines.slice(pos)].join("\n"),
    }));
  });

  it("the checks read every Markdown file the Skill ships (scope control)", () => {
    const shipped = walkFiles(path.join(ROOT, "skills", "stream-kdef"), ROOT)
      .files.filter((f) => f.endsWith(".md"))
      .sort();
    expect(shipped).toContain("skills/stream-kdef/SKILL.md");
    expect(corpus.map((c) => c.file).sort()).toEqual(shipped);
  });

  it("a defective gain range planted anywhere in the text is seen (control)", () => {
    expect(new Set(plantings.map((p) => p.file)).size).toBe(corpus.length);
    expect(plantings.length).toBeGreaterThan(corpus.length * 2);
    const missed: string[] = [];
    for (const p of plantings) {
      for (const d of DEFECTS) {
        const planted = corpus.map((c) => (c.file === p.file ? p.plant(d) : c.text)).join("\n");
        const seen =
          marginalBeyondMean(planted).length > 0 &&
          (!d.includes("`marginal_value.p10`") || gainRangesIn(planted).includes("marginal_value"));
        if (!seen) missed.push(`${p.where}: ${d}`);
      }
    }
    expect(missed).toEqual([]);
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
