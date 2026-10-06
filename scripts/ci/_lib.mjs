// @ts-check
// _lib.mjs — shared helpers for the zero-dependency supply-chain checks in scripts/ci/
// (docs/plan/04 §4.1 `supply-chain` job, R11; plan 02 S10). Node built-ins only.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Repository root (scripts/ci/ is two levels down). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * True when the module at `metaUrl` is the process entry point.
 * @param {string} metaUrl
 */
export function isMain(metaUrl) {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(path.resolve(entry)).href === metaUrl;
}

/**
 * Parse `--flag value` pairs and bare `--switch`es.
 * @param {string[]} argv
 * @returns {Record<string, string | true>}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string | true>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[a.slice(2)] = next;
      i++;
    } else {
      out[a.slice(2)] = true;
    }
  }
  return out;
}

/**
 * Read and parse a JSON file; the error names the file.
 * @param {string} file
 * @returns {unknown}
 */
export function readJson(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`invalid JSON in ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
export function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Run npm with an argument array (never a shell string) and return stdout. npm ls exits 1 when the
 * tree has problems but still prints JSON; the caller inspects `problems`.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
export function runNpm(args, cwd) {
  const r = spawnSync("npm", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, npm_config_update_notifier: "false", npm_config_fund: "false" },
  });
  if (r.error) throw new Error(`npm ${args.join(" ")} failed to start: ${r.error.message}`);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/**
 * `path` is the path npm printed; `dir` is where the package was found on disk (set when
 * flattenTree is given the project root). npm's text is not a path to trust: `npm ls --json`
 * prints any UUID-like path segment as `***` (its secret redaction), so a checkout under such a
 * directory gets printed paths that name no file.
 * @typedef {{ name: string, version: string, path?: string, dir?: string, resolved?: string }} TreeNode
 * @typedef {{ nodes: Map<string, TreeNode>, problems: string[] }} RuntimeTree
 */

/**
 * The directory the dependency `name` of the package in `fromDir` is installed in, found the way
 * Node resolves a bare specifier: `<d>/node_modules/<name>` for `fromDir` and each ancestor, up to
 * and including `root` and never above it. null when none of them holds a package.json.
 * @param {string} name
 * @param {string} fromDir
 * @param {string} root
 * @returns {string | null}
 */
export function resolveInstalled(name, fromDir, root) {
  const top = path.resolve(root);
  const inside = (/** @type {string} */ p) => {
    const rel = path.relative(top, p);
    return (
      rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
    );
  };
  let d = path.resolve(fromDir);
  while (inside(d)) {
    if (path.basename(d) !== "node_modules") {
      const candidate = path.join(d, "node_modules", name);
      if (existsSync(path.join(candidate, "package.json"))) return candidate;
    }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

/**
 * Flatten `npm ls --omit=dev --all --json --long` output into unique name@version nodes.
 * Deduped references carry no `path`; another occurrence of the same name@version does. With
 * `root`, each node's `dir` is looked up on disk from its parent's directory (resolveInstalled),
 * falling back to npm's printed path only when that path exists.
 * @param {unknown} ls
 * @param {string} [root]
 * @returns {RuntimeTree}
 */
export function flattenTree(ls, root) {
  if (!isRecord(ls)) throw new Error("npm ls output is not a JSON object");
  /** @type {Map<string, TreeNode>} */
  const nodes = new Map();
  /** @type {string[]} */
  const problems = [];
  if (Array.isArray(ls.problems)) for (const p of ls.problems) problems.push(String(p));

  /**
   * @param {unknown} deps
   * @param {number} depth
   * @param {string | undefined} fromDir the requiring package's directory (with `root` only)
   */
  const walk = (deps, depth, fromDir) => {
    if (!isRecord(deps)) return;
    if (depth > 200) throw new Error("npm ls tree deeper than 200 levels — refusing");
    for (const [name, raw] of Object.entries(deps)) {
      if (!isRecord(raw)) continue;
      if (raw.missing === true) problems.push(`missing: ${name}`);
      if (raw.invalid === true) problems.push(`invalid: ${name}`);
      if (raw.extraneous === true) problems.push(`extraneous: ${name}`);
      const version = typeof raw.version === "string" ? raw.version : "";
      if (!version) {
        problems.push(`no version for ${name}`);
        continue;
      }
      const key = `${name}@${version}`;
      const prev = nodes.get(key);
      /** @type {TreeNode} */
      const node = prev ?? { name, version };
      if (typeof raw.path === "string" && node.path === undefined) node.path = raw.path;
      if (typeof raw.resolved === "string" && node.resolved === undefined) {
        node.resolved = raw.resolved;
      }
      /** @type {string | undefined} */
      let dir;
      if (root !== undefined && fromDir !== undefined) {
        const printed =
          typeof raw.path === "string" && existsSync(path.join(raw.path, "package.json"))
            ? raw.path
            : undefined;
        dir = resolveInstalled(name, fromDir, root) ?? printed;
        if (dir !== undefined && node.dir === undefined) node.dir = dir;
      }
      nodes.set(key, node);
      walk(raw.dependencies, depth + 1, dir);
    }
  };
  walk(ls.dependencies, 0, root);
  return { nodes, problems };
}

/**
 * The runtime (production) dependency tree of the project at `root`.
 * @param {string} root
 * @returns {RuntimeTree}
 */
export function runtimeTree(root) {
  const r = runNpm(["ls", "--omit=dev", "--all", "--json", "--long"], root);
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    throw new Error(
      `npm ls did not print JSON (exit ${String(r.status)}): ${r.stderr.slice(0, 500)}`,
    );
  }
  return flattenTree(parsed, root);
}

/**
 * Where a node's installed package.json lives: the directory found on disk, else npm's printed
 * path, else the top-level node_modules entry.
 * @param {TreeNode} node
 * @param {string} root
 */
export function manifestDir(node, root) {
  return node.dir ?? node.path ?? path.join(root, "node_modules", node.name);
}

/**
 * Fail/warn reporter shared by every check.
 * @param {string} tool
 */
export function reporter(tool) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  return {
    errors,
    warnings,
    /** @param {string} m */
    error: (m) => errors.push(m),
    /** @param {string} m */
    warn: (m) => warnings.push(m),
    /** @param {string} okMessage @returns {number} */
    finish(okMessage) {
      for (const w of warnings) process.stderr.write(`${tool}: warning: ${w}\n`);
      if (errors.length) {
        process.stderr.write(`${tool}: FAILED (${String(errors.length)})\n`);
        for (const e of errors) process.stderr.write(`  - ${e}\n`);
        return 1;
      }
      process.stdout.write(`${tool}: ok — ${okMessage}\n`);
      return 0;
    },
  };
}
