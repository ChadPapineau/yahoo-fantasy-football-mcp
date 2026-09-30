// parse.ts — hostile-input-safe YAML parsing of league.yaml (plan 01 §8 X1; plan 02 §5 input
// validation; critic C-13b: a bad file is LeagueFileError(invalid) with value-free issues). The
// file is hand- or model-written, so it is parsed as untrusted: YAML 1.2 core schema only (no
// custom tags, no merge keys), duplicate keys rejected, one document, no aliases at all (an alias
// bomb never expands), string keys only (a collection key would be stringified and warned about
// on stderr WITH its content), `__proto__`/`constructor`/`prototype` keys rejected, bounded size,
// depth and node count. Nothing from the file ever reaches an error message or a log line.
import {
  isAlias,
  isMap,
  isPair,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  type Document,
} from "yaml";
import { LeagueFileError, type LeagueFileIssue } from "../platform.js";

/** Largest league.yaml accepted (a 12-team file with every roster is ~40 KB). */
export const MAX_LEAGUE_FILE_BYTES = 256 * 1024;
/** Deepest nesting of collections accepted (the schema itself needs 5). */
export const MAX_YAML_DEPTH = 12;
/** Most YAML nodes accepted. */
export const MAX_YAML_NODES = 50_000;
/** Most issues reported for one file. */
export const MAX_ISSUES = 50;

/** Object keys that could reach a prototype when a parsed object is later spread or merged. */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** A location for a byte offset: `line N` (never the text at it). */
function lineOf(lc: LineCounter, offset: number | undefined): string {
  if (offset === undefined) return "$";
  return `line ${String(lc.linePos(offset).line)}`;
}

/** Throws LeagueFileError(invalid) with at most MAX_ISSUES issues. */
function fail(issues: readonly LeagueFileIssue[]): never {
  throw new LeagueFileError("invalid", issues.slice(0, MAX_ISSUES));
}

/** Walks the AST (iteratively) enforcing the structural limits; returns the problems found. */
function structuralIssues(doc: Document, lc: LineCounter): LeagueFileIssue[] {
  const issues: LeagueFileIssue[] = [];
  const stack: { n: unknown; d: number }[] = [{ n: doc.contents, d: 0 }];
  let nodes = 0;
  while (stack.length > 0 && issues.length < MAX_ISSUES) {
    const { n, d } = stack.pop() as { n: unknown; d: number };
    if (n === null || n === undefined) continue;
    nodes += 1;
    if (nodes > MAX_YAML_NODES) {
      issues.push({ path: "$", reason: `too many YAML nodes (maximum ${String(MAX_YAML_NODES)})` });
      break;
    }
    if (d > MAX_YAML_DEPTH) {
      issues.push({ path: "$", reason: `nested too deeply (maximum ${String(MAX_YAML_DEPTH)})` });
      break;
    }
    if (isAlias(n)) {
      issues.push({ path: lineOf(lc, n.range?.[0]), reason: "YAML aliases are not allowed" });
    } else if (isMap(n)) {
      for (const pair of n.items) {
        const key: unknown = pair.key;
        if (!isScalar(key) || typeof key.value !== "string") {
          const at =
            isAlias(key) || isScalar(key) || isMap(key) || isSeq(key) ? key.range?.[0] : undefined;
          issues.push({ path: lineOf(lc, at), reason: "every mapping key must be a plain string" });
          continue;
        }
        if (FORBIDDEN_KEYS.has(key.value)) {
          issues.push({
            path: lineOf(lc, key.range?.[0]),
            reason: "reserved key name is not allowed",
          });
          continue;
        }
        stack.push({ n: pair.value, d: d + 1 });
      }
    } else if (isSeq(n)) {
      for (const item of n.items) stack.push({ n: item, d: d + 1 });
    } else if (isPair(n)) {
      // A pair appears as a sequence item for `- a: 1` shorthand in some modes; treat as a map entry.
      stack.push({ n: n.value, d: d + 1 });
    } else if (!isScalar(n)) {
      issues.push({ path: "$", reason: "unsupported YAML node" });
    }
  }
  return issues;
}

/**
 * Parses league.yaml text into plain JSON-like data, or throws LeagueFileError(invalid) with
 * value-free issues. Never writes to stderr (the yaml library's process warnings are unreachable:
 * non-string keys and aliases are rejected before `toJS`).
 */
export function parseLeagueYaml(text: string): unknown {
  if (Buffer.byteLength(text, "utf8") > MAX_LEAGUE_FILE_BYTES) {
    fail([{ path: "$", reason: `file is larger than ${String(MAX_LEAGUE_FILE_BYTES)} bytes` }]);
  }
  const lc = new LineCounter();
  let doc: Document;
  try {
    doc = parseDocument(text, {
      version: "1.2",
      schema: "core",
      merge: false,
      uniqueKeys: true,
      strict: true,
      prettyErrors: false,
      keepSourceTokens: false,
      lineCounter: lc,
      // Collect problems on the document; never print them (they could quote the file).
      logLevel: "error",
    });
  } catch {
    // A pathological input can exhaust the parser (stack depth); the file is simply invalid.
    fail([{ path: "$", reason: "YAML could not be parsed" }]);
  }
  const problems = [...doc.errors, ...doc.warnings];
  if (problems.length > 0) {
    fail(
      problems.map((e) => ({
        path: lineOf(lc, e.pos[0]),
        reason: `YAML ${e.name === "YAMLWarning" ? "warning" : "error"} (${e.code})`,
      })),
    );
  }
  if (doc.contents === null) fail([{ path: "$", reason: "file is empty" }]);
  const structural = structuralIssues(doc, lc);
  if (structural.length > 0) fail(structural);
  try {
    return doc.toJS({ maxAliasCount: 0 }) as unknown;
  } catch {
    fail([{ path: "$", reason: "YAML could not be converted" }]);
  }
}
