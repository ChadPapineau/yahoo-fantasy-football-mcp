#!/usr/bin/env node
// scan-secrets.mjs — zero-dependency secret + personal-identifier scanner.
//
// Runs locally BEFORE anything is committed (the pre-commit and commit-msg hooks and
// scripts/dev/commit-paths.sh call it). It is a second, independent layer:
// gitleaks runs in CI (.github/workflows/secrets.yml) and GitHub push
// protection is enabled on the repo. Findings print the rule id and
// file:line only — never the matched value.
//
// Usage:
//   node scripts/dev/scan-secrets.mjs [--staged] [--all] [--index] [--identity]
//                                     [--message <file>|-] [--editmsg <file>] [--] <file>...
//     --staged    scan the STAGED (index) blob of each given file; a path that is not in the
//                 index, or that cannot be read, is an error (exit 2) — never "clean"
//     --all       scan every tracked file (git ls-files)
//     --index     scan every blob the next commit adds or changes (index vs HEAD, any status but
//                 D — including type changes — read by object id, so no path is ever re-quoted);
//                 the pre-commit hook and commit-paths.sh use this (QA-1-088). It also refuses
//                 to ADD a path with an iCloud/Finder conflict-copy segment ("ci 2.yml",
//                 "src/cli 2/x.ts"); deleting one is never blocked
//     --identity  refuse an author or committer address that is not a no-reply or reserved
//                 placeholder address (QA-1-095); the address itself is never printed
//     --message   scan a commit message exactly as it will be stored (a file, or - for standard
//                 input): commit-paths.sh passes the bytes it hands to `git commit-tree` (QA-2-026)
//     --editmsg   scan the message file git hands a commit-msg hook: the subject, the body, every
//                 trailer and the comment lines too (with -m git keeps them); only lines below the
//                 scissors line that have the form of the diff `git commit -v` writes there are
//                 left out, since git drops that diff (QA-2-026)
//   A finding in a message prints as `commit message:<line>`. A missing or unreadable message file
//   is an error (exit 2), never clean.
// Exit: 0 clean · 1 findings · 2 usage/IO error, or a file it cannot scan (QA-1-089: it fails
// closed — a file too large to read is an error, and a NUL byte only skips a file whose name is a
// known binary format; anything else is scanned as text).
//
// Encodings (QA-1-089 d): a file that is valid UTF-8 with no NUL byte is read as UTF-8. Any other
// text — UTF-16 or UTF-32 with or without a byte-order mark, at either byte alignment, UTF-8 with
// stray NUL bytes, or Latin-1 — is matched in each of those readings, so a value is found in
// whichever encoding it was written. (UTF-32 is decoded in full when it has a byte-order mark;
// without one, its ASCII and Latin-1 text is still found.)
//
// Suppression: a line containing `scan-secrets: allow` is skipped by the pattern rules (use only
// for documented placeholders; gitleaks in CI does not honour this marker). The marker never hides a
// deny-listed name (a real name is never a placeholder), and it is not honoured in a commit message,
// which never needs a secret-shaped value. No file is exempt, this one included (QA-2-030): the
// gitleaks self-test fixture alone skips the pattern rules, all but the address rule.
//
// Personal identifiers: an optional, LOCAL-ONLY deny-list is read from
// $FF_SCAN_DENYLIST or ~/.config/fantasy-football-mcp-dev/scan-denylist.txt
// (one case-insensitive term per line, `#` comments). It never lives in
// the repo — it holds the very strings that must never enter it. A term is found however the gaps
// between its words are written (QA-2-027): any run of spaces, tabs, no-break or other Unicode
// spaces, line breaks (a wrapped comment or quote marker included: // # * > ;), hyphens,
// underscores, dots, slashes or plus signs — or no gap at all ("ExampleName"). A gap is never
// found inside a word: "Exam pleName" is not the name, and a one-word term is never matched across
// a gap ("ab cd" is not "abcd"). Invisible format characters (zero-width spaces, soft hyphens) are
// ignored; case, compatibility forms (full-width letters) and apostrophe variants are folded. A
// match that runs over a line break is reported at the line where it starts.

import { isUtf8 } from "node:buffer";
import { readFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const PLACEHOLDER =
  /example|placeholder|your[-_]|[-_]here\b|xxxx|dummy|fake|redacted|changeme|change[-_]me|<[^>]*>|\$\{|\bnot[-_]?a[-_]?real|sample|fixture|test[-_]?(?:token|secret|key|value)|lorem|abcdef0123|0123456789abcdef/i;

/** @type {{id:string, re:RegExp, group?:number, allow?:(m:RegExpExecArray)=>boolean}[]} */
const RULES = [
  { id: "private-key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g },
  { id: "yahoo-client-id", re: /dj0yJmk9[A-Za-z0-9=_-]{20,}/g },
  { id: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { id: "github-fine-grained-token", re: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g },
  { id: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/g },
  { id: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { id: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { id: "bearer-token", re: /\b[Bb]earer\s+([A-Za-z0-9._~+/-]{24,}=*)/g, group: 1 },
  {
    id: "assigned-secret",
    re: /(?:secret|token|passw(?:or)?d|api[_-]?key|client[_-]?secret|refresh[_-]?token|access[_-]?token)["']?\s*[:=]\s*["']([^"'\s]{16,})["']/gi,
    group: 1,
  },
  {
    id: "env-secret",
    re: /^\s*(?:export\s+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY)[A-Z0-9_]*\s*=\s*([^\s#'"]{12,})/gm,
    group: 1,
  },
  {
    // never narrower than .gitleaks.toml yahoo-league-key / yahoo-team-key: a 2–3 digit game id OR
    // a game code; case-insensitive (stricter than gitleaks); placeholders 1000 and 10000–10009
    // (tests/lint/scan-secrets.test.ts checks the two stay aligned, QA-1-089)
    id: "yahoo-league-or-team-key",
    re: /\b(?:\d{2,3}|nfl|mlb|nba|nhl)\.l\.(\d{4,8})(?:\.t\.\d{1,2})?\b/gi,
    allow: (m) => /^1000\d?$/.test(m[1] ?? ""),
  },
  { id: "yahoo-guid", re: /xoauth_yahoo_guid["']?\s*[:=]\s*["']?([A-Z0-9]{26})/g, group: 1 },
  {
    // ANY mailbox (CONTRIBUTING.md Security: never commit an email address); only no-reply and
    // reserved placeholder addresses pass (isPlaceholderEmail). The lookbehind starts a match only at
    // the beginning of a local-part run, which keeps the scan linear on long word-character lines.
    id: "email-address",
    re: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
    // not a mailbox: a no-reply/reserved address; the `git` SSH transport user (git@github.com:…);
    // or URL userinfo (https://user:pw@host — the authority of a scheme:// URL, not an address)
    allow: (m) =>
      isPlaceholderEmail(m[0]) || /^git@/i.test(m[0]) || /\/\/[^/\s@]*$/.test(m.input.slice(0, m.index)),
  },
];

/** RFC 2606 / RFC 6761 reserved names: never a real mailbox. */
const RESERVED_DOMAIN = /(?:^|\.)(?:example|invalid|test|localhost)$|^example\.(?:com|net|org)$/;

/**
 * True for an address that can never identify a person: a no-reply mailbox (GitHub's
 * users.noreply.github.com, noreply@…, no-reply@…) or one on a reserved domain.
 * @param {string} addr
 */
export function isPlaceholderEmail(addr) {
  const at = addr.lastIndexOf("@");
  if (at <= 0) return false;
  const local = addr.slice(0, at).toLowerCase();
  const domain = addr.slice(at + 1).toLowerCase();
  if (domain === "users.noreply.github.com") return true;
  if (/^no-?reply$/.test(local)) return true;
  return RESERVED_DOMAIN.test(domain);
}

/** A NUL byte skips a file only when its name is one of these binary formats (QA-1-089 d). */
const BINARY_EXT =
  /\.(?:png|jpe?g|gif|webp|ico|icns|bmp|tiff?|avif|heic|pdf|parquet|arrow|feather|sqlite3?|db|gz|tgz|zip|bz2|xz|zst|7z|jar|woff2?|ttf|otf|eot|wasm|mp3|mp4|m4a|mov|wav|ogg|webm|docx|xlsx|pptx|node|dylib|so|o|a|class|bin)$/i;

/** The largest file it reads; anything larger is an error, never skipped (QA-1-089 c). */
const MAX_SCAN_BYTES = (() => {
  const n = Number(process.env.FF_SCAN_MAX_BYTES);
  return Number.isSafeInteger(n) && n > 0 ? n : 64 * 1024 * 1024;
})();

/** @returns {{plain: string, re: RegExp | null}[]} each term as a plain line compares it, and as a
 * pattern over folded text in which every gap between its words is optional (null: nothing left) */
function loadDenylist() {
  const p = process.env.FF_SCAN_DENYLIST || join(homedir(), ".config", "fantasy-football-mcp-dev", "scan-denylist.txt");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const words = fold(l).split(" ").filter(Boolean);
      const re = words.length ? new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(" ?"), "g") : null;
      return { plain: normalise(l), re };
    });
}

/** Lower case, apostrophe variants folded: the plain per-line comparison. */
function normalise(s) {
  return s.toLowerCase().replace(/[‘’ʼ`]/g, "'");
}

/** Invisible characters: format characters (zero-width space and joiners, soft hyphen, BOM, bidi
 * marks) and control characters other than whitespace (a NUL between the letters of a UTF-32 text). */
const INVISIBLE = /[\p{Cf}\0-\x08\x0e-\x1f\x7f-\x9f]/gu;
/** What can stand between two words of a name (QA-2-027): whitespace of any kind, a dash, `_`, `.`,
 * `/`, `+`, and the markers that continue a wrapped comment or quote (`//`, `#`, `*`, `>`, `;`). */
const GAP = /[\s\p{Pd}_.\/+*#>;]+/gu;

/** A term or a line with case, compatibility forms and apostrophes folded, invisible characters
 * removed and every gap between words written as one space. */
function fold(s) {
  return normalise(s.normalize("NFKC")).replace(INVISIBLE, "").replace(GAP, " ").trim();
}

/** The last index i with starts[i] <= at (starts ascending, at >= starts[0]). */
function lastAtOrBefore(starts, at) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= at) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The 0-based lines where a deny-listed term starts (QA-2-027). The lines are folded and joined
 * into one text, so a name split by a line break is found, and each match maps back to the line
 * where it starts. Each gap between a term's words may be one space or none; no gap is ever added
 * inside a word, so a one-word term matches only as written. The plain per-line substring match is
 * kept too, so this is never narrower than a line-by-line check.
 * @param {string[]} lines
 * @param {{plain: string, re: RegExp | null}[]} terms
 * @returns {Set<number>}
 */
function denyHits(lines, terms) {
  const hits = new Set();
  let text = "";
  /** @type {number[]} */ const startAt = [];
  /** @type {number[]} */ const lineAt = [];
  lines.forEach((line, idx) => {
    const n = normalise(line);
    if (terms.some((t) => n.includes(t.plain))) hits.add(idx);
    const f = fold(line);
    if (!f) return;
    if (text) text += " ";
    startAt.push(text.length);
    lineAt.push(idx);
    text += f;
  });
  for (const { re } of terms) {
    if (!re) continue;
    re.lastIndex = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      hits.add(lineAt[lastAtOrBefore(startAt, m.index)]);
      re.lastIndex = m.index + 1;
    }
  }
  return hits;
}

class ScanError extends Error {}

/** @param {string[]} args */
function git(args, maxBuffer = 16 * 1024 * 1024) {
  return execFileSync("git", args, { maxBuffer, stdio: ["ignore", "pipe", "pipe"] });
}

/** Reads one blob by object id, refusing (ScanError) one larger than MAX_SCAN_BYTES. */
function readBlob(sha, file) {
  const size = Number(git(["cat-file", "-s", sha]).toString("utf8").trim());
  if (!(size >= 0)) throw new ScanError(`cannot size the staged blob of ${file}`);
  if (size > MAX_SCAN_BYTES) throw new ScanError(`${file} is ${String(size)} bytes, over the ${String(MAX_SCAN_BYTES)}-byte scan limit — it cannot be scanned, so it cannot be committed`);
  return git(["cat-file", "blob", sha], MAX_SCAN_BYTES + 1024);
}

/**
 * The index blob of `file` (--staged). A path missing from the index is an error, never
 * "deleted": callers only pass staged paths, and a mangled (e.g. C-quoted) name must not pass.
 */
function readStaged(file) {
  const out = git(["--literal-pathspecs", "ls-files", "-s", "-z", "--", file]).toString("utf8");
  const entries = out.split("\0").filter(Boolean);
  const exact = entries.filter((e) => e.slice(e.indexOf("\t") + 1) === file);
  if (exact.length !== 1) throw new ScanError(`${file} is not (uniquely) in the index`);
  const [mode, sha] = (exact[0] ?? "").split(/[ \t]/);
  if (mode === "160000") return null; // a submodule commit, not a blob
  return readBlob(sha ?? "", file);
}

function readWorktree(file) {
  if (!existsSync(file)) return null;
  const st = statSync(file);
  if (!st.isFile()) return null;
  if (st.size > MAX_SCAN_BYTES) throw new ScanError(`${file} is ${String(st.size)} bytes, over the ${String(MAX_SCAN_BYTES)}-byte scan limit — it cannot be scanned`);
  return readFileSync(file);
}

/**
 * Every blob the next commit adds or changes: `git diff --cached --raw -z --no-renames` (index
 * vs HEAD, or vs the empty tree before the first commit). NUL-separated, so no name is quoted;
 * every status except D is kept (A, M, T type change, …); blobs are read by object id.
 * @returns {{file: string, sha: string, status: string}[]}
 */
function indexEntries() {
  const raw = git(["diff", "--cached", "--raw", "-z", "--no-renames", "--no-abbrev", "--no-ext-diff", "--ignore-submodules=none"], 256 * 1024 * 1024)
    .toString("utf8")
    .split("\0");
  const entries = [];
  for (let i = 0; i < raw.length; i++) {
    const meta = raw[i];
    if (!meta) continue;
    if (!meta.startsWith(":")) throw new ScanError(`unexpected git diff --raw record: ${meta.slice(0, 40)}`);
    const [, newMode, , newSha, status = ""] = meta.slice(1).split(" ");
    const paths = /^[RC]/.test(status) ? 2 : 1;
    const file = raw[i + paths] ?? "";
    i += paths;
    if (status.startsWith("D") || newMode === "000000" || newMode === "160000") continue;
    if (!newSha || /^0+$/.test(newSha)) throw new ScanError(`${file}: no staged blob id (status ${status})`);
    entries.push({ file, sha: newSha, status });
  }
  return entries;
}

/**
 * True when any segment of a repo-relative path is an iCloud/Finder conflict copy: a space, a
 * number, then only dot-extensions ("ci 2.yml", "foo.test 3.ts", "cli 2", "Copy 12"). In an
 * iCloud-synced checkout these appear on their own; committing ".github/workflows/ci 2.yml" would
 * add a second CI workflow. "v2.ts", "round-2.md" and "Season 2026 notes.md" are not copies.
 * @param {string} file
 */
export function isConflictCopyName(file) {
  return file.split("/").some((segment) => / [0-9]+(\.[^.]+)*$/.test(segment));
}

/** The address in a `git var GIT_*_IDENT` line ("Name <addr> 1700000000 +0000"). */
function identEmail(which) {
  const ident = git(["var", which]).toString("utf8");
  const m = /<([^<>]*)>\s+\d+\s+[+-]\d{4}\s*$/.exec(ident.trim());
  return m?.[1] ?? "";
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** UTF-16 text from `offset` on, little- or big-endian (a trailing odd byte is dropped). */
function utf16(buf, offset, bigEndian) {
  const body = Buffer.from(buf.subarray(offset, offset + Math.max(0, (buf.length - offset) & ~1)));
  if (bigEndian) body.swap16();
  return body.toString("utf16le");
}

/** UTF-32 text (a code point that is out of range or a surrogate reads as U+FFFD). */
function utf32(buf, bigEndian) {
  const parts = [];
  for (let i = 0; i + 4 <= buf.length; i += 4) {
    const cp = bigEndian ? buf.readUInt32BE(i) : buf.readUInt32LE(i);
    parts.push(cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : "\ufffd");
  }
  return parts.join("");
}

/** The bytes with every NUL removed: ASCII written as UTF-16 or UTF-32, at any alignment. */
function withoutNul(buf) {
  const out = Buffer.allocUnsafe(buf.length);
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) out[n++] = buf[i] ?? 0;
  return out.subarray(0, n);
}

/** Latin-1 as files are really written: Windows-1252 (curly quotes at 0x91–0x94), per WHATWG. */
const CP1252 = new TextDecoder("windows-1252");

/**
 * Every reading of `buf` a value could hide in (QA-1-089 d). Valid UTF-8 with no NUL byte has one
 * reading. Anything else is also read as UTF-16 (both byte orders, both alignments), as UTF-32
 * when it starts with a UTF-32 byte-order mark, with its NUL bytes removed, and as Latin-1
 * (Windows-1252) when it holds no NUL but is not UTF-8 either.
 * @param {Buffer} buf
 * @returns {string[]}
 */
function readings(buf) {
  const utf8 = buf.toString("utf8");
  const nul = buf.includes(0);
  if (!nul && isUtf8(buf)) return [utf8];
  const out = [utf8];
  if (!nul) out.push(CP1252.decode(buf));
  for (const offset of [0, 1]) out.push(utf16(buf, offset, false), utf16(buf, offset, true));
  if (buf[0] === 0xff && buf[1] === 0xfe && buf[2] === 0 && buf[3] === 0) out.push(utf32(buf.subarray(4), false));
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 0xfe && buf[3] === 0xff) out.push(utf32(buf.subarray(4), true));
  if (nul) out.push(withoutNul(buf).toString("utf8"));
  return out;
}

/** git's scissors line, under any comment string (core.commentChar / core.commentString). */
const SCISSORS = /^\S+ -{24} >8 -{24}$/;
/** A line of the diff `git commit -v` writes below the scissors line (git drops it from the message). */
const DIFF_LINE =
  /^(?:[ +\-@\\]|diff --(?:git|cc|combined) |index [0-9a-f,]+\.\.|(?:old|new) mode |(?:deleted|new) file mode |(?:dis)?similarity index |rename (?:from|to) |copy (?:from|to) |Binary files |Submodule )/;

/** A commit-msg hook's message with the `git commit -v` diff blanked (line numbers are kept). */
function withoutVerboseDiff(text) {
  const lines = text.split(/\r?\n/);
  const cut = lines.findIndex((l) => SCISSORS.test(l));
  if (cut === -1) return text;
  return lines.map((l, i) => (i > cut && DIFF_LINE.test(l) ? "" : l)).join("\n");
}

/** A commit message file (or - for standard input); a missing or unreadable one is a ScanError. */
function readMessage(file) {
  if (file === "-") return readFileSync(0);
  if (!existsSync(file) || !statSync(file).isFile()) throw new ScanError(`commit message file ${file} cannot be read — the message cannot be scanned`);
  const st = statSync(file);
  if (st.size > MAX_SCAN_BYTES) throw new ScanError(`commit message file ${file} is over the ${String(MAX_SCAN_BYTES)}-byte scan limit — it cannot be scanned`);
  return readFileSync(file);
}

/** @param {unknown} e */
function fail(e) {
  process.stderr.write(`scan-secrets: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
let staged = false;
let all = false;
let index = false;
let identity = false;
const files = [];
/** @type {{file: string, editmsg: boolean}[]} */
const messages = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--staged") staged = true;
  else if (a === "--all") all = true;
  else if (a === "--index") index = true;
  else if (a === "--identity") identity = true;
  else if (a === "--message" || a === "--editmsg") {
    const file = args[++i];
    if (file === undefined || file === "") fail(`${a} needs a message file (or - for standard input)`);
    messages.push({ file: file ?? "", editmsg: a === "--editmsg" });
  } else if (a === "--") files.push(...args.slice(i + 1)), (i = args.length);
  else files.push(a);
}

/** @type {{file: string, read: () => Buffer | null, message?: boolean, editmsg?: boolean}[]} */
const targets = [];
/** Paths refused for their NAME, before any content is read. */
const nameFindings = [];
try {
  if (identity) {
    for (const which of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
      if (!isPlaceholderEmail(identEmail(which))) {
        process.stderr.write(
          `scan-secrets: commit identity refused — the ${which === "GIT_AUTHOR_IDENT" ? "author" : "committer"} address is not a no-reply or reserved placeholder address (address not printed).\n` +
            "  Set one for this clone:  git config user.email '<id>+<login>@users.noreply.github.com'\n",
        );
        process.exit(1);
      }
    }
  }
  if (all) {
    for (const f of git(["ls-files", "-z"], 64 * 1024 * 1024).toString("utf8").split("\0").filter(Boolean)) {
      targets.push({ file: f, read: () => readWorktree(f) });
    }
  }
  if (index) {
    for (const { file, sha, status } of indexEntries()) {
      if (status.startsWith("A") && isConflictCopyName(file)) nameFindings.push(`${file}  [conflict-copy-name]`);
      targets.push({ file, read: () => readBlob(sha, file) });
    }
  }
  for (const f of files) targets.push({ file: f, read: () => (staged ? readStaged(f) : readWorktree(f)) });
  for (const m of messages) targets.push({ file: "commit message", read: () => readMessage(m.file), message: true, editmsg: m.editmsg });
} catch (e) {
  fail(e);
}
if (!targets.length && !index && !identity) {
  process.stderr.write("scan-secrets: no files given (use --all, --index or pass paths)\n");
  process.exit(2);
}

const deny = loadDenylist();
const findings = [...nameFindings];
let scanned = 0;
let binary = 0;
let messageScanned = false;
/** The gitleaks self-test fixture is DELIBERATELY full of fake, well-formed secrets (CI proves
 * gitleaks fires on it). By exact name, it skips the pattern rules — all but the address rule: that
 * rule and the deny-list still apply, and no other file is exempt, this one included. */
const FIXTURE = "scripts/gitleaks-selftest/must-flag.txt";
const FIXTURE_RULES = RULES.filter((r) => r.id === "email-address");
/** Report order: line, then rule (RULES order, the deny-list last). */
const ORDER = [...RULES.map((r) => r.id), "personal-identifier"];

/**
 * Findings in one reading of a text: `line\trule` -> how many times (1-based lines).
 * @param {string} text
 * @param {typeof RULES} rules
 * @param {boolean} honourAllow
 */
function scanText(text, rules, honourAllow) {
  /** @type {Map<string, number>} */
  const found = new Map();
  const add = (/** @type {number} */ idx, /** @type {string} */ id) => {
    const k = `${String(idx + 1)}\t${id}`;
    found.set(k, (found.get(k) ?? 0) + 1);
  };
  const lines = text.split(/\r?\n/);
  lines.forEach((line, idx) => {
    if (honourAllow && line.includes("scan-secrets: allow")) return;
    for (const rule of rules) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line)) !== null) {
        const value = rule.group ? (m[rule.group] ?? "") : m[0];
        if (rule.allow && rule.allow(m)) continue;
        if ((rule.id === "assigned-secret" || rule.id === "env-secret" || rule.id === "bearer-token") && PLACEHOLDER.test(value)) continue;
        // a filesystem path or URL named *_TOKEN_STORE / *_SECRET_FILE is a location, not a secret
        if ((rule.id === "assigned-secret" || rule.id === "env-secret") && /^(?:~\/|\/|\.\.?\/|\$\{?[A-Z_]|https?:\/\/)/.test(value)) continue;
        add(idx, rule.id);
        if (!rule.re.global) break;
      }
    }
  });
  if (deny.length) for (const idx of denyHits(lines, deny)) add(idx, "personal-identifier");
  return found;
}

for (const target of targets) {
  const { file, read } = target;
  let buf;
  try {
    buf = read();
  } catch (e) {
    fail(e instanceof ScanError ? e : new Error(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`));
  }
  if (!buf) continue;
  if (!target.message && isBinary(buf) && BINARY_EXT.test(file)) {
    binary++;
    continue;
  }
  if (target.message) messageScanned = true;
  else scanned++;
  const rules = !target.message && file === FIXTURE ? FIXTURE_RULES : RULES;
  /** @type {Map<string, number>} the most any one reading found, per line and rule */
  const found = new Map();
  for (const reading of readings(buf)) {
    const text = target.editmsg ? withoutVerboseDiff(reading) : reading;
    for (const [k, n] of scanText(text, rules, !target.message)) found.set(k, Math.max(found.get(k) ?? 0, n));
  }
  const sorted = [...found].map(([k, n]) => {
    const [line = "0", id = ""] = k.split("\t");
    return { line: Number(line), id, n };
  });
  sorted.sort((a, b) => a.line - b.line || ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  for (const { line, id, n } of sorted) for (let i = 0; i < n; i++) findings.push(`${file}:${String(line)}  [${id}]`);
}

if (findings.length) {
  process.stderr.write(`scan-secrets: ${findings.length} finding(s) — NOTHING may be committed until each is removed:\n`);
  for (const f of findings) process.stderr.write(`  ${f}\n`);
  process.exit(1);
}
process.stdout.write(
  `scan-secrets: clean (${scanned} text file(s) scanned${binary ? `, ${binary} binary file(s) skipped` : ""}${identity ? ", commit identity ok" : ""}${messageScanned ? ", commit message ok" : ""}${deny.length ? `, local deny-list: ${deny.length} term(s)` : ""})\n`,
);
