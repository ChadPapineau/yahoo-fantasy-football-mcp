// @ts-check
// check-licenses.mjs — every runtime package, at any depth, must carry a license on the allow-list
// (docs/plan/04 §4.1 `supply-chain`). Fails naming the package. Node built-ins only.
//
// SPDX handling: `A OR B` passes when any alternative is allowed; `A AND B` needs all; parentheses
// are honoured; `WITH <exception>`, `SEE LICENSE IN …`, UNLICENSED, a missing license and anything
// unparseable fail (a human decides those, not a regex).
//
// Usage: node scripts/ci/check-licenses.mjs [--root <dir>]
import path from "node:path";
import {
  REPO_ROOT,
  isMain,
  isRecord,
  manifestDir,
  parseArgs,
  readJson,
  reporter,
  runtimeTree,
} from "./_lib.mjs";

export const ALLOWED = Object.freeze([
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "0BSD",
  "CC0-1.0",
  "Unlicense",
]);

/**
 * The declared license expression of a manifest, or null. Accepts the legacy `{ type }` object and
 * a single-entry `licenses` array; several legacy entries are joined with OR (npm's reading).
 * @param {unknown} manifest
 * @returns {string | null}
 */
export function declaredLicense(manifest) {
  if (!isRecord(manifest)) return null;
  const lic = manifest.license;
  if (typeof lic === "string" && lic.trim()) return lic.trim();
  if (isRecord(lic) && typeof lic.type === "string" && lic.type.trim()) return lic.type.trim();
  if (Array.isArray(manifest.licenses)) {
    const types = manifest.licenses
      .map((l) => (isRecord(l) && typeof l.type === "string" ? l.type.trim() : ""))
      .filter(Boolean);
    if (types.length) return types.length === 1 ? (types[0] ?? null) : `(${types.join(" OR ")})`;
  }
  return null;
}

/**
 * Evaluate an SPDX expression against the allow-list. Throws on anything it cannot parse.
 * @param {string} expr
 * @param {readonly string[]} [allowed]
 * @returns {boolean}
 */
export function isAllowed(expr, allowed = ALLOWED) {
  const tokens = expr.replace(/\(/g, " ( ").replace(/\)/g, " ) ").split(/\s+/).filter(Boolean);
  if (!tokens.length) throw new Error("empty license expression");
  let i = 0;
  const peek = () => tokens[i];
  /** @returns {boolean} */
  const primary = () => {
    const t = tokens[i++];
    if (t === undefined) throw new Error(`unexpected end of license expression "${expr}"`);
    if (t === "(") {
      const v = orExpr();
      if (tokens[i++] !== ")") throw new Error(`unbalanced parentheses in "${expr}"`);
      return v;
    }
    if (/^(AND|OR|WITH|\))$/i.test(t)) throw new Error(`unexpected "${t}" in "${expr}"`);
    if (peek()?.toUpperCase() === "WITH") throw new Error(`license exception in "${expr}"`);
    // SPDX license ids match case-insensitively (SPDX spec, annex D)
    return allowed.some((a) => a.toLowerCase() === t.toLowerCase());
  };
  /** @returns {boolean} */
  const andExpr = () => {
    let v = primary();
    while (peek()?.toUpperCase() === "AND") {
      i++;
      const rhs = primary();
      v = v && rhs;
    }
    return v;
  };
  /** @returns {boolean} */
  function orExpr() {
    let v = andExpr();
    while (peek()?.toUpperCase() === "OR") {
      i++;
      const rhs = andExpr();
      v = v || rhs;
    }
    return v;
  }
  const result = orExpr();
  if (i !== tokens.length) throw new Error(`trailing tokens in license expression "${expr}"`);
  return result;
}

/**
 * @param {string} id
 * @param {unknown} manifest
 * @returns {string | null} an error message, or null when allowed
 */
export function checkManifest(id, manifest) {
  const lic = declaredLicense(manifest);
  if (lic === null) return `${id}: no license declared`;
  try {
    return isAllowed(lic) ? null : `${id}: license "${lic}" is not on the allow-list`;
  } catch (e) {
    return `${id}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * @param {string} root
 * @returns {number} exit code
 */
export function main(root) {
  const r = reporter("check-licenses");
  const tree = runtimeTree(root);
  for (const p of tree.problems) r.error(`npm ls: ${p}`);
  /** @type {Map<string, number>} */
  const tally = new Map();
  for (const node of tree.nodes.values()) {
    const id = `${node.name}@${node.version}`;
    let manifest;
    try {
      manifest = readJson(path.join(manifestDir(node, root), "package.json"));
    } catch (e) {
      r.error(`${id}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const err = checkManifest(id, manifest);
    if (err) r.error(err);
    const lic = declaredLicense(manifest) ?? "(none)";
    tally.set(lic, (tally.get(lic) ?? 0) + 1);
  }
  const summary = [...tally].map(([l, n]) => `${l}×${String(n)}`).join(", ");
  return r.finish(`${String(tree.nodes.size)} runtime package(s): ${summary || "none"}`);
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const root = typeof args.root === "string" ? path.resolve(args.root) : REPO_ROOT;
  try {
    process.exitCode = main(root);
  } catch (e) {
    process.stderr.write(`check-licenses: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 2;
  }
}
