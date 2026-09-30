// schema.ts — every env/config key, its default and its precedence: env > <config>/config.json >
// defaults (plan 03 §3; plan 04 §1 "README table generated from it"). Also the platform key grammar
// (plan 02 §5) and the nflverse id grammar (gsis ids, team abbreviations — research 04 §D), kept
// here because config is the leaf layer every other layer may import (src/mcp/bounds.ts re-exports
// them; domain/sources/providers import them directly). Secrets never come from config.json and are
// never enumerable. config.json is additive: unknown keys warn, never fail (plan 03 §7).
import { z } from "zod/v4";
import {
  assertNotSynced,
  assertOutsideRepo,
  configFilePath,
  defaultLeagueFilePath,
  isInside,
  PathSecurityError,
  readSecureFile,
  resolveAbsolute,
  resolveCacheDir,
  resolveConfigDir,
  type Env,
} from "./paths.js";

// --- key grammar (plan 02 §5; digit widths are plan 02 A-8) ------------------------------------

/** Yahoo key grammar — kept for the FantasyPlatform seam although Phase 1b is deferred. */
export const YAHOO_KEY_RE = Object.freeze({
  game: /^(?:nfl|[0-9]{1,4})$/,
  league: /^[0-9]{1,4}\.l\.[0-9]{1,8}$/,
  team: /^[0-9]{1,4}\.l\.[0-9]{1,8}\.t\.[0-9]{1,3}$/,
  player: /^[0-9]{1,4}\.p\.[0-9]{1,8}$/,
  transaction: /^[0-9]{1,4}\.l\.[0-9]{1,8}\.(?:tr|pt)\.[0-9]{1,12}$/,
  waiver_claim: /^[0-9]{1,4}\.l\.[0-9]{1,8}\.w\.c\.[0-9_]{1,24}$/,
});

/**
 * ManualLeagueProvider key grammar (plan 01 §8 X1): `manual.l.<slug>` (lowercase letters, digits,
 * inner hyphens, ≤ 32), teams `<league>.t.<1-3 digits>`, players `manual.p.<id>` where the id is
 * ASCII letters/digits/`_`/`-` (a gsis id such as `00-0012345` is the recommended form).
 */
export const MANUAL_KEY_RE = Object.freeze({
  league: /^manual\.l\.[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/,
  team: /^manual\.l\.[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\.t\.[0-9]{1,3}$/,
  player: /^manual\.p\.[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/,
});

/** Whether `s` is a league key of any supported platform grammar (Yahoo or manual). */
export function isLeagueKey(s: string): boolean {
  return YAHOO_KEY_RE.league.test(s) || MANUAL_KEY_RE.league.test(s);
}

/**
 * The longest string each key grammar admits (derived from the regexes above, pinned by a property
 * test): manual league `manual.l.` + 32 = 41; manual team 41 + `.t.` + 3 = 47; manual player
 * `manual.p.` + 32 = 41. The zod `.max()` of every key schema uses these, so a valid key can never
 * fail on length before the grammar check (critic C-11).
 */
export const KEY_MAX_CHARS = Object.freeze({ league: 41, team: 47, player: 41 });

// --- nflverse ids (research 04 §D; plan 05 §2 domain/crosswalk "unknown abbreviation fails") ------

/** nflverse team abbreviations (research 04 §D: nflverse uses `LA` for the Rams, `LV`, `JAX`). */
export const NFL_TEAMS = [
  "ARI",
  "ATL",
  "BAL",
  "BUF",
  "CAR",
  "CHI",
  "CIN",
  "CLE",
  "DAL",
  "DEN",
  "DET",
  "GB",
  "HOU",
  "IND",
  "JAX",
  "KC",
  "LA",
  "LAC",
  "LV",
  "MIA",
  "MIN",
  "NE",
  "NO",
  "NYG",
  "NYJ",
  "PHI",
  "PIT",
  "SEA",
  "SF",
  "TB",
  "TEN",
  "WAS",
] as const;
/** An nflverse team abbreviation. */
export type NflTeam = (typeof NFL_TEAMS)[number];

/** Whether `s` is an nflverse team abbreviation. */
export function isNflTeam(s: string): s is NflTeam {
  return (NFL_TEAMS as readonly string[]).includes(s);
}

/** nflverse gsis id grammar (`00-0012345`). */
export const GSIS_ID_RE = /^00-[0-9]{7}$/;

// --- keys ------------------------------------------------------------------------------------

/** Log levels, most to least severe (plan 01 §7). */
export const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
/** A log level. */
export type LogLevel = (typeof LOG_LEVELS)[number];
/** Tool sets (plan 07 C3): `core` = the 19 P0 tools, `full` adds P1/P2. */
export const TOOLSETS = ["core", "full"] as const;
/** A tool set. */
export type Toolset = (typeof TOOLSETS)[number];
/** Weather sources (plan 01 §5.2; `off` disables the driver — it is then named as omitted). */
export const WEATHER_SOURCES = ["open-meteo", "nws", "off"] as const;
/** A weather source. */
export type WeatherSource = (typeof WEATHER_SOURCES)[number];

/** Documentation row for one key — the single source of the README/.env.example tables. */
export interface ConfigKeySpec {
  /** The environment variable name (also the config.json property name when file-settable). */
  readonly key: ConfigKey;
  /** One-line description. */
  readonly description: string;
  /** The default, as text; `null` = unset by default. */
  readonly default: string | null;
  /** Holds a secret: never accepted from config.json, never logged, never enumerable on Config. */
  readonly secret: boolean;
  /** May appear in `<config>/config.json`. */
  readonly fileSettable: boolean;
  /** `now` = read by the 1a build; `1b`/`later` = accepted and documented, not yet used. */
  readonly status: "now" | "1b" | "later";
}

/** Every key the server reads. */
export const CONFIG_KEYS = [
  "FF_CONFIG_DIR",
  "FF_CACHE_DIR",
  "FF_LEAGUE_FILE",
  "FF_LOG_LEVEL",
  "FF_TOOLSET",
  "FF_WEATHER_SOURCE",
  "FF_FIXTURE_DIR",
  "FF_LEAGUE_KEYS",
  "FF_WRITE_ENABLED",
  "FF_AUTH_PORT",
  "YAHOO_CLIENT_ID",
  "YAHOO_CLIENT_SECRET",
  "YAHOO_CLIENT_SECRET_FILE",
  "ODDS_API_KEY",
] as const;
/** A config key name. */
export type ConfigKey = (typeof CONFIG_KEYS)[number];

const spec = (
  key: ConfigKey,
  description: string,
  def: string | null,
  o: { secret?: boolean; file?: boolean; status?: ConfigKeySpec["status"] } = {},
): ConfigKeySpec =>
  Object.freeze({
    key,
    description,
    default: def,
    secret: o.secret ?? false,
    fileSettable: o.file ?? true,
    status: o.status ?? "now",
  });

/** The documented key table, in README order. */
export const CONFIG_KEY_SPECS: readonly ConfigKeySpec[] = Object.freeze([
  spec(
    "FF_CONFIG_DIR",
    "Config directory (0700; holds league.yaml and config.json). Env only.",
    "$XDG_CONFIG_HOME/fantasy-football-mcp or ~/.config/fantasy-football-mcp",
    { file: false },
  ),
  spec(
    "FF_CACHE_DIR",
    "Cache directory (0700; store.sqlite, ds/ dataset files, backups).",
    "$XDG_CACHE_HOME/fantasy-football-mcp or ~/.cache/fantasy-football-mcp",
  ),
  spec(
    "FF_LEAGUE_FILE",
    "ManualLeagueProvider league file (0600; real names — never inside the checkout).",
    "<config>/league.yaml",
  ),
  spec("FF_LOG_LEVEL", "stderr log level: error | warn | info | debug.", "info"),
  spec("FF_TOOLSET", "Registered tools: core (19 P0 tools) | full (adds P1/P2 analytics).", "core"),
  spec(
    "FF_WEATHER_SOURCE",
    "Weather driver: open-meteo (non-commercial) | nws (US, public domain) | off.",
    "open-meteo",
  ),
  spec(
    "FF_FIXTURE_DIR",
    "Fixture mode: serve recorded fixtures from this absolute directory (tests, smoke, debug tools).",
    null,
  ),
  spec(
    "FF_LEAGUE_KEYS",
    "Optional comma-separated allow-list of league keys the tools accept.",
    null,
  ),
  spec(
    "FF_WRITE_ENABLED",
    "Writes are not supported in this build: always off. Setting 1 is ignored with a warning (plan 02 §3.4; Phase W).",
    "0",
  ),
  spec("FF_AUTH_PORT", "Phase 1b — not used. Fixed port for `ff auth --listener`.", null, {
    status: "1b",
  }),
  spec("YAHOO_CLIENT_ID", "Phase 1b — not used. Yahoo app client id.", null, { status: "1b" }),
  spec(
    "YAHOO_CLIENT_SECRET",
    "Phase 1b — not used. Yahoo client secret (prefer the _FILE form). Env only.",
    null,
    { secret: true, file: false, status: "1b" },
  ),
  spec(
    "YAHOO_CLIENT_SECRET_FILE",
    "Phase 1b — not used. Path to a 0600 file holding the client secret.",
    "<config>/client_secret",
    { status: "1b" },
  ),
  spec("ODDS_API_KEY", "Deferred (plan 10 D4) — not used. The Odds API key. Env only.", null, {
    secret: true,
    file: false,
    status: "later",
  }),
]);

// --- errors ----------------------------------------------------------------------------------

/** One configuration problem. `reason` never contains the offending value (it may be a secret). */
export interface ConfigIssue {
  /** The key (or `config.json`) the issue is about. */
  readonly key: string;
  /** A fixed description of what is wrong. */
  readonly reason: string;
}

/**
 * Configuration is invalid; startup exits 2 with one stderr line per issue (plan 03 §1.1). If one
 * ever surfaces inside a tool call it maps to INTERNAL, never VALIDATION: the model's arguments are
 * not at fault and a VALIDATION result would send it into argument retries (critic C-13).
 */
export class ConfigError extends Error {
  /** Error-contract code (plan 01 §4.3): not the caller's fault, not retryable. */
  readonly ffCode = "INTERNAL" as const;
  /** Process exit code for the CLI (plan 03 §1.3: bad config → exit 2). */
  readonly exitCode = 2 as const;
  /** Every problem found (all are reported, not just the first). */
  readonly issues: readonly ConfigIssue[];
  constructor(issues: readonly ConfigIssue[]) {
    super(`invalid configuration: ${issues.map((i) => `${i.key}: ${i.reason}`).join("; ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

// --- the resolved configuration ----------------------------------------------------------------

/** Where a resolved value came from (precedence: env > file > default). */
export type ValueOrigin = "env" | "file" | "default";

/** Secrets held by the config. Non-enumerable on `Config`, so JSON/log serialisation omits them. */
export interface ConfigSecrets {
  /** YAHOO_CLIENT_SECRET (Phase 1b — unused today). */
  readonly yahooClientSecret: string | null;
  /** ODDS_API_KEY (deferred — unused today). */
  readonly oddsApiKey: string | null;
}

/** The validated, fully resolved configuration. */
export interface Config {
  /** Absolute config dir (outside the repo, outside synced folders). */
  readonly configDir: string;
  /** Absolute cache dir (outside the repo, outside synced folders). */
  readonly cacheDir: string;
  /** Absolute manual league file path. */
  readonly leagueFile: string;
  /** stderr log level. */
  readonly logLevel: LogLevel;
  /** Registered tool set. */
  readonly toolset: Toolset;
  /** Weather driver. */
  readonly weatherSource: WeatherSource;
  /** Absolute fixture dir, or null outside fixture mode. */
  readonly fixtureDir: string | null;
  /** League-key allow-list from FF_LEAGUE_KEYS (empty = no extra restriction). */
  readonly leagueKeys: readonly string[];
  /** Always false in this build: no write-capable provider exists (plan 02 §3.4, Phase W). */
  readonly writeEnabled: false;
  /** Whether the operator asked for writes (FF_WRITE_ENABLED=1) — reported, never honoured. */
  readonly writeRequested: boolean;
  /** Phase 1b settings, accepted and validated but unused. */
  readonly yahoo: {
    readonly clientId: string | null;
    readonly clientSecretFile: string | null;
    readonly authPort: number | null;
  };
  /** Where each key's value came from. */
  readonly origins: Readonly<Record<ConfigKey, ValueOrigin>>;
  /** Non-fatal notices for the startup log / `ff doctor` (never contain values of secrets). */
  readonly warnings: readonly string[];
  /** Secrets (non-enumerable). */
  readonly secrets: ConfigSecrets;
}

/** Inputs to `loadConfig` — everything it reads, injected (no ambient process state). */
export interface ConfigInput {
  /** The environment (process.env shape). */
  readonly env: Env;
  /** Parsed `<config>/config.json`, or undefined when absent. */
  readonly file: unknown;
  /** The user's home directory. */
  readonly home: string;
  /** The package checkout root; config/cache/league paths must not be inside it. */
  readonly repoRoot: string;
}

const MAX_VALUE_LEN = 4096;
const MAX_LEAGUE_KEYS = 20;

const FILE_KEYS = CONFIG_KEY_SPECS.filter((s) => s.fileSettable).map((s) => s.key);
const SECRET_KEYS = new Set(CONFIG_KEY_SPECS.filter((s) => s.secret).map((s) => s.key));

/**
 * config.json: a flat object of file-settable keys with string values. Unknown keys are stripped
 * here and reported by `loadConfig` as a warning — plan 03 §7 "Config: additive only; unknown keys
 * warn, never fail" (a file written by a newer version, or kept across a rollback, must not stop
 * the server). Secret-looking keys and wrongly typed values stay hard errors.
 */
export const configFileSchema = z.object(
  Object.fromEntries(FILE_KEYS.map((k) => [k, z.string().max(MAX_VALUE_LEN).optional()])),
);

/** The fixed issue text for a secret (or secret-looking key) found in config.json. */
const SECRETS_IN_FILE =
  "secrets are not allowed in config.json (use the environment or a _FILE path)";
/** The fixed warning for unknown config.json keys (plan 03 §7: additive; never echoes the key). */
export const UNKNOWN_FILE_KEYS_WARNING = "unknown key(s) in config.json are ignored";

/** A syntactically plausible secret-looking key name, for the "secrets never in config.json" rule. */
const SECRETISH = /secret|token|password|passwd|api[_-]?key|credential/i;

/** A value-free reason for a path failure (never echoes the path or an unexpected error text). */
function pathReason(e: unknown): string {
  return e instanceof PathSecurityError ? e.detail : "path could not be checked";
}

function envStr(env: Env, key: string): string | undefined {
  const v = env[key];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

/**
 * Resolves and validates the configuration. Collects every issue and throws one `ConfigError`;
 * never echoes a value in a reason. Pure apart from the path checks' filesystem `realpath` reads.
 */
export function loadConfig(input: ConfigInput): Config {
  const { env, home, repoRoot } = input;
  const issues: ConfigIssue[] = [];
  const warnings: string[] = [];
  const origins = {} as Record<ConfigKey, ValueOrigin>;

  // config.json shape
  let fileVals: Partial<Record<string, string>> = {};
  if (input.file !== undefined) {
    if (typeof input.file !== "object" || input.file === null || Array.isArray(input.file)) {
      issues.push({ key: "config.json", reason: "must be a JSON object of string values" });
    } else {
      const raw = input.file as Record<string, unknown>;
      let unknownKeys = 0;
      for (const k of Object.keys(raw)) {
        if (SECRET_KEYS.has(k as ConfigKey) || SECRETISH.test(k)) {
          if (!issues.some((i) => i.key === "config.json" && i.reason === SECRETS_IN_FILE))
            issues.push({ key: "config.json", reason: SECRETS_IN_FILE });
        } else if ((CONFIG_KEYS as readonly string[]).includes(k)) {
          if (!FILE_KEYS.includes(k as ConfigKey))
            warnings.push(`${k} is env-only; its config.json value is ignored`);
        } else {
          unknownKeys++;
        }
      }
      if (unknownKeys > 0) warnings.push(UNKNOWN_FILE_KEYS_WARNING);
      const parsed = configFileSchema.safeParse(raw);
      if (parsed.success) {
        fileVals = parsed.data;
      } else {
        for (const iss of parsed.error.issues) {
          const key =
            typeof iss.path[0] === "string" && FILE_KEYS.includes(iss.path[0] as ConfigKey)
              ? iss.path[0]
              : "config.json";
          const reason = "value must be a string of at most 4096 characters";
          if (!issues.some((i) => i.key === key && i.reason === reason))
            issues.push({ key, reason });
        }
      }
    }
  }

  for (const k of Object.keys(env)) {
    if (
      k.startsWith("FF_") &&
      !(CONFIG_KEYS as readonly string[]).includes(k) &&
      !k.startsWith("FF_SCAN_")
    ) {
      warnings.push(`unknown environment variable ${k.slice(0, 64)} (typo?) is ignored`);
    }
  }

  /** Resolve one key by precedence; records its origin. */
  const pick = (key: ConfigKey): string | undefined => {
    const e = envStr(env, key);
    if (e !== undefined) {
      if (e.length > MAX_VALUE_LEN) {
        issues.push({ key, reason: "value is too long" });
        origins[key] = "env";
        return undefined;
      }
      origins[key] = "env";
      return e;
    }
    const f = fileVals[key]?.trim();
    if (f !== undefined && f !== "") {
      origins[key] = "file";
      return f;
    }
    origins[key] = "default";
    return undefined;
  };

  const oneOf = <T extends string>(key: ConfigKey, allowed: readonly T[], def: T): T => {
    const v = pick(key);
    if (v === undefined) return def;
    if ((allowed as readonly string[]).includes(v)) return v as T;
    issues.push({ key, reason: `must be one of: ${allowed.join(" | ")}` });
    return def;
  };

  const absPath = (key: string, v: string): string | null => {
    try {
      return resolveAbsolute(v, home, key);
    } catch (e) {
      issues.push({ key, reason: pathReason(e) });
      return null;
    }
  };

  const guardLocation = (key: string, p: string): void => {
    for (const check of [
      () => {
        assertOutsideRepo(p, repoRoot, key);
      },
      () => {
        assertNotSynced(p, home, key);
      },
    ]) {
      try {
        check();
      } catch (e) {
        issues.push({ key, reason: pathReason(e) });
      }
    }
  };

  // directories
  let configDir = "";
  try {
    configDir = resolveConfigDir(env, home);
  } catch (e) {
    issues.push({ key: "FF_CONFIG_DIR", reason: pathReason(e) });
  }
  origins.FF_CONFIG_DIR = envStr(env, "FF_CONFIG_DIR") !== undefined ? "env" : "default";
  if (configDir) guardLocation("FF_CONFIG_DIR", configDir);

  const cacheRaw = pick("FF_CACHE_DIR");
  let cacheDir = "";
  try {
    cacheDir = resolveCacheDir(env, home, cacheRaw);
  } catch (e) {
    issues.push({ key: "FF_CACHE_DIR", reason: pathReason(e) });
  }
  if (cacheDir) guardLocation("FF_CACHE_DIR", cacheDir);

  const fixtureRaw = pick("FF_FIXTURE_DIR");
  const fixtureDir = fixtureRaw === undefined ? null : absPath("FF_FIXTURE_DIR", fixtureRaw);

  const leagueRaw = pick("FF_LEAGUE_FILE");
  let leagueFile: string | null = configDir ? defaultLeagueFilePath(configDir) : null;
  if (leagueRaw !== undefined) {
    leagueFile = absPath("FF_LEAGUE_FILE", leagueRaw);
    // A fixture league inside the fixture dir is the one allowed in-repo league file (fixture mode).
    if (leagueFile !== null && !(fixtureDir !== null && isInside(leagueFile, fixtureDir))) {
      guardLocation("FF_LEAGUE_FILE", leagueFile);
    }
  }

  const logLevel = oneOf("FF_LOG_LEVEL", LOG_LEVELS, "info");
  const toolset = oneOf("FF_TOOLSET", TOOLSETS, "core");
  const weatherSource = oneOf("FF_WEATHER_SOURCE", WEATHER_SOURCES, "open-meteo");

  // FF_LEAGUE_KEYS
  const lkRaw = pick("FF_LEAGUE_KEYS");
  const leagueKeys: string[] = [];
  if (lkRaw !== undefined) {
    const parts = lkRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    if (parts.length > MAX_LEAGUE_KEYS) {
      issues.push({
        key: "FF_LEAGUE_KEYS",
        reason: `at most ${String(MAX_LEAGUE_KEYS)} league keys`,
      });
    } else if (parts.some((p) => !isLeagueKey(p))) {
      issues.push({
        key: "FF_LEAGUE_KEYS",
        reason: "every entry must be a league key (e.g. 461.l.1000 or manual.l.example)",
      });
    } else {
      leagueKeys.push(...new Set(parts));
    }
  }

  // FF_WRITE_ENABLED — accepted, reported, never honoured
  let writeRequested = false;
  const we = pick("FF_WRITE_ENABLED");
  if (we !== undefined) {
    if (we === "1" || we === "true") writeRequested = true;
    else if (we !== "0" && we !== "false")
      issues.push({ key: "FF_WRITE_ENABLED", reason: "must be 0, 1, true or false" });
  }
  if (writeRequested) {
    warnings.push(
      "FF_WRITE_ENABLED=1 is ignored: this build has no write-capable provider (plan 02 §3.4; Phase W)",
    );
  }

  // Phase 1b keys — validated so a typo surfaces now, unused
  const clientIdRaw = pick("YAHOO_CLIENT_ID");
  let clientId: string | null = null;
  if (clientIdRaw !== undefined) {
    if (/^[A-Za-z0-9=_-]{1,256}$/.test(clientIdRaw)) clientId = clientIdRaw;
    else
      issues.push({
        key: "YAHOO_CLIENT_ID",
        reason: "must be 1-256 characters of A-Z a-z 0-9 = _ -",
      });
  }
  const secretFileRaw = pick("YAHOO_CLIENT_SECRET_FILE");
  const clientSecretFile =
    secretFileRaw === undefined ? null : absPath("YAHOO_CLIENT_SECRET_FILE", secretFileRaw);
  const portRaw = pick("FF_AUTH_PORT");
  let authPort: number | null = null;
  if (portRaw !== undefined) {
    const n = /^[0-9]{1,5}$/.test(portRaw) ? Number(portRaw) : NaN;
    if (Number.isInteger(n) && n >= 1024 && n <= 65535) authPort = n;
    else issues.push({ key: "FF_AUTH_PORT", reason: "must be an integer 1024-65535" });
  }
  if (clientId !== null || clientSecretFile !== null || authPort !== null) {
    warnings.push("Yahoo settings are accepted but unused: Phase 1b (YahooProvider) is not built");
  }

  // secrets: env only (config.json rejected above)
  const yahooClientSecret = envStr(env, "YAHOO_CLIENT_SECRET") ?? null;
  const oddsApiKey = envStr(env, "ODDS_API_KEY") ?? null;
  origins.YAHOO_CLIENT_SECRET = yahooClientSecret === null ? "default" : "env";
  origins.ODDS_API_KEY = oddsApiKey === null ? "default" : "env";
  for (const [key, v] of [
    ["YAHOO_CLIENT_SECRET", yahooClientSecret],
    ["ODDS_API_KEY", oddsApiKey],
  ] as const) {
    if (v !== null && v.length > MAX_VALUE_LEN) issues.push({ key, reason: "value is too long" });
  }

  if (issues.length > 0 || leagueFile === null) {
    throw new ConfigError(
      issues.length > 0 ? issues : [{ key: "FF_LEAGUE_FILE", reason: "could not be resolved" }],
    );
  }

  const config = {
    configDir,
    cacheDir,
    leagueFile,
    logLevel,
    toolset,
    weatherSource,
    fixtureDir,
    leagueKeys: Object.freeze(leagueKeys),
    writeEnabled: false as const,
    writeRequested,
    yahoo: Object.freeze({ clientId, clientSecretFile, authPort }),
    origins: Object.freeze(origins),
    warnings: Object.freeze(warnings),
  } as Omit<Config, "secrets">;
  Object.defineProperty(config, "secrets", {
    value: Object.freeze({ yahooClientSecret, oddsApiKey }),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(config) as Config;
}

/** Every secret value the config holds — the logger registers these for redaction (plan 01 §7). */
export function secretValues(config: Config): readonly { kind: string; value: string }[] {
  const out: { kind: string; value: string }[] = [];
  if (config.secrets.yahooClientSecret !== null)
    out.push({ kind: "client_secret", value: config.secrets.yahooClientSecret });
  if (config.secrets.oddsApiKey !== null)
    out.push({ kind: "api_key", value: config.secrets.oddsApiKey });
  return out;
}

/**
 * Reads `<config>/config.json` (plan 03 §3) for `loadConfig`. Missing → undefined. Never follows a
 * symlink; at most 64 KiB; malformed JSON is a `ConfigError` (the file's content is not echoed).
 */
export function readConfigFile(configDir: string): unknown {
  const text = readSecureFile(configFilePath(configDir), {
    requirePrivate: false,
    maxBytes: 64 * 1024,
    what: "config.json",
  });
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ConfigError([{ key: "config.json", reason: "is not valid JSON" }]);
  }
}

/**
 * Resolves the config from the real process environment: config dir → config.json → loadConfig.
 * An unusable FF_CONFIG_DIR is not a config.json problem: config.json is then not read at all and
 * `loadConfig` reports the issue under FF_CONFIG_DIR, together with every other issue (QA-1-057).
 */
export function loadConfigFromProcess(opts: { env: Env; home: string; repoRoot: string }): Config {
  let configDir: string | null;
  try {
    configDir = resolveConfigDir(opts.env, opts.home);
  } catch {
    configDir = null;
  }
  let file: unknown;
  if (configDir !== null) {
    try {
      file = readConfigFile(configDir);
    } catch (e) {
      if (e instanceof ConfigError) throw e;
      throw new ConfigError([{ key: "config.json", reason: pathReason(e) }]);
    }
  }
  return loadConfig({ ...opts, file });
}
