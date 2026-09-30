#!/usr/bin/env node
/**
 * check-links.mjs — internal Markdown link checker.
 *
 * Zero dependencies: Node >= 22, ESM, imports nothing beyond `node:*`. Run locally or in CI
 * (`.github/workflows/docs.yml`, job `links`).
 *
 * What it checks
 *   For every `*.md` under --root (default: the repo root, i.e. the parent of `scripts/`), every
 *   inline link `[text](target)`, image `![alt](target)` and reference definition `[label]: target`
 *   whose target is relative (or repo-root-absolute, `/docs/x.md`, which GitHub resolves against the
 *   repository root) must point at an existing file or directory inside the repo. When the target
 *   carries a `#fragment`, the fragment must match a heading of the target Markdown file (GitHub's
 *   slug rules: lower-case, punctuation dropped, spaces to hyphens, duplicates suffixed -1, -2 …) or
 *   an explicit HTML `id=`/`name=` anchor. `#L12` / `#L12-L20` line fragments are accepted as-is.
 *
 * What it ignores, on purpose
 *   External links (anything with a scheme, or protocol-relative `//`) — flaky, a different check.
 *   Anything inside fenced code blocks or inline code spans — those are examples, not links.
 *   Reference-style *uses* `[text][label]` — the definition is what carries the path and is checked.
 *   `[citation]: prose that continues…` — not a definition (CommonMark: a definition ends after
 *   the destination and an optional quoted title), so citations in the research docs are prose.
 *   Any directory containing a `.docs-check-skip` file — that is how `scripts/docs-check-selftest/`
 *   (deliberately broken fixtures for this checker's own negative test) stays out of the real run.
 *
 * Usage
 *   node scripts/check-links.mjs [--root <dir>] [--verbose] [--no-annotate]
 *   --no-annotate  do not emit `::error` annotations / the step summary (used by the self-test step)
 *
 * Exit codes
 *   0  every internal link resolves
 *   1  at least one broken link; each is printed as `<file>:<line>: <target> — <reason>` (and as a
 *      `::error` annotation under GitHub Actions unless --no-annotate)
 *   2  usage error
 */

import { appendFile, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", "out", ".cache", "tmp", ".turbo"]);
const SKIP_MARKER = ".docs-check-skip"; // a directory containing this file is not scanned (self-test fixtures)

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), verbose: false, annotate: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") {
      const v = argv[++i];
      if (!v) usage("--root needs a value");
      opts.root = path.resolve(v);
    } else if (a === "--verbose" || a === "-v") {
      opts.verbose = true;
    } else if (a === "--no-annotate") {
      opts.annotate = false;
    } else if (a === "--help" || a === "-h") {
      usage();
    } else {
      usage(`unknown argument: ${a}`);
    }
  }
  return opts;
}

function usage(msg) {
  if (msg) console.error(`check-links: ${msg}`);
  console.error("usage: node scripts/check-links.mjs [--root <dir>] [--verbose] [--no-annotate]");
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------
// File walk
// ---------------------------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------------------------
// Markdown line model: skip fenced code blocks, blank out inline code spans
// ---------------------------------------------------------------------------------------------

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Yields { n, line } for every line that is not inside a fenced code block. */
function* proseLines(text) {
  const lines = text.split(/\r?\n/);
  let fence = null; // { ch, len }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = FENCE_RE.exec(line);
    if (fence) {
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && m[2].trim() === "") fence = null;
      continue;
    }
    if (m && !(m[1][0] === "`" && m[2].includes("`"))) {
      fence = { ch: m[1][0], len: m[1].length };
      continue;
    }
    yield { n: i + 1, line };
  }
}

/** Replaces inline code spans with spaces of equal length so columns are preserved. */
function stripCodeSpans(line) {
  return line.replace(/(?<!`)(`+)(?!`)([\s\S]*?)(?<!`)\1(?!`)/g, (m) => " ".repeat(m.length));
}

// ---------------------------------------------------------------------------------------------
// Headings → slugs (GitHub rules), plus explicit HTML anchors
// ---------------------------------------------------------------------------------------------

const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const NOT_PARAGRAPH_RE = /^(?: {4,}|\t|\s*(?:[-*+]|\d+[.)])\s|\s*>|\s*\||\s*#|\s*(?:-{3,}|\*{3,}|_{3,})\s*$)/;
const HTML_ANCHOR_RE = /<(?:a|h[1-6]|div|span|p|section)\b[^>]*?\b(?:id|name)\s*=\s*["']([^"']+)["']/gi;

function headingTexts(text) {
  const out = [];
  let prev = null; // previous prose line (for setext headings)
  for (const { line } of proseLines(text)) {
    const atx = ATX_RE.exec(line);
    if (atx) {
      out.push(atx[2] ?? "");
      prev = null;
      continue;
    }
    if (SETEXT_RE.test(line) && prev !== null && prev.trim() !== "" && !NOT_PARAGRAPH_RE.test(prev)) {
      out.push(prev.trim());
      prev = null;
      continue;
    }
    prev = line;
  }
  return out;
}

/** Rendered text of a heading: links/images → their text, code spans → their content, emphasis marks dropped. */
function renderedHeadingText(raw) {
  return raw
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[*_]{1,3}(?=\S)([^*_]+?)(?<=\S)[*_]{1,3}/g, "$1")
    .trim();
}

// github-slugger's punctuation list (what GitHub actually strips), and a broader Unicode variant;
// a fragment matching either is accepted so a legitimate anchor is never failed on a slug edge case.
const GH_STRIP_RE = /[ -⁯⸀-⹿\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g;
const UNI_STRIP_RE = /[^\p{L}\p{N}\p{M} _-]/gu;

function slugVariants(headings) {
  const make = (re) => {
    const seen = new Map();
    const set = new Set();
    for (const h of headings) {
      let s = renderedHeadingText(h).toLowerCase().replace(re, "").replace(/ /g, "-");
      const n = seen.get(s) ?? 0;
      seen.set(s, n + 1);
      if (n > 0) s = `${s}-${n}`;
      set.add(s);
    }
    return set;
  };
  return [make(GH_STRIP_RE), make(UNI_STRIP_RE)];
}

const loose = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

const anchorCache = new Map();
async function anchorsOf(file) {
  let entry = anchorCache.get(file);
  if (entry) return entry;
  const text = await readFile(file, "utf8");
  const [gh, uni] = slugVariants(headingTexts(text));
  const html = new Set();
  for (const { line } of proseLines(text)) {
    for (const m of line.matchAll(HTML_ANCHOR_RE)) html.add(m[1].toLowerCase());
  }
  const exact = new Set([...gh, ...uni, ...html]);
  const looseSet = new Set([...exact].map(loose));
  entry = { exact, looseSet };
  anchorCache.set(file, entry);
  return entry;
}

// ---------------------------------------------------------------------------------------------
// Link extraction
// ---------------------------------------------------------------------------------------------

// [text](dest "title") — text may nest one level of brackets; dest is <…> or a run without
// whitespace, allowing one level of balanced parentheses.
const INLINE_LINK_RE =
  /!?\[((?:[^[\]\\]|\\.|\[(?:[^[\]\\]|\\.)*\])*)\]\(\s*(<[^>\n]*>|(?:[^\s()\\]|\\.|\((?:[^\s()\\]|\\.)*\))*)(?:\s+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\)))?\s*\)/g;
// [label]: dest "optional title" — and then NOTHING else on the line (CommonMark); otherwise it is prose.
const REF_DEF_RE =
  /^ {0,3}\[((?:[^[\]\\]|\\.)+)\]:[ \t]*(<[^>\n]*>|\S+)(?:[ \t]+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\)))?[ \t]*$/;

function* linksIn(line) {
  const def = REF_DEF_RE.exec(line);
  if (def) {
    yield { text: def[1], dest: unwrap(def[2]) };
    return;
  }
  for (const m of line.matchAll(INLINE_LINK_RE)) yield { text: m[1], dest: unwrap(m[2]) };
}

const unwrap = (d) => (d.startsWith("<") && d.endsWith(">") ? d.slice(1, -1) : d).trim();
const isExternal = (d) => /^[a-z][a-z0-9+.-]*:/i.test(d) || d.startsWith("//");

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = opts.root;
  try {
    if (!(await stat(root)).isDirectory()) usage(`--root is not a directory: ${root}`);
  } catch {
    usage(`--root does not exist: ${root}`);
  }

  const broken = [];
  let files = 0;
  let checked = 0;
  let external = 0;
  let looseMatches = 0;
  const rel = (p) => path.relative(root, p).split(path.sep).join("/");

  for await (const file of walk(root)) {
    files++;
    const text = await readFile(file, "utf8");
    for (const { n, line } of proseLines(text)) {
      for (const { dest } of linksIn(stripCodeSpans(line))) {
        if (dest === "") continue;
        if (isExternal(dest)) {
          external++;
          continue;
        }
        checked++;
        const hash = dest.indexOf("#");
        let p = hash === -1 ? dest : dest.slice(0, hash);
        const frag = hash === -1 ? "" : dest.slice(hash + 1);
        p = p.replace(/\?.*$/, "");
        try {
          p = decodeURIComponent(p);
        } catch {
          /* keep the raw path; it will simply not resolve */
        }
        const fail = (reason) => broken.push({ file: rel(file), line: n, dest, reason });

        const target = p === "" ? file : p.startsWith("/") ? path.join(root, p) : path.resolve(path.dirname(file), p);
        const relTarget = path.relative(root, target);
        if (relTarget.startsWith("..") || path.isAbsolute(relTarget)) {
          fail("target escapes the repository root");
          continue;
        }
        let st;
        try {
          st = await stat(target);
        } catch {
          fail(p === "" ? "unreadable file" : "file or directory not found");
          continue;
        }
        if (frag === "") {
          if (opts.verbose) console.log(`ok    ${rel(file)}:${n}: ${dest}`);
          continue;
        }
        if (st.isDirectory()) {
          fail("fragment on a directory link");
          continue;
        }
        if (/^L\d+(?:-L\d+)?$/.test(frag)) continue; // blob line anchor
        if (!/\.(md|markdown)$/i.test(target)) continue; // fragments on non-Markdown files are not ours to judge
        let f = frag;
        try {
          f = decodeURIComponent(frag);
        } catch {
          /* raw */
        }
        f = f.toLowerCase();
        const { exact, looseSet } = await anchorsOf(target);
        if (exact.has(f)) {
          if (opts.verbose) console.log(`ok    ${rel(file)}:${n}: ${dest}`);
        } else if (looseSet.has(loose(f))) {
          looseMatches++;
          if (opts.verbose) console.log(`ok~   ${rel(file)}:${n}: ${dest} (loose anchor match)`);
        } else {
          fail(`no heading or anchor '#${frag}' in ${rel(target)}`);
        }
      }
    }
  }

  const annotate = opts.annotate && !!process.env.GITHUB_ACTIONS;
  for (const b of broken) {
    console.log(`${b.file}:${b.line}: ${b.dest} — ${b.reason}`);
    if (annotate) console.log(`::error file=${b.file},line=${b.line}::broken internal link ${b.dest} — ${b.reason}`);
  }
  const summary = `check-links: ${files} markdown files, ${checked} internal links checked (${external} external skipped, ${looseMatches} loose anchor matches), ${broken.length} broken`;
  console.log(summary);
  if (opts.annotate && process.env.GITHUB_STEP_SUMMARY) {
    const lines = [`### ${broken.length === 0 ? "Internal links: OK" : "Internal links: BROKEN"}`, "", summary, ""];
    for (const b of broken) lines.push(`- \`${b.file}:${b.line}\` → \`${b.dest}\` — ${b.reason}`);
    await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  }
  process.exit(broken.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`check-links: ${err?.stack ?? err}`);
  process.exit(2);
});
