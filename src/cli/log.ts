// log.ts — the stderr-only JSON-lines logger (plan 01 §2 "protocol on stdout, everything else on
// stderr", §7 fields + redaction rules; plan 05 §2 `cli/log`; plan 05 §7: a 100 %-coverage module).
// Every field passes through redaction: registered secret values, token/key shapes (the patterns of
// scripts/dev/scan-secrets.mjs), OAuth/query parameters, Authorization values, emails, URL query
// strings; long strings are truncated. Nothing is ever written to stdout.
import type { LogLevel } from "../config/schema.js";

/** Level order, most severe first (plan 01 §7). */
const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { error: 0, warn: 1, info: 2, debug: 3 };

/** Default cap for one string field, in UTF-16 units (plan 01 §7: bodies truncated to 500). */
export const DEFAULT_MAX_STRING = 500;
/** Strings longer than this are dropped whole rather than scanned (bounds CPU per line). */
export const HARD_MAX_STRING = 8 * 1024 * 1024;
/** Registered secrets shorter than this are ignored: redacting 1–3-char strings would shred logs. */
export const MIN_SECRET_LENGTH = 4;
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 50;
const MAX_KEY_CHARS = 64;
const RESERVED = new Set(["ts", "level", "event"]);
const EVENT_RE = /^[a-z0-9_.:-]{1,64}$/;
const KIND_RE = /^[a-z_]{1,32}$/;

/** Structured fields attached to one log line. */
export type LogFields = Readonly<Record<string, unknown>>;

/** A logger. Every method writes at most one JSON line to stderr and never throws. */
export interface Logger {
  /** The level below which lines are dropped. */
  readonly level: LogLevel;
  /** Logs at `error`. `event` is a short fixed name such as `tool.error`. */
  error(event: string, fields?: LogFields): void;
  /** Logs at `warn`. */
  warn(event: string, fields?: LogFields): void;
  /** Logs at `info`. */
  info(event: string, fields?: LogFields): void;
  /** Logs at `debug`. */
  debug(event: string, fields?: LogFields): void;
  /** A logger that adds `bound` to every line (e.g. `{ request_id, tool }`); shares the secret registry. */
  child(bound: LogFields): Logger;
  /** Registers a secret value (token, client secret, API key) to be replaced by `[redacted:<kind>]`. */
  registerSecret(kind: string, value: string): void;
}

/** Options for `createLogger`. */
export interface LoggerOptions {
  /** Minimum level to emit. */
  readonly level: LogLevel;
  /** Where each finished line (without newline) goes; default: process.stderr. Never stdout. */
  readonly sink?: (line: string) => void;
  /** Timestamp source; default: the wall clock. */
  readonly now?: () => string;
  /** Per-string cap; default 500. */
  readonly maxStringChars?: number;
}

/** A shared registry of secret values, longest first so overlapping secrets redact fully. */
export class SecretRegistry {
  private readonly entries: { kind: string; value: string }[] = [];

  /** Adds a secret (and its URL-encoded form when different). Short or empty values are ignored. */
  add(kind: string, value: string): void {
    const k = KIND_RE.test(kind) ? kind : "secret";
    if (value.length < MIN_SECRET_LENGTH) return;
    for (const v of new Set([value, encodeURIComponent(value)])) {
      if (!this.entries.some((e) => e.value === v)) this.entries.push({ kind: k, value: v });
    }
    this.entries.sort((a, b) => b.value.length - a.value.length);
  }

  /** Replaces every registered value in `s`. */
  apply(s: string): string {
    let out = s;
    for (const e of this.entries) {
      if (out.includes(e.value)) out = out.split(e.value).join(`[redacted:${e.kind}]`);
    }
    return out;
  }

  /** How many values are registered (for tests and `ff status`). */
  get size(): number {
    return this.entries.length;
  }
}

/** One pattern-based redaction: a regex and its replacement (plan 01 §7; scan-secrets.mjs shapes). */
interface PatternRule {
  readonly id: string;
  readonly re: RegExp;
  readonly replace: string;
}

/** The pattern rules, applied in order to every string after registered values. */
export const REDACTION_PATTERNS: readonly PatternRule[] = Object.freeze([
  {
    id: "private_key",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    replace: "[redacted:private_key]",
  },
  {
    id: "authorization",
    re: /\b(authorization["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token)\s+)?[^\s"',;}]+/gi,
    replace: "$1[redacted:authorization]",
  },
  {
    id: "bearer",
    re: /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: "$1 [redacted:token]",
  },
  {
    id: "url",
    re: /\b([a-z][a-z0-9+.-]{1,15}:\/\/)(?:[^\s/@"'<>]*@)?([^\s/?#"'<>]+)([^\s?#"'<>]*)(?:[?#][^\s"'<>]*)?/gi,
    replace: "$1$2$3",
  },
  {
    id: "param",
    re: /\b(code|state|access_token|refresh_token|id_token|client_secret|client_assertion|password|passwd|token|api_key|apikey|oauth_token|oauth_verifier|xoauth_yahoo_guid|guid|secret)=([^&\s"',;]+)/gi,
    replace: "$1=[redacted]",
  },
  {
    id: "json_secret",
    re: /("(?:access_token|refresh_token|id_token|client_secret|password|passwd|api_key|apikey|token|secret|xoauth_yahoo_guid|guid|authorization)"\s*:\s*")[^"]*(")/gi,
    replace: "$1[redacted]$2",
  },
  {
    id: "email",
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    replace: "[redacted:email]",
  },
  {
    id: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    replace: "[redacted:token]",
  },
  { id: "yahoo_client_id", re: /dj0yJmk9[A-Za-z0-9=_-]{20,}/g, replace: "[redacted:client_id]" },
  {
    id: "github_token",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/g,
    replace: "[redacted:token]",
  },
  { id: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, replace: "[redacted:api_key]" },
  { id: "openai_key", re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/g, replace: "[redacted:api_key]" },
  { id: "aws_key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: "[redacted:api_key]" },
  { id: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replace: "[redacted:token]" },
  { id: "google_key", re: /\bAIza[0-9A-Za-z_-]{35}/g, replace: "[redacted:api_key]" },
]);

/** Object keys whose values are always redacted whole (case-insensitive substring match). */
const SECRET_KEY_RE =
  /authorization|cookie|password|passwd|secret|token|api[_-]?key|credential|guid|email|private[_-]?key/i;

/** Redacts one string: registered values, then every pattern. Pure apart from the registry. */
export function redactString(s: string, secrets: SecretRegistry): string {
  let out = secrets.apply(s);
  for (const rule of REDACTION_PATTERNS) out = out.replace(rule.re, rule.replace);
  return out;
}

/** Truncates to `max` UTF-16 units without splitting a surrogate pair, noting the dropped length. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = max;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${s.slice(0, cut)}…[truncated ${String(s.length - cut)} chars]`;
}

/**
 * Deep-redacts any value into a JSON-safe structure: strings redacted then truncated; secret-named
 * keys replaced whole; Errors reduced to name/message/code; depth, array and key counts bounded;
 * cycles, functions, symbols and binary data made inert.
 */
export function redactValue(
  v: unknown,
  secrets: SecretRegistry,
  maxString: number = DEFAULT_MAX_STRING,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof v === "string") {
    if (v.length > HARD_MAX_STRING) return `[dropped ${String(v.length)} chars]`;
    return truncate(redactString(v, secrets), maxString);
  }
  if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
  if (typeof v === "boolean" || v === null) return v;
  if (typeof v === "bigint") return v.toString();
  if (typeof v !== "object") return v === undefined ? null : `[${typeof v}]`;
  if (seen.has(v)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[depth limit]";
  seen.add(v);
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : "[invalid date]";
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer)
    return `[binary ${String(v.byteLength)} bytes]`;
  if (v instanceof Error) {
    const out: Record<string, unknown> = {
      name: redactValue(v.name, secrets, maxString, depth + 1, seen),
      message: redactValue(v.message, secrets, maxString, depth + 1, seen),
    };
    const code = (v as { code?: unknown }).code;
    if (typeof code === "string" || typeof code === "number")
      out.code = redactValue(code, secrets, maxString, depth + 1, seen);
    return out;
  }
  if (Array.isArray(v)) {
    const items = v
      .slice(0, MAX_ARRAY_ITEMS)
      .map((x) => redactValue(x, secrets, maxString, depth + 1, seen));
    if (v.length > MAX_ARRAY_ITEMS) items.push(`[+${String(v.length - MAX_ARRAY_ITEMS)} more]`);
    return items;
  }
  if (v instanceof Map || v instanceof Set)
    return `[${v instanceof Map ? "Map" : "Set"} of ${String(v.size)}]`;
  const out: Record<string, unknown> = {};
  const keys = Object.keys(v);
  for (const k of keys.slice(0, MAX_OBJECT_KEYS)) {
    const safeKey = truncate(redactString(k, secrets), MAX_KEY_CHARS);
    const child = (v as Record<string, unknown>)[k];
    out[safeKey] =
      SECRET_KEY_RE.test(k) && child !== null && child !== undefined
        ? "[redacted]"
        : redactValue(child, secrets, maxString, depth + 1, seen);
  }
  if (keys.length > MAX_OBJECT_KEYS) out["[more_keys]"] = keys.length - MAX_OBJECT_KEYS;
  return out;
}

let stderrGuarded = false;

/** The default sink: process.stderr, with an `error` listener so a closed pipe (EPIPE) cannot crash. */
function stderrSink(line: string): void {
  if (!stderrGuarded) {
    stderrGuarded = true;
    process.stderr.on("error", () => undefined);
  }
  process.stderr.write(`${line}\n`);
}

/** Creates a logger. Lines are `{"ts","level","event",...fields}` JSON, one per line, on stderr only. */
export function createLogger(opts: LoggerOptions): Logger {
  return makeLogger(opts, new SecretRegistry(), {});
}

function makeLogger(opts: LoggerOptions, secrets: SecretRegistry, bound: LogFields): Logger {
  const sink = opts.sink ?? stderrSink;
  const now = opts.now ?? (() => new Date().toISOString());
  const maxString = opts.maxStringChars ?? DEFAULT_MAX_STRING;
  const threshold = LEVEL_RANK[opts.level];

  const emit = (level: LogLevel, event: string, fields: LogFields | undefined): void => {
    if (LEVEL_RANK[level] > threshold) return;
    try {
      const line: Record<string, unknown> = {
        ts: now(),
        level,
        event: EVENT_RE.test(event) ? event : "invalid_event",
      };
      for (const src of [bound, fields ?? {}]) {
        const red = redactValue(src, secrets, maxString) as Record<string, unknown>;
        for (const [k, val] of Object.entries(red)) if (!RESERVED.has(k)) line[k] = val;
      }
      sink(JSON.stringify(line));
    } catch {
      // Logging must never break a tool call (a throwing sink, a hostile getter): drop the line.
    }
  };

  return {
    level: opts.level,
    error: (e, f) => {
      emit("error", e, f);
    },
    warn: (e, f) => {
      emit("warn", e, f);
    },
    info: (e, f) => {
      emit("info", e, f);
    },
    debug: (e, f) => {
      emit("debug", e, f);
    },
    child: (more) => makeLogger(opts, secrets, { ...bound, ...more }),
    registerSecret: (kind, value) => {
      secrets.add(kind, value);
    },
  };
}
