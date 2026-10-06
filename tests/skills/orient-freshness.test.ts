// orient-freshness.test.ts — QA-1-038 (the Skills half): Step 0 of orient must tell a Skill to note
// every `sources[]` row `ff_get_status` can return in a state other than `fresh`, and plan 07 G1
// must list the same states. The states come from the tool's own output schema, so a state the
// server gains (`unreadable` did, in the round-2 fix) fails here until the Skills and the plan
// name it — a Skill that notes only `stale` rows reads a file the server cannot serve as healthy.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { REGISTRY } from "../../src/mcp/registry.js";
import { ROOT } from "./helpers.js";

const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** The `freshness` values G1's `sources[]` rows can carry, from the registered output schema. */
const STATES: readonly string[] = (() => {
  const def = REGISTRY.find((e) => e.tool.name === "ff_get_status")?.tool;
  if (def === undefined) throw new Error("ff_get_status is not registered");
  if (def.data === null) throw new Error("ff_get_status has no data schema");
  const json = z.toJSONSchema(def.data, { io: "output", unrepresentable: "any" }) as {
    properties?: {
      sources?: { items?: { properties?: { freshness?: { enum?: unknown[] } } } };
    };
  };
  const values = json.properties?.sources?.items?.properties?.freshness?.enum;
  if (!Array.isArray(values)) throw new Error("no freshness enum on sources[] rows");
  return values.map(String);
})();

/** Step 0's first item: what a Skill notes from `ff_get_status`. */
const stepZeroItem = (text: string): string =>
  /^1\. Call `[^`]*ff_get_status`.*$/m.exec(text)?.[0] ?? "";

describe("QA-1-038: orient's Step 0 notes every sources[] state but fresh", () => {
  it("the schema has the states the round-2 fix introduced", () => {
    expect(STATES).toContain("fresh");
    expect(STATES).toContain("unreadable");
  });

  const files = [
    "skills/_shared/references/orient.md",
    ...["onboard", "retro", "start-sit", "stream-kdef"].map(
      (s) => `skills/${s}/references/orient.md`,
    ),
  ];
  it.each(files)("%s names every state but fresh as one to note, with last_error", (rel) => {
    const item = stepZeroItem(read(rel));
    expect(item, `${rel}: no Step 0 ff_get_status item`).not.toBe("");
    for (const s of STATES.filter((x) => x !== "fresh")) expect(item, s).toContain(`\`${s}\``);
    expect(item).toMatch(/last_error/);
    // and how to repair a source that cannot be served
    expect(item).toMatch(/ff refresh/);
  });

  it("the tool-outputs cheat-sheet lists the same states for sources[].freshness", () => {
    const row = /^\| `ff_get_status` \|.*$/m.exec(
      read("skills/_shared/references/tool-outputs.md"),
    );
    expect(row?.[0]).toBeDefined();
    for (const s of STATES) expect(row?.[0], s).toContain(s);
  });
});

describe("QA-1-038: plan 07 G1 lists exactly the schema's freshness states", () => {
  it("G1's sources[] freshness union equals the registered enum", () => {
    const g1 = /^\*\*G1 `ff_get_status`\*\*[\s\S]*?^- Output `data`: (.*)$/m.exec(
      read("docs/plan/07-tool-catalog.md"),
    )?.[1];
    expect(g1).toBeDefined();
    const union = /freshness: ((?:"[a-z_]+"\|?)+)/.exec(g1 ?? "")?.[1];
    expect(union, "G1 states freshness as a union of literals").toBeDefined();
    const listed = [...(union ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect([...listed].sort()).toEqual([...STATES].sort());
  });
});
