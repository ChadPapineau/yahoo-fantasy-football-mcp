// serve-invalid-request.test.ts — a JSON-RPC line that parses but is not a valid message gets a
// -32600 Invalid Request reply when it carries a usable id (QA-1-085; JSON-RPC 2.0 §5.1, plan 01 §4.3
// "protocol errors are reserved for unknown tools and malformed requests"), instead of silence until
// the client's own timeout. An unparseable line has no readable id (MCP forbids a null id), so it
// is logged, never answered; a malformed notification (no id) is never answered.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, invalidRequestReply, serve } from "../../src/cli/serve.js";
import { FIXTURE_LEAGUE, ROOT } from "./helpers/env.js";

describe("invalidRequestReply (pure)", () => {
  const CASES: readonly [string, string, string | number | null][] = [
    ["jsonrpc 1.0", '{"jsonrpc":"1.0","id":11,"method":"ping"}', 11],
    ["params array", '{"jsonrpc":"2.0","id":12,"method":"ping","params":[1]}', 12],
    [
      "tools/call params string",
      '{"jsonrpc":"2.0","id":"s-13","method":"tools/call","params":"x"}',
      "s-13",
    ],
    [
      "progressToken object",
      '{"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":"ff_get_status","arguments":{},"_meta":{"progressToken":{}}}}',
      14,
    ],
    ["valid ping", '{"jsonrpc":"2.0","id":15,"method":"ping"}', null],
    ["valid notification", '{"jsonrpc":"2.0","method":"notifications/initialized"}', null],
    ["truncated frame", '{"jsonrpc":"2.0","id":10,"method":"ping"', null],
    ["invalid notification (no id)", '{"jsonrpc":"1.0","method":"x"}', null],
    ["null id", '{"jsonrpc":"1.0","id":null,"method":"ping"}', null],
    ["object id", '{"jsonrpc":"1.0","id":{},"method":"ping"}', null],
    ["a response, not a request", '{"jsonrpc":"1.0","id":3,"result":{}}', null],
    ["an array (no batching)", '[{"jsonrpc":"2.0","id":1,"method":"ping"}]', null],
    ["a non-finite id", '{"jsonrpc":"1.0","id":1e999,"method":"ping"}', null],
  ];
  for (const [label, line, id] of CASES)
    it(label, () => {
      const r = invalidRequestReply(line);
      if (id === null) expect(r).toBeNull();
      else
        expect(r).toEqual({
          jsonrpc: "2.0",
          id,
          error: { code: -32600, message: "Invalid Request" },
        });
    });
});

interface Harness {
  root: string;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  out: string[];
  err: string[];
}
let h: Harness;
beforeEach(() => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ff-serve-inv-")));
  chmodSync(root, 0o700);
  for (const d of ["home", "config", "cache"]) mkdirSync(path.join(root, d), { mode: 0o700 });
  const out: string[] = [];
  const err: string[] = [];
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on("data", (b: Buffer) => out.push(...b.toString("utf8").split("\n").filter(Boolean)));
  stderr.on("data", (b: Buffer) => err.push(...b.toString("utf8").split("\n").filter(Boolean)));
  h = { root, stdin, stdout, stderr, out, err };
});
afterEach(() => {
  rmSync(h.root, { recursive: true, force: true });
});

const waitFor = async (pred: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("ff serve answers malformed requests that carry an id (QA-1-085)", () => {
  it("-32600 for each invalid request with an id; a parse error is logged; the server stays up", async () => {
    const done = serve(
      {
        argv: [],
        env: {
          HOME: path.join(h.root, "home"),
          FF_CONFIG_DIR: path.join(h.root, "config"),
          FF_CACHE_DIR: path.join(h.root, "cache"),
          FF_LEAGUE_FILE: FIXTURE_LEAGUE,
          FF_FIXTURE_DIR: path.join(ROOT, "fixtures"),
          FF_LOG_LEVEL: "debug",
        },
        stdin: h.stdin,
        stdout: h.stdout,
        stderr: h.stderr,
      },
      { signals: false, packageRoot: ROOT },
    );
    h.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } })}\n`,
    );
    await waitFor(() => h.out.length >= 1);
    h.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    // two lines in one chunk, one split across chunks, CRLF endings
    h.stdin.write(
      '{"jsonrpc":"2.0","id":10,"method":"ping"\r\n{"jsonrpc":"1.0","id":11,"method":"ping"}\n',
    );
    h.stdin.write('{"jsonrpc":"2.0","id":12,"method":"pi');
    h.stdin.write('ng","params":[1]}\r\n');
    h.stdin.write('{"jsonrpc":"2.0","id":13,"method":"tools/call","params":"x"}\n');
    h.stdin.write('{"jsonrpc":"2.0","id":15,"method":"ping"}\n');
    await waitFor(() => h.out.some((l) => l.includes('"id":15')));
    await waitFor(() => h.out.filter((l) => l.includes("-32600")).length >= 3);
    const byId = new Map(
      h.out
        .map((l) => JSON.parse(l) as { id: unknown; error?: { code: number }; result?: unknown })
        .map((m) => [m.id, m]),
    );
    for (const id of [11, 12, 13]) expect(byId.get(id)?.error?.code, String(id)).toBe(-32600);
    expect(byId.has(10)).toBe(false);
    expect(byId.get(15)?.result).toEqual({});
    expect(h.out.filter((l) => l.includes("-32600"))).toHaveLength(3);
    h.stdin.end();
    expect(await done).toBe(EXIT.ok);
    expect(h.err.join("\n")).toContain('"event":"transport.invalid_request"');
    expect(h.err.join("\n")).toContain('"event":"transport.parse_error"');
  });
});
