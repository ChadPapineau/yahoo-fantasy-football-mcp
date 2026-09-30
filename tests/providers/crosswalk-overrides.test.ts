// crosswalk-overrides.test.ts — src/providers/crosswalk-overrides.ts: the shipped overrides file
// loads; hostile YAML (alias bombs, prototype keys, 10 MB, wrong types, duplicates, bad encoding) is
// rejected with a coded error (research 04 §D step 3; plan 02 §2; plan 05 §2).
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CrosswalkOverridesError,
  DEFAULT_OVERRIDES_PATH,
  MAX_ALIAS_COUNT,
  MAX_OVERRIDES,
  MAX_OVERRIDES_BYTES,
  assertNoForbiddenKeys,
  loadCrosswalkOverrides,
  parseCrosswalkOverrides,
  type OverridesErrorCode,
} from "../../src/providers/crosswalk-overrides.js";

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ff-xw-overrides-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function codeOf(fn: () => unknown): OverridesErrorCode | "none" {
  try {
    fn();
    return "none";
  } catch (err) {
    expect(err).toBeInstanceOf(CrosswalkOverridesError);
    return (err as CrosswalkOverridesError).code;
  }
}

const ROW = `  - platform: yahoo
    platform_player_id: "nfl.p.30977"
    gsis_id: "00-0034857"
    note: "example"
`;

describe("the shipped file", () => {
  it("loads to an empty list", () => {
    expect(loadCrosswalkOverrides()).toEqual([]);
    expect(loadCrosswalkOverrides(DEFAULT_OVERRIDES_PATH)).toEqual([]);
  });
});

describe("parseCrosswalkOverrides — valid input", () => {
  it("parses rows, defaulting note to null, frozen", () => {
    const out = parseCrosswalkOverrides(`version: 1
overrides:
${ROW}  - platform: manual
    platform_player_id: manual.p.00-0041027
    gsis_id: 00-0041027
  - platform: sleeper
    platform_player_id: "4984"
    gsis_id: "00-0034857"
    note: null
  - platform: espn
    platform_player_id: "3918298"
    gsis_id: "00-0034857"
`);
    expect(out).toEqual([
      {
        platform: "yahoo",
        platform_player_id: "nfl.p.30977",
        gsis_id: "00-0034857",
        note: "example",
      },
      {
        platform: "manual",
        platform_player_id: "manual.p.00-0041027",
        gsis_id: "00-0041027",
        note: null,
      },
      { platform: "sleeper", platform_player_id: "4984", gsis_id: "00-0034857", note: null },
      { platform: "espn", platform_player_id: "3918298", gsis_id: "00-0034857", note: null },
    ]);
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out[0])).toBe(true);
  });

  it("accepts unicode notes and a BOM-free UTF-8 file with comments", () => {
    const out = parseCrosswalkOverrides(`# comment
version: 1
overrides:
  - platform: yahoo
    platform_player_id: "461.p.1"
    gsis_id: "00-0000001"
    note: "Kaʻimi — same-name practice squad ✓"
`);
    expect(out[0]?.note).toBe("Kaʻimi — same-name practice squad ✓");
  });

  it("accepts exactly MAX_OVERRIDES rows", () => {
    const rows = Array.from(
      { length: MAX_OVERRIDES },
      (_, i) =>
        `  - {platform: sleeper, platform_player_id: "${String(i + 1)}", gsis_id: "00-${String(i).padStart(7, "0")}"}\n`,
    ).join("");
    expect(parseCrosswalkOverrides(`version: 1\noverrides:\n${rows}`)).toHaveLength(MAX_OVERRIDES);
  });
});

describe("parseCrosswalkOverrides — hostile input", () => {
  it("rejects a billion-laughs alias bomb", () => {
    const bomb = `a: &a ["x","x","x","x","x","x","x","x","x"]
b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]
c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]
d: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]
e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]
f: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e]
g: &g [*f,*f,*f,*f,*f,*f,*f,*f,*f]
version: 1
overrides: []
`;
    const t0 = performance.now();
    expect(codeOf(() => parseCrosswalkOverrides(bomb))).toBe("alias_limit");
    expect(performance.now() - t0).toBeLessThan(2_000);
  });

  it("rejects more aliases than the budget even when small", () => {
    const refs = Array.from({ length: MAX_ALIAS_COUNT + 1 }, () => "*r").join(", ");
    const text = `version: 1\nx: &r "a"\ny: [${refs}]\noverrides: []\n`;
    expect(codeOf(() => parseCrosswalkOverrides(text))).toBe("alias_limit");
  });

  it("a legal alias still has to pass the schema", () => {
    const text = `version: 1\noverrides:\n  - &row {platform: sleeper, platform_player_id: "1", gsis_id: "00-0000001"}\n  - *row\n`;
    expect(codeOf(() => parseCrosswalkOverrides(text))).toBe("duplicate");
  });

  it.each([
    ["top-level __proto__", `version: 1\noverrides: []\n__proto__: {polluted: true}\n`],
    [
      "row __proto__",
      `version: 1\noverrides:\n  - __proto__: {isAdmin: true}\n    platform: yahoo\n`,
    ],
    ["constructor", `version: 1\noverrides: []\nconstructor: {prototype: {x: 1}}\n`],
    ["prototype", `version: 1\noverrides:\n  - prototype: 1\n`],
    ["nested", `version: 1\noverrides: [{note: {a: {__proto__: 1}}}]\n`],
  ])("rejects a %s key", (_label, text) => {
    expect(codeOf(() => parseCrosswalkOverrides(text))).toBe("forbidden_key");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
  });

  it("rejects a 10 MB text before parsing", () => {
    const big = `version: 1\noverrides: []\n# ${"x".repeat(10 * 1024 * 1024)}\n`;
    const t0 = performance.now();
    expect(codeOf(() => parseCrosswalkOverrides(big))).toBe("too_large");
    expect(performance.now() - t0).toBeLessThan(1_000);
  });

  it("counts bytes, not characters, against the cap", () => {
    const n = Math.floor(MAX_OVERRIDES_BYTES / 3);
    expect(codeOf(() => parseCrosswalkOverrides(`# ${"€".repeat(n)}`))).toBe("too_large");
  });

  it.each([
    ["duplicate key", `version: 1\nversion: 1\noverrides: []\n`],
    ["two documents", `version: 1\noverrides: []\n---\nversion: 1\n`],
    ["unknown tag", `version: 1\noverrides: !!js/function "return 1"\n`],
    ["custom tag", `version: !evil 1\noverrides: []\n`],
    ["broken syntax", `version: 1\noverrides: [\n`],
    ["bad indentation", `version: 1\n  overrides: []\n`],
    ["tab indentation", `version: 1\noverrides:\n\t- a\n`],
    [
      "merge key",
      `base: &b {platform: yahoo}\nversion: 1\noverrides:\n  - <<: *b\n    platform_player_id: "461.p.1"\n    gsis_id: "00-0000001"\n`,
    ],
  ])("rejects YAML with a %s", (_label, text) => {
    const code = codeOf(() => parseCrosswalkOverrides(text));
    expect(["yaml", "schema"]).toContain(code);
  });

  it("reports a yaml error by code and position, never by content", () => {
    try {
      parseCrosswalkOverrides(`version: 1\nversion: 2\noverrides: [SECRET-LOOKING-TEXT\n`);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/^crosswalk overrides: yaml \([A-Z_]+ at \d+:\d+\)$/);
      expect((err as Error).message).not.toContain("SECRET");
    }
  });

  it("survives absurd nesting without crashing the process", () => {
    const deep = `${"[".repeat(50_000)}${"]".repeat(50_000)}`;
    expect(["yaml", "schema"]).toContain(codeOf(() => parseCrosswalkOverrides(deep)));
    const deepMap = `version: 1\noverrides: []\nx: ${"{a: ".repeat(40)}1${"}".repeat(40)}\n`;
    expect(codeOf(() => parseCrosswalkOverrides(deepMap))).toBe("schema");
  });

  it.each([
    ["empty file", ""],
    ["null document", "~\n"],
    ["a list", "- 1\n"],
    ["a scalar", "hello\n"],
    ["missing version", "overrides: []\n"],
    ["version 2", "version: 2\noverrides: []\n"],
    ["version as string", `version: "1"\noverrides: []\n`],
    ["overrides null", "version: 1\noverrides:\n"],
    ["overrides a map", "version: 1\noverrides: {a: 1}\n"],
    ["unknown top-level key", "version: 1\noverrides: []\nextra: 1\n"],
    ["unknown row key", `version: 1\noverrides:\n${ROW}    extra: 1\n`],
    [
      "unknown platform",
      `version: 1\noverrides:\n  - {platform: fleaflicker, platform_player_id: "1", gsis_id: "00-0000001"}\n`,
    ],
    [
      "numeric id",
      `version: 1\noverrides:\n  - {platform: sleeper, platform_player_id: 4984, gsis_id: "00-0034857"}\n`,
    ],
    [
      "numeric gsis",
      `version: 1\noverrides:\n  - {platform: sleeper, platform_player_id: "4984", gsis_id: 34857}\n`,
    ],
    [
      "gsis with a leading space",
      `version: 1\noverrides:\n  - {platform: sleeper, platform_player_id: "4984", gsis_id: " 00-0034857"}\n`,
    ],
    [
      "gsis NA",
      `version: 1\noverrides:\n  - {platform: sleeper, platform_player_id: "4984", gsis_id: "NA"}\n`,
    ],
    [
      "yahoo id with a team key",
      `version: 1\noverrides:\n  - {platform: yahoo, platform_player_id: "461.l.1000.t.1", gsis_id: "00-0034857"}\n`,
    ],
    [
      "manual id with the yahoo grammar",
      `version: 1\noverrides:\n  - {platform: manual, platform_player_id: "461.p.1", gsis_id: "00-0034857"}\n`,
    ],
    [
      "empty id",
      `version: 1\noverrides:\n  - {platform: sleeper, platform_player_id: "", gsis_id: "00-0034857"}\n`,
    ],
    [
      "over-long id",
      `version: 1\noverrides:\n  - {platform: sleeper, platform_player_id: "${"1".repeat(65)}", gsis_id: "00-0034857"}\n`,
    ],
    [
      "note with a control character",
      `version: 1\noverrides:\n  - {platform: sleeper, platform_player_id: "1", gsis_id: "00-0000001", note: "a\\u0007b"}\n`,
    ],
    [
      "over-long note",
      `version: 1\noverrides:\n  - {platform: sleeper, platform_player_id: "1", gsis_id: "00-0000001", note: "${"n".repeat(201)}"}\n`,
    ],
    [
      "note as a list",
      `version: 1\noverrides:\n  - {platform: sleeper, platform_player_id: "1", gsis_id: "00-0000001", note: [a]}\n`,
    ],
    ["row as a string", `version: 1\noverrides:\n  - "00-0000001"\n`],
  ])("rejects wrong types / shapes: %s", (_label, text) => {
    expect(codeOf(() => parseCrosswalkOverrides(text))).toBe("schema");
  });

  it("rejects more than MAX_OVERRIDES rows", () => {
    const rows = Array.from(
      { length: MAX_OVERRIDES + 1 },
      (_, i) =>
        `- {platform: sleeper, platform_player_id: "${String(i + 1)}", gsis_id: "00-0000001"}\n`,
    ).join("");
    expect(codeOf(() => parseCrosswalkOverrides(`version: 1\noverrides:\n${rows}`))).toBe("schema");
  });

  it("names the failing path, not the value", () => {
    try {
      parseCrosswalkOverrides(
        `version: 1\noverrides:\n  - {platform: sleeper, platform_player_id: "1", gsis_id: "SECRET"}\n`,
      );
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toBe("crosswalk overrides: schema (overrides.0.gsis_id)");
    }
  });

  it.each([
    ["identical rows", `${ROW}${ROW}`],
    [
      "the same Yahoo player under two game prefixes",
      `${ROW}  - {platform: yahoo, platform_player_id: "461.p.30977", gsis_id: "00-0036900"}\n`,
    ],
  ])("rejects duplicate platform players: %s", (_label, rows) => {
    try {
      parseCrosswalkOverrides(`version: 1\noverrides:\n${rows}`);
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({
        code: "duplicate",
        message: "crosswalk overrides: duplicate (overrides.1)",
      });
    }
  });

  it("allows the same id on different platforms", () => {
    const text = `version: 1\noverrides:\n  - {platform: sleeper, platform_player_id: "1", gsis_id: "00-0000001"}\n  - {platform: espn, platform_player_id: "1", gsis_id: "00-0000001"}\n`;
    expect(parseCrosswalkOverrides(text)).toHaveLength(2);
  });
});

describe("loadCrosswalkOverrides — the file", () => {
  it("reads a valid file", () => {
    const p = join(dir, "ok.yaml");
    writeFileSync(p, `version: 1\noverrides:\n${ROW}`);
    expect(loadCrosswalkOverrides(p)).toHaveLength(1);
  });

  it("strips a UTF-8 BOM", () => {
    const p = join(dir, "bom.yaml");
    writeFileSync(p, `﻿version: 1\noverrides: []\n`);
    expect(loadCrosswalkOverrides(p)).toEqual([]);
  });

  it("rejects a 10 MB file, reading at most the cap + 1 byte", () => {
    const p = join(dir, "big.yaml");
    writeFileSync(p, Buffer.alloc(10 * 1024 * 1024, 0x61));
    expect(codeOf(() => loadCrosswalkOverrides(p))).toBe("too_large");
  });

  it("accepts a file of exactly the cap if it is valid, rejects one byte more", () => {
    const head = "version: 1\noverrides: []\n#";
    const exact = join(dir, "exact.yaml");
    writeFileSync(exact, head + "x".repeat(MAX_OVERRIDES_BYTES - head.length));
    expect(loadCrosswalkOverrides(exact)).toEqual([]);
    const over = join(dir, "over.yaml");
    writeFileSync(over, head + "x".repeat(MAX_OVERRIDES_BYTES - head.length + 1));
    expect(codeOf(() => loadCrosswalkOverrides(over))).toBe("too_large");
  });

  it("rejects invalid UTF-8", () => {
    const p = join(dir, "latin1.yaml");
    writeFileSync(p, Buffer.from([0x76, 0x3a, 0x20, 0xff, 0xfe, 0x0a]));
    expect(codeOf(() => loadCrosswalkOverrides(p))).toBe("encoding");
  });

  it("rejects a missing file, a directory and a FIFO-like non-file with io", () => {
    expect(codeOf(() => loadCrosswalkOverrides(join(dir, "nope.yaml")))).toBe("io");
    const sub = join(dir, "sub");
    mkdirSync(sub);
    expect(codeOf(() => loadCrosswalkOverrides(sub))).toBe("io");
    try {
      loadCrosswalkOverrides(join(dir, "nope.yaml"));
    } catch (err) {
      expect((err as Error).message).toBe("crosswalk overrides: io (ENOENT)");
    }
  });

  it("follows a symlink to a regular file but still applies every check", () => {
    const target = join(dir, "target.yaml");
    writeFileSync(target, `version: 1\noverrides: []\n__proto__: 1\n`);
    const link = join(dir, "link.yaml");
    symlinkSync(target, link);
    expect(codeOf(() => loadCrosswalkOverrides(link))).toBe("forbidden_key");
  });

  it("loads concurrently-called files independently", async () => {
    const paths = Array.from({ length: 20 }, (_, i) => {
      const p = join(dir, `c${String(i)}.yaml`);
      writeFileSync(
        p,
        `version: 1\noverrides:\n  - {platform: sleeper, platform_player_id: "${String(i + 1)}", gsis_id: "00-0000001"}\n`,
      );
      return p;
    });
    const results = await Promise.all(
      paths.map((p) => Promise.resolve().then(() => loadCrosswalkOverrides(p))),
    );
    expect(results.map((r) => r[0]?.platform_player_id)).toEqual(
      paths.map((_, i) => String(i + 1)),
    );
  });
});

describe("assertNoForbiddenKeys", () => {
  it("accepts plain data", () => {
    expect(() => {
      assertNoForbiddenKeys({ a: [1, "x", null, { b: true }], c: { d: 1.5 } });
    }).not.toThrow();
  });

  it.each([
    ["a Map", new Map([["a", 1]])],
    [
      "a class instance",
      new (class Evil {
        readonly tag = 1;
      })(),
    ],
    ["a null-prototype object", Object.create(null) as object],
    ["a Date", new Date(0)],
    ["a nested non-plain object", { a: [{ b: new Set([1]) }] }],
  ])("rejects %s", (_label, value) => {
    expect(
      codeOf(() => {
        assertNoForbiddenKeys(value);
      }),
    ).toBe("forbidden_key");
  });

  it("rejects an own __proto__ key created with defineProperty", () => {
    const o = {};
    Object.defineProperty(o, "__proto__", { value: { polluted: true }, enumerable: true });
    expect(
      codeOf(() => {
        assertNoForbiddenKeys({ list: [o] });
      }),
    ).toBe("forbidden_key");
  });

  it("stops at 32 levels of nesting", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = [deep];
    expect(
      codeOf(() => {
        assertNoForbiddenKeys(deep);
      }),
    ).toBe("schema");
  });
});

describe("failure modes of the dependencies", () => {
  it("maps an unexpected yaml exception to a coded error without its message", async () => {
    vi.resetModules();
    vi.doMock("yaml", () => ({
      parseDocument: () => {
        throw new TypeError("internal SECRET detail");
      },
    }));
    try {
      const mod = await import("../../src/providers/crosswalk-overrides.js");
      try {
        mod.parseCrosswalkOverrides("version: 1\noverrides: []\n");
        expect.unreachable();
      } catch (err) {
        expect((err as Error).message).toBe("crosswalk overrides: yaml (PARSE)");
      }
    } finally {
      vi.doUnmock("yaml");
      vi.resetModules();
    }
  });

  it("maps a ReferenceError that is not about aliases to a yaml error", async () => {
    vi.resetModules();
    vi.doMock("yaml", () => ({
      parseDocument: () => ({
        errors: [],
        warnings: [],
        toJS: () => {
          throw new ReferenceError("something else");
        },
      }),
    }));
    try {
      const mod = await import("../../src/providers/crosswalk-overrides.js");
      expect(() => mod.parseCrosswalkOverrides("x: 1\n")).toThrow(
        expect.objectContaining({ code: "yaml", message: "crosswalk overrides: yaml (PARSE)" }),
      );
    } finally {
      vi.doUnmock("yaml");
      vi.resetModules();
    }
  });

  it("maps an fs error without a code to a generic io error", async () => {
    vi.resetModules();
    vi.doMock("node:fs", async (orig) => ({
      ...(await orig<typeof import("node:fs")>()),
      openSync: () => {
        throw new Error("weird /secret/path");
      },
    }));
    try {
      const mod = await import("../../src/providers/crosswalk-overrides.js");
      try {
        mod.loadCrosswalkOverrides(join(dir, "any.yaml"));
        expect.unreachable();
      } catch (err) {
        expect((err as Error).message).toBe("crosswalk overrides: io (read failed)");
      }
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });
});
