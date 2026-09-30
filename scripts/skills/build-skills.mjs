#!/usr/bin/env node
// @ts-check
// build-skills.mjs — stamps the single-source shared text into every Skill (plan 09 §4 K4/K5, §2):
// copies skills/_shared/references/*.md byte-for-byte into each skills/<name>/references/, replaces
// every generated block in each SKILL.md body with its source file, and writes `metadata.version`
// (package.json) + `metadata.tool_contract` (skills/_shared/manifest.json) into each frontmatter.
// Zero dependencies. Idempotent. `--check` writes nothing and exits 1 when any output is stale.
//
// Usage: node scripts/skills/build-skills.mjs [--check] [--root <repo root>]
// Exit:  0 up to date / written · 1 stale (--check) or a structural error · 2 usage error.
import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  BEGIN_PREFIX,
  END_PREFIX,
  REPO_ROOT,
  SHARED_REFS_DIR,
  SKILLS_DIR,
  beginMarker,
  endMarker,
  errMsg,
  isMain,
  listSkillDirs,
  parseFrontmatter,
  readManifest,
  readPackageVersion,
} from "./_lib.mjs";

/** The temp-file names `writeAtomic` uses: `<target>.<pid>.<12 hex>.tmp`. */
export const TEMP_FILE_RE = /\.\d+\.[0-9a-f]{12}\.tmp$/;

/** Shared reference file names: lowercase kebab-case Markdown. */
export const SHARED_NAME_RE = /^[a-z0-9][a-z0-9-]*\.md$/;

/**
 * Read the shared references (only `*.md` files directly in skills/_shared/references/).
 * @param {string} skillsRoot
 * @returns {{ files: Map<string, string>, errors: string[] }}
 */
export function readSharedRefs(skillsRoot) {
  const dir = path.join(skillsRoot, SHARED_REFS_DIR);
  /** @type {Map<string, string>} */
  const files = new Map();
  /** @type {string[]} */
  const errors = [];
  if (!existsSync(dir)) return { files, errors: [`skills/${SHARED_REFS_DIR}: missing`] };
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const st = lstatSync(full);
    if (!st.isFile() || st.isSymbolicLink()) {
      errors.push(`skills/${SHARED_REFS_DIR}/${name}: only regular Markdown files are allowed`);
      continue;
    }
    if (!SHARED_NAME_RE.test(name)) {
      errors.push(`skills/${SHARED_REFS_DIR}/${name}: name must match ${String(SHARED_NAME_RE)}`);
      continue;
    }
    const text = readFileSync(full, "utf8");
    if (text.includes(BEGIN_PREFIX) || text.includes(END_PREFIX)) {
      errors.push(
        `skills/${SHARED_REFS_DIR}/${name}: a shared file may not contain generated markers`,
      );
      continue;
    }
    files.set(name, text);
  }
  if (files.size === 0 && errors.length === 0)
    errors.push(`skills/${SHARED_REFS_DIR}: no shared references`);
  return { files, errors };
}

/**
 * Replace every generated block in `body` with its source. A block is a BEGIN marker line naming a
 * shared file, any lines, and the matching END marker line. Unknown sources, nesting, a missing END,
 * an END without BEGIN, or a hand-edited marker line are errors.
 * @param {string} body
 * @param {Map<string, string>} shared
 * @param {string} where file label for errors
 * @returns {{ body: string, stamped: string[], errors: string[] }}
 */
export function stampBody(body, shared, where) {
  const lines = body.split("\n");
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const stamped = [];
  /** @type {string[]} */
  const errors = [];
  /** @type {{ file: string, line: number } | null} */
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const t = line.trim();
    if (t.startsWith(BEGIN_PREFIX)) {
      const file = t.slice(BEGIN_PREFIX.length).split(" ")[0] ?? "";
      if (open) {
        errors.push(
          `${where}:${String(i + 1)}: nested generated block (${file} inside ${open.file})`,
        );
        continue;
      }
      if (t !== beginMarker(file)) {
        errors.push(
          `${where}:${String(i + 1)}: malformed BEGIN marker — expected \`${beginMarker(file)}\``,
        );
      }
      const src = shared.get(file);
      if (src === undefined) {
        errors.push(`${where}:${String(i + 1)}: unknown shared source _shared/references/${file}`);
      }
      open = { file, line: i + 1 };
      out.push(beginMarker(file));
      if (src !== undefined) {
        out.push(...src.replace(/\n+$/, "").split("\n"));
        stamped.push(file);
      }
      continue;
    }
    if (t.startsWith(END_PREFIX)) {
      const file = t.slice(END_PREFIX.length).split(" ")[0] ?? "";
      if (!open) {
        errors.push(`${where}:${String(i + 1)}: END marker without a BEGIN (${file})`);
        continue;
      }
      if (file !== open.file || t !== endMarker(file)) {
        errors.push(
          `${where}:${String(i + 1)}: END marker does not match BEGIN ${open.file} (line ${String(open.line)})`,
        );
      }
      out.push(endMarker(open.file));
      open = null;
      continue;
    }
    if (!open) out.push(line); // lines inside a block are replaced by the source
  }
  if (open)
    errors.push(`${where}:${String(open.line)}: generated block ${open.file} has no END marker`);
  return { body: out.join("\n"), stamped, errors };
}

/**
 * Rewrite the frontmatter's `metadata:` block to the canonical two keys (inserted before the
 * closing `---` when absent). The rest of the frontmatter is left byte-for-byte.
 * @param {string} text the whole SKILL.md
 * @param {{ version: string, tool_contract: number }} meta
 * @returns {string}
 */
export function stampMetadata(text, meta) {
  const fm = parseFrontmatter(text); // throws on a malformed frontmatter
  const lines = text.split("\n");
  const head = lines.slice(1, fm.end);
  const block = [
    "metadata:",
    `  version: ${JSON.stringify(meta.version)}`,
    `  tool_contract: ${String(meta.tool_contract)}`,
  ];
  const at = head.findIndex((l) => /^metadata:\s*$/.test(l));
  /** @type {string[]} */
  let next;
  if (at === -1) {
    next = [...head, ...block];
  } else {
    let j = at + 1;
    while (j < head.length && /^\s+\S/.test(head[j] ?? "")) j++;
    next = [...head.slice(0, at), ...block, ...head.slice(j)];
  }
  return ["---", ...next, ...lines.slice(fm.end)].join("\n");
}

/**
 * Write `text` to `file` through a sibling temp file and a rename, so a concurrent reader (another
 * build, the checker, an editor) sees the old bytes or the new bytes, never a torn file.
 * @param {string} file
 * @param {string} text
 */
export function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${String(process.pid)}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, text, { flag: "wx" });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Compute every output of the build, and (unless `check`) write the changed ones. Nothing is
 * written when any error is found (all-or-nothing).
 * @param {{ root?: string, check?: boolean }} [opts]
 * @returns {{ changed: string[], errors: string[], skills: string[] }}
 */
export function buildSkills(opts = {}) {
  const root = opts.root ?? REPO_ROOT;
  const skillsRoot = path.join(root, SKILLS_DIR);
  /** @type {string[]} */
  const errors = [];
  /** @type {{ file: string, text: string }[]} */
  const writes = [];
  if (!existsSync(skillsRoot)) return { changed: [], errors: ["skills/: missing"], skills: [] };

  let version = "";
  let contract = 0;
  try {
    version = readPackageVersion(root);
  } catch (e) {
    errors.push(errMsg(e));
  }
  try {
    contract = readManifest(skillsRoot).tool_contract;
  } catch (e) {
    errors.push(errMsg(e));
  }
  const shared = readSharedRefs(skillsRoot);
  errors.push(...shared.errors);
  const listed = listSkillDirs(skillsRoot);
  errors.push(...listed.errors);

  for (const skill of listed.skills) {
    const dir = path.join(skillsRoot, skill);
    const skillFile = path.join(dir, "SKILL.md");
    const rel = `skills/${skill}/SKILL.md`;
    const text = readFileSync(skillFile, "utf8");
    let fmEnd = -1;
    try {
      fmEnd = parseFrontmatter(text).end;
    } catch (e) {
      errors.push(`${rel}: ${errMsg(e)}`);
      continue;
    }
    const lines = text.split("\n");
    const head = lines.slice(0, fmEnd + 1).join("\n");
    const stamped = stampBody(lines.slice(fmEnd + 1).join("\n"), shared.files, rel);
    errors.push(...stamped.errors);
    let next = `${head}\n${stamped.body}`;
    if (version && contract) {
      try {
        next = stampMetadata(next, { version, tool_contract: contract });
      } catch (e) {
        errors.push(`${rel}: ${errMsg(e)}`);
      }
    }
    if (next !== text) writes.push({ file: skillFile, text: next });

    // references: shared copies byte-for-byte; Skill-specific files must be `<skill>-*.md`
    const refDir = path.join(dir, "references");
    for (const [name, body] of shared.files) {
      const target = path.join(refDir, name);
      const cur = existsSync(target) ? readFileSync(target, "utf8") : null;
      if (cur !== body) writes.push({ file: target, text: body });
    }
    if (existsSync(refDir)) {
      for (const name of readdirSync(refDir).sort()) {
        if (shared.files.has(name)) continue;
        if (TEMP_FILE_RE.test(name)) {
          // another build's write in flight; a leftover one (a crashed build) fails --check
          if (opts.check)
            errors.push(`skills/${skill}/references/${name}: leftover temp file — delete it`);
          continue;
        }
        /** @type {import("node:fs").Stats} */
        let st;
        try {
          st = lstatSync(path.join(refDir, name));
        } catch {
          continue; // vanished between readdir and lstat (a concurrent rename)
        }
        if (
          !st.isFile() ||
          st.isSymbolicLink() ||
          !name.startsWith(`${skill}-`) ||
          !name.endsWith(".md")
        ) {
          errors.push(
            `skills/${skill}/references/${name}: not a shared copy and not a Skill-specific \`${skill}-*.md\` file (a stale generated copy? delete it)`,
          );
        }
      }
    }
  }

  const changed = writes.map((w) => path.relative(root, w.file).split(path.sep).join("/"));
  if (!opts.check && errors.length === 0) {
    for (const w of writes) writeAtomic(w.file, w.text);
  }
  return { changed, errors, skills: listed.skills };
}

/**
 * CLI entry.
 * @param {string[]} argv
 * @returns {number} exit code
 */
export function main(argv) {
  let check = false;
  /** @type {string | undefined} */
  let root;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") check = true;
    else if (a === "--root" && argv[i + 1] !== undefined) root = path.resolve(argv[++i] ?? "");
    else {
      process.stderr.write(
        `build-skills: unexpected argument ${String(a)}\nusage: build-skills.mjs [--check] [--root <dir>]\n`,
      );
      return 2;
    }
  }
  const r = buildSkills({ ...(root ? { root } : {}), check });
  for (const e of r.errors) process.stderr.write(`build-skills: ${e}\n`);
  if (r.errors.length) return 1;
  if (check) {
    if (r.changed.length) {
      process.stderr.write(
        `build-skills: ${String(r.changed.length)} generated file(s) are stale — run npm run build:skills:\n`,
      );
      for (const c of r.changed) process.stderr.write(`  ${c}\n`);
      return 1;
    }
    process.stdout.write(`build-skills: up to date (${String(r.skills.length)} Skill(s))\n`);
    return 0;
  }
  process.stdout.write(
    `build-skills: ${String(r.changed.length)} file(s) written, ${String(r.skills.length)} Skill(s)\n`,
  );
  return 0;
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
