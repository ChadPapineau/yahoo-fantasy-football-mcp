// schema.test.ts — src/config/schema.ts (plan 03 §3 precedence env > config.json > defaults; plan
// 02 §3.3 locations; plan 02 §3.4 writes off). Adversarial: invalid enums, secrets in config.json,
// secret-looking values in the wrong key never echoed, relative/in-repo/synced paths, oversize
// values, unknown keys, and that no secret is ever enumerable or serialised.
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONFIG_KEYS,
  CONFIG_KEY_SPECS,
  ConfigError,
  GSIS_ID_RE,
  KEY_MAX_CHARS,
  MANUAL_KEY_RE,
  NFL_TEAMS,
  isNflTeam,
  YAHOO_KEY_RE,
  configFileSchema,
  isLeagueKey,
  loadConfig,
  UNKNOWN_FILE_KEYS_WARNING,
  loadConfigFromProcess,
  readConfigFile,
  secretValues,
  type Config,
  type ConfigInput,
} from "../../src/config/schema.js";
import { ROOT, tempDir } from "./helpers.js";

let tmp: { dir: string; cleanup: () => void };
let home: string;
beforeEach(() => {
  tmp = tempDir();
  home = tmp.dir;
});
afterEach(() => {
  tmp.cleanup();
});

const input = (env: Record<string, string | undefined> = {}, file?: unknown): ConfigInput => ({
  env,
  file,
  home,
  repoRoot: ROOT,
});

function issuesOf(fn: () => unknown): { key: string; reason: string }[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) {
      expect(e.exitCode).toBe(2);
      // INTERNAL, never VALIDATION: a config problem is not the model's arguments (critic C-13).
      expect(e.ffCode).toBe("INTERNAL");
      return [...e.issues];
    }
    throw e;
  }
  return [];
}

// A fake secret-shaped value, built at runtime so no literal of a real shape sits in the repo.
const FAKE_SECRET = ["sk", "ant", "Q".repeat(24)].join("-");

describe("defaults (no env, no file)", () => {
  it("resolves the XDG layout, core toolset, info, open-meteo, writes off", () => {
    const c = loadConfig(input());
    expect(c.configDir).toBe(path.join(home, ".config", "fantasy-football-mcp"));
    expect(c.cacheDir).toBe(path.join(home, ".cache", "fantasy-football-mcp"));
    expect(c.leagueFile).toBe(path.join(c.configDir, "league.yaml"));
    expect(c.logLevel).toBe("info");
    expect(c.toolset).toBe("core");
    expect(c.weatherSource).toBe("open-meteo");
    expect(c.fixtureDir).toBeNull();
    expect(c.leagueKeys).toEqual([]);
    expect(c.writeEnabled).toBe(false);
    expect(c.writeRequested).toBe(false);
    expect(c.yahoo).toEqual({ clientId: null, clientSecretFile: null, authPort: null });
    expect(c.warnings).toEqual([]);
    expect(c.origins.FF_TOOLSET).toBe("default");
    expect(c.origins.FF_CONFIG_DIR).toBe("default");
    expect(secretValues(c)).toEqual([]);
    expect(Object.isFrozen(c)).toBe(true);
  });
});

describe("precedence: env > config.json > default", () => {
  it("takes file values over defaults and env over file, recording origins", () => {
    const file = { FF_TOOLSET: "full", FF_LOG_LEVEL: "debug", FF_WEATHER_SOURCE: "nws" };
    const c = loadConfig(input({ FF_LOG_LEVEL: "warn" }, file));
    expect(c.toolset).toBe("full");
    expect(c.origins.FF_TOOLSET).toBe("file");
    expect(c.logLevel).toBe("warn");
    expect(c.origins.FF_LOG_LEVEL).toBe("env");
    expect(c.weatherSource).toBe("nws");
  });
  it("treats empty/whitespace env values as unset and trims values", () => {
    const c = loadConfig(
      input({ FF_TOOLSET: "   ", FF_LOG_LEVEL: " debug " }, { FF_TOOLSET: " full " }),
    );
    expect(c.toolset).toBe("full");
    expect(c.logLevel).toBe("debug");
  });
  it("an empty file value falls through to the default", () => {
    expect(loadConfig(input({}, { FF_TOOLSET: "" })).toolset).toBe("core");
  });
  it("FF_CONFIG_DIR is env-only (config.json lives inside it): the file value warns and is ignored", () => {
    const c = loadConfig(input({}, { FF_CONFIG_DIR: "/elsewhere" }));
    expect(c.configDir).toBe(path.join(home, ".config", "fantasy-football-mcp"));
    expect(c.warnings).toEqual(["FF_CONFIG_DIR is env-only; its config.json value is ignored"]);
  });
});

describe("enums", () => {
  it.each([
    ["FF_TOOLSET", "Full"],
    ["FF_TOOLSET", "core,full"],
    ["FF_LOG_LEVEL", "trace"],
    ["FF_LOG_LEVEL", "INFO"],
    ["FF_WEATHER_SOURCE", "openmeteo"],
    ["FF_WEATHER_SOURCE", "open-meteo​"],
  ])("%s=%j is rejected with the allowed values named", (key, value) => {
    const issues = issuesOf(() => loadConfig(input({ [key]: value })));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.key).toBe(key);
    expect(issues[0]?.reason).toMatch(/^must be one of: /);
  });
  it("accepts weather off", () => {
    expect(loadConfig(input({ FF_WEATHER_SOURCE: "off" })).weatherSource).toBe("off");
  });
  it("never echoes the offending value (it may be a secret pasted into the wrong key)", () => {
    try {
      loadConfig(
        input({
          FF_TOOLSET: FAKE_SECRET,
          FF_LEAGUE_KEYS: FAKE_SECRET,
          YAHOO_CLIENT_ID: `${FAKE_SECRET}!`,
        }),
      );
      expect.unreachable();
    } catch (e) {
      const err = e as ConfigError;
      expect(err.issues.length).toBe(3);
      expect(err.message).not.toContain(FAKE_SECRET);
      expect(JSON.stringify(err.issues)).not.toContain(FAKE_SECRET);
    }
  });
});

describe("locations (plan 02 §3.3)", () => {
  it("refuses a relative FF_CONFIG_DIR / FF_CACHE_DIR", () => {
    const issues = issuesOf(() =>
      loadConfig(input({ FF_CONFIG_DIR: "conf", FF_CACHE_DIR: "./cache" })),
    );
    expect(issues.map((i) => i.key).sort()).toEqual(["FF_CACHE_DIR", "FF_CONFIG_DIR"]);
    for (const i of issues) expect(i.reason).toMatch(/absolute/);
  });
  it("refuses config/cache/league paths inside the repo checkout, without echoing the path", () => {
    const issues = issuesOf(() =>
      loadConfig(
        input({
          FF_CONFIG_DIR: path.join(ROOT, "conf"),
          FF_CACHE_DIR: ROOT,
          FF_LEAGUE_FILE: path.join(ROOT, "league.yaml"),
        }),
      ),
    );
    expect(issues.map((i) => i.key).sort()).toEqual([
      "FF_CACHE_DIR",
      "FF_CONFIG_DIR",
      "FF_LEAGUE_FILE",
    ]);
    for (const i of issues) {
      expect(i.reason).toMatch(/inside the repository/);
      expect(i.reason).not.toContain(ROOT);
    }
  });
  it("refuses cloud-synced folders (Documents, Desktop, iCloud Drive)", () => {
    const issues = issuesOf(() =>
      loadConfig(
        input({
          FF_CONFIG_DIR: path.join(home, "Documents", "ff"),
          FF_CACHE_DIR: path.join(home, "Library", "Mobile Documents", "ff"),
          FF_LEAGUE_FILE: path.join(home, "Desktop", "league.yaml"),
        }),
      ),
    );
    expect(issues.map((i) => i.key).sort()).toEqual([
      "FF_CACHE_DIR",
      "FF_CONFIG_DIR",
      "FF_LEAGUE_FILE",
    ]);
    for (const i of issues) expect(i.reason).toMatch(/cloud-synced/);
  });
  it("allows a league file inside FF_FIXTURE_DIR even when that is in the repo (fixture mode)", () => {
    const fixtures = path.join(ROOT, "fixtures");
    const c = loadConfig(
      input({
        FF_FIXTURE_DIR: fixtures,
        FF_LEAGUE_FILE: path.join(fixtures, "manual", "league.yaml"),
      }),
    );
    expect(c.fixtureDir).toBe(fixtures);
    expect(c.leagueFile).toBe(path.join(fixtures, "manual", "league.yaml"));
  });
  it("still refuses an in-repo league file outside the fixture dir in fixture mode", () => {
    const issues = issuesOf(() =>
      loadConfig(
        input({
          FF_FIXTURE_DIR: path.join(ROOT, "fixtures"),
          FF_LEAGUE_FILE: path.join(ROOT, "src", "league.yaml"),
        }),
      ),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.key).toBe("FF_LEAGUE_FILE");
    expect(issues[0]?.reason).toMatch(/inside the repository/);
  });
  it("expands ~ in path keys and rejects relative ones", () => {
    const c = loadConfig(input({ FF_LEAGUE_FILE: "~/private/league.yaml" }));
    expect(c.leagueFile).toBe(path.join(home, "private", "league.yaml"));
    expect(issuesOf(() => loadConfig(input({ FF_FIXTURE_DIR: "fixtures" })))[0]?.key).toBe(
      "FF_FIXTURE_DIR",
    );
  });
});

describe("FF_LEAGUE_KEYS", () => {
  it("parses, trims and de-duplicates Yahoo and manual keys", () => {
    const c = loadConfig(input({ FF_LEAGUE_KEYS: " 461.l.1000 ,manual.l.example,461.l.1000,," }));
    expect(c.leagueKeys).toEqual(["461.l.1000", "manual.l.example"]);
  });
  it.each(["461.L.1000", "461.l.1000;drop", "461.l.1000.t.1", "manual.l.Example", "../etc"])(
    "rejects %j",
    (bad) => {
      expect(issuesOf(() => loadConfig(input({ FF_LEAGUE_KEYS: bad })))[0]?.key).toBe(
        "FF_LEAGUE_KEYS",
      );
    },
  );
  it("caps the list at 20", () => {
    const many = Array.from(
      { length: 21 },
      (_, i) => `461.l.1000${String(i % 10)}${String(i)}`,
    ).join(",");
    expect(issuesOf(() => loadConfig(input({ FF_LEAGUE_KEYS: many })))[0]?.reason).toMatch(
      /at most 20/,
    );
  });
});

describe("FF_WRITE_ENABLED (plan 02 §3.4: unsupported; always off in this build)", () => {
  it.each(["1", "true"])("=%s is ignored with a warning; writeEnabled stays false", (v) => {
    const c = loadConfig(input({ FF_WRITE_ENABLED: v }));
    expect(c.writeEnabled).toBe(false);
    expect(c.writeRequested).toBe(true);
    expect(c.warnings.join("\n")).toMatch(/FF_WRITE_ENABLED=1 is ignored/);
  });
  it.each(["0", "false"])("=%s is quietly off", (v) => {
    const c = loadConfig(input({ FF_WRITE_ENABLED: v }));
    expect(c.writeRequested).toBe(false);
    expect(c.warnings).toEqual([]);
  });
  it.each(["yes", "TRUE", "2", "on"])("=%s is a config error (no guessing)", (v) => {
    expect(issuesOf(() => loadConfig(input({ FF_WRITE_ENABLED: v })))[0]?.key).toBe(
      "FF_WRITE_ENABLED",
    );
  });
});

describe("Phase 1b keys (accepted, validated, unused)", () => {
  it("accepts a client id, a secret file path and a port, with a warning", () => {
    const c = loadConfig(
      input({
        YAHOO_CLIENT_ID: "placeholder-client-id",
        YAHOO_CLIENT_SECRET_FILE: "~/.config/ff/client_secret",
        FF_AUTH_PORT: "8443",
      }),
    );
    expect(c.yahoo.clientId).toBe("placeholder-client-id");
    expect(c.yahoo.clientSecretFile).toBe(path.join(home, ".config", "ff", "client_secret"));
    expect(c.yahoo.authPort).toBe(8443);
    expect(c.warnings.join("\n")).toMatch(/Phase 1b/);
  });
  it.each(["80", "1023", "65536", "8443.5", "-1", "abc", "１２３４"])(
    "rejects FF_AUTH_PORT=%j",
    (p) => {
      expect(issuesOf(() => loadConfig(input({ FF_AUTH_PORT: p })))[0]?.key).toBe("FF_AUTH_PORT");
    },
  );
  it("rejects a client id with spaces or quotes", () => {
    expect(issuesOf(() => loadConfig(input({ YAHOO_CLIENT_ID: "a b" })))[0]?.key).toBe(
      "YAHOO_CLIENT_ID",
    );
  });
});

describe("secrets", () => {
  it("are read from env only, held non-enumerable, never serialised", () => {
    const c = loadConfig(
      input({ YAHOO_CLIENT_SECRET: FAKE_SECRET, ODDS_API_KEY: `${FAKE_SECRET}-odds` }),
    );
    expect(c.secrets.yahooClientSecret).toBe(FAKE_SECRET);
    expect(Object.keys(c)).not.toContain("secrets");
    expect(JSON.stringify(c)).not.toContain(FAKE_SECRET);
    expect(JSON.stringify({ ...c })).not.toContain(FAKE_SECRET);
    expect(c.origins.YAHOO_CLIENT_SECRET).toBe("env");
    expect(secretValues(c)).toEqual([
      { kind: "client_secret", value: FAKE_SECRET },
      { kind: "api_key", value: `${FAKE_SECRET}-odds` },
    ]);
  });
  it("cannot be reassigned", () => {
    const c: Config = loadConfig(input({ ODDS_API_KEY: FAKE_SECRET }));
    expect(() => {
      (c as { secrets: unknown }).secrets = null;
    }).toThrow(TypeError);
  });
  it.each([
    { YAHOO_CLIENT_SECRET: "x" },
    { ODDS_API_KEY: "x" },
    { client_secret: "x" },
    { my_token: "x" },
    { PASSWORD: "x" },
    { "api-key": "x" },
  ])("config.json containing %j is rejected", (file) => {
    const issues = issuesOf(() => loadConfig(input({}, file)));
    expect(issues.some((i) => i.reason.includes("secrets are not allowed"))).toBe(true);
    expect(JSON.stringify(issues)).not.toContain('"x"');
  });
  it("rejects an over-long secret", () => {
    expect(issuesOf(() => loadConfig(input({ ODDS_API_KEY: "k".repeat(5000) })))[0]).toEqual({
      key: "ODDS_API_KEY",
      reason: "value is too long",
    });
  });
});

describe("config.json shape", () => {
  it.each([[[]], ["string"], [42], [null]])("rejects a non-object %j", (file) => {
    expect(issuesOf(() => loadConfig(input({}, file)))).toEqual([
      { key: "config.json", reason: "must be a JSON object of string values" },
    ]);
  });
  it("rejects non-string values; an unknown key alone never fails (plan 03 §7: additive)", () => {
    const issues = issuesOf(() => loadConfig(input({}, { FF_TOOLSETT: "full", FF_TOOLSET: 1 })));
    expect(issues).toEqual([
      { key: "FF_TOOLSET", reason: "value must be a string of at most 4096 characters" },
    ]);
  });
  it("an unknown config.json key (a newer version's, or after a rollback) warns and still loads", () => {
    const hostile = "FF_FUTURE_KEY\u202e<script>";
    const c = loadConfig(
      input({}, { FF_FUTURE_KEY: "x", [hostile]: { nested: true }, FF_TOOLSET: "full" }),
    );
    expect(c.toolset).toBe("full");
    expect(c.warnings).toEqual([UNKNOWN_FILE_KEYS_WARNING]);
    expect(c.warnings.join("")).not.toContain("FUTURE");
    // two unknown keys still produce ONE warning, and the value is never echoed
    expect(JSON.stringify(c)).not.toContain("nested");
  });
  it("a secret-looking key is still a hard error even alongside unknown keys", () => {
    const issues = issuesOf(() =>
      loadConfig(input({}, { zzz: "1", my_token: "x", your_secret: "y" })),
    );
    expect(issues).toEqual([
      {
        key: "config.json",
        reason: "secrets are not allowed in config.json (use the environment or a _FILE path)",
      },
    ]);
  });
  it("rejects over-long file values", () => {
    expect(issuesOf(() => loadConfig(input({}, { FF_TOOLSET: "f".repeat(5000) })))[0]?.key).toBe(
      "FF_TOOLSET",
    );
  });
  it("configFileSchema admits exactly the file-settable keys", () => {
    const fileKeys = CONFIG_KEY_SPECS.filter((s) => s.fileSettable)
      .map((s) => s.key)
      .sort();
    expect(Object.keys(configFileSchema.shape).sort()).toEqual(fileKeys);
    expect(fileKeys).not.toContain("YAHOO_CLIENT_SECRET");
    expect(fileKeys).not.toContain("ODDS_API_KEY");
    expect(fileKeys).not.toContain("FF_CONFIG_DIR");
  });
});

describe("env hygiene", () => {
  it("warns about unknown FF_ variables (typos) but not FF_SCAN_*", () => {
    const c = loadConfig(input({ FF_TOOLSETS: "full", FF_SCAN_DENYLIST: "/x", HOME: "/h" }));
    expect(c.warnings).toEqual(["unknown environment variable FF_TOOLSETS (typo?) is ignored"]);
  });
  it("rejects an env value over 4096 chars", () => {
    expect(issuesOf(() => loadConfig(input({ FF_TOOLSET: "c".repeat(5000) })))[0]).toEqual({
      key: "FF_TOOLSET",
      reason: "value is too long",
    });
  });
  it("collects every issue, not just the first", () => {
    const issues = issuesOf(() =>
      loadConfig(input({ FF_TOOLSET: "x", FF_LOG_LEVEL: "y", FF_CONFIG_DIR: "z" })),
    );
    expect(issues.length).toBe(3);
  });
});

describe("key documentation table (plan 04 §1: README + .env.example are generated from it)", () => {
  it("documents every key exactly once, in CONFIG_KEYS order", () => {
    expect(CONFIG_KEY_SPECS.map((s) => s.key)).toEqual([...CONFIG_KEYS]);
    for (const s of CONFIG_KEY_SPECS) {
      expect(s.description.length).toBeGreaterThan(10);
      if (s.secret) expect(s.fileSettable).toBe(false);
    }
  });
  it(".env.example lists every key and nothing else, with no value on any secret key", () => {
    const text = readFileSync(path.join(ROOT, ".env.example"), "utf8");
    const keys = [...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]);
    expect([...new Set(keys)].sort()).toEqual([...CONFIG_KEYS].sort());
    for (const s of CONFIG_KEY_SPECS.filter((k) => k.secret)) {
      const line = text.split("\n").find((l) => new RegExp(`^#?\\s*${s.key}=`).test(l));
      expect(line?.replace(/^#?\s*[A-Z0-9_]+=/, "")).toBe("");
    }
  });
});

describe("key grammar (plan 02 §5; manual X1 grammar)", () => {
  it("isLeagueKey accepts both grammars and nothing else", () => {
    expect(isLeagueKey("461.l.1000")).toBe(true);
    expect(isLeagueKey("manual.l.example-league")).toBe(true);
    expect(isLeagueKey("manual.l.-bad")).toBe(false);
    expect(isLeagueKey("manual.l.bad-")).toBe(false);
    expect(isLeagueKey("")).toBe(false);
    expect(YAHOO_KEY_RE.league.test("461.l.1000\n")).toBe(false);
    expect(MANUAL_KEY_RE.team.test("manual.l.example.t.12")).toBe(true);
  });
});

describe("readConfigFile / loadConfigFromProcess", () => {
  const confDir = () => {
    const d = path.join(home, ".config", "fantasy-football-mcp");
    mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
  };
  it("returns undefined when config.json is absent", () => {
    expect(readConfigFile(confDir())).toBeUndefined();
  });
  it("parses config.json and feeds it into loadConfig", () => {
    writeFileSync(path.join(confDir(), "config.json"), JSON.stringify({ FF_TOOLSET: "full" }));
    const c = loadConfigFromProcess({ env: {}, home, repoRoot: ROOT });
    expect(c.toolset).toBe("full");
  });
  it("reports malformed JSON without echoing it", () => {
    writeFileSync(path.join(confDir(), "config.json"), `{"FF_TOOLSET": "${FAKE_SECRET}"`);
    const issues = issuesOf(() => loadConfigFromProcess({ env: {}, home, repoRoot: ROOT }));
    expect(issues).toEqual([{ key: "config.json", reason: "is not valid JSON" }]);
  });
  it("refuses a symlinked config.json", () => {
    const d = confDir();
    const elsewhere = path.join(home, "other.json");
    writeFileSync(elsewhere, "{}");
    symlinkSync(elsewhere, path.join(d, "config.json"));
    const issues = issuesOf(() => loadConfigFromProcess({ env: {}, home, repoRoot: ROOT }));
    expect(issues[0]?.reason).toMatch(/symbolic link/);
  });
  it("reads a world-readable config.json (it holds no secrets — plan 03 §3)", () => {
    const f = path.join(confDir(), "config.json");
    writeFileSync(f, "{}");
    chmodSync(f, 0o644);
    expect(loadConfigFromProcess({ env: {}, home, repoRoot: ROOT }).toolset).toBe("core");
  });
  it("turns an unusable FF_CONFIG_DIR into a ConfigError", () => {
    const issues = issuesOf(() =>
      loadConfigFromProcess({ env: { FF_CONFIG_DIR: "relative" }, home, repoRoot: ROOT }),
    );
    expect(issues[0]?.key).toBe("config.json");
    expect(issues[0]?.reason).toMatch(/absolute/);
  });
  it("surfaces an unexpected I/O failure as a value-free ConfigError", () => {
    const d = confDir();
    mkdirSync(path.join(d, "config.json", "nested"), { recursive: true });
    const issues = issuesOf(() => loadConfigFromProcess({ env: {}, home, repoRoot: ROOT }));
    expect(issues[0]?.key).toBe("config.json");
  });
});

describe("nflverse ids and key lengths live in the leaf layer (critics C-19b, C-11)", () => {
  it("NFL_TEAMS has the 32 nflverse abbreviations (LA not LAR, WAS, JAX, LV)", () => {
    expect(NFL_TEAMS).toHaveLength(32);
    expect(new Set(NFL_TEAMS).size).toBe(32);
    for (const t of ["LA", "WAS", "JAX", "LV", "KC"]) expect(isNflTeam(t)).toBe(true);
    for (const t of ["LAR", "WSH", "JAC", "OAK", "kc", "", "KC ", "__proto__", "toString"])
      expect(isNflTeam(t)).toBe(false);
  });
  it("GSIS_ID_RE is anchored and exact", () => {
    expect(GSIS_ID_RE.test("00-0012345")).toBe(true);
    for (const bad of ["00-001234", "00-00123456", "01-0012345", "00-0012345\n", " 00-0012345"])
      expect(GSIS_ID_RE.test(bad)).toBe(false);
  });
  it("KEY_MAX_CHARS is exactly the longest string each manual grammar admits", () => {
    const slug32 = "a".repeat(32);
    expect(`manual.l.${slug32}`).toHaveLength(KEY_MAX_CHARS.league);
    expect(MANUAL_KEY_RE.league.test(`manual.l.${slug32}`)).toBe(true);
    expect(MANUAL_KEY_RE.league.test(`manual.l.${slug32}a`)).toBe(false);
    expect(`manual.l.${slug32}.t.999`).toHaveLength(KEY_MAX_CHARS.team);
    expect(MANUAL_KEY_RE.team.test(`manual.l.${slug32}.t.999`)).toBe(true);
    expect(`manual.p.${slug32}`).toHaveLength(KEY_MAX_CHARS.player);
    expect(MANUAL_KEY_RE.player.test(`manual.p.${slug32}`)).toBe(true);
    expect(MANUAL_KEY_RE.player.test(`manual.p.${slug32}a`)).toBe(false);
  });
});
