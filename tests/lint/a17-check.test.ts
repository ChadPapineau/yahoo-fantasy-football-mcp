// a17-check.test.ts — scripts/dev/a17-check.mjs decides plan 10 A17 (does Claude Code show the MODEL
// a tool result's structuredContent?) from Claude Code's stream-json transcript. Adversarial by
// default: every transcript is hand-written in the shape the 2.1 CLI emits, with the envelope built
// by the server's own buildEnvelope and a fresh nonce per run. The decisive trap is the
// `tool_use_result` field: Claude Code's internal record of the FULL tool output, which carries
// structuredContent whether or not the model sees it — a check that read it would always say "yes".
// The real CLI is never run here; the end-to-end cases drive main() against a stub `claude` (a POSIX
// sh script) that records what it was handed and replays a transcript.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTH_RE,
  DEFAULT_TIMEOUT_S,
  EXIT,
  MAX_TURNS,
  PROMPT,
  SERVER_NAME,
  TOOL,
  analyseRun,
  buildClaudeArgs,
  buildMcpConfig,
  findAnswerTokens,
  findShownNonces,
  formatReport,
  handoffLine,
  isoDate,
  main,
  oneLine,
  parseOptions,
  parseStreamJson,
  parseVersion,
  qualifiedTool,
  toolResultText,
} from "../../scripts/dev/a17-check.mjs";
import { buildEnvelope } from "../../src/mcp/envelope.js";
import { DEBUG_TOOL_NAME } from "../../src/mcp/registry.js";
import { DEBUG_ECHO_TEXT } from "../../src/mcp/tools/ops.js";
import { ROOT, tempDir } from "./helpers.js";

const SCRIPT = path.join(ROOT, "scripts", "dev", "a17-check.mjs");
const Q = qualifiedTool();
const SESSION = "4f0c2a8e-7d1b-4c3a-9e6f-0a1b2c3d4e5f";
const VERSION = "9.8.7";

type Ev = Record<string, unknown>;
const hex12 = () => randomBytes(6).toString("hex");

function init(over: Ev = {}): Ev {
  return {
    type: "system",
    subtype: "init",
    cwd: "/tmp/ff-a17-x/work",
    session_id: SESSION,
    tools: ["Bash", "Read", Q],
    mcp_servers: [{ name: SERVER_NAME, status: "connected" }],
    model: "claude-test-model",
    permissionMode: "default",
    apiKeySource: "none",
    claude_code_version: VERSION,
    ...over,
  };
}
function call(id = "toolu_01", name = Q): Ev {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      model: "claude-test-model",
      content: [{ type: "tool_use", id, name, input: {} }],
    },
    parent_tool_use_id: null,
    session_id: SESSION,
  };
}
function toolResult(
  content: unknown,
  opts: { id?: string; isError?: boolean; record?: unknown } = {},
): Ev {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: opts.id ?? "toolu_01",
          content,
          ...(opts.isError === true ? { is_error: true } : {}),
        },
      ],
    },
    parent_tool_use_id: null,
    session_id: SESSION,
    ...(opts.record === undefined ? {} : { tool_use_result: opts.record }),
  };
}
function say(text: string): Ev {
  return {
    type: "assistant",
    message: { role: "assistant", model: "claude-test-model", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    session_id: SESSION,
  };
}
function result(text: string, over: Ev = {}): Ev {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1200,
    num_turns: 2,
    result: text,
    stop_reason: "end_turn",
    session_id: SESSION,
    total_cost_usd: 0,
    permission_denials: [],
    ...over,
  };
}
const jsonl = (...lines: (Ev | string)[]): string =>
  `${lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")}\n`;

/** structuredContent exactly as ff_debug_echo builds it (its request_id ends in 12 hex too). */
const envelope = (nonce: string) =>
  JSON.parse(
    JSON.stringify(
      buildEnvelope({
        data: { nonce },
        requestId: `r-${hex12()}`,
        nowMs: Date.UTC(2026, 9, 6, 12),
        inputs: [],
      }),
    ),
  ) as Record<string, unknown>;
const TEXT_ONLY = [{ type: "text", text: DEBUG_ECHO_TEXT }];
/** What a client that forwards structuredContent hands the model: the text block + the JSON. */
const withStructured = (nonce: string) => [
  ...TEXT_ONLY,
  { type: "text", text: JSON.stringify(envelope(nonce)) },
];
/** Claude Code's internal record of the full output — it carries structuredContent either way. */
const record = (nonce: string) => ({ content: TEXT_ONLY, structuredContent: envelope(nonce) });

/** A complete run in which the model saw `content` and answered `answer`. */
const run = (content: unknown, answer: string, rec?: unknown) =>
  jsonl(
    init(),
    call(),
    toolResult(content, rec === undefined ? {} : { record: rec }),
    say(answer),
    result(answer),
  );

describe("the check's constants track the server", () => {
  it("calls the server's fixture-only debug tool, and the server's text block holds no nonce", () => {
    expect(TOOL).toBe(DEBUG_TOOL_NAME);
    expect(Q).toBe(`mcp__${SERVER_NAME}__${DEBUG_TOOL_NAME}`);
    expect(findShownNonces(DEBUG_ECHO_TEXT)).toEqual([]);
  });

  it("the real envelope's request_id (r-<12 hex>) is never read as a nonce", () => {
    const env = envelope(hex12());
    const meta = env.meta as Record<string, unknown>;
    expect(meta.request_id).toMatch(/^r-[0-9a-f]{12}$/);
    expect(findShownNonces(meta.request_id as string)).toEqual([]);
  });
});

describe("analyseRun — the visibility verdict", () => {
  it("yes: the tool result handed to the model holds the nonce and the model repeats it", () => {
    const n = hex12();
    const a = analyseRun({ stdout: run(withStructured(n), `NONCE ${n}`, record(n)) });
    expect(a.outcome).toBe("visible");
    expect(a.exitCode).toBe(EXIT.ANSWERED);
    expect(a.visible).toBe(true);
    expect(a.shownNonces).toEqual([n]); // the nonce, not the request_id's hex
    expect(a.modelRepeated).toBe(true);
    expect(a.version).toBe(VERSION);
    expect(a.toolCalls).toBe(1);
    expect(a.notes).toEqual([]);
  });

  it("no: the nonce is only in Claude Code's internal record (tool_use_result), never in the tool result", () => {
    const n = hex12();
    const a = analyseRun({ stdout: run(TEXT_ONLY, "NO NONCE", record(n)) });
    expect(a.outcome).toBe("not-visible");
    expect(a.exitCode).toBe(EXIT.ANSWERED);
    expect(a.visible).toBe(false);
    expect(a.shownNonces).toEqual([]);
    expect(a.recordedNonces).toEqual([n]); // the record WAS there — and did not count
    expect(a.modelRepeated).toBe(false);
  });

  it("no: a 12-hex token only in the model's answer is an invented value, never a yes", () => {
    const invented = hex12();
    for (const rec of [undefined, record(hex12())]) {
      const a = analyseRun({ stdout: run(TEXT_ONLY, `NONCE ${invented}`, rec) });
      expect(a.outcome).toBe("not-visible");
      expect(a.visible).toBe(false);
      expect(a.modelTokens).toEqual([invented]);
      expect(a.notes.join(" ")).toContain("invented");
    }
  });

  it("yes from a plain-string tool result, and from a non-JSON rendering of structuredContent", () => {
    const n = hex12();
    const plain = analyseRun({ stdout: run(`${DEBUG_ECHO_TEXT}\nnonce: ${n}`, `NONCE ${n}`) });
    expect(plain.visible).toBe(true);
    const yamlish = `${DEBUG_ECHO_TEXT}\ndata:\n  nonce: ${n}\nmeta:\n  request_id: r-${hex12()}`;
    const a = analyseRun({ stdout: run([{ type: "text", text: yamlish }], `NONCE ${n}`) });
    expect(a.visible).toBe(true);
    expect(a.shownNonces).toEqual([n]);
  });

  it("a non-text block handed to the model is still read (serialised), never skipped", () => {
    const n = hex12();
    const content = [...TEXT_ONLY, { type: "resource", resource: { uri: "ff://x", text: n } }];
    expect(toolResultText(content)).toContain(n);
    expect(analyseRun({ stdout: run(content, `NONCE ${n}`) }).visible).toBe(true);
  });

  it("yes when the model does not repeat it — the tool result decides — with a note", () => {
    const n = hex12();
    const a = analyseRun({ stdout: run(withStructured(n), "NO NONCE", record(n)) });
    expect(a.outcome).toBe("visible");
    expect(a.modelRepeated).toBe(false);
    expect(a.notes.join(" ")).toContain("did not repeat");
  });

  it("the model's answer is matched case-insensitively (it may upper-case what it repeats)", () => {
    const n = "abcdef012345";
    const a = analyseRun({ stdout: run(withStructured(n), `NONCE ${n.toUpperCase()}`) });
    expect(a.modelRepeated).toBe(true);
  });

  it("inconclusive (exit 7): the model repeats the real nonce the tool result never showed it", () => {
    const n = hex12();
    const a = analyseRun({ stdout: run(TEXT_ONLY, `NONCE ${n}`, record(n)) });
    expect(a.outcome).toBe("malformed");
    expect(a.exitCode).toBe(EXIT.MALFORMED);
    expect(a.visible).toBeNull();
    expect(a.detail).toContain("inconclusive");
  });

  it("inconclusive (exit 7): the tool result shows a token that is not the recorded nonce", () => {
    const shown = hex12();
    const a = analyseRun({ stdout: run(withStructured(shown), `NONCE ${shown}`, record(hex12())) });
    expect(a.outcome).toBe("malformed");
    expect(a.visible).toBeNull();
  });

  it("12-hex tokens in ANOTHER tool's result, a request_id tail, a UUID or a longer hex run do not count", () => {
    const n = hex12();
    const ours = [{ type: "text", text: `${DEBUG_ECHO_TEXT} r-${n} ${SESSION} ${n}ff x${n}` }];
    const stdout = jsonl(
      init(),
      call("toolu_09", "Bash"),
      toolResult(`token ${hex12()}`, { id: "toolu_09" }),
      call(),
      toolResult(ours),
      say("NO NONCE"),
      result("NO NONCE"),
    );
    const a = analyseRun({ stdout });
    expect(a.outcome).toBe("not-visible");
    expect(a.shownNonces).toEqual([]);
  });

  it("an API error line after the call is not the model's answer, whichever marker flags it", () => {
    const n = hex12();
    const apiError = (marker: Ev): Ev => ({
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-test-model",
        content: [{ type: "text", text: `API Error: 500 (request ${n})` }],
      },
      session_id: SESSION,
      ...marker,
    });
    for (const marker of [
      { is_api_error_message: true },
      { error: "server_error" },
      {
        message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: n }] },
      },
    ]) {
      const stdout = jsonl(
        init(),
        call(),
        toolResult(TEXT_ONLY, { record: record(n) }),
        apiError(marker),
        result("API Error: 500", { is_error: true }),
      );
      const a = analyseRun({ stdout });
      expect(a.outcome, JSON.stringify(marker)).toBe("not-visible");
      expect(a.finalAnswer).toBeNull();
      expect(a.notes.join(" ")).toContain("ended with an error after the tool call");
    }
  });

  it("a tool_result whose id matches no ff_debug_echo call is ignored", () => {
    const n = hex12();
    const stdout = jsonl(
      init(),
      call(),
      toolResult(TEXT_ONLY),
      toolResult(withStructured(n), { id: "toolu_99" }),
      result("NO NONCE"),
    );
    expect(analyseRun({ stdout }).visible).toBe(false);
  });

  it("several calls: visible if any tool result shows the nonce, with a note on the mix", () => {
    const n = hex12();
    const stdout = jsonl(
      init(),
      call("toolu_01"),
      toolResult(TEXT_ONLY, { id: "toolu_01" }),
      call("toolu_02"),
      toolResult(withStructured(n), { id: "toolu_02" }),
      result(`NONCE ${n}`),
    );
    const a = analyseRun({ stdout });
    expect(a.visible).toBe(true);
    expect(a.toolCalls).toBe(2);
    expect(a.notes.join(" ")).toContain("1 of 2");
  });

  it("property: for ANY 12-hex nonce (all-digit ones included) the verdict follows the tool result alone", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9a-f]{12}$/), fc.boolean(), (n, repeat) => {
        const answer = repeat ? `NONCE ${n}` : "NO NONCE";
        const yes = analyseRun({ stdout: run(withStructured(n), answer, record(n)) });
        const no = analyseRun({ stdout: run(TEXT_ONLY, "NO NONCE", record(n)) });
        expect(yes.visible).toBe(true);
        expect(yes.shownNonces).toEqual([n]);
        expect(no.visible).toBe(false);
        const date = new Date(2026, 9, 6);
        expect(formatReport(yes, date).stdout.at(-1)).toBe(handoffLine(VERSION, true, date));
        expect(formatReport(no, date).stdout.at(-1)).toBe(handoffLine(VERSION, false, date));
      }),
      { numRuns: 200 },
    );
  });
});

describe("analyseRun — failures are classified, never a verdict", () => {
  const NOT_LOGGED_IN = "Not logged in · Please run /login";
  const authError = (text: string): Ev => ({
    type: "assistant",
    message: {
      role: "assistant",
      model: "<synthetic>",
      content: [{ type: "text", text }],
    },
    parent_tool_use_id: null,
    error: "authentication_failed",
    session_id: SESSION,
  });

  it("not logged in (exit 3) and the message names `claude auth login`", () => {
    const stdout = jsonl(
      init(),
      authError(NOT_LOGGED_IN),
      result(NOT_LOGGED_IN, { is_error: true, num_turns: 1 }),
    );
    const a = analyseRun({ stdout, exitCode: 1 });
    expect(a.outcome).toBe("auth");
    expect(a.exitCode).toBe(EXIT.AUTH);
    expect(a.visible).toBeNull();
    expect(a.detail).toContain("claude auth login");
    expect(a.detail).toContain(NOT_LOGGED_IN);
    expect(formatReport(a, new Date()).stdout).toEqual([]);
  });

  it("every 2.1 expired/revoked/invalid wording is an auth failure, from the result, stderr or a 401", () => {
    const wordings = [
      "OAuth token revoked · Please run /login",
      "Login expired · Please run /login",
      "Failed to authenticate: OAuth session expired and could not be refreshed",
      "Invalid API key · Fix external API key",
      "Invalid auth token · Fix external auth token",
      'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
      "OAuth token has expired. Please obtain a new token or refresh your existing token.",
    ];
    for (const w of wordings) {
      expect(AUTH_RE.test(w), w).toBe(true);
      const viaResult = analyseRun({ stdout: jsonl(init(), result(w, { is_error: true })) });
      expect(viaResult.outcome, w).toBe("auth");
      const viaStderr = analyseRun({ stdout: "", stderr: `${w}\n`, exitCode: 1 });
      expect(viaStderr.outcome, w).toBe("auth");
    }
    const status401 = analyseRun({
      stdout: jsonl(init(), result("API Error", { is_error: true, api_error_status: 401 })),
    });
    expect(status401.outcome).toBe("auth");
  });

  it("auth wording in the model's ordinary (non-error) answer is not an auth failure", () => {
    const stdout = jsonl(
      init(),
      say("You may need to run /login."),
      result("You may need to run /login."),
    );
    const a = analyseRun({ stdout });
    expect(a.outcome).toBe("no-tool-call");
  });

  it("an auth failure also names a server that did not connect", () => {
    const stdout = jsonl(
      init({ mcp_servers: [{ name: SERVER_NAME, status: "failed" }] }),
      authError(NOT_LOGGED_IN),
      result(NOT_LOGGED_IN, { is_error: true }),
    );
    const a = analyseRun({ stdout });
    expect(a.outcome).toBe("auth");
    expect(a.notes.join(" ")).toContain("did not connect");
  });

  it("the MCP server failed (exit 4): failed status, missing from the list, or no ff_debug_echo", () => {
    const cases: [Ev, string][] = [
      [init({ mcp_servers: [{ name: SERVER_NAME, status: "failed" }] }), "status: failed"],
      [
        init({ mcp_servers: [{ name: "other", status: "connected" }] }),
        "not in Claude Code's server list",
      ],
      [init({ mcp_servers: "nope" }), "not in Claude Code's server list"],
      [init({ tools: ["Bash", "mcp__ffx__ff_status"] }), "fixture mode"],
    ];
    for (const [ev, says] of cases) {
      const a = analyseRun({
        stdout: jsonl(ev, say("I have no such tool."), result("I have no such tool.")),
      });
      expect(a.outcome, says).toBe("server-failed");
      expect(a.exitCode).toBe(EXIT.SERVER);
      expect(a.detail).toContain(says);
    }
  });

  it("the tool was never called (exit 5) — even when the model answers with a hex token", () => {
    const stdout = jsonl(init(), say(`NONCE ${hex12()}`), result(`NONCE ${hex12()}`));
    const a = analyseRun({ stdout });
    expect(a.outcome).toBe("no-tool-call");
    expect(a.exitCode).toBe(EXIT.NO_TOOL_CALL);
    expect(a.visible).toBeNull();
    expect(a.detail).toContain("never called");
  });

  it("the tool call failed or was denied (exit 5), with the reason and the denied tools", () => {
    const denied =
      "Claude requested permissions to use mcp__ffx__ff_debug_echo, but you haven't granted it yet.";
    const stdout = jsonl(
      init(),
      call(),
      toolResult(denied, { isError: true }),
      result("I could not call it.", {
        permission_denials: [{ tool_name: Q, tool_use_id: "toolu_01", tool_input: {} }],
      }),
    );
    const a = analyseRun({ stdout });
    expect(a.outcome).toBe("no-tool-call");
    expect(a.detail).toContain("haven't granted it");
  });

  it("other ends without a successful call: no tool result, max turns, a non-auth error", () => {
    const noResult = analyseRun({ stdout: jsonl(init(), call(), result("")) });
    expect(noResult.outcome).toBe("no-tool-call");
    expect(noResult.detail).toContain("no tool result came back");
    const maxTurns = analyseRun({
      stdout: jsonl(init(), result("", { subtype: "error_max_turns", is_error: true, errors: [] })),
    });
    expect(maxTurns.outcome).toBe("no-tool-call");
    expect(maxTurns.detail).toContain("error_max_turns");
    const credit = analyseRun({
      stdout: jsonl(init(), result("Credit balance is too low", { is_error: true })),
    });
    expect(credit.outcome).toBe("no-tool-call");
    expect(credit.detail).toContain("Credit balance is too low");
    const deniedOther = analyseRun({
      stdout: jsonl(
        init(),
        result("done", { permission_denials: [{ tool_name: "ToolSearch", tool_use_id: "t" }] }),
      ),
    });
    expect(deniedOther.notes.join(" ")).toContain("ToolSearch");
  });

  it("a result subtype other than success is an error even when is_error is false [QA-2-018]", () => {
    const sub = { subtype: "error_max_turns", is_error: false };
    const before = analyseRun({ stdout: jsonl(init(), result("", sub)) });
    expect(before.outcome).toBe("no-tool-call");
    expect(before.detail).toContain(
      "ended with an error (error_max_turns) before the tool was called",
    );
    const n = hex12();
    const after = analyseRun({
      stdout: jsonl(init(), call(), toolResult(withStructured(n)), result("", sub)),
    });
    expect(after.outcome).toBe("visible");
    expect(after.notes.join(" ")).toContain(
      "the run ended with an error after the tool call: error_max_turns",
    );
  });

  it("timeout (exit 6) wins over partial evidence, which is kept as a note", () => {
    const n = hex12();
    const stdout = jsonl(init(), call(), toolResult(withStructured(n)));
    const a = analyseRun({ stdout, timedOut: true, timeoutS: 180 });
    expect(a.outcome).toBe("timeout");
    expect(a.exitCode).toBe(EXIT.TIMEOUT);
    expect(a.visible).toBeNull();
    expect(a.detail).toContain("180 s");
    expect(a.notes.join(" ")).toContain("showed a nonce");
  });

  it("malformed (exit 7): no stream-json at all, with the exit code and stderr tail", () => {
    const a = analyseRun({
      stdout: "",
      stderr: "error: unknown option '--strict-mcp-config'\n",
      exitCode: 1,
    });
    expect(a.outcome).toBe("malformed");
    expect(a.exitCode).toBe(EXIT.MALFORMED);
    expect(a.detail).toContain("exit 1");
    expect(a.detail).toContain("unknown option");
  });

  it("malformed (exit 7): only garbage — partial JSON, null, arrays, objects without a type", () => {
    const stdout = [
      '{"type":"system","subtype":"in',
      "null",
      "[1,2]",
      '{"no":"type"}',
      "plain text",
      "42",
    ].join("\n");
    const parsed = parseStreamJson(stdout);
    expect(parsed.events).toEqual([]);
    expect(parsed.badLines).toBe(6);
    const a = analyseRun({ stdout });
    expect(a.outcome).toBe("malformed");
    expect(a.notes.join(" ")).toContain("6 output line(s)");
  });

  it("malformed (exit 7): the result line is truncated — even though the tool result showed the nonce", () => {
    const n = hex12();
    const full = run(withStructured(n), `NONCE ${n}`).trimEnd();
    const cut = full.slice(0, full.length - 20); // the last line (the result) loses its tail
    const a = analyseRun({ stdout: cut });
    expect(a.outcome).toBe("malformed");
    expect(a.visible).toBeNull();
    expect(a.detail).toContain("without a result event");
    expect(a.notes.join(" ")).toContain("showed a nonce");
  });

  it("a stray non-JSON line and CRLF endings do not spoil an intact transcript", () => {
    const n = hex12();
    const lines = run(withStructured(n), `NONCE ${n}`).trimEnd().split("\n");
    lines.splice(2, 0, "Warning: something printed to stdout", "");
    const a = analyseRun({ stdout: lines.join("\r\n") });
    expect(a.outcome).toBe("visible");
    expect(a.notes.join(" ")).toContain("1 output line(s)");
  });

  it("a spawn failure is a setup error (exit 2), and no init means no version", () => {
    const a = analyseRun({ stdout: "", spawnError: "spawn claude ENOENT" });
    expect(a.outcome).toBe("cli-missing");
    expect(a.exitCode).toBe(EXIT.SETUP);
    expect(a.detail).toContain("--claude <path>");
    expect(a.version).toBeNull();
  });

  it("never throws on hostile shapes", () => {
    const hostile = [
      { type: "assistant", message: "x" },
      { type: "assistant", message: { content: [null, 1, { type: "tool_use" }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: 5 }] } },
      { type: "user", message: { content: "a string" }, tool_use_result: { nonce: 5 } },
      { type: "system", subtype: "init", claude_code_version: 7, mcp_servers: [null] },
      { type: "result", result: { not: "a string" }, permission_denials: [null, 3] },
    ];
    const a = analyseRun({ stdout: jsonl(...hostile) });
    expect(a.visible).toBeNull();
    expect(a.version).toBeNull();
  });

  it("terminal output is one safe line", () => {
    expect(oneLine("a\u001b[31mb\nc\u0007d")).toBe("a [31mb c d");
    expect(oneLine("x".repeat(500), 10)).toHaveLength(10);
  });
});

describe("the MCP config, the command and the report", () => {
  it("the temp MCP config is exactly one stdio server: this node + the fixture launcher, no env", () => {
    const repo = "/repo/root";
    const cfg = buildMcpConfig({ nodePath: "/usr/local/bin/node", repoRoot: repo });
    expect(cfg).toEqual({
      mcpServers: {
        ffx: {
          command: "/usr/local/bin/node",
          args: [path.join(repo, "tests", "smoke", "fixture-serve.mjs")],
        },
      },
    });
    expect(JSON.parse(JSON.stringify(cfg))).toEqual(cfg);
    expect(existsSync(path.join(ROOT, "tests", "smoke", "fixture-serve.mjs"))).toBe(true);
  });

  it("the claude command: print mode, strict MCP config, only ff_debug_echo pre-approved, stream-json, no session record", () => {
    const args = buildClaudeArgs({ configPath: "/tmp/x/mcp.json" });
    expect(args).toEqual([
      "-p",
      PROMPT,
      "--mcp-config",
      "/tmp/x/mcp.json",
      "--strict-mcp-config",
      "--allowedTools",
      "mcp__ffx__ff_debug_echo",
      "--max-turns",
      String(MAX_TURNS),
      "--output-format",
      "stream-json",
      "--verbose",
      // the session record would land in ~/.claude/projects, outside the temp dir (QA-2-016)
      "--no-session-persistence",
    ]);
    // the CLI's --mcp-config and --allowedTools are variadic: each must be followed by an option
    for (const opt of ["--mcp-config", "--allowedTools"]) {
      const i = args.indexOf(opt);
      expect(args[i + 2]?.startsWith("--"), opt).toBe(true);
    }
    expect(args.join(" ")).not.toMatch(/dangerously|bypassPermissions|--permission-mode/);
    expect(PROMPT).toContain(Q);
    expect(PROMPT).toContain("NO NONCE");
    expect(PROMPT).toMatch(/never guess or invent/i);
  });

  it("the HANDOFF line uses the LOCAL calendar date", () => {
    const lateEvening = new Date(2026, 9, 6, 23, 59);
    expect(isoDate(lateEvening)).toBe("2026-10-06");
    expect(handoffLine("2.1.238", true, lateEvening)).toBe(
      "A17 Claude Code 2.1.238: structuredContent visible to the model: yes (2026-10-06)",
    );
    expect(handoffLine(null, false, new Date(2027, 0, 2))).toBe(
      "A17 Claude Code (version unknown): structuredContent visible to the model: no (2027-01-02)",
    );
  });

  it("a verdict goes to stdout with the HANDOFF line last; a failure goes to stderr only", () => {
    const n = hex12();
    const yes = formatReport(
      analyseRun({ stdout: run(withStructured(n), `NONCE ${n}`) }),
      new Date(2026, 9, 6),
    );
    expect(yes.stderr).toEqual([]);
    expect(yes.stdout[0]).toContain("visible to the model: yes");
    expect(yes.stdout.at(-2)).toBe('Record in docs/HANDOFF.md "Build facts":');
    expect(yes.stdout.at(-1)).toBe(
      "A17 Claude Code 9.8.7: structuredContent visible to the model: yes (2026-10-06)",
    );
    const fail = formatReport(analyseRun({ stdout: "" }), new Date());
    expect(fail.stdout).toEqual([]);
    expect(fail.stderr[0]).toMatch(/^a17-check: no verdict \(malformed\)/);
  });

  it("options: defaults, values, and refusals", () => {
    expect(parseOptions([])).toEqual({
      help: false,
      timeoutS: DEFAULT_TIMEOUT_S,
      claude: "claude",
    });
    expect(
      parseOptions(["--timeout", "2.5", "--claude", "/x/claude", "--save", "t.jsonl"]),
    ).toEqual({
      help: false,
      timeoutS: 2.5,
      claude: "/x/claude",
      save: "t.jsonl",
    });
    expect(parseOptions(["--from", "t.jsonl"]).from).toBe("t.jsonl");
    expect(parseOptions(["-h"]).help).toBe(true);
    for (const bad of [
      ["--timeout", "0"],
      ["--timeout", "-1"],
      ["--timeout", "abc"],
      ["--timeout", "3601"],
      ["--timeout"],
      ["--claude", "--save"],
      ["--bogus"],
      ["positional"],
    ])
      expect(() => parseOptions(bad), bad.join(" ")).toThrow();
  });

  it("parses `claude --version`", () => {
    expect(parseVersion("2.1.238 (Claude Code)\n")).toBe("2.1.238");
    expect(parseVersion("v3.0.0-beta.1")).toBe("3.0.0-beta.1");
    expect(parseVersion("Claude Code")).toBeNull();
  });

  it("answer tokens: standalone 12-hex only, lower-cased, de-duplicated", () => {
    const n = hex12();
    expect(findAnswerTokens(`NONCE ${n}. Again: ${n.toUpperCase()}`)).toEqual([n]);
    expect(findAnswerTokens(`r-${n} ${n}0 x${n}`)).toEqual([]);
  });
});

// --- main() end to end, against a stub `claude` -----------------------------------------------------

const STUB = `#!/bin/sh
rec="$A17_STUB_DIR"
if [ "$1" = "--version" ]; then echo "${VERSION} (Claude Code)"; exit 0; fi
pwd -P > "$rec/cwd.txt"
echo $$ > "$rec/stub.pid"
case "$A17_STUB_MODE" in
  hang|linger)
    # a grandchild in the same process group, holding the output pipes; started first so a
    # loaded machine cannot race it
    sleep 60 &
    echo $! > "$rec/child.pid.tmp" && mv "$rec/child.pid.tmp" "$rec/child.pid" ;;
  hang-hard|linger-hard)
    # the same, but it ignores SIGTERM (a server slow to shut down): only SIGKILL ends it
    ( trap '' TERM; exec sleep 20 ) &
    echo $! > "$rec/child.pid.tmp" && mv "$rec/child.pid.tmp" "$rec/child.pid" ;;
esac
case "$A17_STUB_MODE" in
  hang|hang-hard) wait; exit 0 ;;
  # exits normally, leaving the grandchild behind (a server that outlives the CLI)
  linger|linger-hard) cat "$rec/transcript.jsonl"; exit 0 ;;
esac
for a in "$@"; do printf '%s\\n' "$a"; done > "$rec/args.txt"
prev=""
for a in "$@"; do
  if [ "$prev" = "--mcp-config" ]; then cp "$a" "$rec/mcp.json"; printf '%s' "$a" > "$rec/config-path.txt"; fi
  prev="$a"
done
cat > "$rec/stdin.txt"
cat "$rec/transcript.jsonl"
printf '%s\\n' "$A17_STUB_STDERR" >&2
exit "\${A17_STUB_EXIT:-0}"
`;

const temps: ReturnType<typeof tempDir>[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) t.cleanup();
});

/** A fake checkout (placeholder dist/cli.js + launcher) and a stub claude that records its inputs. */
function harness(opts: { built?: boolean } = {}) {
  const tmp = tempDir("ff-a17-test-");
  temps.push(tmp);
  const repo = path.join(tmp.dir, "repo");
  const rec = path.join(tmp.dir, "rec");
  mkdirSync(path.join(repo, "tests", "smoke"), { recursive: true });
  mkdirSync(rec);
  writeFileSync(path.join(repo, "tests", "smoke", "fixture-serve.mjs"), "// placeholder\n");
  if (opts.built !== false) {
    mkdirSync(path.join(repo, "dist"));
    writeFileSync(path.join(repo, "dist", "cli.js"), "// placeholder\n");
  }
  const stub = path.join(tmp.dir, "claude-stub.sh");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  const out: string[] = [];
  const err: string[] = [];
  const go = (argv: string[], env: Record<string, string> = {}) =>
    main(["--claude", stub, ...argv], {
      repoRoot: repo,
      nodePath: "/opt/node/bin/node",
      now: new Date(2026, 9, 6, 9, 30),
      env: { ...process.env, A17_STUB_DIR: rec, ...env },
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    });
  const transcript = (text: string) => {
    writeFileSync(path.join(rec, "transcript.jsonl"), text);
  };
  return { dir: tmp.dir, repo, rec, stub, out, err, go, transcript };
}

/** Alive and not a zombie (`ps` reports a zombie's state as Z). */
function alive(pid: number): boolean {
  const r = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  const stat = r.stdout.trim();
  return stat !== "" && !stat.startsWith("Z");
}

/** The pid the stub recorded in `<rec>/<file>`. */
function pidIn(rec: string, file: string): number {
  const pid = Number(readFileSync(path.join(rec, file), "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 1) throw new Error(`bad pid in ${file}`);
  return pid;
}

/** Whether `pid` is gone within `ms` (a killed process may take a moment to be reaped). */
async function gone(pid: number, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  return !alive(pid);
}

describe("main() end to end with a stub claude (the real CLI is never run)", () => {
  it("refuses without dist/cli.js and tells the user to build — the CLI is never started", async () => {
    const h = harness({ built: false });
    const code = await h.go([]);
    expect(code).toBe(EXIT.SETUP);
    expect(h.err.join("")).toMatch(
      /dist\/cli\.js is missing: build the server first \(npm run build\)/,
    );
    expect(existsSync(path.join(h.rec, "args.txt"))).toBe(false);
  });

  it("not logged in: exit 3, and the CLI got the exact command, a temp cwd, closed stdin and the config", async () => {
    const h = harness();
    const msg = "Not logged in · Please run /login";
    h.transcript(
      jsonl(
        init(),
        {
          type: "assistant",
          message: {
            role: "assistant",
            model: "<synthetic>",
            content: [{ type: "text", text: msg }],
          },
          error: "authentication_failed",
          session_id: SESSION,
        },
        result(msg, { is_error: true }),
      ),
    );
    // a 20 s limit: a stdin left open would hang the stub's `cat` into a timeout (exit 6), not 3
    const code = await h.go(["--timeout", "20"], { A17_STUB_EXIT: "1" });
    expect(code).toBe(EXIT.AUTH);
    expect(h.out).toEqual([]);
    expect(h.err.join("")).toContain("Run `claude auth login`, then rerun this check");

    const configPath = readFileSync(path.join(h.rec, "config-path.txt"), "utf8");
    const args = readFileSync(path.join(h.rec, "args.txt"), "utf8").trimEnd().split("\n");
    expect(args).toEqual(buildClaudeArgs({ configPath }));
    expect(JSON.parse(readFileSync(path.join(h.rec, "mcp.json"), "utf8"))).toEqual(
      buildMcpConfig({ nodePath: "/opt/node/bin/node", repoRoot: h.repo }),
    );
    expect(readFileSync(path.join(h.rec, "stdin.txt"), "utf8")).toBe("");
    const cwd = readFileSync(path.join(h.rec, "cwd.txt"), "utf8").trim();
    expect(cwd).not.toBe(h.repo);
    expect(cwd).not.toBe(process.cwd());
    expect(path.basename(cwd)).toBe("work");
    expect(path.basename(path.dirname(cwd))).toMatch(/^ff-a17-/);
    // the temp dir (config + cwd) is removed after the run
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(cwd)).toBe(false);
  });

  it("a verdict prints the one-line answer and the exact HANDOFF line", async () => {
    const h = harness();
    const n = hex12();
    h.transcript(run(TEXT_ONLY, "NO NONCE", record(n)));
    const code = await h.go([]);
    expect(code).toBe(EXIT.ANSWERED);
    const lines = h.out.join("").trimEnd().split("\n");
    expect(lines[0]).toContain("structuredContent visible to the model: no");
    expect(lines.at(-1)).toBe(
      "A17 Claude Code 9.8.7: structuredContent visible to the model: no (2026-10-06)",
    );
  });

  it("a verdict without an init event takes the version from `claude --version`", async () => {
    const h = harness();
    const n = hex12();
    h.transcript(jsonl(call(), toolResult(withStructured(n)), result(`NONCE ${n}`)));
    expect(await h.go([])).toBe(EXIT.ANSWERED);
    expect(h.out.join("")).toContain(
      `A17 Claude Code ${VERSION}: structuredContent visible to the model: yes`,
    );
  });

  it("timeout: exit 6, and the CLI's whole process group is gone (no orphaned child)", async () => {
    const h = harness();
    const t0 = Date.now();
    const code = await h.go(["--timeout", "2"], { A17_STUB_MODE: "hang" });
    expect(code).toBe(EXIT.TIMEOUT);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(h.err.join("")).toContain("did not finish within 2 s");
    const pid = Number(readFileSync(path.join(h.rec, "child.pid"), "utf8").trim());
    expect(pid).toBeGreaterThan(1);
    const deadline = Date.now() + 5000;
    while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(alive(pid)).toBe(false);
  });

  it("a child the CLI leaves behind is stopped when the CLI exits — no wait for the time limit", async () => {
    const h = harness();
    const n = hex12();
    h.transcript(run(TEXT_ONLY, "NO NONCE", record(n)));
    const t0 = Date.now();
    const code = await h.go(["--timeout", "20"], { A17_STUB_MODE: "linger" });
    expect(code).toBe(EXIT.ANSWERED);
    expect(Date.now() - t0).toBeLessThan(10_000);
    const pid = Number(readFileSync(path.join(h.rec, "child.pid"), "utf8").trim());
    const deadline = Date.now() + 5000;
    while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(alive(pid)).toBe(false);
  });

  it("a child that ignores SIGTERM after the CLI exits gets SIGKILL: the verdict comes well before the limit [QA-2-014]", async () => {
    const h = harness();
    const n = hex12();
    h.transcript(run(TEXT_ONLY, "NO NONCE", record(n)));
    const t0 = Date.now();
    const code = await h.go(["--timeout", "20"], { A17_STUB_MODE: "linger-hard" });
    expect(code).toBe(EXIT.ANSWERED);
    expect(Date.now() - t0).toBeLessThan(12_000);
    expect(await gone(pidIn(h.rec, "child.pid"))).toBe(true);
  });

  it("a completed run is not a timeout when the limit passes while its leftover child is being stopped [QA-2-014]", async () => {
    const h = harness();
    const n = hex12();
    h.transcript(run(TEXT_ONLY, "NO NONCE", record(n)));
    // the CLI exits at once; the SIGTERM-ignoring child holds the pipes ~3 s, past the 2 s limit
    const code = await h.go(["--timeout", "2"], { A17_STUB_MODE: "linger-hard" });
    expect(code).toBe(EXIT.ANSWERED);
    expect(h.out.join("")).toContain("structuredContent visible to the model: no");
    expect(await gone(pidIn(h.rec, "child.pid"))).toBe(true);
  });

  it("a hung run whose child ignores SIGTERM ends about 3 s after the limit, the child killed [QA-2-014]", async () => {
    const h = harness();
    const t0 = Date.now();
    const code = await h.go(["--timeout", "2"], { A17_STUB_MODE: "hang-hard" });
    expect(code).toBe(EXIT.TIMEOUT);
    expect(Date.now() - t0).toBeLessThan(2_000 + 3_000 + 4_000);
    expect(await gone(pidIn(h.rec, "child.pid"))).toBe(true);
  });

  it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
    "interrupted by %s: exit 130, the group stopped, this run's temp dir removed, the listeners gone [QA-2-012, QA-2-013]",
    async (sig) => {
      const h = harness();
      const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
      const before = new Map(signals.map((s) => [s, process.listeners(s)]));
      const state = { settled: false }; // set by the promise, so not narrowed to its initial value
      const pending = h.go(["--timeout", "60"], { A17_STUB_MODE: "hang" }).finally(() => {
        state.settled = true;
      });
      try {
        const pidFile = path.join(h.rec, "child.pid");
        const deadline = Date.now() + 10_000;
        while (!existsSync(pidFile) && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 20));
        // every stop signal is handled while the CLI runs, each by exactly one new listener
        for (const s of signals)
          expect(process.listenerCount(s), s).toBe((before.get(s) ?? []).length + 1);
        const added = process.listeners(sig).filter((l) => !(before.get(sig) ?? []).includes(l));
        expect(added).toHaveLength(1);
        // only the check's own listener runs: no real signal, and no other handler in this worker
        (added[0] as (s: NodeJS.Signals) => void)(sig);
        expect(await pending).toBe(EXIT.INTERRUPTED);
        expect(h.err.join("")).toContain("interrupted");
        for (const s of signals)
          expect(process.listenerCount(s), s).toBe((before.get(s) ?? []).length);
        // this run's own temp dir (the stub's cwd is <tmp>/work), not a count of every ff-a17-* dir
        const cwd = readFileSync(path.join(h.rec, "cwd.txt"), "utf8").trim();
        expect(path.basename(path.dirname(cwd))).toMatch(/^ff-a17-/);
        expect(existsSync(path.dirname(cwd))).toBe(false);
        expect(await gone(pidIn(h.rec, "child.pid"))).toBe(true);
        expect(await gone(pidIn(h.rec, "stub.pid"))).toBe(true);
      } finally {
        // a failed assertion must not leave the run behind: end the stub's group, then wait for it
        if (!state.settled) {
          try {
            process.kill(-pidIn(h.rec, "stub.pid"), "SIGKILL");
          } catch {
            // already gone
          }
          await pending.catch(() => undefined);
        }
      }
    },
  );

  it("--save writes the raw transcript (0600); --from re-analyses it without starting anything", async () => {
    const h = harness();
    const n = hex12();
    const text = run(withStructured(n), `NONCE ${n}`);
    h.transcript(text);
    const saved = path.join(h.dir, "saved.jsonl");
    expect(await h.go(["--save", saved])).toBe(EXIT.ANSWERED);
    expect(readFileSync(saved, "utf8")).toBe(text);
    expect(statSync(saved).mode & 0o777).toBe(0o600);

    const again = harness({ built: false }); // --from needs no build and runs no CLI
    expect(await again.go(["--from", saved])).toBe(EXIT.ANSWERED);
    expect(again.out.join("")).toContain("visible to the model: yes (2026-10-06)");
    expect(existsSync(path.join(again.rec, "args.txt"))).toBe(false);
    expect(await again.go(["--from", path.join(again.dir, "missing.jsonl")])).toBe(EXIT.SETUP);
  });

  it("--save into a missing directory is refused before the CLI starts (exit 2) [QA-2-015]", async () => {
    const h = harness();
    h.transcript(run(TEXT_ONLY, "NO NONCE"));
    const target = path.join(h.dir, "no-such-dir", "t.jsonl");
    expect(await h.go(["--save", target])).toBe(EXIT.SETUP);
    expect(h.err.join("")).toContain("cannot write --save");
    expect(existsSync(path.join(h.rec, "args.txt"))).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  it("--save onto an existing 0644 file leaves it 0600 with the transcript [QA-2-015]", async () => {
    const h = harness();
    const n = hex12();
    const text = run(withStructured(n), `NONCE ${n}`);
    h.transcript(text);
    const saved = path.join(h.dir, "existing.jsonl");
    writeFileSync(saved, "old contents\n", { mode: 0o644 });
    chmodSync(saved, 0o644);
    expect(await h.go(["--save", saved])).toBe(EXIT.ANSWERED);
    expect(readFileSync(saved, "utf8")).toBe(text);
    expect(statSync(saved).mode & 0o777).toBe(0o600);
  });

  it("a missing CLI is a setup error (exit 2), and a bad option prints the usage", async () => {
    const h = harness();
    const missing = path.join(tmpdir(), `no-such-claude-${hex12()}`);
    expect(await h.go(["--claude", missing])).toBe(EXIT.SETUP);
    expect(h.err.join("")).toContain("could not be started");
    expect(await h.go(["--nope"])).toBe(EXIT.SETUP);
    expect(h.err.join("")).toContain("usage:");
  });

  it("the script never names the owner's league config directory", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).not.toMatch(/\.config[\\/]+fantasy-football-mcp/);
    expect(src).not.toMatch(/FF_CONFIG_DIR|FF_LEAGUE_FILE/);
  });
});
