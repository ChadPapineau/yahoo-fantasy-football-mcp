#!/usr/bin/env node
/**
 * check-mermaid.mjs — extract and (in CI) render every ```mermaid block in the repo.
 *
 * Zero dependencies: Node >= 22, ESM, imports nothing beyond `node:*`. The renderer it drives
 * (`@mermaid-js/mermaid-cli`, which pulls a Chromium) is only ever run in GitHub Actions
 * (`.github/workflows/docs.yml`, job `mermaid`) — never on a developer machine by this script.
 *
 * What it does
 *   1. Walks every `*.md` under --root and extracts each fenced block whose info string starts with
 *      `mermaid` (``` or ~~~ fences, any length, indented fences allowed) into
 *      `<out>/<file-slug>--<n>.mmd`, where n is the 1-based index of the block within its file.
 *      Directories containing a `.docs-check-skip` file are not scanned (that keeps
 *      `scripts/docs-check-selftest/`, the deliberately broken fixture, out of the real run).
 *   2. With --renderer "<cmd> [args…]": runs `<cmd> [args…] -i <block>.mmd -o <block>.svg` per block
 *      and fails for every block whose renderer exits non-zero, produces no SVG, or produces
 *      mermaid's own error diagram (`aria-roledescription="error"`) — so a silent pass is impossible.
 *      Without --renderer it only extracts and lists (the local, dependency-free mode).
 *
 * Usage
 *   node scripts/check-mermaid.mjs [--root <dir>] [--out <dir>] [--renderer "<cmd> [args…]"] [--verbose] [--no-annotate]
 *   (the renderer string is split on whitespace; no shell, no quoting)
 *   --no-annotate  do not emit `::error`/`::warning` annotations or the step summary (self-test step)
 *
 * Exit codes
 *   0  every block extracted (and, with --renderer, rendered)
 *   1  at least one block failed — printed as `FAIL <file> block <n> (line <l>): <error>` plus a
 *      `::error` annotation under GitHub Actions
 *   2  usage error or the renderer could not be started at all
 */

import { spawnSync } from "node:child_process";
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", "out", ".cache", "tmp", ".turbo"]);
const SKIP_MARKER = ".docs-check-skip"; // a directory containing this file is not scanned (self-test fixtures)
const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

function usage(msg) {
  if (msg) console.error(`check-mermaid: ${msg}`);
  console.error('usage: node scripts/check-mermaid.mjs [--root <dir>] [--out <dir>] [--renderer "<cmd> [args…]"] [--verbose] [--no-annotate]');
  process.exit(2);
}

function parseArgs(argv) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const opts = { root: path.resolve(here, ".."), out: null, renderer: null, verbose: false, annotate: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) usage(`${a} needs a value`);
      return v;
    };
    if (a === "--root") opts.root = path.resolve(next());
    else if (a === "--out") opts.out = path.resolve(next());
    else if (a === "--renderer") opts.renderer = next().trim().split(/\s+/).filter(Boolean);
    else if (a === "--verbose" || a === "-v") opts.verbose = true;
    else if (a === "--no-annotate") opts.annotate = false;
    else if (a === "--help" || a === "-h") usage();
    else usage(`unknown argument: ${a}`);
  }
  if (!opts.out) opts.out = path.join(process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? "/tmp", "mermaid-blocks");
  if (opts.renderer && opts.renderer.length === 0) usage("--renderer is empty");
  return opts;
}

async function* walk(dir, isRoot = true) {
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  if (!isRoot && entries.some((e) => e.isFile() && e.name === SKIP_MARKER)) return;
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(full, false);
    } else if (e.isFile() && /\.(md|markdown)$/i.test(e.name)) {
      yield full;
    }
  }
}

/** Returns [{ line, text }] for every mermaid block in a Markdown text (line = the opening fence, 1-based). */
export function extractMermaidBlocks(text) {
  const blocks = [];
  const lines = text.split(/\r?\n/);
  let fence = null; // { ch, len, indent, mermaid, start, body }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = FENCE_RE.exec(line);
    if (fence) {
      if (m && m[2][0] === fence.ch && m[2].length >= fence.len && m[3].trim() === "") {
        if (fence.mermaid) blocks.push({ line: fence.start, text: fence.body.join("\n") + "\n" });
        fence = null;
      } else if (fence.mermaid) {
        // CommonMark: up to the fence's own indentation is stripped from each content line
        fence.body.push(line.startsWith(fence.indent) ? line.slice(fence.indent.length) : line.replace(/^ +/, ""));
      }
      continue;
    }
    if (m && !(m[2][0] === "`" && m[3].includes("`"))) {
      const info = m[3].trim().toLowerCase();
      fence = { ch: m[2][0], len: m[2].length, indent: m[1], mermaid: /^mermaid(?:\s|$)/.test(info), start: i + 1, body: [] };
    }
  }
  return blocks;
}

function firstLine(text) {
  return text.split("\n").map((l) => l.trim()).find((l) => l !== "" && !l.startsWith("%%")) ?? "(empty)";
}

function lastLines(s, n) {
  const lines = (s ?? "").trim().split("\n");
  return lines.slice(-n).join("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  try {
    if (!(await stat(opts.root)).isDirectory()) usage(`--root is not a directory: ${opts.root}`);
  } catch {
    usage(`--root does not exist: ${opts.root}`);
  }
  await mkdir(opts.out, { recursive: true });
  const rel = (p) => path.relative(opts.root, p).split(path.sep).join("/");
  const annotate = opts.annotate && !!process.env.GITHUB_ACTIONS;

  // 1. extract
  const all = [];
  let files = 0;
  for await (const file of walk(opts.root)) {
    files++;
    const blocks = extractMermaidBlocks(await readFile(file, "utf8"));
    const slug = rel(file).replace(/\.(md|markdown)$/i, "").replace(/[^A-Za-z0-9._-]+/g, "__");
    for (let i = 0; i < blocks.length; i++) {
      const mmd = path.join(opts.out, `${slug}--${i + 1}.mmd`);
      await writeFile(mmd, blocks[i].text, "utf8");
      all.push({ file: rel(file), index: i + 1, line: blocks[i].line, mmd, kind: firstLine(blocks[i].text) });
    }
  }
  const filesWithBlocks = new Set(all.map((b) => b.file)).size;
  console.log(`check-mermaid: ${all.length} mermaid block(s) in ${filesWithBlocks} of ${files} markdown files → ${opts.out}`);
  if (all.length === 0) console.log(`${annotate ? "::warning::" : "warning: "}check-mermaid found no mermaid blocks — the check is vacuous on this tree`);

  // 2. render
  const failures = [];
  if (opts.renderer) {
    const [cmd, ...baseArgs] = opts.renderer;
    for (const b of all) {
      const svg = `${b.mmd}.svg`;
      const res = spawnSync(cmd, [...baseArgs, "-i", b.mmd, "-o", svg], { encoding: "utf8", timeout: 180_000 });
      let error = null;
      if (res.error) {
        console.error(`check-mermaid: cannot start renderer '${cmd}': ${res.error.message}`);
        process.exit(2);
      }
      if (res.status !== 0) {
        error = `renderer exit ${res.status ?? `signal ${res.signal}`}: ${lastLines(res.stderr || res.stdout, 8)}`;
      } else {
        try {
          const out = await readFile(svg, "utf8");
          if (out.length === 0) error = "renderer exited 0 but wrote an empty SVG";
          else if (/aria-roledescription="error"/.test(out)) error = "renderer produced mermaid's error diagram (parse error rendered, not thrown)";
        } catch {
          error = "renderer exited 0 but wrote no SVG";
        }
      }
      if (error) {
        failures.push({ ...b, error });
        console.log(`FAIL ${b.file} block ${b.index} (line ${b.line}): ${error}`);
        if (annotate) console.log(`::error file=${b.file},line=${b.line}::mermaid block ${b.index} failed to render: ${error.split("\n")[0]}`);
      } else {
        console.log(`OK   ${b.file} block ${b.index} (line ${b.line}) — ${b.kind}`);
      }
    }
  } else {
    for (const b of all) console.log(`LIST ${b.file} block ${b.index} (line ${b.line}) — ${b.kind}`);
  }

  const verdict = opts.renderer
    ? `check-mermaid: rendered ${all.length - failures.length}/${all.length}, failed ${failures.length}`
    : `check-mermaid: extracted ${all.length} block(s); no --renderer given, nothing rendered`;
  console.log(verdict);
  if (opts.annotate && process.env.GITHUB_STEP_SUMMARY) {
    const lines = [`### ${failures.length === 0 ? "Mermaid: OK" : "Mermaid: FAILED"}`, "", verdict, ""];
    for (const b of all) lines.push(`- ${failures.some((f) => f.mmd === b.mmd) ? "FAIL" : "ok"} \`${b.file}\` block ${b.index} (line ${b.line}) — ${b.kind}`);
    await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`check-mermaid: ${err?.stack ?? err}`);
    process.exit(2);
  });
}
