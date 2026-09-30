// @ts-check
// check-no-scripts.mjs — no runtime dependency, at any depth, may carry an install-time hook or a
// native build (docs/plan/04 §4.1 `supply-chain`; plan 02 S10). Node built-ins only.
//
// Fails on: scripts.preinstall/install/postinstall; `prepare` on a package NOT resolved from the
// npm registry (npm runs `prepare` for git/file/link installs, never for a registry tarball — a
// registry `prepare` is reported as a warning); `gypfile: true`; a binding.gyp file; a dependency on
// a native build/prebuilt-download helper; `hasInstallScript` in the lockfile; any npm ls problem.
//
// Usage: node scripts/ci/check-no-scripts.mjs [--root <dir>]
import { existsSync } from "node:fs";
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

export const INSTALL_HOOKS = Object.freeze(["preinstall", "install", "postinstall"]);
export const NATIVE_HELPERS = Object.freeze([
  "prebuild-install",
  "node-gyp",
  "node-gyp-build",
  "node-pre-gyp",
  "@mapbox/node-pre-gyp",
  "prebuildify",
  "cmake-js",
  "napi-postinstall",
]);
const REGISTRY = "https://registry.npmjs.org/";

/**
 * Inspect one installed package.
 * @param {{ id: string, dir: string, manifest: unknown, resolved?: string | undefined }} pkg
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function inspectPackage(pkg) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  const m = pkg.manifest;
  if (!isRecord(m)) {
    errors.push(`${pkg.id}: package.json is not an object`);
    return { errors, warnings };
  }
  const scripts = isRecord(m.scripts) ? m.scripts : {};
  for (const hook of INSTALL_HOOKS) {
    if (typeof scripts[hook] === "string") errors.push(`${pkg.id}: has a "${hook}" script`);
  }
  if (typeof scripts.prepare === "string") {
    const fromRegistry = typeof pkg.resolved === "string" && pkg.resolved.startsWith(REGISTRY);
    if (fromRegistry) {
      warnings.push(`${pkg.id}: has a "prepare" script (not run for a registry tarball)`);
    } else {
      errors.push(`${pkg.id}: has a "prepare" script and is not installed from the npm registry`);
    }
  }
  if (m.gypfile === true) errors.push(`${pkg.id}: gypfile: true (native build)`);
  if (existsSync(path.join(pkg.dir, "binding.gyp"))) {
    errors.push(`${pkg.id}: ships binding.gyp (native build)`);
  }
  for (const field of ["dependencies", "optionalDependencies"]) {
    const deps = m[field];
    if (!isRecord(deps)) continue;
    for (const helper of NATIVE_HELPERS) {
      if (helper in deps) errors.push(`${pkg.id}: depends on ${helper} (native/prebuilt download)`);
    }
  }
  return { errors, warnings };
}

/**
 * Runtime entries the lockfile marks `hasInstallScript` (npm records it at install time).
 * @param {unknown} lock
 * @returns {string[]}
 */
export function lockfileInstallScripts(lock) {
  if (!isRecord(lock) || !isRecord(lock.packages)) return [];
  /** @type {string[]} */
  const out = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === "" || !isRecord(entry)) continue;
    if (entry.dev === true || entry.devOptional === true) continue;
    if (entry.hasInstallScript === true) out.push(key);
  }
  return out;
}

/**
 * @param {string} root
 * @returns {number} exit code
 */
export function main(root) {
  const r = reporter("check-no-scripts");
  const tree = runtimeTree(root);
  for (const p of tree.problems) r.error(`npm ls: ${p}`);
  for (const node of tree.nodes.values()) {
    const id = `${node.name}@${node.version}`;
    const dir = manifestDir(node, root);
    let manifest;
    try {
      manifest = readJson(path.join(dir, "package.json"));
    } catch (e) {
      r.error(`${id}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const found = inspectPackage({ id, dir, manifest, resolved: node.resolved });
    found.errors.forEach(r.error);
    found.warnings.forEach(r.warn);
  }
  const lockPath = path.join(root, "package-lock.json");
  if (existsSync(lockPath)) {
    for (const k of lockfileInstallScripts(readJson(lockPath))) {
      r.error(`package-lock.json: ${k} hasInstallScript`);
    }
  }
  return r.finish(
    `${String(tree.nodes.size)} runtime package(s), no install hooks or native builds`,
  );
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const root = typeof args.root === "string" ? path.resolve(args.root) : REPO_ROOT;
  try {
    process.exitCode = main(root);
  } catch (e) {
    process.stderr.write(`check-no-scripts: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 2;
  }
}
