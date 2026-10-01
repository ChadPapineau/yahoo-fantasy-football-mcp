// onboard-log-entry.test.ts — QA-1-070: the onboard Skill's verify flow logs a no-move entry
// (plan 09 §2: every Skill logs before answering, "no move" included), but it calls no analytics
// tool, so there is no `data.rec` to copy and the tool advertises `rec` as an opaque object. The
// guide must therefore carry the exact entry, and that entry — with only its <placeholders> filled
// from the verify flow's own calls — must be accepted by the real ff_record_recommendation. The
// template and the Lane 1 sequence must be the same entry (one source).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./helpers.js";
import { T0, dataOf, skillWorld } from "./world.js";

type Json = Record<string, unknown>;
const guide = readFileSync(
  path.join(ROOT, "skills/onboard/references/onboard-league-yaml.md"),
  "utf8",
);
const skill = readFileSync(path.join(ROOT, "skills/onboard/SKILL.md"), "utf8");
const jsonBlocks = [...guide.matchAll(/^```json\n([\s\S]*?)^```/gm)].map((m) => m[1] ?? "");
const seq = JSON.parse(
  readFileSync(path.join(ROOT, "skills/onboard/evals/tool_sequence.json"), "utf8"),
) as { sequences: { id: string; steps: { id: string; tool: string; args: Json }[] }[] };
const seqRecord = seq.sequences
  .find((s) => s.id === "verify")
  ?.steps.find((s) => s.tool === "ff_record_recommendation")?.args;

/** The template, parsed (throws when the guide has none). */
function template(): Json {
  expect(jsonBlocks, "the guide carries exactly one JSON log entry").toHaveLength(1);
  return JSON.parse(jsonBlocks[0] ?? "") as Json;
}
const isPlaceholder = (v: unknown): v is string => typeof v === "string" && /^<[^>]+>$/.test(v);

describe("QA-1-070: the onboard Skill has an exact, accepted no-move log entry", () => {
  it("the Skill's log step points at the template in the guide", () => {
    const step = skill.split("\n").find((l) => /^5\.\s.*ff_record_recommendation/.test(l)) ?? "";
    expect(step).toMatch(/onboard-league-yaml\.md#the-verification-log-entry/);
  });

  it("the template is the Lane 1 sequence's entry (one source), placeholders aside", () => {
    const t = template();
    expect(seqRecord).toBeDefined();
    const rec = t.rec as Json;
    const seqRec = seqRecord?.rec as Json;
    expect(isPlaceholder(rec.as_of)).toBe(true);
    expect({ ...rec, as_of: null }).toEqual({ ...seqRec, as_of: null });
    for (const k of ["kind", "alternatives", "followed_hint", "client_ref"])
      expect(t[k], k).toEqual(seqRecord?.[k]);
  });

  it("filled from the verify flow's own calls, the entry is accepted by ff_record_recommendation", async () => {
    const t = template();
    const sw = await skillWorld(T0);
    try {
      const league = await sw.call("ff_get_league");
      const roster = await sw.call("ff_get_roster");
      const stats = await sw.call("ff_get_player_stats", {
        player_keys: ["manual.p.00-0034857", "manual.p.00-0036900", "manual.p.00-0031136"],
        type: "week",
        week: 3,
      });
      const ld = dataOf(league) as { league: { current_week: number } };
      const ids: Record<string, unknown> = {
        ff_get_league: (league.body.meta as Json).request_id,
        ff_get_roster: (roster.body.meta as Json).request_id,
        ff_get_player_stats: (stats.body.meta as Json).request_id,
      };
      const fill = (v: unknown, key: string): unknown => {
        if (key === "as_of" && isPlaceholder(v)) return (league.body.meta as Json).as_of;
        if (key === "week" && isPlaceholder(v)) return ld.league.current_week;
        return v;
      };
      const walk = (v: unknown, key = ""): unknown =>
        Array.isArray(v)
          ? v.map((x) => walk(x))
          : v !== null && typeof v === "object"
            ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]))
            : fill(v, key);
      const args = walk(t) as Json;
      // source_calls: one entry per verify call the template names, with that call's request id
      args.source_calls = (t.source_calls as { tool: string }[]).map((c) => ({
        tool: c.tool,
        request_id: ids[c.tool],
      }));
      const left = JSON.stringify(args).match(/"<[^>]+>"/g);
      expect(left, "every placeholder is one the verify flow can fill").toBeNull();
      const r = await sw.call("ff_record_recommendation", args);
      expect(r.ok, JSON.stringify(r.body).slice(0, 400)).toBe(true);
      expect(typeof (dataOf(r) as { log_id: unknown }).log_id).toBe("string");
    } finally {
      await sw.close();
    }
  }, 60_000);
});
