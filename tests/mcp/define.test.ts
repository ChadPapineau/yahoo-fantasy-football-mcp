// define.test.ts — the registration helper (plan 01 §4): the pointer, the advertised schemas (only
// ever LOOSER than the zod contract), analytics rounding (monotone, so quantiles stay ordered), the
// budget and self-validation steps that turn a bug into a coded INTERNAL result and a log line.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import {
  FAMILY_ANNOTATIONS,
  TOOL_NAME_GRAMMAR,
  advertisedInputSchema,
  advertisedOutputSchema,
  compactJsonSchema,
  defineTool,
  envelopeOutline,
  fullDescription,
  roundDeep,
  runTool,
  type AnyToolDefinition,
} from "../../src/mcp/define.js";
import { UNTRUSTED_POINTER, distSchema } from "../../src/mcp/envelope.js";
import { FfError } from "../../src/mcp/errors.js";
import type { McpServerOptions, McpServices } from "../../src/mcp/services.js";
import { fixedClock } from "../../src/domain/clock.js";

const noop = (): undefined => undefined;

function fakeServices(lines: string[]): McpServices {
  const log = (level: string) => (event: string, fields?: Readonly<Record<string, unknown>>) => {
    lines.push(JSON.stringify({ level, event, ...fields }));
  };
  return {
    clock: fixedClock("2026-09-30T00:00:00Z"),
    logger: { error: log("error"), warn: log("warn"), info: log("info"), debug: log("debug") },
    beforeCall: noop,
  } as unknown as McpServices;
}
const OPTIONS = {} as McpServerOptions;

describe("names, descriptions, annotations", () => {
  it("defineTool refuses a name outside the ff_<verb>_<resource> grammar", () => {
    const base = {
      family: "ops" as const,
      description: "d",
      input: z.strictObject({}),
      data: null,
      budget: "list" as const,
      run: () => Promise.resolve({ data: {}, inputs: [] }),
    };
    expect(() => defineTool({ ...base, name: "get_status" })).toThrow(RangeError);
    expect(() => defineTool({ ...base, name: "ff_Get" })).toThrow(RangeError);
    expect(() => defineTool({ ...base, name: `ff_${"a".repeat(40)}` })).toThrow(RangeError);
    expect(defineTool({ ...base, name: "ff_get_x" }).name).toBe("ff_get_x");
    expect(TOOL_NAME_GRAMMAR.test("ff_record_recommendation")).toBe(true);
  });
  it("the pointer is appended once and always last", () => {
    expect(fullDescription("Does X.")).toBe(`Does X. ${UNTRUSTED_POINTER}`);
    expect(fullDescription(`Does X. ${UNTRUSTED_POINTER}`)).toBe(`Does X. ${UNTRUSTED_POINTER}`);
    expect(fullDescription("  padded  ").endsWith(UNTRUSTED_POINTER)).toBe(true);
  });
  it("families: only the local-write family is not read-only; none is destructive", () => {
    for (const [family, a] of Object.entries(FAMILY_ANNOTATIONS)) {
      expect(a.readOnlyHint).toBe(family !== "local_write");
      expect(a.destructiveHint ?? false).toBe(false);
    }
  });
});

describe("advertised schemas are compact and never tighter than zod", () => {
  it("compactJsonSchema drops $schema, pattern and additionalProperties:false, keeps the rest", () => {
    const j = compactJsonSchema({
      $schema: "x",
      type: "object",
      additionalProperties: false,
      properties: {
        k: { type: "string", pattern: "^a$", maxLength: 3 },
        n: { type: "integer", minimum: 1 },
      },
      required: ["k"],
      items: [{ pattern: "p" }, null, 1],
    });
    expect(j).toEqual({
      type: "object",
      properties: { k: { type: "string", maxLength: 3 }, n: { type: "integer", minimum: 1 } },
      required: ["k"],
      items: [{}, null, 1],
    });
  });
  it("the output outline lists data's top-level fields; validation stays the full zod schema", async () => {
    const data = z.strictObject({ a: z.number().int(), b: z.array(z.string()).nullable() });
    expect(envelopeOutline(data)).toEqual({
      type: "object",
      properties: {
        data: { type: "object", properties: { a: {}, b: {} } },
        meta: { type: "object" },
      },
      required: ["data", "meta"],
    });
    expect(envelopeOutline(z.string())).toMatchObject({
      properties: { data: { properties: {} } },
    });
    const std = advertisedOutputSchema(data)["~standard"];
    expect(std.jsonSchema.output({ target: "draft-2020-12" })).toEqual(envelopeOutline(data));
    const bad = await std.validate({ data: { a: 1.5, b: null } });
    expect("issues" in bad && bad.issues !== undefined).toBe(true);
  });
  it("the input schema passes values through unvalidated and advertises opaque properties", async () => {
    const s = z.strictObject({
      rec: z.strictObject({ x: z.number() }),
      alts: z.array(z.string()),
      k: z.string().regex(/^a+$/),
    });
    const std = advertisedInputSchema(s, { rec: "from E2", alts: "list" })["~standard"];
    const v = await std.validate({ anything: 1 });
    expect(v).toEqual({ value: { anything: 1 } });
    const json = std.jsonSchema.input({ target: "draft-2020-12" }) as {
      properties: Record<string, unknown>;
    };
    expect(json.properties.rec).toEqual({ type: "object", description: "from E2" });
    expect(json.properties.alts).toEqual({ type: "array", description: "list" });
    expect(json.properties.k).toEqual({ type: "string" });
    expect(std.jsonSchema.input({ target: "draft-2020-12" })).toBe(json); // memoised
  });
});

describe("roundDeep (analytics output rounding)", () => {
  it("rounds non-integers to 3 places, keeps integers, strings, null, -0 → 0", () => {
    expect(roundDeep({ a: 1.23456, b: [2, -0.0001, "x"], c: null, d: { e: Number.NaN } })).toEqual({
      a: 1.235,
      b: [2, 0, "x"],
      c: null,
      d: { e: Number.NaN },
    });
    expect(Object.is(roundDeep(-0.0004), 0)).toBe(true);
  });
  it("property: rounding keeps every Dist's quantiles ordered (monotone)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -500, max: 500, noNaN: true }), { minLength: 5, maxLength: 5 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (xs, pz) => {
          const q = [...xs].sort((a, b) => a - b);
          const d = {
            mean: q[2] ?? 0,
            p10: q[0] ?? 0,
            p25: q[1] ?? 0,
            p50: q[2] ?? 0,
            p75: q[3] ?? 0,
            p90: q[4] ?? 0,
            p_zero: pz,
            basis: "position_cv" as const,
          };
          expect(distSchema.safeParse(roundDeep(d)).success).toBe(true);
        },
      ),
    );
  });
});

describe("runTool: budget and self-validation (a bug is INTERNAL + a log line, never a leak)", () => {
  const tool = (over: Partial<AnyToolDefinition>): AnyToolDefinition => ({
    name: "ff_test_tool",
    family: "ops",
    description: "t",
    input: z.strictObject({}),
    data: null,
    budget: "list",
    run: () => Promise.resolve({ data: { items: [] }, inputs: [] }),
    ...over,
  });

  it("an over-budget result without a list to halve is INTERNAL and logged", async () => {
    const lines: string[] = [];
    const def = tool({
      run: () => Promise.resolve({ data: { blob: "x".repeat(25_000) }, inputs: [] }),
    });
    const p = runTool(def, {}, { requestId: "r-000000000001" }, fakeServices(lines), OPTIONS, null);
    await expect(p).rejects.toBeInstanceOf(FfError);
    expect(lines.join("")).toContain("tool.over_budget");
  });
  it("a list over budget is halved, truncated:true, with the fixed hint; pageable sets has_more", async () => {
    const def = tool({
      pageable: true,
      run: () =>
        Promise.resolve({
          data: {
            items: Array.from({ length: 200 }, (_, i) => `item-${String(i)}-${"y".repeat(150)}`),
          },
          inputs: [],
          listKey: "items",
          page: { limit: 200, offset: 0, count: 200, has_more: false, next_offset: null },
        }),
    });
    const r = await runTool(
      def,
      {},
      { requestId: "r-000000000002" },
      fakeServices([]),
      OPTIONS,
      null,
    );
    const env = JSON.parse(r.content[0].text) as {
      truncated: boolean;
      page: { has_more: boolean; next_offset: number };
      warnings: string[];
      data: { items: unknown[] };
    };
    expect(env.truncated).toBe(true);
    expect(env.page.has_more).toBe(true);
    expect(env.page.next_offset).toBe(env.data.items.length);
    expect(env.warnings.some((w) => w.startsWith("result truncated"))).toBe(true);
    expect(r.structuredContent).toBeUndefined();
  });
  it("a result that fails its own output schema is INTERNAL and logged with issue codes only", async () => {
    const lines: string[] = [];
    const data = z.strictObject({ n: z.number().int() });
    const def = tool({
      data,
      run: () => Promise.resolve({ data: { n: 1.5 }, inputs: [] }),
    });
    const full = z.strictObject({
      data,
      meta: z.unknown(),
      truncated: z.boolean(),
      warnings: z.unknown(),
    });
    const p = runTool(def, {}, { requestId: "r-000000000003" }, fakeServices(lines), OPTIONS, full);
    await expect(p).rejects.toBeInstanceOf(FfError);
    expect(lines.join("")).toContain("tool.output_invalid");
    expect(lines.join("")).not.toContain("1.5");
  });
  it("analytics results are rounded before they are measured and validated", async () => {
    const def = tool({
      budget: "analytics",
      run: () => Promise.resolve({ data: { x: 1.23456789 }, inputs: [], estimate: true }),
    });
    const r = await runTool(
      def,
      {},
      { requestId: "r-000000000004" },
      fakeServices([]),
      OPTIONS,
      null,
    );
    const env = JSON.parse(r.content[0].text) as {
      data: { x: number };
      meta: { estimate: boolean };
    };
    expect(env.data.x).toBe(1.235);
    expect(env.meta.estimate).toBe(true);
  });
});
