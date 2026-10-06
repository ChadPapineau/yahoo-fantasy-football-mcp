#!/usr/bin/env node
// scan-secrets.mjs — zero-dependency secret + personal-identifier scanner.
//
// Runs locally BEFORE anything is committed (the pre-commit hook and
// scripts/dev/commit-paths.sh call it). It is a second, independent layer:
// gitleaks runs in CI (.github/workflows/secrets.yml) and GitHub push
// protection is enabled on the repo. Findings print the rule id and
// file:line only — never the matched value.
//
// Usage:
//   node scripts/dev/scan-secrets.mjs [--staged] [--all] [--index] [--identity] [--] <file>...
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
// Exit: 0 clean · 1 findings · 2 usage/IO error, or a file it cannot scan (QA-1-089: it fails
// closed — a file too large to read is an error, and a NUL byte only skips a file whose name is a
// known binary format; anything else is scanned as text).
//
// Suppression: a line containing `scan-secrets: allow` is skipped (use only for
// documented placeholders; gitleaks in CI does not honour this marker).
//
// Personal identifiers: an optional, LOCAL-ONLY deny-list is read from
// $FF_SCAN_DENYLIST or ~/.config/fantasy-football-mcp-dev/scan-denylist.txt
// (one case-insensitive substring per line, `#` comments). It never lives in
// the repo — it holds the very strings that must never enter it.

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
    // ANY mailbox (CLAUDE.md: never commit an email address); only no-reply and reserved
    // placeholder addresses pass (isPlaceholderEmail). The lookbehind starts a match only at the
    // beginning of a local-part run, which keeps the scan linear on long word-character lines.
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

function loadDenylist() {
  const p = process.env.FF_SCAN_DENYLIST || join(homedir(), ".config", "fantasy-football-mcp-dev", "scan-denylist.txt");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => normalise(l));
}

function normalise(s) {
  return s.toLowerCase().replace(/[‘’ʼ`]/g, "'");
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

const args = process.argv.slice(2);
let staged = false;
let all = false;
let index = false;
let identity = false;
const files = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--staged") staged = true;
  else if (a === "--all") all = true;
  else if (a === "--index") index = true;
  else if (a === "--identity") identity = true;
  else if (a === "--") files.push(...args.slice(i + 1)), (i = args.length);
  else files.push(a);
}

/** @param {unknown} e */
function fail(e) {
  process.stderr.write(`scan-secrets: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(2);
}

/** @type {{file: string, read: () => Buffer | null}[]} */
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
for (const { file, read } of targets) {
  if (file === "scripts/dev/scan-secrets.mjs") continue; // this file names the patterns
  // the gitleaks self-test fixture is DELIBERATELY full of fake, well-formed secrets
  // (CI proves gitleaks fires on it); it is the only path excluded, by exact name
  if (file === "scripts/gitleaks-selftest/must-flag.txt") continue;
  let buf;
  try {
    buf = read();
  } catch (e) {
    fail(e instanceof ScanError ? e : new Error(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`));
  }
  if (!buf) continue;
  if (isBinary(buf) && BINARY_EXT.test(file)) {
    binary++;
    continue;
  }
  scanned++;
  const lines = buf.toString("utf8").split(/\r?\n/);
  lines.forEach((line, idx) => {
    if (line.includes("scan-secrets: allow")) return;
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line)) !== null) {
        const value = rule.group ? (m[rule.group] ?? "") : m[0];
        if (rule.allow && rule.allow(m)) continue;
        if ((rule.id === "assigned-secret" || rule.id === "env-secret" || rule.id === "bearer-token") && PLACEHOLDER.test(value)) continue;
        // a filesystem path or URL named *_TOKEN_STORE / *_SECRET_FILE is a location, not a secret
        if ((rule.id === "assigned-secret" || rule.id === "env-secret") && /^(?:~\/|\/|\.\.?\/|\$\{?[A-Z_]|https?:\/\/)/.test(value)) continue;
        findings.push(`${file}:${idx + 1}  [${rule.id}]`);
        if (!rule.re.global) break;
      }
    }
    if (deny.length) {
      const n = normalise(line);
      if (deny.some((d) => n.includes(d))) findings.push(`${file}:${idx + 1}  [personal-identifier]`);
    }
  });
}

if (findings.length) {
  process.stderr.write(`scan-secrets: ${findings.length} finding(s) — NOTHING may be committed until each is removed:\n`);
  for (const f of findings) process.stderr.write(`  ${f}\n`);
  process.exit(1);
}
process.stdout.write(
  `scan-secrets: clean (${scanned} text file(s) scanned${binary ? `, ${binary} binary file(s) skipped` : ""}${identity ? ", commit identity ok" : ""}${deny.length ? `, local deny-list: ${deny.length} term(s)` : ""})\n`,
);
