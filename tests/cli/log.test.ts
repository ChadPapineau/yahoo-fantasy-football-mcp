// log.test.ts — src/cli/log.ts (plan 01 §2 stdout discipline, §7 redaction; plan 05 §2 `cli/log`:
// "for any object containing the current token/secret values, or strings matching the token/
// secret/code=/state=/guid/email patterns, the emitted line does not contain them; query strings
// stripped; bodies truncated; never writes to stdout (fd 1 is a closed pipe and nothing throws)").
// A 100 %-coverage module (plan 05 §7).
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_STRING,
  HARD_MAX_STRING,
  MIN_SECRET_LENGTH,
  PRECUT_SLACK,
  REDACTION_PATTERNS,
  SecretRegistry,
  createLogger,
  redactAndTruncate,
  redactString,
  redactValue,
  truncate,
  type Logger,
} from "../../src/cli/log.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const TS = "2026-09-30T18:00:00.000Z";

// Fake secret-shaped values, assembled at runtime so no literal of a real shape sits in the repo.
const J = (...p: string[]) => p.join("");
/** A PEM armour line, assembled at runtime (e.g. PEM("BEGIN RSA")). */
const PEM = (what: string) => J("-----", what, " PRIVATE", " KEY-----");
const FAKE = {
  access: J("AT", "x".repeat(30), "9"),
  refresh: J("RT", "y".repeat(30), "8"),
  clientSecret: J("cs", "z".repeat(20), "/+="),
  jwt: J("eyJ", "a".repeat(16), ".eyJ", "b".repeat(16), ".", "c".repeat(16)),
  github: J("gh", "p_", "A".repeat(36)),
  githubPat: J("github", "_pat_", "B".repeat(55)),
  anthropic: J("sk-", "ant-", "C".repeat(30)),
  openai: J("sk-", "D".repeat(40)),
  aws: J("AK", "IA", "E".repeat(16)),
  slack: J("xo", "xb-", "1".repeat(12)),
  google: J("AI", "za", "F".repeat(35)),
  yahooId: J("dj0y", "Jmk9", "G".repeat(30)),
  email: J("someone", "@", "example", ".org"),
  guid: "H".repeat(26),
};

function capture(level: "error" | "warn" | "info" | "debug" = "debug"): {
  log: Logger;
  lines: () => Record<string, unknown>[];
  raw: string[];
} {
  const raw: string[] = [];
  const log = createLogger({ level, sink: (l) => raw.push(l), now: () => TS });
  return { log, raw, lines: () => raw.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("line format and levels", () => {
  it("writes one JSON object per line with ts, level, event, then fields", () => {
    const { log, raw, lines } = capture();
    log.info("tool.done", {
      request_id: "r-0123456789ab",
      tool: "ff_get_roster",
      ms: 12,
      cache: "hit",
      msg: "line1\nline2",
    });
    expect(raw).toHaveLength(1);
    expect(raw[0]).not.toContain("\n");
    expect(lines()[0]).toEqual({
      ts: TS,
      level: "info",
      event: "tool.done",
      request_id: "r-0123456789ab",
      tool: "ff_get_roster",
      ms: 12,
      cache: "hit",
      msg: "line1\nline2",
    });
    expect(Object.keys(lines()[0] ?? {}).slice(0, 3)).toEqual(["ts", "level", "event"]);
  });

  it.each([
    ["error", ["error"]],
    ["warn", ["error", "warn"]],
    ["info", ["error", "warn", "info"]],
    ["debug", ["error", "warn", "info", "debug"]],
  ] as const)("level %s emits %j", (level, expected) => {
    const { log, lines } = capture(level);
    log.error("e");
    log.warn("w");
    log.info("i");
    log.debug("d");
    expect(lines().map((l) => l.level)).toEqual(expected);
    expect(log.level).toBe(level);
  });

  it("fields cannot overwrite ts/level/event; a bad event name is replaced", () => {
    const { log, lines } = capture();
    log.info("Bad Event!‮", { ts: "forged", level: "error", event: "forged", ok: 1 });
    expect(lines()[0]).toEqual({ ts: TS, level: "info", event: "invalid_event", ok: 1 });
  });

  it("defaults the timestamp to the wall clock", () => {
    const raw: string[] = [];
    createLogger({ level: "info", sink: (l) => raw.push(l) }).info("x");
    expect((JSON.parse(raw[0] ?? "{}") as { ts: string }).ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("child loggers bind fields and share the secret registry both ways", () => {
    const { log, lines } = capture();
    const child = log.child({ request_id: "r-aaaaaaaaaaaa", tool: "ff_get_status" });
    child.registerSecret("access_token", FAKE.access);
    log.info("parent", { v: FAKE.access });
    child.warn("child", { tool: "override", v: FAKE.access });
    const [p, c] = lines();
    expect(p).toEqual({ ts: TS, level: "info", event: "parent", v: "[redacted:access_token]" });
    expect(c).toEqual({
      ts: TS,
      level: "warn",
      event: "child",
      request_id: "r-aaaaaaaaaaaa",
      tool: "override",
      v: "[redacted:access_token]",
    });
    child.child({ extra: 1 }).error("grandchild");
    expect(lines()[2]).toMatchObject({ request_id: "r-aaaaaaaaaaaa", extra: 1 });
  });
});

describe("registered secrets (plan 01 §7: the logger is given their current values)", () => {
  it("redacts the value, its URL-encoded form, inside strings, keys, arrays and errors", () => {
    const { log, raw } = capture();
    log.registerSecret("client_secret", FAKE.clientSecret);
    log.registerSecret("refresh_token", FAKE.refresh);
    log.error("upstream", {
      body: `grant_type=refresh_token&client_secret=${encodeURIComponent(FAKE.clientSecret)}`,
      nested: { list: [`x${FAKE.refresh}y`, { deeper: FAKE.clientSecret }] },
      [FAKE.refresh]: "key-is-secret",
      err: new Error(`bad ${FAKE.refresh}`),
    });
    const line = raw.join("\n");
    expect(line).not.toContain(FAKE.clientSecret);
    expect(line).not.toContain(encodeURIComponent(FAKE.clientSecret));
    expect(line).not.toContain(FAKE.refresh);
    expect(line).toContain("[redacted:refresh_token]");
  });

  it("redacts the longer of two overlapping secrets fully", () => {
    const reg = new SecretRegistry();
    reg.add("short", "abcd1234");
    reg.add("long", "abcd1234efgh5678");
    expect(reg.apply("x abcd1234efgh5678 y abcd1234")).toBe("x [redacted:long] y [redacted:short]");
    expect(reg.size).toBe(2);
  });

  it("ignores empty and < 4-char values, de-duplicates, and sanitises the kind", () => {
    const reg = new SecretRegistry();
    reg.add("x", "");
    reg.add("x", "abc");
    expect(reg.size).toBe(0);
    reg.add("Bad Kind!", "valuevalue");
    reg.add("token", "valuevalue");
    expect(reg.size).toBe(1);
    expect(reg.apply("valuevalue")).toBe("[redacted:secret]");
    expect(MIN_SECRET_LENGTH).toBe(4);
  });

  it("property: any registered secret embedded anywhere in a field never appears in the line", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 8, maxLength: 64 }).filter((s) => s.trim().length >= 8),
        fc.string({ maxLength: 40 }),
        fc.string({ maxLength: 40 }),
        (secret, pre, post) => {
          const raw: string[] = [];
          const log = createLogger({
            level: "info",
            sink: (l) => raw.push(l),
            now: () => TS,
            maxStringChars: 10_000,
          });
          log.registerSecret("token", secret);
          log.info("x", { a: `${pre}${secret}${post}`, b: [secret], c: { d: secret } });
          const parsed = JSON.stringify(JSON.parse(raw[0] ?? "{}"));
          return !parsed.includes(secret) && !parsed.includes(JSON.stringify(secret).slice(1, -1));
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("pattern redaction (plan 01 §7; scan-secrets shapes)", () => {
  const reg = new SecretRegistry();
  const R = (s: string) => redactString(s, reg);

  it.each([
    ["jwt", `token ${FAKE.jwt} end`, FAKE.jwt],
    ["github", `x ${FAKE.github} y`, FAKE.github],
    ["github pat", `x ${FAKE.githubPat}`, FAKE.githubPat],
    ["anthropic", `key=${FAKE.anthropic}`, FAKE.anthropic],
    ["openai", `k ${FAKE.openai}`, FAKE.openai],
    ["aws", `id ${FAKE.aws} x`, FAKE.aws],
    ["slack", `t ${FAKE.slack}`, FAKE.slack],
    ["google", `g ${FAKE.google}`, FAKE.google],
    ["yahoo client id", `client_id ${FAKE.yahooId}`, FAKE.yahooId],
    ["email", `manager ${FAKE.email} wrote`, FAKE.email],
    ["private key", `${PEM("BEGIN RSA")}\nMIIEow\n${PEM("END RSA")}`, "MIIEow"],
    ["unterminated private key", `${PEM("BEGIN")}\nMIIEow...`, "MIIEow"],
  ])("%s", (_label, input, secret) => {
    expect(R(input)).not.toContain(secret);
  });

  it("Authorization headers (Bearer/Basic, header or JSON form)", () => {
    for (const s of [
      `Authorization: Bearer ${FAKE.access}`,
      `authorization=Basic ${FAKE.access}`,
      `{"Authorization":"Bearer ${FAKE.access}"}`,
      `'authorization': '${FAKE.access}'`,
      `curl -H "Bearer ${FAKE.access}"`,
    ]) {
      expect(R(s), s).not.toContain(FAKE.access);
    }
    expect(R(`Authorization: Bearer ${FAKE.access}`)).toBe(
      "Authorization: [redacted:authorization]",
    );
  });

  it("OAuth and query parameters", () => {
    for (const k of [
      "code",
      "state",
      "access_token",
      "refresh_token",
      "id_token",
      "client_secret",
      "password",
      "xoauth_yahoo_guid",
      "api_key",
    ]) {
      const s = `grant=x&${k}=${FAKE.access}&keep=1`;
      expect(R(s), k).toBe(`grant=x&${k}=[redacted]&keep=1`);
    }
  });

  it("JSON secret fields", () => {
    expect(R(`{"access_token": "${FAKE.access}", "expires_in": 3600}`)).toBe(
      '{"access_token": "[redacted]", "expires_in": 3600}',
    );
    expect(R(`{"xoauth_yahoo_guid":"${FAKE.guid}"}`)).toBe('{"xoauth_yahoo_guid":"[redacted]"}');
  });

  it("URLs keep scheme, host and path; lose userinfo, query and fragment", () => {
    expect(
      R(
        `GET https://fantasysports.yahooapis.com/fantasy/v2/league/461.l.1000/settings?access_token=${FAKE.access}#frag done`,
      ),
    ).toBe("GET https://fantasysports.yahooapis.com/fantasy/v2/league/461.l.1000/settings done");
    expect(R(`https://user:${FAKE.access}@example.com/p?q=1`)).toBe("https://example.com/p");
    expect(R("see http://example.com/ok")).toBe("see http://example.com/ok");
  });

  it("leaves ordinary text alone", () => {
    const s = "Refreshed nflverse:injuries in 812 ms (412 rows); state Valid; cache hit";
    expect(R(s)).toBe(s);
  });

  it("every pattern is global (a second occurrence is redacted too)", () => {
    for (const p of REDACTION_PATTERNS) expect(p.re.flags).toContain("g");
    expect(R(`${FAKE.jwt} and ${FAKE.jwt}`)).toBe("[redacted:token] and [redacted:token]");
  });
});

describe("object-key redaction and value shaping", () => {
  const reg = new SecretRegistry();
  it("redacts whole values under secret-named keys, at any depth, but not null/undefined", () => {
    const out = redactValue(
      {
        headers: { Authorization: "whatever", Cookie: "c", "X-Api-Key": "k" },
        password: "p",
        client_secret: "s",
        refresh_token: { nested: "t" },
        email: "a",
        guid: "g",
        private_key: "pk",
        token: null,
        api_key: undefined,
        state: "Valid",
        ok: "fine",
      },
      reg,
    );
    expect(out).toEqual({
      headers: { Authorization: "[redacted]", Cookie: "[redacted]", "X-Api-Key": "[redacted]" },
      password: "[redacted]",
      client_secret: "[redacted]",
      refresh_token: "[redacted]",
      email: "[redacted]",
      guid: "[redacted]",
      private_key: "[redacted]",
      token: null,
      api_key: null,
      state: "Valid",
      ok: "fine",
    });
  });

  it("truncates long strings to 500 with the dropped count, never splitting a surrogate pair", () => {
    expect(redactValue("x".repeat(600), reg)).toBe(`${"x".repeat(500)}…[truncated 100 chars]`);
    expect(truncate("short", 10)).toBe("short");
    const s = `${"a".repeat(499)}\u{1F600}tail`;
    const t = truncate(s, 500);
    expect(t.startsWith("a".repeat(499))).toBe(true);
    expect(t).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(t).toBe(`${"a".repeat(499)}…[truncated 6 chars]`);
    expect(DEFAULT_MAX_STRING).toBe(500);
  });

  it("drops a string beyond the hard maximum without scanning it", () => {
    const huge = "q".repeat(HARD_MAX_STRING + 1);
    expect(redactValue(huge, reg)).toBe(`[dropped ${String(huge.length)} chars]`);
  });

  it("makes every JSON-hostile value inert", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const out = redactValue(
      {
        n: NaN,
        inf: -Infinity,
        big: 12n,
        und: undefined,
        fn: () => 1,
        sym: Symbol("s"),
        date: new Date("2026-09-30T00:00:00Z"),
        bad: new Date("nope"),
        buf: Buffer.from("secret bytes"),
        ab: new ArrayBuffer(8),
        map: new Map([["k", "v"]]),
        set: new Set([1, 2]),
        circular,
      },
      reg,
    );
    expect(out).toEqual({
      n: "NaN",
      inf: "-Infinity",
      big: "12",
      und: null,
      fn: "[function]",
      sym: "[symbol]",
      date: "2026-09-30T00:00:00.000Z",
      bad: "[invalid date]",
      buf: "[binary 12 bytes]",
      ab: "[binary 8 bytes]",
      map: "[Map of 1]",
      set: "[Set of 2]",
      circular: { a: 1, self: "[circular]" },
    });
  });

  it("reduces Errors to name/message/code (no stack)", () => {
    const e = Object.assign(new Error("boom"), { code: "ENOENT" });
    expect(redactValue(e, reg)).toEqual({ name: "Error", message: "boom", code: "ENOENT" });
    expect(redactValue(Object.assign(new Error("x"), { code: 7 }), reg)).toEqual({
      name: "Error",
      message: "x",
      code: 7,
    });
    expect(redactValue(Object.assign(new Error("x"), { code: { o: 1 } }), reg)).toEqual({
      name: "Error",
      message: "x",
    });
  });

  it("bounds depth, array length and key count", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 12; i++) deep = { d: deep };
    expect(JSON.stringify(redactValue(deep, reg))).toContain("[depth limit]");
    const arr = redactValue(
      Array.from({ length: 60 }, (_, i) => i),
      reg,
    ) as unknown[];
    expect(arr).toHaveLength(51);
    expect(arr.at(-1)).toBe("[+10 more]");
    const wide = Object.fromEntries(Array.from({ length: 55 }, (_, i) => [`k${String(i)}`, i]));
    const w = redactValue(wide, reg) as Record<string, unknown>;
    expect(Object.keys(w)).toHaveLength(51);
    expect(w["[more_keys]"]).toBe(5);
  });

  it("caps key length and redacts keys", () => {
    const out = redactValue({ ["k".repeat(100)]: 1 }, reg) as Record<string, unknown>;
    expect(Object.keys(out)[0]?.startsWith("k".repeat(64))).toBe(true);
  });
});

describe("never breaks a caller", () => {
  it("a throwing sink drops the line silently", () => {
    const log = createLogger({
      level: "info",
      sink: () => {
        throw new Error("EPIPE");
      },
    });
    expect(() => {
      log.info("x", { a: 1 });
    }).not.toThrow();
  });
  it("a hostile getter in the fields drops the line silently", () => {
    const { log, raw } = capture();
    const hostile = {};
    Object.defineProperty(hostile, "boom", {
      enumerable: true,
      get() {
        throw new Error("getter");
      },
    });
    expect(() => {
      log.info("x", hostile);
    }).not.toThrow();
    expect(raw).toEqual([]);
  });
});

describe("stdout is the MCP transport: never written", () => {
  it("the default sink writes to stderr only", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, "write");
    const log = createLogger({ level: "debug" });
    log.error("a");
    log.debug("b", { v: 1 });
    expect(out).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledTimes(2);
    const first = String(err.mock.calls[0]?.[0]);
    expect(first.endsWith("\n")).toBe(true);
    expect(JSON.parse(first)).toMatchObject({ level: "error", event: "a" });
    expect(process.stderr.listenerCount("error")).toBeGreaterThan(0);
    // the guard swallows an async EPIPE instead of crashing the process
    expect(() =>
      process.stderr.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })),
    ).not.toThrow();
  });

  it("in a real process: stdout stays empty, and a closed stderr pipe does not crash it", async () => {
    const mod = pathToFileURL(path.join(ROOT, "src", "cli", "log.ts")).href;
    const script = `
      const { createLogger } = await import(${JSON.stringify(mod)});
      const log = createLogger({ level: "debug" });
      for (let i = 0; i < 2000; i++) log.info("tick", { i, pad: "x".repeat(200) });
      await new Promise((r) => setTimeout(r, 50));
      for (let i = 0; i < 2000; i++) log.info("tock", { i });
    `;
    const run = (closeStderr: boolean) =>
      new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
        stdout: string;
        stderr: string;
      }>((resolve) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
        if (closeStderr) child.stderr.destroy();
        else child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
        child.on("close", (code, signal) => {
          resolve({ code, signal, stdout, stderr });
        });
      });
    const open = await run(false);
    expect(open.code).toBe(0);
    expect(open.stdout).toBe("");
    const jsonLines = open.stderr.split("\n").filter((l) => l.startsWith("{"));
    expect(jsonLines.length).toBe(4000);
    const closed = await run(true);
    expect(closed.signal).toBeNull();
    expect(closed.code).toBe(0);
    expect(closed.stdout).toBe("");
  }, 30_000);
});

describe("linear-time redaction (critic C-11b: the email pattern was quadratic)", () => {
  const time = (f: () => unknown) => {
    const t = performance.now();
    f();
    return performance.now() - t;
  };
  const reg = () => new SecretRegistry();

  it("1 MB of 'a' and address-like runs log fast (were 4.1 s at 60 000 chars)", () => {
    const lines: string[] = [];
    const log = createLogger({ level: "debug", sink: (l) => lines.push(l), now: () => TS });
    const inputs = [
      "a".repeat(1_000_000),
      `a@${"b.".repeat(300_000)}`,
      "a.".repeat(500_000),
      `${"x".repeat(100_000)}@${"y-".repeat(100_000)}`,
      "code=".repeat(200_000),
      "https://".repeat(100_000),
    ];
    for (const v of inputs) {
      expect(
        time(() => {
          log.info("big", { v });
        }),
      ).toBeLessThan(250);
    }
    expect(lines).toHaveLength(inputs.length);
  });
  it("the email pattern itself is bounded: 60 000 address-like chars redact in well under 250 ms", () => {
    const s = `${"a".repeat(30_000)}@${"b".repeat(30_000)}`;
    expect(time(() => redactString(s, reg()))).toBeLessThan(250);
    expect(time(() => redactString("a@b.".repeat(15_000), reg()))).toBeLessThan(250);
  });
  it("still redacts ordinary emails, including ones next to punctuation", () => {
    const e = FAKE.email;
    for (const s of [`<${e}>`, `(${e})`, `mailto:${e}`, `x ${e}, y`, `"${e}"`]) {
      expect(redactString(s, reg())).not.toContain(e);
      expect(redactString(s, reg())).toContain("[redacted:email]");
    }
  });
  it("pre-cut cannot let a registered secret survive in the kept prefix", () => {
    const r = reg();
    const secret = J("SEC", "q".repeat(40), "RET");
    r.add("client_secret", secret);
    const max = 100;
    // the secret straddles the cap at every offset around it
    for (let at = max - secret.length - 2; at <= max + 2; at++) {
      const s = `${"a".repeat(Math.max(0, at))}${secret}${"z".repeat(PRECUT_SLACK * 3)}`;
      const out = redactAndTruncate(s, r, max);
      expect(out).not.toContain(secret.slice(0, 12));
      expect(out).toMatch(/…\[truncated \d+ chars\]$/);
    }
  });
  it("a long value is cut to the cap with the ORIGINAL length reported (surrogates never split)", () => {
    const s = `${"x".repeat(DEFAULT_MAX_STRING - 1)}😀${"y".repeat(20_000)}`;
    const out = redactAndTruncate(s, reg(), DEFAULT_MAX_STRING);
    expect(out.startsWith("x".repeat(DEFAULT_MAX_STRING - 1))).toBe(true);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    const n = Number(/truncated (\d+) chars/.exec(out)?.[1]);
    expect(n).toBe(s.length - (DEFAULT_MAX_STRING - 1));
    // a short value is untouched
    expect(redactAndTruncate("hello", reg(), DEFAULT_MAX_STRING)).toBe("hello");
  });
  it("a redaction that shrinks the pre-cut prefix below the cap still reports truncation", () => {
    const tokenish = `Bearer ${"t".repeat(PRECUT_SLACK * 2)}`;
    const out = redactAndTruncate(tokenish, reg(), DEFAULT_MAX_STRING);
    expect(out).toContain("[redacted:token]");
    expect(out).toMatch(/truncated \d+ chars\]$/);
    expect(out).not.toContain("tttttttttt");
  });
  it("a registered identifier (e.g. the manual league's team name) is redacted (critic C-23b)", () => {
    const lines: string[] = [];
    const log = createLogger({ level: "debug", sink: (l) => lines.push(l), now: () => TS });
    log.registerSecret("identifier", "Team A Placeholder Name");
    log.info("tool.call", {
      args: { team: "Team A Placeholder Name" },
      note: "for Team A Placeholder Name",
    });
    expect(lines[0]).not.toContain("Team A Placeholder Name");
    expect(lines[0]).toContain("[redacted:identifier]");
  });
});

describe("the pre-cut when redaction shrinks the text before the cut (QA-2-031)", () => {
  // a 32-char registered value with no recognisable shape, and a token shape nothing registers
  const SECRET = J("Sx7Qp2Lm9Vt4", "Rb8Nc3Kd6Wf1Yh5Zj0Ga");
  const TOKEN = J("gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
  const NOTE = /…\[truncated \d+ chars\]$/;

  /** `secret` placed so that the pre-cut at `keep` falls `kept` chars into it, after a long query. */
  const line = (secret: string, keep: number, kept: number): string => {
    const head = "fetch failed for https://h.example/p?";
    const tail = " key ";
    return `${head}${"q".repeat(keep - kept - head.length - tail.length)}${tail}${secret} end`;
  };

  it("a registered secret cut by the pre-cut is not pulled into the kept prefix", () => {
    const r = new SecretRegistry();
    r.add("api_key", SECRET);
    const keep = DEFAULT_MAX_STRING + r.longest + PRECUT_SLACK;
    for (const kept of [1, 8, 16, 31]) {
      const out = redactAndTruncate(line(SECRET, keep, kept), r, DEFAULT_MAX_STRING);
      expect(out).not.toContain(SECRET.slice(0, Math.min(kept, 6)));
      expect(out).toMatch(NOTE);
    }
  });

  it("a token shape cut by the pre-cut, nothing registered, is not pulled into the kept prefix", () => {
    const keep = DEFAULT_MAX_STRING + PRECUT_SLACK;
    for (const kept of [4, 20, 39]) {
      const out = redactAndTruncate(
        line(TOKEN, keep, kept),
        new SecretRegistry(),
        DEFAULT_MAX_STRING,
      );
      expect(out).not.toContain(TOKEN.slice(0, kept));
    }
  });

  it("through the logger, the line keeps no fragment of the registered secret", () => {
    const { log, raw } = capture("info");
    log.registerSecret("api_key", SECRET);
    log.warn("http.error", {
      detail: line(SECRET, DEFAULT_MAX_STRING + SECRET.length + PRECUT_SLACK, 31),
    });
    expect(raw[0]).not.toContain(SECRET.slice(0, 6));
  });

  it("a JSON secret value longer than the pre-cut slack is redacted, not cut and kept", () => {
    const value = "v".repeat(PRECUT_SLACK * 3);
    for (const k of ["password", "access_token", "client_secret"]) {
      const out = redactAndTruncate(`{"${k}":"${value}"}`, new SecretRegistry(), 100);
      expect(out).not.toContain("vvvvvv");
    }
  });

  // what shrinks: a dropped query string, a replaced JSON / parameter / Authorization value
  const SHRINKERS: Readonly<Record<string, (n: number) => string>> = {
    url: (n) => `fetch failed for https://h.example/p?${"q".repeat(n)} `,
    json: (n) => `{"password":"${"p".repeat(n)}"} `,
    param: (n) => `token=${"t".repeat(n)} `,
    auth: (n) => `Authorization: Bearer ${"b".repeat(n)} `,
    none: () => "",
  };
  const SECRETS: Readonly<Record<string, { value: string; registered: boolean }>> = {
    registered: { value: SECRET, registered: true },
    spaced: { value: "Quokka Zebra Placeholder Name", registered: true },
    token: { value: TOKEN, registered: false },
  };

  it("property: any shrink before the cut, any cut inside the secret — the kept text is a prefix of the full redaction", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...Object.keys(SHRINKERS)),
        fc.integer({ min: 0, max: 9000 }),
        fc.constantFrom(...Object.keys(SECRETS)),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 20, max: 700 }),
        (shrinker, n, which, at, max) => {
          const sec = SECRETS[which] as { value: string; registered: boolean };
          const r = new SecretRegistry();
          if (sec.registered) r.add("identifier", sec.value);
          const keep = max + r.longest + PRECUT_SLACK;
          const kept = 1 + Math.floor(at * (sec.value.length - 1));
          const sep = " key ";
          const room = keep - kept - sep.length;
          const head = (SHRINKERS[shrinker] as (n: number) => string)(n).slice(0, room);
          const s = `${head}${"w ".repeat(room)}`.slice(0, room) + sep + sec.value + " end";
          expect(s.indexOf(sec.value)).toBe(keep - kept);
          const out = redactAndTruncate(s, r, max);
          const body = out.replace(NOTE, "");
          expect(redactString(s, r).startsWith(body)).toBe(true);
          for (let i = 0; i + 6 <= sec.value.length; i++)
            expect(body).not.toContain(sec.value.slice(i, i + 6));
        },
      ),
      { numRuns: 400 },
    );
  });
});
