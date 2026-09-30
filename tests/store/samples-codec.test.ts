// samples-codec.test.ts — src/store/repos/samples-codec.ts (plan 08 §5 "compressed; canonical names
// only"; plan 10 A15): the compact form round-trips every engine-shaped batch exactly, anything else
// falls back to exact JSON, legacy JSON rows still read, and a corrupt column is refused, never
// half-decoded.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { StatLine } from "../../src/domain/scoring/types.js";
import {
  decodeSamples,
  encodeSamples,
  MAX_COMPACT_SAMPLES,
  SAMPLES_ENCODING,
} from "../../src/store/repos/samples-codec.js";

const SRC = "projection:v1-trailing";
const line = (values: Record<string, number>, pt: StatLine["position_type"] = "O"): StatLine => ({
  values,
  present: Object.keys(values).sort(),
  position_type: pt,
  provisional: false,
  source: SRC,
});
const isCompact = (text: string): boolean => text.startsWith(`{"enc":"${SAMPLES_ENCODING}"`);
const header = (over: Record<string, unknown>): string =>
  JSON.stringify({
    enc: SAMPLES_ENCODING,
    n: 1,
    position_type: "O",
    provisional: false,
    source: SRC,
    keys: ["rec"],
    data: Buffer.alloc(8).toString("base64"),
    ...over,
  });

describe("encodeSamples / decodeSamples — the compact form", () => {
  it("round-trips an engine-shaped batch exactly (shared present, empty lines, −0, extremes)", () => {
    const keys = ["rec", "rec_td", "rec_yd"];
    const empty: StatLine = { ...line({}), present: [] };
    const lines = [
      { ...line({ rec: 5.25, rec_td: 0.4, rec_yd: 61.3 }), present: keys },
      empty,
      { ...line({ rec: -0, rec_td: Number.MIN_VALUE, rec_yd: 1e9 }), present: keys },
      empty,
    ];
    const text = encodeSamples(lines);
    expect(isCompact(text)).toBe(true);
    const back = decodeSamples(text);
    expect(back).toEqual(lines);
    expect(Object.is(back[2]?.values.rec, -0)).toBe(true);
    expect(back[1]).toEqual({ ...empty, values: {}, present: [] });
  });

  it("round-trips a defence batch whose lines carry different keys (union of columns)", () => {
    const lines = [
      line({ dst_pa: 17, dst_ya: 320, dst_sack: 3 }, "DT"),
      line({ dst_pa: 0, dst_ya: 250, dst_int: 1 }, "DT"),
    ];
    const text = encodeSamples(lines);
    expect(isCompact(text)).toBe(true);
    expect(decodeSamples(text)).toEqual(lines);
  });

  it("is several times smaller than JSON on a 4 000-sample player-week (the A15 root cause)", () => {
    const keys = ["fum_lost", "rec", "rec_td", "rec_yd", "rush_att", "rush_yd", "targets"];
    const lines = Array.from({ length: 4000 }, (_, i) => {
      const g = 0.2 + (i % 97) / 37;
      return line(Object.fromEntries(keys.map((k, j) => [k, (j + 1.37) * g])));
    });
    const compact = encodeSamples(lines);
    expect(compact.length * 3).toBeLessThan(JSON.stringify(lines).length);
    expect(decodeSamples(compact)).toEqual(lines);
  });

  it("property: any batch of canonical lines round-trips exactly", () => {
    const name = fc.stringMatching(/^[a-z][a-z0-9_]{0,12}$/);
    const values = fc.dictionary(name, fc.double({ noNaN: true, noDefaultInfinity: true }), {
      maxKeys: 6,
    });
    fc.assert(
      fc.property(
        fc.array(values, { minLength: 1, maxLength: 40 }),
        fc.constantFrom<StatLine["position_type"]>("O", "K", "DT", "D"),
        fc.boolean(),
        (vs, pt, provisional) => {
          const lines = vs.map((v) => ({ ...line(v, pt), provisional }));
          const text = encodeSamples(lines);
          expect(isCompact(text)).toBe(true);
          expect(decodeSamples(text)).toEqual(lines);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("encodeSamples — exact JSON fallback for anything the compact form cannot hold", () => {
  const base = line({ rec: 1 });
  it.each<[string, StatLine[]]>([
    ["mixed position types", [base, line({ rec: 1 }, "K")]],
    ["mixed provisional", [base, { ...base, provisional: true }]],
    ["mixed sources", [base, { ...base, source: "nflverse" }]],
    ["a non-canonical key", [line({ "Rec Yd": 1 })]],
    ["a unicode key", [line({ réc: 1 })]],
    [
      "a __proto__ key",
      [
        JSON.parse(
          '{"values":{"__proto__":1},"present":["__proto__"],"position_type":"O","provisional":false,"source":"x"}',
        ) as StatLine,
      ],
    ],
    ["present missing a key", [{ ...line({ rec: 1, rec_yd: 2 }), present: ["rec"] }]],
    ["present naming an absent key", [{ ...line({ rec: 1 }), present: ["rec", "rec_yd"] }]],
    ["present naming a different key", [{ ...line({ rec_yd: 2 }), present: ["rec"] }]],
    ["present out of order", [{ ...line({ rec: 1, rec_yd: 2 }), present: ["rec_yd", "rec"] }]],
    ["present with a duplicate", [{ ...line({ rec: 1 }), present: ["rec", "rec"] }]],
    ["a NaN value", [line({ rec: Number.NaN })]],
    ["an infinite value", [line({ rec: Number.POSITIVE_INFINITY })]],
    ["a string value", [line({ rec: "3" as unknown as number })]],
    [
      "an inherited value",
      [{ ...base, values: Object.create({ rec: 1 }) as Record<string, number> }],
    ],
  ])("%s", (_, lines) => {
    const text = encodeSamples(lines);
    expect(text.startsWith("[")).toBe(true);
    expect(text).toBe(JSON.stringify(lines));
  });

  it("an empty batch and an oversized batch stay JSON", () => {
    expect(encodeSamples([])).toBe("[]");
    expect(decodeSamples("[]")).toEqual([]);
    const shared = line({ rec: 1 });
    const huge = new Array<StatLine>(MAX_COMPACT_SAMPLES + 1).fill(shared);
    expect(encodeSamples(huge).startsWith("[")).toBe(true);
    const max = new Array<StatLine>(MAX_COMPACT_SAMPLES).fill(shared);
    expect(isCompact(encodeSamples(max))).toBe(true);
  });

  it("legacy rows (a plain JSON array written before the compact form) still read", () => {
    const legacy = [line({ pass_yd: 250.5 }), line({ pass_yd: 0 })];
    expect(decodeSamples(JSON.stringify(legacy))).toEqual(legacy);
  });
});

describe("decodeSamples — a corrupt column is refused whole", () => {
  it.each<[string, unknown]>([
    ["not a string", 42],
    ["null", null],
    ["JSON null", "null"],
    ["a JSON number", "7"],
    ["an unknown encoding", header({ enc: "f32le-b64:9" })],
    ["n zero", header({ n: 0, data: "" })],
    ["n fractional", header({ n: 1.5 })],
    ["n a string", header({ n: "1" })],
    ["n past the cap", header({ n: MAX_COMPACT_SAMPLES + 1, keys: [], data: "" })],
    ["an unknown position type", header({ position_type: "QB" })],
    ["provisional not boolean", header({ provisional: "no" })],
    ["source not a string", header({ source: 1 })],
    ["keys not an array", header({ keys: "rec" })],
    ["a non-canonical key", header({ keys: ["Rec"] })],
    ["a non-string key", header({ keys: [1] })],
    [
      "unsorted keys",
      header({ keys: ["rec_yd", "rec"], data: Buffer.alloc(16).toString("base64") }),
    ],
    ["duplicate keys", header({ keys: ["rec", "rec"], data: Buffer.alloc(16).toString("base64") })],
    ["data not a string", header({ data: 5 })],
    ["data too short", header({ data: Buffer.alloc(7).toString("base64") })],
    ["data too long", header({ data: Buffer.alloc(16).toString("base64") })],
    [
      "an infinite cell",
      header({ data: Buffer.from(new Float64Array([Infinity]).buffer).toString("base64") }),
    ],
  ])("%s", (_, text) => {
    expect(() => decodeSamples(text)).toThrow(/corrupt samples column/);
  });

  it("malformed JSON throws", () => {
    expect(() => decodeSamples("{")).toThrow();
  });

  it("an all-absent row decodes as an empty line; a zero-width batch keeps its row count", () => {
    const nan = Buffer.alloc(8);
    nan.writeDoubleLE(Number.NaN, 0);
    expect(decodeSamples(header({ data: nan.toString("base64") }))).toEqual([
      { values: {}, present: [], position_type: "O", provisional: false, source: SRC },
    ]);
    expect(decodeSamples(header({ n: 3, keys: [], data: "" }))).toHaveLength(3);
  });
});
