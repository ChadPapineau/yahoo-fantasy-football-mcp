// parse.ts — hostile-input-safe YAML parsing of league.yaml (plan 01 §8 X1; plan 02 §5 input
// validation; critic C-13b: a bad file is LeagueFileError(invalid) with value-free issues). The
// file is hand- or model-written, so it is parsed as untrusted: YAML 1.2 core schema only (no
// custom tags, no merge keys), duplicate keys rejected, one document, no aliases at all (an alias
// bomb never expands), string keys only (a collection key would be stringified and warned about
// on stderr WITH its content), `__proto__`/`constructor`/`prototype` keys rejected, bounded size,
// depth and node count. Nothing from the file ever reaches an error message or a log line.
// Measured cost model (yaml 2.9.1): the lexer/CST parser is linear (~0.4 s for 128 KB of worst-case
// input) but the composer's duplicate-key check is QUADRATIC in a map's size — one 20 000-key map
// (190 KB) took 62 s. So the CST is checked first (depth, node count, items per map/sequence) and
// only a bounded tree is ever composed.
import {
  Composer,
  isMap,
  isNode,
  isPair,
  isScalar,
  isSeq,
  LineCounter,
  Parser,
  type CST,
  type Document,
} from "yaml";
import { LeagueFileError, type LeagueFileIssue } from "../platform.js";

/** Largest league.yaml accepted (the 12-team fixture is ~6 KB; every roster listed is ~25 KB). */
export const MAX_LEAGUE_FILE_BYTES = 128 * 1024;
/** Most entries in one mapping (the widest schema map, `scoring.overrides`, has 42 keys). */
export const MAX_MAP_ENTRIES = 100;
/** Most items in one sequence (the longest schema list, `free_agents`, allows 500). */
export const MAX_SEQ_ITEMS = 600;
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

/**
 * Walks the CST (iteratively, before composition) enforcing depth, node count and collection
 * sizes — the limits that keep the composer's quadratic duplicate-key check bounded.
 */
function cstIssues(tokens: readonly CST.Token[], lc: LineCounter): LeagueFileIssue[] {
  const stack: { tok: CST.Token | null | undefined; d: number }[] = tokens.map((tok) => ({
    tok,
    d: 0,
  }));
  let nodes = 0;
  while (stack.length > 0) {
    const { tok, d } = stack.pop() as { tok: CST.Token | null | undefined; d: number };
    if (tok === null || tok === undefined) continue;
    nodes += 1;
    if (nodes > MAX_YAML_NODES)
      return [{ path: "$", reason: `too many YAML nodes (maximum ${String(MAX_YAML_NODES)})` }];
    if (d > MAX_YAML_DEPTH + 1)
      return [
        {
          path: lineOf(lc, tok.offset),
          reason: `nested too deeply (maximum ${String(MAX_YAML_DEPTH)})`,
        },
      ];
    switch (tok.type) {
      case "document":
        stack.push({ tok: tok.value, d });
        break;
      case "block-map":
      case "block-seq":
      case "flow-collection": {
        const isMapLike =
          tok.type === "block-map" || (tok.type === "flow-collection" && tok.start.source === "{");
        const max = isMapLike ? MAX_MAP_ENTRIES : MAX_SEQ_ITEMS;
        if (tok.items.length > max)
          return [
            {
              path: lineOf(lc, tok.offset),
              reason: `${isMapLike ? "mapping has more than" : "sequence has more than"} ${String(max)} entries`,
            },
          ];
        for (const item of tok.items as readonly CST.CollectionItem[]) {
          // A flow-sequence item written as `a: b` is a single-pair map: bound it like a map.
          stack.push({ tok: item.key, d: d + 1 }, { tok: item.value, d: d + 1 });
        }
        break;
      }
      case "alias":
        return [{ path: lineOf(lc, tok.offset), reason: "YAML aliases are not allowed" }];
      case "directive":
        // `%YAML 1.1` would switch schemas (merge keys, !!set, !!timestamp); `%TAG` adds handles.
        return [{ path: lineOf(lc, tok.offset), reason: "YAML directives are not allowed" }];
      default:
        break;
    }
  }
  return [];
}

/**
 * Walks the composed AST (already bounded by `cstIssues`) checking every mapping key: a plain
 * string, and never `__proto__`/`constructor`/`prototype`. Returns the problems found.
 */
function keyIssues(doc: Document, lc: LineCounter): LeagueFileIssue[] {
  const issues: LeagueFileIssue[] = [];
  const stack: unknown[] = [doc.contents];
  while (stack.length > 0 && issues.length < MAX_ISSUES) {
    const n = stack.pop();
    // A flow sequence item written `[a: 1]` composes to a bare Pair: check it like a map entry.
    const pairs = isMap(n) ? n.items : isPair(n) ? [n] : null;
    if (pairs === null) {
      if (isSeq(n)) stack.push(...n.items);
      continue;
    }
    for (const pair of pairs) {
      const key: unknown = pair.key;
      if (!isScalar(key) || typeof key.value !== "string") {
        issues.push({
          path: lineOf(lc, isNode(key) ? key.range?.[0] : undefined),
          reason: "every mapping key must be a plain string",
        });
      } else if (FORBIDDEN_KEYS.has(key.value)) {
        issues.push({
          path: lineOf(lc, key.range?.[0]),
          reason: "reserved key name is not allowed",
        });
      } else {
        stack.push(pair.value);
      }
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
  let doc: Document | undefined;
  try {
    const tokens = [...new Parser(lc.addNewLine).parse(text)];
    const cst = cstIssues(tokens, lc);
    if (cst.length > 0) fail(cst);
    const composer = new Composer({
      version: "1.2",
      schema: "core",
      merge: false,
      uniqueKeys: true,
      strict: true,
      prettyErrors: false,
      keepSourceTokens: false,
      // Collect problems on the document; never print them (they could quote the file).
      logLevel: "error",
    });
    for (const d of composer.compose(tokens, true, text.length)) {
      if (doc !== undefined)
        fail([{ path: lineOf(lc, d.range[0]), reason: "YAML error (MULTIPLE_DOCS)" }]);
      doc = d;
    }
  } catch (e) {
    if (e instanceof LeagueFileError) throw e;
    // A pathological input can exhaust the parser (stack depth); the file is simply invalid.
    fail([{ path: "$", reason: "YAML could not be parsed" }]);
  }
  if (doc === undefined) fail([{ path: "$", reason: "file is empty" }]);
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
  const structural = keyIssues(doc, lc);
  if (structural.length > 0) fail(structural);
  try {
    return doc.toJS({ maxAliasCount: 0 }) as unknown;
  } catch {
    fail([{ path: "$", reason: "YAML could not be converted" }]);
  }
}
