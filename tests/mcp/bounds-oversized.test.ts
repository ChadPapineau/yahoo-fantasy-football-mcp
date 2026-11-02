// bounds-oversized.test.ts — a size bound on a collection is checked before its elements are parsed
// (plan 02 §5 bounds; the mechanism of QA-1-078: `wrapHandler` parses a tools/call's whole argument
// object, so an over-long list must cost one `too_big` issue, not a parse and an issue per element).
// zod 4.6.5 parsed every element first (GHSA-mrhx-c7xc-m3w5: memory exhaustion on an oversized
// constrained collection); 4.6.6 checks array, set and map size bounds before parsing elements. The
// same properties hold for the server's own list schemas, and an in-bound list still validates every
// element.
import fc from "fast-check";
import { z } from "zod/v4";
import { describe, expect, it } from "vitest";
import { BOUNDS, playerKeysSchema, playerSelectorSchema } from "../../src/mcp/bounds.js";

const MAX = BOUNDS.playerList.max;
/** An over-long list length: just past the bound up to a few thousand elements. */
const oversized = fc.integer({ min: MAX + 1, max: 4000 });

/** A counting element schema: every call means zod parsed that element. */
function spyElement() {
  let calls = 0;
  const schema = z.string().refine(() => {
    calls += 1;
    return false;
  });
  return { schema, calls: () => calls };
}

const containers: [string, (e: z.ZodString) => z.ZodType, (n: number) => unknown][] = [
  ["array", (e) => z.array(e).max(MAX), (n) => Array.from({ length: n }, () => "x")],
  [
    "set",
    (e) => z.set(e).max(MAX),
    (n) => new Set(Array.from({ length: n }, (_, i) => `v${String(i)}`)),
  ],
  [
    "map",
    (e) => z.map(e, e).max(MAX),
    (n) => new Map(Array.from({ length: n }, (_, i) => [`k${String(i)}`, "v"])),
  ],
];

describe("a size bound is checked before the elements (GHSA-mrhx-c7xc-m3w5, QA-1-078)", () => {
  it.each(containers)(
    "an over-large %s parses no element and reports one issue, at the container",
    (_name, bounded, value) => {
      fc.assert(
        fc.property(oversized, (n) => {
          const spy = spyElement();
          const r = bounded(spy.schema).safeParse(value(n));
          expect(r.success).toBe(false);
          expect(spy.calls()).toBe(0);
          expect(r.error?.issues.map((i) => [i.code, i.path.length])).toEqual([["too_big", 0]]);
        }),
        { numRuns: 30 },
      );
    },
  );

  it("the server's player-key list rejects any over-long list with no per-element issue", () => {
    fc.assert(
      fc.property(oversized, fc.boolean(), (n, validKeys) => {
        // valid keys or hostile ones: either way the elements are never looked at
        const keys = Array.from({ length: n }, (_, i) =>
          validKeys ? `461.p.${String(i + 1)}` : `not a key ${String(i)}`,
        );
        for (const r of [
          playerKeysSchema.safeParse(keys),
          playerSelectorSchema.safeParse({ player_keys: keys }),
          playerSelectorSchema.safeParse({ gsis_ids: keys }),
        ]) {
          expect(r.success).toBe(false);
          const issues = r.error?.issues ?? [];
          // a union reports each branch's issues once: the count is bounded, never ~n
          expect(issues.length).toBeLessThanOrEqual(8);
          expect(JSON.stringify(r.error?.issues)).toContain("too_big");
          // no issue anywhere (nested union branches included) sits at an element index
          expect(/"path":\[(?:"[a-z_]+",)?\d+/.exec(JSON.stringify(issues))).toBeNull();
        }
      }),
      { numRuns: 30 },
    );
  });

  it("an in-bound list still validates every element (the bound short-cuts only past it)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: MAX }), fc.nat(), (n, seed) => {
        const bad = seed % n;
        const keys = Array.from({ length: n }, (_, i) =>
          i === bad ? "461.P.1" : `461.p.${String(i + 1)}`,
        );
        const r = playerKeysSchema.safeParse(keys);
        expect(r.success).toBe(false);
        expect(r.error?.issues.map((i) => i.path)).toEqual([[bad]]);
        const spy = spyElement();
        z.array(spy.schema).max(MAX).safeParse(keys);
        expect(spy.calls()).toBe(n);
      }),
      { numRuns: 100 },
    );
  });
});
