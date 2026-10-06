#!/usr/bin/env node
// @ts-check
// a17-check.mjs — the Claude Code half of plan 10 A17, run headlessly: does Claude Code show the
// MODEL a tool result's `structuredContent` as well as its text? The fixture-only tool
// `ff_debug_echo` (plan 07 G3) puts a fresh 12-hex nonce ONLY in structuredContent; its text block
// says "nonce omitted from text". This script makes Claude Code call it once and decides from
// Claude Code's own stream-json transcript whether the tool_result it handed the model holds the
// nonce. Zero dependencies (Node built-ins only), like scan-secrets.mjs.
//
// What it runs (argument array, never a shell string; stdin closed; hard timeout; cwd = a fresh
// temp dir, so no project files or project instructions load):
//   claude -p "<prompt>" --mcp-config <tmp>/mcp.json --strict-mcp-config
//     --allowedTools mcp__ffx__ff_debug_echo --max-turns 4 --output-format stream-json --verbose
//     --no-session-persistence
// --allowedTools pre-approves the one tool; it does not remove Claude Code's built-in tools.
// User-level configuration still applies (~/.claude/settings.json, its hooks and plugins,
// ~/.claude/CLAUDE.md). --no-session-persistence keeps the session record out of
// ~/.claude/projects, which the temp-dir cleanup would not reach.
// where <tmp>/mcp.json is {"mcpServers":{"ffx":{"command":<this node>,"args":[<repo>/tests/smoke/fixture-serve.mjs]}}}.
// fixture-serve.mjs starts the BUILT server (dist/cli.js serve) in fixture mode over its own
// private temp home, config and cache dirs — this script never reads the owner's league config,
// and nothing it starts does. Claude Code and the server run in their own process group, which is
// stopped on timeout, on Ctrl-C/SIGTERM/SIGHUP and after the run: SIGTERM, then SIGKILL 3 s later
// for anything still holding the output pipes (no orphaned server).
//
// The decision (analyseRun, pure and unit-tested): only the `tool_result` blocks of
// `message.content` count — that is what the client hands the model. The `tool_use_result` field
// of the same line is Claude Code's internal record of the full tool output (it carries
// structuredContent whether or not the model sees it), so it is used only to cross-check the
// model's answer, never as evidence of visibility.
//
// Usage:
//   scripts/dev/with-node.sh node scripts/dev/a17-check.mjs [--timeout <seconds>] [--claude <path>] [--save <file>]
//   scripts/dev/with-node.sh node scripts/dev/a17-check.mjs --from <file>   re-analyse a saved transcript; runs nothing
//     --timeout   hard limit for the whole run (default 180 s)
//     --claude    the Claude Code CLI to run (default: `claude` on PATH)
//     --save      also write Claude Code's raw stream-json output to <file> (mode 0600, set even on
//                 an existing file); a file that cannot be opened is refused before anything runs
// Needs a build first (dist/cli.js) and a logged-in Claude Code (`claude auth login`).
//
// Output: on a verdict, one line on stdout plus the exact line to record in docs/HANDOFF.md
// "Build facts", e.g.  A17 Claude Code 2.1.0: structuredContent visible to the model: no (2026-10-06)
// Exit: 0 verdict reached (yes OR no — the printed line says which) · 1 unexpected internal error ·
// 2 setup/usage (bad option, dist/cli.js missing, the claude CLI not found, unreadable --from file,
// unwritable --save file) ·
// 3 Claude Code not logged in or its login expired (run `claude auth login`, then rerun) ·
// 4 the MCP server failed to connect, or does not list ff_debug_echo · 5 the tool was never called,
// or its call failed · 6 timeout · 7 malformed or inconclusive output · 130 interrupted (Ctrl-C,
// SIGTERM or SIGHUP — the CLI's process group is stopped and the temp dir removed first).
import { execFile, spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The repository root (this file lives in scripts/dev/). */
export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

/** The MCP server name in the temp config; Claude Code names the tool mcp__<server>__<tool>. */
export const SERVER_NAME = "ffx";
/** The plan 07 G3 spike tool (fixture mode only). */
export const TOOL = "ff_debug_echo";
export const MAX_TURNS = 4;
export const DEFAULT_TIMEOUT_S = 180;

/** Exit codes (see the header). */
export const EXIT = Object.freeze({
  ANSWERED: 0,
  INTERNAL: 1,
  SETUP: 2,
  AUTH: 3,
  SERVER: 4,
  NO_TOOL_CALL: 5,
  TIMEOUT: 6,
  MALFORMED: 7,
  INTERRUPTED: 130,
});

/**
 * @typedef {"visible" | "not-visible" | "cli-missing" | "auth" | "server-failed" | "no-tool-call" | "timeout" | "malformed"} Outcome
 */

/** @type {Readonly<Record<Outcome, number>>} */
const EXIT_FOR = Object.freeze({
  visible: EXIT.ANSWERED,
  "not-visible": EXIT.ANSWERED,
  "cli-missing": EXIT.SETUP,
  auth: EXIT.AUTH,
  "server-failed": EXIT.SERVER,
  "no-tool-call": EXIT.NO_TOOL_CALL,
  timeout: EXIT.TIMEOUT,
  malformed: EXIT.MALFORMED,
});

/** @param {string} server */
export const qualifiedTool = (server = SERVER_NAME) => `mcp__${server}__${TOOL}`;

/** The one prompt: call the tool once, then repeat any nonce it can see — never invent one. */
export const PROMPT = [
  `This is an automated client check. Call the tool ${qualifiedTool()} exactly once, with no arguments.`,
  "Then look at everything the tool result shows you.",
  "If you can see a 12-character lowercase hexadecimal nonce anywhere in it, reply with exactly one line: NONCE <the nonce>.",
  "If you cannot see one, reply with exactly one line: NO NONCE.",
  "Never guess or invent a value.",
].join(" ");

// --- configuration ------------------------------------------------------------------------------

/**
 * The temp MCP config: one stdio server, the fixture launcher run by this very Node. No `env`
 * key — fixture-serve.mjs sets its own private home/config/cache.
 * @param {{ nodePath: string, repoRoot: string, serverName?: string }} o
 */
export function buildMcpConfig(o) {
  return {
    mcpServers: {
      [o.serverName ?? SERVER_NAME]: {
        command: o.nodePath,
        args: [path.join(o.repoRoot, "tests", "smoke", "fixture-serve.mjs")],
      },
    },
  };
}

/**
 * The claude argument array. `--mcp-config` and `--allowedTools` are variadic in the CLI, so
 * each is followed by another `--` option, never by a positional.
 * @param {{ configPath: string, serverName?: string, prompt?: string, maxTurns?: number }} o
 * @returns {string[]}
 */
export function buildClaudeArgs(o) {
  return [
    "-p",
    o.prompt ?? PROMPT,
    "--mcp-config",
    o.configPath,
    "--strict-mcp-config",
    "--allowedTools",
    qualifiedTool(o.serverName ?? SERVER_NAME),
    "--max-turns",
    String(o.maxTurns ?? MAX_TURNS),
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
  ];
}

// --- the pure parser ----------------------------------------------------------------------------

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** @param {Iterable<string>} xs @returns {string[]} */
const unique = (xs) => [...new Set(xs)];

/**
 * One terminal-safe line: control characters become spaces, whitespace collapses, long text is cut.
 * @param {string} s
 * @param {number} [max]
 */
export function oneLine(s, max = 200) {
  const flat = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Splits Claude Code's stream-json output into events. Blank lines are skipped; a line that is not
 * a JSON object with a string `type` (a partial line, a stray warning, `null`, an array) is
 * counted in `badLines`, never thrown.
 * @param {string} text
 * @returns {{ events: Record<string, unknown>[], badLines: number }}
 */
export function parseStreamJson(text) {
  /** @type {Record<string, unknown>[]} */
  const events = [];
  let badLines = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    /** @type {unknown} */
    let v;
    try {
      v = JSON.parse(line);
    } catch {
      badLines++;
      continue;
    }
    if (isRecord(v) && typeof v.type === "string") events.push(v);
    else badLines++;
  }
  return { events, badLines };
}

/**
 * A message's content as blocks (a string content is one text block).
 * @param {unknown} content
 * @returns {Record<string, unknown>[]}
 */
function blocksOf(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

/**
 * The text a tool_result block hands the model: its string content, or every block of its array
 * (a text block by its text; any other block serialised, so nothing handed over is skipped).
 * @param {unknown} content
 */
export function toolResultText(content) {
  if (typeof content === "string") return content;
  if (content === undefined) return "";
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((b) => (isRecord(b) && b.type === "text" && typeof b.text === "string" ? b.text : JSON.stringify(b)))
    .join("\n");
}

/** A `"nonce": "<12 hex>"` pair (structuredContent rendered as JSON). */
const KEYED_RE = /"nonce"\s*:\s*"([0-9a-f]{12})"/g;
/**
 * A standalone 12-hex token: not inside a longer word or hex run, and not the tail of a hyphenated
 * id — the envelope's `request_id` is `r-<12 hex>`, and a UUID ends in a 12-hex group.
 */
const STANDALONE_RE = /(?<![0-9A-Za-z_-])[0-9a-f]{12}(?![0-9A-Za-z_-])/g;
/** The same, case-insensitive, for the model's answer (it may upper-case what it repeats). */
const ANSWER_RE = /(?<![0-9A-Za-z_-])[0-9A-Fa-f]{12}(?![0-9A-Za-z_-])/g;

/**
 * The nonce(s) in text handed to the model: the value of a `"nonce": "…"` pair when the text
 * holds one, else every standalone 12-hex token.
 * @param {string} text
 * @returns {string[]}
 */
export function findShownNonces(text) {
  const keyed = [...text.matchAll(KEYED_RE)].map((m) => m[1] ?? "");
  return unique(keyed.length > 0 ? keyed : (text.match(STANDALONE_RE) ?? []));
}

/**
 * Every standalone 12-hex token in the model's answer, lower-cased.
 * @param {string} text
 * @returns {string[]}
 */
export function findAnswerTokens(text) {
  return unique((text.match(ANSWER_RE) ?? []).map((t) => t.toLowerCase()));
}

/**
 * Collects every `nonce` property holding 12 hex chars (and any `"nonce": "…"` pair inside a
 * string) from Claude Code's internal record of a tool output.
 * @param {unknown} v
 * @param {Set<string>} into
 * @param {number} [depth]
 */
function collectRecordedNonces(v, into, depth = 0) {
  if (depth > 64) return;
  if (typeof v === "string") {
    for (const m of v.matchAll(KEYED_RE)) into.add(m[1] ?? "");
  } else if (Array.isArray(v)) {
    for (const x of v) collectRecordedNonces(x, into, depth + 1);
  } else if (isRecord(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (k === "nonce" && typeof x === "string" && /^[0-9a-f]{12}$/.test(x)) into.add(x);
      else collectRecordedNonces(x, into, depth + 1);
    }
  }
}

/**
 * Claude Code's not-logged-in / expired-login wording (the messages the 2.1 CLI ships), matched
 * only against error output — never against the model's own answer.
 */
export const AUTH_RE =
  /not logged in|run \/login|claude auth login|invalid api key|invalid auth token|oauth (?:token|session) (?:has )?(?:expired|revoked)|login expired|failed to authenticate|authentication[ _](?:error|failed)|api error:? 401\b/i;

/**
 * Why the server is unusable according to the init event, or null when it looks fine.
 * @param {Record<string, unknown>} init
 * @param {string} server
 */
function serverProblem(init, server) {
  const servers = Array.isArray(init.mcp_servers) ? init.mcp_servers.filter(isRecord) : [];
  const entry = servers.find((s) => s.name === server);
  if (entry === undefined)
    return `the MCP server "${server}" is not in Claude Code's server list (the --mcp-config file did not load)`;
  if (entry.status !== "connected")
    return `the MCP server "${server}" did not connect (status: ${oneLine(String(entry.status), 40)}); check that the built server starts: npm run smoke`;
  if (Array.isArray(init.tools) && !init.tools.includes(qualifiedTool(server)))
    return `the MCP server "${server}" connected but does not offer ${TOOL} (it is registered in fixture mode only)`;
  return null;
}

/**
 * @typedef {{
 *   stdout: string,
 *   stderr?: string,
 *   exitCode?: number | null,
 *   timedOut?: boolean,
 *   timeoutS?: number,
 *   spawnError?: string,
 *   serverName?: string,
 * }} RunInput
 * @typedef {{
 *   outcome: Outcome,
 *   exitCode: number,
 *   detail: string,
 *   visible: boolean | null,
 *   version: string | null,
 *   shownNonces: string[],
 *   recordedNonces: string[],
 *   modelTokens: string[],
 *   modelRepeated: boolean,
 *   finalAnswer: string | null,
 *   toolCalls: number,
 *   notes: string[],
 * }} Analysis
 */

/**
 * Decides A17 from one run of Claude Code. Pure: no I/O, never throws on bad input.
 * `visible` is set only on a verdict ("visible" / "not-visible"), which needs a completed run
 * (a `result` event, no timeout) with at least one successful ff_debug_echo tool_result.
 * @param {RunInput} input
 * @returns {Analysis}
 */
export function analyseRun(input) {
  const server = input.serverName ?? SERVER_NAME;
  const qualified = qualifiedTool(server);
  const { events, badLines } = parseStreamJson(input.stdout);
  /** @type {string[]} */
  const notes = [];
  if (badLines > 0) notes.push(`${String(badLines)} output line(s) were not stream-json events and were ignored`);

  /** @type {Record<string, unknown> | null} */
  let init = null;
  /** @type {Record<string, unknown> | null} */
  let result = null;
  /** @type {Set<string>} */
  const ourIds = new Set();
  /** @type {Set<string>} */
  const shown = new Set();
  /** @type {Set<string>} */
  const recorded = new Set();
  /** @type {string[]} */
  const toolErrors = [];
  /** @type {{ kind: string, text: string }[]} */
  const apiErrors = [];
  let toolCalls = 0;
  let okResults = 0;
  let resultsWithNonce = 0;
  /** @type {string | null} */
  let lastText = null;

  for (const ev of events) {
    if (ev.type === "system" && ev.subtype === "init") {
      init ??= ev;
      continue;
    }
    if (ev.type === "result") {
      result = ev;
      continue;
    }
    const msg = isRecord(ev.message) ? ev.message : null;
    if (msg === null) continue;
    const blocks = blocksOf(msg.content);
    if (ev.type === "assistant") {
      const text = blocks
        .map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : ""))
        .filter((t) => t !== "")
        .join("\n");
      // an API/auth error surfaces as a synthetic assistant message, not as the model speaking
      if (typeof ev.error === "string" || ev.is_api_error_message === true || msg.model === "<synthetic>") {
        apiErrors.push({ kind: typeof ev.error === "string" ? ev.error : "", text });
        continue;
      }
      for (const b of blocks)
        if (b.type === "tool_use" && b.name === qualified && typeof b.id === "string") {
          ourIds.add(b.id);
          toolCalls++;
        }
      if (text.trim() !== "") lastText = text;
    } else if (ev.type === "user") {
      let ours = false;
      for (const b of blocks) {
        if (b.type !== "tool_result" || typeof b.tool_use_id !== "string" || !ourIds.has(b.tool_use_id)) continue;
        ours = true;
        const text = toolResultText(b.content);
        if (b.is_error === true) {
          toolErrors.push(text);
          continue;
        }
        okResults++;
        const found = findShownNonces(text);
        if (found.length > 0) resultsWithNonce++;
        for (const n of found) shown.add(n);
      }
      if (ours && ev.tool_use_result !== undefined) collectRecordedNonces(ev.tool_use_result, recorded);
    }
  }

  const version =
    init !== null && typeof init.claude_code_version === "string" && init.claude_code_version.trim() !== ""
      ? oneLine(init.claude_code_version, 40)
      : null;
  const resultText = result !== null && typeof result.result === "string" ? result.result : null;
  const resultIsError =
    result !== null && (result.is_error === true || (typeof result.subtype === "string" && result.subtype !== "success"));
  const finalAnswer = result !== null && !resultIsError && resultText !== null ? resultText : lastText;
  const modelTokens = finalAnswer === null ? [] : findAnswerTokens(finalAnswer);
  const shownNonces = [...shown];
  const recordedNonces = [...recorded];
  const modelRepeated = modelTokens.some((t) => shown.has(t));

  /**
   * @param {Outcome} outcome
   * @param {string} detail
   * @param {boolean | null} [visible]
   * @returns {Analysis}
   */
  const done = (outcome, detail, visible = null) => ({
    outcome,
    exitCode: EXIT_FOR[outcome],
    detail,
    visible,
    version,
    shownNonces,
    recordedNonces,
    modelTokens,
    modelRepeated,
    finalAnswer,
    toolCalls,
    notes,
  });
  const partial = () => {
    if (okResults > 0)
      notes.push(`a tool result was seen before the run ended, and it ${shown.size > 0 ? "showed" : "did not show"} a nonce — rerun for a verdict`);
  };

  if (input.spawnError !== undefined)
    return done("cli-missing", `the claude CLI could not be started (${oneLine(input.spawnError)}): install Claude Code, or pass --claude <path>`);
  if (input.timedOut === true) {
    partial();
    return done("timeout", `Claude Code did not finish within ${input.timeoutS === undefined ? "the time limit" : `${String(input.timeoutS)} s`} and was stopped`);
  }

  if (okResults > 0 && result !== null) {
    if (recorded.size > 0 && shown.size > 0 && !shownNonces.some((n) => recorded.has(n)))
      return done(
        "malformed",
        `inconclusive: the tool result shows ${shownNonces.join(", ")}, but Claude Code recorded the nonce as ${recordedNonces.join(", ")}`,
      );
    const visible = shown.size > 0;
    if (!visible && modelTokens.some((t) => recorded.has(t)))
      return done(
        "malformed",
        "inconclusive: the model repeated the real nonce although the tool result handed to it never showed it — save the transcript (--save) and read it by hand",
      );
    if (visible && resultsWithNonce < okResults)
      notes.push(`${String(resultsWithNonce)} of ${String(okResults)} tool results showed a nonce`);
    if (visible && !modelRepeated)
      notes.push("the model did not repeat the nonce it was shown; the verdict rests on the tool result");
    if (!visible && modelTokens.length > 0)
      notes.push(`the model's answer holds ${modelTokens.join(", ")}, which no tool result showed it (an invented value)`);
    if (resultIsError)
      notes.push(
        `the run ended with an error after the tool call: ${oneLine(resultText !== null && resultText.trim() !== "" ? resultText : String(result.subtype))}`,
      );
    return visible
      ? done("visible", `the tool result Claude Code handed the model holds the nonce${modelRepeated ? ", and the model repeated it" : ""}`, true)
      : done("not-visible", "the tool result Claude Code handed the model holds no nonce (only the text block)", false);
  }

  /** @type {string[]} */
  const errorTexts = apiErrors.map((e) => e.text);
  if (resultIsError) {
    if (resultText !== null) errorTexts.push(resultText);
    if (result !== null && Array.isArray(result.errors))
      for (const e of result.errors) if (typeof e === "string") errorTexts.push(e);
  }
  const stderrAuth = (input.stderr ?? "").split(/\r?\n/).find((l) => AUTH_RE.test(l));
  const authText = errorTexts.find((t) => AUTH_RE.test(t)) ?? stderrAuth;
  const isAuth =
    apiErrors.some((e) => e.kind === "authentication_failed") ||
    authText !== undefined ||
    (result !== null && result.api_error_status === 401);
  const problem = init === null ? null : serverProblem(init, server);

  if (isAuth) {
    if (problem !== null) notes.push(problem);
    const shownText = authText ?? apiErrors[0]?.text ?? "";
    return done(
      "auth",
      `Claude Code is not logged in, or its login expired${shownText === "" ? "" : ` ("${oneLine(shownText, 120)}")`}. Run \`claude auth login\`, then rerun this check`,
    );
  }
  if (problem !== null) return done("server-failed", problem);
  if (toolErrors.length > 0) return done("no-tool-call", `the ${TOOL} call failed: ${oneLine(toolErrors[0] ?? "")}`);

  const exit = input.exitCode === undefined || input.exitCode === null ? "" : ` (exit ${String(input.exitCode)})`;
  const stderrTail = oneLine((input.stderr ?? "").trim().split(/\r?\n/).slice(-3).join(" / "));
  const stderrNote = stderrTail === "" ? "" : `; stderr: ${stderrTail}`;
  if (events.length === 0) return done("malformed", `Claude Code printed no stream-json${exit}${stderrNote}`);
  if (result === null) {
    partial();
    return done("malformed", `the run ended without a result event${exit}${stderrNote}`);
  }

  if (Array.isArray(result.permission_denials)) {
    const denied = unique(
      result.permission_denials.filter(isRecord).map((d) => (typeof d.tool_name === "string" ? d.tool_name : "?")),
    );
    if (denied.length > 0) notes.push(`permission denied for: ${denied.map((d) => oneLine(d, 60)).join(", ")}`);
  }
  if (toolCalls > 0) return done("no-tool-call", `${TOOL} was called but no tool result came back`);
  const message = errorTexts.find((t) => t.trim() !== "");
  const subtype = typeof result.subtype === "string" && result.subtype !== "success" ? ` (${oneLine(result.subtype, 60)})` : "";
  const why = resultIsError
    ? `the run ended with an error${subtype} before the tool was called${message === undefined ? "" : `: ${oneLine(message)}`}`
    : `the model never called ${TOOL}`;
  return done("no-tool-call", why);
}

// --- report -------------------------------------------------------------------------------------

/** @param {Date} d @returns {string} the LOCAL calendar date, YYYY-MM-DD */
export function isoDate(d) {
  const p = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return `${String(d.getFullYear())}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * The line to record in docs/HANDOFF.md "Build facts".
 * @param {string | null} version
 * @param {boolean} visible
 * @param {Date} date
 */
export function handoffLine(version, visible, date) {
  return `A17 Claude Code ${version ?? "(version unknown)"}: structuredContent visible to the model: ${visible ? "yes" : "no"} (${isoDate(date)})`;
}

/**
 * The verdict (stdout) or the failure (stderr), one line first, notes after.
 * @param {Analysis} a
 * @param {Date} now
 * @returns {{ stdout: string[], stderr: string[] }}
 */
export function formatReport(a, now) {
  const notes = a.notes.map((n) => `  note: ${n}`);
  if (a.visible === null) return { stdout: [], stderr: [`a17-check: no verdict (${a.outcome}): ${a.detail}`, ...notes] };
  return {
    stdout: [
      `a17-check: Claude Code ${a.version ?? "(version unknown)"} — structuredContent visible to the model: ${a.visible ? "yes" : "no"} (${a.detail})`,
      ...notes,
      'Record in docs/HANDOFF.md "Build facts":',
      handoffLine(a.version, a.visible, now),
    ],
    stderr: [],
  };
}

/**
 * "2.1.0 (Claude Code)" -> "2.1.0".
 * @param {string} text
 */
export function parseVersion(text) {
  const m = /^\s*v?(\d+\.\d+\.\d+[^\s]*)/.exec(text);
  return m?.[1] ?? null;
}

// --- the runner ---------------------------------------------------------------------------------

/**
 * @typedef {{
 *   stdout: string,
 *   stderr: string,
 *   exitCode: number | null,
 *   timedOut: boolean,
 *   interrupted: boolean,
 *   spawnError?: string,
 * }} RunResult
 */

/** stdout kept from one run; a transcript of this check is a few kilobytes. */
const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_CHARS = 64 * 1024;
/** Signals that interrupt the check; each stops the CLI's group before the script ends. */
const STOP_SIGNALS = /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"]);

/**
 * Runs the CLI with stdin closed, in its own process group, under a hard timeout. At the limit,
 * on SIGINT/SIGTERM/SIGHUP to this script, and when the CLI exits, the group gets SIGTERM (the
 * server shuts down cleanly on it) and SIGKILL 3 s later unless every process holding the output
 * pipes is gone by then. So nothing that holds the pipes outlives the check, and a completed run
 * whose leftover child ignores SIGTERM still gets its verdict about 3 s after the CLI exits, not
 * at the limit. A process that closes the pipes and ignores SIGTERM is not waited for.
 * @param {{ bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number }} o
 * @returns {Promise<RunResult>}
 */
export function runClaude(o) {
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const out = [];
    let outBytes = 0;
    let stderr = "";
    let timedOut = false;
    let interrupted = false;
    let exited = false;
    let settled = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let hardKill;
    const child = spawn(o.bin, o.args, {
      cwd: o.cwd,
      env: o.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    /** @param {NodeJS.Signals} sig */
    const killGroup = (sig) => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, sig);
      } catch {
        // the group is already gone
      }
    };
    const stop = () => {
      killGroup("SIGTERM");
      hardKill ??= setTimeout(() => {
        killGroup("SIGKILL");
      }, 3000);
    };
    const onSignal = () => {
      interrupted = true;
      stop();
    };
    const timer = setTimeout(() => {
      // a CLI that already exited finished its run: a leftover child being stopped is no timeout
      if (exited) return;
      timedOut = true;
      stop();
    }, o.timeoutMs);
    /** @param {RunResult} r */
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardKill);
      for (const sig of STOP_SIGNALS) process.removeListener(sig, onSignal);
      resolve(r);
    };
    for (const sig of STOP_SIGNALS) process.on(sig, onSignal);
    child.stdout.on("data", (/** @type {Buffer} */ b) => {
      if (outBytes >= MAX_STDOUT_BYTES) return;
      out.push(b);
      outBytes += b.length;
    });
    child.stderr.on("data", (/** @type {Buffer} */ b) => {
      stderr = (stderr + b.toString("utf8")).slice(-MAX_STDERR_CHARS);
    });
    child.on("error", (e) => {
      // a spawn failure (ENOENT, EACCES) has no pid and may never emit 'close'
      if (child.pid === undefined)
        finish({ stdout: "", stderr, exitCode: null, timedOut: false, interrupted, spawnError: e.message });
    });
    // the CLI is gone: whatever it started (the MCP server) gets SIGTERM now, and SIGKILL 3 s
    // later, rather than holding the pipes open until the time limit; 'close' follows once every
    // holder has exited
    child.on("exit", () => {
      exited = true;
      stop();
    });
    child.on("close", (code) => {
      finish({ stdout: Buffer.concat(out).toString("utf8"), stderr, exitCode: code, timedOut, interrupted });
    });
  });
}

/**
 * `<cli> --version`, for a run whose transcript carries no init event.
 * @param {string} bin
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<string | null>}
 */
function cliVersion(bin, env) {
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { env, cwd: tmpdir(), timeout: 15_000, encoding: "utf8" }, (err, stdout) => {
      resolve(err ? null : parseVersion(stdout));
    });
  });
}

const USAGE = `usage: scripts/dev/with-node.sh node scripts/dev/a17-check.mjs [--timeout <seconds>] [--claude <path>] [--save <file>]
       scripts/dev/with-node.sh node scripts/dev/a17-check.mjs --from <file>
Runs Claude Code headlessly against the fixture-mode server and reports whether it shows the model
a tool result's structuredContent (plan 10 A17). Needs dist/cli.js (build first) and a logged-in
Claude Code (claude auth login). Exit codes: see the header of this file.
`;

/**
 * @typedef {{ help: boolean, timeoutS: number, claude: string, save?: string, from?: string }} Options
 */

/**
 * @param {string[]} argv
 * @returns {Options}
 */
export function parseOptions(argv) {
  /** @type {Options} */
  const o = { help: false, timeoutS: DEFAULT_TIMEOUT_S, claude: "claude" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--help" || a === "-h") {
      o.help = true;
      continue;
    }
    if (!["--timeout", "--claude", "--save", "--from"].includes(a)) throw new Error(`unknown argument: ${a}`);
    const v = argv[++i];
    if (v === undefined || v === "" || v.startsWith("--")) throw new Error(`${a} needs a value`);
    if (a === "--timeout") {
      const s = Number(v);
      if (!Number.isFinite(s) || s <= 0 || s > 3600) throw new Error("--timeout must be a number of seconds in (0, 3600]");
      o.timeoutS = s;
    } else if (a === "--claude") o.claude = v;
    else if (a === "--save") o.save = v;
    else o.from = v;
  }
  return o;
}

/**
 * @typedef {{
 *   repoRoot?: string,
 *   nodePath?: string,
 *   env?: NodeJS.ProcessEnv,
 *   now?: Date,
 *   out?: (s: string) => void,
 *   err?: (s: string) => void,
 * }} Deps
 */

/**
 * @param {string[]} argv
 * @param {Deps} [deps]
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, deps = {}) {
  /** @type {(s: string) => void} */
  const out = deps.out ?? ((s) => void process.stdout.write(s));
  /** @type {(s: string) => void} */
  const err = deps.err ?? ((s) => void process.stderr.write(s));
  const repoRoot = deps.repoRoot ?? REPO_ROOT;
  const env = deps.env ?? process.env;
  /** @type {Options} */
  let opts;
  try {
    opts = parseOptions(argv);
  } catch (e) {
    err(`a17-check: ${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    return EXIT.SETUP;
  }
  if (opts.help) {
    out(USAGE);
    return EXIT.ANSWERED;
  }

  /** @type {Analysis} */
  let analysis;
  if (opts.from !== undefined) {
    let text;
    try {
      text = readFileSync(opts.from, "utf8");
    } catch (e) {
      err(`a17-check: cannot read ${opts.from}: ${e instanceof Error ? e.message : String(e)}\n`);
      return EXIT.SETUP;
    }
    analysis = analyseRun({ stdout: text });
  } else {
    const required = [
      { rel: path.join("dist", "cli.js"), fix: "build the server first (npm run build), then rerun" },
      { rel: path.join("tests", "smoke", "fixture-serve.mjs"), fix: "run this from a full checkout" },
    ];
    for (const { rel, fix } of required)
      if (!existsSync(path.join(repoRoot, rel))) {
        err(`a17-check: ${rel} is missing: ${fix}\n`);
        return EXIT.SETUP;
      }
    // --save is opened before the run, so a bad path costs nothing; the mode is set on the open
    // file, so an existing file becomes 0600 too
    /** @type {number | undefined} */
    let saveFd;
    if (opts.save !== undefined) {
      try {
        saveFd = openSync(opts.save, "w", 0o600);
        fchmodSync(saveFd, 0o600);
      } catch (e) {
        if (saveFd !== undefined) closeSync(saveFd);
        err(`a17-check: cannot write --save ${opts.save}: ${e instanceof Error ? e.message : String(e)}\n`);
        return EXIT.SETUP;
      }
    }
    const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "ff-a17-")));
    try {
      chmodSync(tmp, 0o700);
      const work = path.join(tmp, "work");
      mkdirSync(work, { mode: 0o700 });
      const configPath = path.join(tmp, "mcp.json");
      const config = buildMcpConfig({ nodePath: deps.nodePath ?? process.execPath, repoRoot });
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      const run = await runClaude({
        bin: opts.claude,
        args: buildClaudeArgs({ configPath }),
        cwd: work,
        env,
        timeoutMs: opts.timeoutS * 1000,
      });
      if (saveFd !== undefined) {
        // a failed save is reported, never allowed to cost the verdict
        try {
          writeFileSync(saveFd, run.stdout);
        } catch (e) {
          err(`a17-check: could not save the transcript to ${String(opts.save)}: ${e instanceof Error ? e.message : String(e)}\n`);
        }
      }
      if (run.interrupted) {
        err("a17-check: interrupted\n");
        return EXIT.INTERRUPTED;
      }
      analysis = analyseRun({ ...run, timeoutS: opts.timeoutS });
      // a verdict without an init event still needs a version for the HANDOFF line
      if (analysis.visible !== null && analysis.version === null)
        analysis.version = await cliVersion(opts.claude, env);
    } finally {
      if (saveFd !== undefined) closeSync(saveFd);
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  const report = formatReport(analysis, deps.now ?? new Date());
  if (report.stdout.length > 0) out(`${report.stdout.join("\n")}\n`);
  if (report.stderr.length > 0) err(`${report.stderr.join("\n")}\n`);
  return analysis.exitCode;
}

/** True when this module is the process entry point. */
function isMain() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMain()) process.exitCode = await main(process.argv.slice(2));
