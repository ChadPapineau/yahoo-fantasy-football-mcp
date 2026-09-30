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
//   node scripts/dev/scan-secrets.mjs [--staged] [--all] [--] <file>...
//     --staged  scan the STAGED content of the given files (git show :<file>)
//     --all     scan every tracked file (git ls-files)
// Exit: 0 clean · 1 findings · 2 usage/IO error.
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
    id: "yahoo-league-or-team-key",
    re: /\b\d{3}\.l\.(\d{4,8})(?:\.t\.\d{1,2})?\b/g,
    allow: (m) => /^1000\d?$/.test(m[1] ?? ""),
  },
  { id: "yahoo-guid", re: /xoauth_yahoo_guid["']?\s*[:=]\s*["']?([A-Z0-9]{26})/g, group: 1 },
  { id: "email-address", re: /\b[A-Za-z0-9._%+-]+@(?:gmail|yahoo|ymail|outlook|hotmail|icloud|me|aol|proton|protonmail)\.[a-z]{2,}\b/gi },
];

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

function readContent(file, staged) {
  if (staged) {
    try {
      return execFileSync("git", ["show", `:${file}`], { maxBuffer: 64 * 1024 * 1024 });
    } catch {
      return null; // deleted in the index
    }
  }
  if (!existsSync(file)) return null;
  const st = statSync(file);
  if (!st.isFile()) return null;
  return readFileSync(file);
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

const args = process.argv.slice(2);
let staged = false;
let all = false;
const files = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--staged") staged = true;
  else if (a === "--all") all = true;
  else if (a === "--") files.push(...args.slice(i + 1)), (i = args.length);
  else files.push(a);
}
if (all) {
  files.push(...execFileSync("git", ["ls-files", "-z"]).toString("utf8").split("\0").filter(Boolean));
}
if (!files.length) {
  process.stderr.write("scan-secrets: no files given (use --all or pass paths)\n");
  process.exit(2);
}

const deny = loadDenylist();
const findings = [];
let scanned = 0;
for (const file of files) {
  if (file === "scripts/dev/scan-secrets.mjs") continue; // this file names the patterns
  // the gitleaks self-test fixture is DELIBERATELY full of fake, well-formed secrets
  // (CI proves gitleaks fires on it); it is the only path excluded, by exact name
  if (file === "scripts/gitleaks-selftest/must-flag.txt") continue;
  let buf;
  try {
    buf = readContent(file, staged);
  } catch (e) {
    process.stderr.write(`scan-secrets: cannot read ${file}: ${e.message}\n`);
    process.exit(2);
  }
  if (!buf || isBinary(buf)) continue;
  if (buf.length > 8 * 1024 * 1024) {
    process.stderr.write(`scan-secrets: skipping ${file} (> 8 MB)\n`);
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
        if (rule.id === "email-address" && /noreply|example/i.test(value)) continue;
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
process.stdout.write(`scan-secrets: clean (${scanned} text file(s) scanned${deny.length ? `, local deny-list: ${deny.length} term(s)` : ""})\n`);
