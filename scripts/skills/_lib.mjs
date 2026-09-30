// @ts-check
// _lib.mjs — shared, zero-dependency helpers for scripts/skills/{build,check}-skills.mjs (plan 09 §2
// frontmatter rules, §4 layout/generation/versioning, §5.1 Lane 1). Node built-ins only.
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Repository root (scripts/skills/ is two levels down). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The Skills bundle directory, relative to the repository root. */
export const SKILLS_DIR = "skills";
/** The shared-text directory (not a Skill: no SKILL.md; plan 09 §4). */
export const SHARED_DIR = "_shared";
/** Shared references, copied byte-for-byte into every Skill's `references/` (plan 09 K4). */
export const SHARED_REFS_DIR = "_shared/references";
/** The manifest: server name, tool contract, the Phase-1a tool list, the write-tool names. */
export const MANIFEST_FILE = "_shared/manifest.json";

/** Marker grammar for a generated block inside a SKILL.md body. */
export const BEGIN_PREFIX = "<!-- BEGIN GENERATED FROM _shared/references/";
export const END_PREFIX = "<!-- END GENERATED FROM _shared/references/";
/** @param {string} file */
export const beginMarker = (file) =>
  `${BEGIN_PREFIX}${file} (edit the source, then run npm run build:skills) -->`;
/** @param {string} file */
export const endMarker = (file) => `${END_PREFIX}${file} -->`;

/**
 * True when the module at `metaUrl` is the process entry point.
 * @param {string} metaUrl
 */
export function isMain(metaUrl) {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(path.resolve(entry)).href === metaUrl;
}

/**
 * @typedef {{ server: string, tool_contract: number, tools: string[], write_tools: string[],
 *   disallowed_tools: string[], skills: string[] }} Manifest
 */

/**
 * Read and validate `skills/_shared/manifest.json`.
 * @param {string} skillsRoot absolute path of the skills/ directory
 * @returns {Manifest}
 */
export function readManifest(skillsRoot) {
  const file = path.join(skillsRoot, MANIFEST_FILE);
  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`manifest: cannot read ${MANIFEST_FILE}: ${errMsg(e)}`);
  }
  if (!isRecord(raw)) throw new Error("manifest: not a JSON object");
  const server = raw["server"];
  const contract = raw["tool_contract"];
  if (typeof server !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(server)) {
    throw new Error("manifest: `server` must be a lowercase server name");
  }
  if (typeof contract !== "number" || !Number.isInteger(contract) || contract < 1) {
    throw new Error("manifest: `tool_contract` must be a positive integer");
  }
  const lists = /** @type {const} */ (["tools", "write_tools", "disallowed_tools", "skills"]);
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const k of lists) {
    const v = raw[k];
    if (!Array.isArray(v) || !v.every((s) => typeof s === "string" && s.length > 0)) {
      throw new Error(`manifest: \`${k}\` must be an array of non-empty strings`);
    }
    if (new Set(v).size !== v.length) throw new Error(`manifest: \`${k}\` has duplicates`);
    out[k] = /** @type {string[]} */ (v);
  }
  const tools = out["tools"] ?? [];
  for (const t of [...tools, ...(out["write_tools"] ?? [])]) {
    if (!/^ff_[a-z][a-z_]{0,36}$/.test(t)) throw new Error(`manifest: bad tool name ${t}`);
  }
  if (tools.some((t) => (out["write_tools"] ?? []).includes(t))) {
    throw new Error("manifest: a tool is listed both as a 1a read tool and as a write tool");
  }
  return {
    server,
    tool_contract: contract,
    tools,
    write_tools: out["write_tools"] ?? [],
    disallowed_tools: out["disallowed_tools"] ?? [],
    skills: out["skills"] ?? [],
  };
}

/**
 * The Skill directories under skills/ (every directory not starting with `_` or `.`), sorted.
 * Symlinks are reported, never followed (a Skill must be a plain, zip-uploadable tree).
 * @param {string} skillsRoot
 * @returns {{ skills: string[], errors: string[] }}
 */
export function listSkillDirs(skillsRoot) {
  /** @type {string[]} */
  const skills = [];
  /** @type {string[]} */
  const errors = [];
  for (const name of readdirSync(skillsRoot).sort()) {
    const full = path.join(skillsRoot, name);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) {
      errors.push(`skills/${name}: symlinks are not allowed in the Skills bundle`);
      continue;
    }
    if (!st.isDirectory() || name.startsWith("_") || name.startsWith(".")) continue;
    if (!existsSync(path.join(full, "SKILL.md"))) {
      errors.push(`skills/${name}: a Skill directory must contain SKILL.md`);
      continue;
    }
    skills.push(name);
  }
  return { skills, errors };
}

/**
 * Every regular file under `dir`, as POSIX paths relative to `base`; symlinks are returned in
 * `links` and not followed.
 * @param {string} dir
 * @param {string} base
 * @returns {{ files: string[], links: string[] }}
 */
export function walkFiles(dir, base) {
  /** @type {string[]} */
  const files = [];
  /** @type {string[]} */
  const links = [];
  /** @param {string} d */
  const visit = (d) => {
    for (const name of readdirSync(d).sort()) {
      const full = path.join(d, name);
      const st = lstatSync(full);
      const rel = toPosix(path.relative(base, full));
      if (st.isSymbolicLink()) links.push(rel);
      else if (st.isDirectory()) visit(full);
      else if (st.isFile()) files.push(rel);
    }
  };
  visit(dir);
  return { files, links };
}

/** @param {string} p */
export const toPosix = (p) => p.split(path.sep).join("/");

// --- frontmatter: a strict subset of YAML, enough for SKILL.md --------------------------------------

/**
 * @typedef {string | number | boolean | null | FmValue[] | { [k: string]: FmValue }} FmValue
 * @typedef {{ data: Record<string, FmValue>, start: number, end: number, bodyStart: number }} Frontmatter
 */

/**
 * Parse the frontmatter of a SKILL.md: `---` on line 1, then `key: scalar`, `key: [a, b]`,
 * `key:` + an indented block list (`  - item`) or an indented map (`  sub: scalar`), then `---`.
 * Anything else (block scalars, anchors, tabs, deeper nesting, duplicate keys) is an error: the
 * subset is what the Skills need and what every client parses the same way.
 * `start`/`end` are the 0-based line indexes of the two `---` lines; `bodyStart` = end + 1.
 * @param {string} text
 * @returns {Frontmatter}
 */
export function parseFrontmatter(text) {
  if (text.includes("\r")) throw new Error("frontmatter: CRLF/CR line endings are not allowed");
  const lines = text.split("\n");
  if (lines[0] !== "---") throw new Error("frontmatter: line 1 must be exactly `---`");
  const end = lines.indexOf("---", 1);
  if (end === -1) throw new Error("frontmatter: no closing `---`");
  /** @type {Record<string, FmValue>} */
  const data = {};
  let i = 1;
  while (i < end) {
    const line = lines[i] ?? "";
    const n = i + 1;
    if (line.trim() === "" || /^\s*#/.test(line)) {
      i++;
      continue;
    }
    if (line.includes("\t")) throw new Error(`frontmatter line ${n}: tabs are not allowed`);
    const m = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s+(.*))?$/.exec(line);
    if (!m) throw new Error(`frontmatter line ${n}: expected \`key: value\` at column 0`);
    const key = m[1] ?? "";
    if (Object.hasOwn(data, key))
      throw new Error(`frontmatter line ${n}: duplicate key \`${key}\``);
    const rest = (m[2] ?? "").trim();
    if (rest !== "") {
      data[key] = parseScalarOrFlow(rest, n);
      i++;
      continue;
    }
    // an indented block: list or map
    /** @type {string[]} */
    const block = [];
    let j = i + 1;
    while (j < end && (/^\s+\S/.test(lines[j] ?? "") || (lines[j] ?? "").trim() === "")) {
      if ((lines[j] ?? "").trim() !== "") block.push(lines[j] ?? "");
      j++;
    }
    if (block.length === 0) throw new Error(`frontmatter line ${n}: \`${key}:\` has no value`);
    if (block.every((b) => /^ {2}- /.test(b))) {
      data[key] = block.map((b, k) => parseScalar(b.slice(4).trim(), n + 1 + k));
    } else if (block.every((b) => /^ {2}[A-Za-z][A-Za-z0-9_-]*:\s+\S/.test(b))) {
      /** @type {Record<string, FmValue>} */
      const map = {};
      for (const [k, b] of block.entries()) {
        const mm = /^ {2}([A-Za-z][A-Za-z0-9_-]*):\s+(.*)$/.exec(b);
        const sub = mm?.[1] ?? "";
        if (Object.hasOwn(map, sub)) {
          throw new Error(`frontmatter line ${n + 1 + k}: duplicate key \`${key}.${sub}\``);
        }
        map[sub] = parseScalar((mm?.[2] ?? "").trim(), n + 1 + k);
      }
      data[key] = map;
    } else {
      throw new Error(
        `frontmatter line ${n}: \`${key}\` must be a 2-space-indented list (\`  - x\`) or map (\`  k: v\`)`,
      );
    }
    i = j;
  }
  return { data, start: 0, end, bodyStart: end + 1 };
}

/**
 * @param {string} s
 * @param {number} n line number for errors
 * @returns {FmValue}
 */
function parseScalarOrFlow(s, n) {
  if (s.startsWith("[")) {
    if (!s.endsWith("]")) throw new Error(`frontmatter line ${n}: unterminated flow list`);
    const inner = s.slice(1, -1).trim();
    if (inner === "") return [];
    return splitFlow(inner, n).map((p) => parseScalar(p.trim(), n));
  }
  return parseScalar(s, n);
}

/**
 * Split a flow list on commas outside quotes.
 * @param {string} s
 * @param {number} n
 * @returns {string[]}
 */
function splitFlow(s, n) {
  /** @type {string[]} */
  const parts = [];
  let cur = "";
  /** @type {string | null} */
  let q = null;
  for (let k = 0; k < s.length; k++) {
    const c = s[k] ?? "";
    if (q) {
      cur += c;
      if (c === "\\" && q === '"') {
        cur += s[k + 1] ?? "";
        k++;
      } else if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === ",") {
      parts.push(cur);
      cur = "";
    } else if (c === "[" || c === "{") {
      throw new Error(`frontmatter line ${n}: nested flow collections are not allowed`);
    } else cur += c;
  }
  if (q) throw new Error(`frontmatter line ${n}: unterminated quote`);
  parts.push(cur);
  return parts;
}

/**
 * @param {string} s
 * @param {number} n
 * @returns {FmValue}
 */
function parseScalar(s, n) {
  if (s === "") throw new Error(`frontmatter line ${n}: empty value`);
  if (s.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(s))
      throw new Error(`frontmatter line ${n}: bad double-quoted string`);
    try {
      return /** @type {string} */ (JSON.parse(s));
    } catch {
      throw new Error(`frontmatter line ${n}: bad escape in double-quoted string`);
    }
  }
  if (s.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(s))
      throw new Error(`frontmatter line ${n}: bad single-quoted string`);
    return s.slice(1, -1).replaceAll("''", "'");
  }
  if (/^[|>]/.test(s))
    throw new Error(`frontmatter line ${n}: block scalars (| or >) are not allowed`);
  if (/^[&*!%@`{[]/.test(s)) throw new Error(`frontmatter line ${n}: unsupported YAML syntax`);
  if (/\s#/.test(s)) throw new Error(`frontmatter line ${n}: trailing comments are not allowed`);
  if (/:\s/.test(s)) throw new Error(`frontmatter line ${n}: quote a value that contains ": "`);
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?(?:0|[1-9]\d*)$/.test(s)) return Number(s);
  if (/^-?(?:0|[1-9]\d*)\.\d+$/.test(s)) return Number(s);
  return s;
}

// --- source-text readers (the contract lives in TypeScript; these scripts are zero-dependency) -------

/**
 * Read `UNTRUSTED_TEXT_RULE` from src/mcp/envelope.ts's source text (a string literal, or literals
 * joined with `+`). Throws when it cannot be found — the Skills must carry the real sentence.
 * @param {string} root repository root
 * @returns {string}
 */
export function readRuleSentence(root) {
  const file = path.join(root, "src", "mcp", "envelope.ts");
  const text = readFileSync(file, "utf8");
  const m =
    /export const UNTRUSTED_TEXT_RULE\s*(?::\s*string\s*)?=\s*((?:"(?:[^"\\\n]|\\.)*"\s*\+?\s*)+);/.exec(
      text,
    );
  if (!m)
    throw new Error('src/mcp/envelope.ts: cannot find `export const UNTRUSTED_TEXT_RULE = "…";`');
  const literals = (m[1] ?? "").match(/"(?:[^"\\\n]|\\.)*"/g) ?? [];
  const sentence = literals.map((l) => /** @type {string} */ (JSON.parse(l))).join("");
  if (sentence.length < 40)
    throw new Error("src/mcp/envelope.ts: UNTRUSTED_TEXT_RULE is implausibly short");
  return sentence;
}

/**
 * Read the plan 01 §4.3 error codes from src/mcp/errors.ts (`export const ERROR_CODES = [...]`).
 * @param {string} root
 * @returns {string[]}
 */
export function readErrorCodes(root) {
  const text = readFileSync(path.join(root, "src", "mcp", "errors.ts"), "utf8");
  const m = /export const ERROR_CODES\s*=\s*\[([\s\S]*?)\]/.exec(text);
  if (!m) throw new Error("src/mcp/errors.ts: cannot find `export const ERROR_CODES = [...]`");
  const codes = [...(m[1] ?? "").matchAll(/"([A-Z_]+)"/g)].map((x) => x[1] ?? "");
  if (codes.length === 0) throw new Error("src/mcp/errors.ts: ERROR_CODES is empty");
  return codes;
}

/**
 * The registry's tool-contract constant, when src/mcp/registry.ts exists and exports it.
 * @param {string} root
 * @returns {{ found: boolean, value: number | null }}
 */
export function readRegistryContract(root) {
  const file = path.join(root, "src", "mcp", "registry.ts");
  if (!existsSync(file)) return { found: false, value: null };
  const m = /export const TOOL_CONTRACT\s*(?::\s*number\s*)?=\s*(\d+)/.exec(
    readFileSync(file, "utf8"),
  );
  return { found: true, value: m ? Number(m[1]) : null };
}

/**
 * The production tool list, when tests/smoke/expected-tools.json exists: a string[] or an object
 * whose `core` is a string[] (plan 07 C3: `core` = the 19 P0 tools).
 * @param {string} root
 * @returns {{ found: boolean, tools: string[] | null, error: string | null }}
 */
export function readExpectedTools(root) {
  const file = path.join(root, "tests", "smoke", "expected-tools.json");
  if (!existsSync(file)) return { found: false, tools: null, error: null };
  try {
    /** @type {unknown} */
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const list = Array.isArray(raw) ? raw : isRecord(raw) ? raw["core"] : undefined;
    if (!Array.isArray(list) || !list.every((s) => typeof s === "string")) {
      return { found: true, tools: null, error: "expected a string[] or { core: string[] }" };
    }
    return { found: true, tools: /** @type {string[]} */ (list), error: null };
  } catch (e) {
    return { found: true, tools: null, error: errMsg(e) };
  }
}

/**
 * The package version (`package.json` `version`).
 * @param {string} root
 * @returns {string}
 */
export function readPackageVersion(root) {
  /** @type {unknown} */
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const v = isRecord(pkg) ? pkg["version"] : undefined;
  if (typeof v !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v)) {
    throw new Error("package.json: `version` must be a semver string");
  }
  return v;
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
export function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** @param {unknown} e */
export function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}
