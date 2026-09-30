// crosswalk-overrides.ts — loads the checked-in crosswalk overrides file data/crosswalk/overrides.yaml
// (research 04 §D step 3; plan 02 §2 "crosswalk overrides file (repo)"; plan 05 §2 domain/crosswalk):
// bounded read, yaml locked down (core schema, unique keys, no merge keys, small alias budget), zod.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { z } from "zod/v4";
import { GSIS_ID_RE } from "../config/schema.js";
import { canonicalPlayerId, isPlatformPlayerId } from "../domain/crosswalk/ids.js";
import type { CrosswalkOverride } from "../domain/crosswalk/types.js";

/** The shipped file (resolves from both src/providers and dist/providers). */
export const DEFAULT_OVERRIDES_PATH = fileURLToPath(
  new URL("../../data/crosswalk/overrides.yaml", import.meta.url),
);

/** Largest overrides file accepted (the expected residue is "a handful" of rows). */
export const MAX_OVERRIDES_BYTES = 256 * 1024;
/** Most override rows accepted. */
export const MAX_OVERRIDES = 2000;
/** yaml's alias-expansion budget (billion-laughs guard); the file has no need for aliases. */
export const MAX_ALIAS_COUNT = 8;
/** Longest `note`. */
export const MAX_NOTE_CHARS = 200;

/** Keys that are never accepted anywhere in the document (prototype pollution). */
export const FORBIDDEN_KEYS: readonly string[] = Object.freeze([
  "__proto__",
  "constructor",
  "prototype",
]);

/** Why a load failed. */
export type OverridesErrorCode =
  | "io"
  | "too_large"
  | "encoding"
  | "yaml"
  | "alias_limit"
  | "forbidden_key"
  | "schema"
  | "duplicate";

/** A load failure. The message names the code and a location, never file content. */
export class CrosswalkOverridesError extends Error {
  readonly code: OverridesErrorCode;
  constructor(code: OverridesErrorCode, detail: string) {
    super(`crosswalk overrides: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "CrosswalkOverridesError";
    this.code = code;
  }
}

const NOTE_RE = /^[^\u0000-\u001F\u007F]*$/u;

const RowSchema = z
  .object({
    platform: z.enum(["yahoo", "manual", "sleeper", "espn"]),
    platform_player_id: z.string().min(1).max(64),
    gsis_id: z.string().regex(GSIS_ID_RE),
    note: z.string().max(MAX_NOTE_CHARS).regex(NOTE_RE).nullable().optional(),
  })
  .strict()
  .refine((r) => isPlatformPlayerId(r.platform, r.platform_player_id), {
    message: "platform_player_id does not match the platform's id grammar",
    path: ["platform_player_id"],
  });

const FileSchema = z
  .object({
    version: z.literal(1),
    overrides: z.array(RowSchema).max(MAX_OVERRIDES),
  })
  .strict();

/**
 * Throws `forbidden_key` if any object in parsed YAML data has a `__proto__`/`constructor`/
 * `prototype` key or is not a plain object; `schema` past 32 levels of nesting.
 */
export function assertNoForbiddenKeys(value: unknown, path = "", depth = 0): void {
  if (depth > 32) throw new CrosswalkOverridesError("schema", "nesting too deep");
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      assertNoForbiddenKeys(v, `${path}[${String(i)}]`, depth + 1);
    });
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new CrosswalkOverridesError("forbidden_key", path || "root");
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (FORBIDDEN_KEYS.includes(key))
      throw new CrosswalkOverridesError("forbidden_key", path || "root");
    assertNoForbiddenKeys((value as Record<string, unknown>)[key], `${path}.${key}`, depth + 1);
  }
}

function yamlDetail(err: unknown): string {
  const e = err as { code?: unknown; linePos?: readonly { line: number; col: number }[] };
  const code = typeof e.code === "string" && /^[A-Z_]{1,40}$/.test(e.code) ? e.code : "PARSE";
  const pos = e.linePos?.[0];
  return pos ? `${code} at ${String(pos.line)}:${String(pos.col)}` : code;
}

/**
 * Parses and validates overrides text. Rejects (CrosswalkOverridesError): more than
 * MAX_OVERRIDES_BYTES, YAML errors or warnings (duplicate keys, unknown tags, several documents),
 * alias expansion over MAX_ALIAS_COUNT, any `__proto__`/`constructor`/`prototype` key, schema
 * violations (unknown keys, wrong types, bad ids), and two rows for the same platform player
 * (Yahoo rows compare by player number, so `nfl.p.1` and `461.p.1` collide).
 */
export function parseCrosswalkOverrides(text: string): readonly CrosswalkOverride[] {
  if (Buffer.byteLength(text, "utf8") > MAX_OVERRIDES_BYTES) {
    throw new CrosswalkOverridesError("too_large", `> ${String(MAX_OVERRIDES_BYTES)} bytes`);
  }
  let data: unknown;
  try {
    const doc = parseDocument(text, {
      version: "1.2",
      schema: "core",
      merge: false,
      uniqueKeys: true,
      strict: true,
      prettyErrors: true, // computes linePos; the message itself is never surfaced
      keepSourceTokens: false,
    });
    const problem = doc.errors[0] ?? doc.warnings[0];
    if (problem !== undefined) throw new CrosswalkOverridesError("yaml", yamlDetail(problem));
    data = doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
  } catch (err) {
    if (err instanceof CrosswalkOverridesError) throw err;
    if (err instanceof ReferenceError && /alias/i.test(err.message)) {
      throw new CrosswalkOverridesError("alias_limit", `> ${String(MAX_ALIAS_COUNT)}`);
    }
    throw new CrosswalkOverridesError("yaml", yamlDetail(err));
  }
  assertNoForbiddenKeys(data);
  const parsed = FileSchema.safeParse(data);
  if (!parsed.success) {
    const where = parsed.error.issues
      .slice(0, 3)
      .map((i) => i.path.map(String).join(".") || "root")
      .join(", ");
    throw new CrosswalkOverridesError("schema", where);
  }
  const seen = new Set<string>();
  const out: CrosswalkOverride[] = [];
  parsed.data.overrides.forEach((row, i) => {
    const key = `${row.platform}:${canonicalPlayerId(row.platform, row.platform_player_id) ?? ""}`;
    if (seen.has(key)) throw new CrosswalkOverridesError("duplicate", `overrides.${String(i)}`);
    seen.add(key);
    out.push(
      Object.freeze({
        platform: row.platform,
        platform_player_id: row.platform_player_id,
        gsis_id: row.gsis_id,
        note: row.note ?? null,
      }),
    );
  });
  return Object.freeze(out);
}

function readBounded(path: string): Buffer {
  let fd: number | null = null;
  try {
    // O_NONBLOCK: opening a FIFO planted at the path must not hang the process.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) throw new CrosswalkOverridesError("io", "not a regular file");
    const buf = Buffer.alloc(MAX_OVERRIDES_BYTES + 1);
    let total = 0;
    let n: number;
    do {
      n = readSync(fd, buf, total, buf.length - total, null);
      total += n;
    } while (n > 0);
    if (total > MAX_OVERRIDES_BYTES) {
      throw new CrosswalkOverridesError("too_large", `> ${String(MAX_OVERRIDES_BYTES)} bytes`);
    }
    return buf.subarray(0, total);
  } catch (err) {
    if (err instanceof CrosswalkOverridesError) throw err;
    throw new CrosswalkOverridesError("io", ioCode(err));
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function ioCode(err: unknown): string {
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && /^E[A-Z]{1,15}$/.test(code) ? code : "read failed";
}

/** Reads (bounded, strict UTF-8) and parses the overrides file at `path`. */
export function loadCrosswalkOverrides(
  path: string = DEFAULT_OVERRIDES_PATH,
): readonly CrosswalkOverride[] {
  const bytes = readBounded(path);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CrosswalkOverridesError("encoding", "not UTF-8");
  }
  return parseCrosswalkOverrides(text);
}
