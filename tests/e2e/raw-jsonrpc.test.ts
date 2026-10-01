// raw-jsonrpc.test.ts — hostile bytes on the BUILT server's stdin, below any SDK client (plan 02 §7;
// plan 05 §4.2): an SDK client normalises arguments before sending (an own `__proto__` key never
// leaves it), so these frames are written by hand. Own `__proto__` / `constructor` keys in tool
// arguments, malformed JSON, a non-object `arguments`, an unknown method, a huge line and binary
// garbage: each gets a JSON-RPC error or a coded tool error, nothing is echoed, nothing but JSON-RPC
// reaches stdout, and the server keeps answering. Requires `npm run build`.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DIST_ENTRY,
  ROOT,
  logRecords,
  makeHome,
  requireDist,
  waitFor,
  type E2eHome,
} from "./helpers.js";

interface Msg {
  jsonrpc?: string;
  id?: number | string | null;
  result?: { isError?: boolean; content?: { text: string }[] };
  error?: { code: number; message: string };
}

let home: E2eHome;
let proc: ChildProcessWithoutNullStreams;
const out: Msg[] = [];
const rawOut: string[] = [];
const err: string[] = [];
let nextId = 100;

function send(line: string): void {
  proc.stdin.write(`${line}\n`);
}

async function request(frame: string, id: number): Promise<Msg> {
  send(frame);
  await waitFor(() => out.some((m) => m.id === id), 15_000);
  const m = out.find((x) => x.id === id);
  if (m === undefined) throw new Error("no response");
  return m;
}

const callFrame = (id: number, name: string, argsJson: string) =>
  `{"jsonrpc":"2.0","id":${String(id)},"method":"tools/call","params":{"name":"${name}","arguments":${argsJson}}}`;

beforeAll(async () => {
  requireDist();
  home = makeHome();
  proc = spawn(process.execPath, [DIST_ENTRY, "serve"], {
    cwd: ROOT,
    env: home.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  proc.stdout.on("data", (b: Buffer) => {
    buf += b.toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines.filter(Boolean)) {
      rawOut.push(l);
      out.push(JSON.parse(l) as Msg);
    }
  });
  proc.stderr.on("data", (b: Buffer) =>
    err.push(...b.toString("utf8").split("\n").filter(Boolean)),
  );
  await request(
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"raw","version":"0"}}}',
    1,
  );
  send('{"jsonrpc":"2.0","method":"notifications/initialized"}');
}, 60_000);

afterAll(async () => {
  proc.stdin.end();
  await new Promise((r) => setTimeout(r, 300));
  if (proc.exitCode === null) proc.kill("SIGKILL");
  home.cleanup();
});

/** The outcome class of one call: "ok", a tool error code, or a JSON-RPC error. */
function outcome(m: Msg): string {
  if (m.error !== undefined) return `rpc:${String(m.error.code)}`;
  if (m.result?.isError !== true) return "ok";
  const text = m.result.content?.[0]?.text ?? "{}";
  return (JSON.parse(text) as { error: { code: string } }).error.code;
}

describe("own __proto__ / constructor keys in tool arguments", () => {
  // Measured: the server-side request parse drops an own `__proto__` key (and never reads values
  // through it — `{"__proto__":{"weeks":[99]}}` is NOT a week-99 request), so such a call behaves
  // exactly like the same call without the key; `constructor` is an ordinary unknown key, which the
  // strict input schemas refuse.
  it.each(["ff_get_status", "ff_list_leagues", "ff_get_schedule", "ff_analyze_waivers"])(
    "%s: __proto__ has no effect, constructor is VALIDATION; never polluting, never echoed",
    async (tool) => {
      const cases: [string, string][] = [
        ['{"__proto__":{"polluted":"yes-proto"}}', "{}"],
        ['{"__proto__":{"weeks":[99],"include_checks":true,"week":"yes-week"}}', "{}"],
        ['{"__proto__":{"toString":"yes-tostring"},"week":4}', '{"week":4}'],
      ];
      for (const [hostile, clean] of cases) {
        const id = nextId++;
        const m = await request(callFrame(id, tool, hostile), id);
        const id2 = nextId++;
        const base = await request(callFrame(id2, tool, clean), id2);
        expect(outcome(m), `${tool} ${hostile}`).toBe(outcome(base));
        expect(JSON.stringify(m)).not.toMatch(/yes-(proto|week|tostring)/);
      }
      const id = nextId++;
      const ctor = await request(
        callFrame(id, tool, '{"constructor":{"prototype":{"polluted":"yes-ctor"}}}'),
        id,
      );
      expect(outcome(ctor)).toBe("VALIDATION");
      expect(JSON.stringify(ctor)).not.toContain("yes-ctor");
      const okId = nextId++;
      const ok = await request(callFrame(okId, "ff_get_status", "{}"), okId);
      expect(outcome(ok)).toBe("ok");
    },
    60_000,
  );
});

describe("malformed frames", () => {
  it("garbage, bad JSON, wrong shapes and a 2 MB line never kill the server", async () => {
    send("this is not json");
    send('{"jsonrpc":"2.0","id":');
    send("\u0000\u0001\u0002binary\uffff");
    send(
      `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"ff_get_status","arguments":"${"A".repeat(2_000_000)}"}}`,
    );
    const bad = [
      [nextId++, callFrame(0, "ff_get_status", '"a string"')],
      [nextId++, callFrame(0, "ff_get_status", "[1,2,3]")],
      [nextId++, callFrame(0, "ff_prepare_lineup", "{}")],
      [nextId++, callFrame(0, "ff_no_such_tool\u202e", "{}")],
    ] as const;
    for (const [id, frame] of bad) {
      const m = await request(frame.replace('"id":0', `"id":${String(id)}`), id);
      const errored = m.error !== undefined || m.result?.isError === true;
      expect(errored, frame.slice(0, 120)).toBe(true);
      // (the SDK's own "tool not found" message repeats the requested name — the client's own
      // input, bounded by the frame; recorded in the integration report)
      expect(JSON.stringify(m).length).toBeLessThan(4000);
    }
    const unknown = nextId++;
    const m = await request(
      `{"jsonrpc":"2.0","id":${String(unknown)},"method":"no/such/method"}`,
      unknown,
    );
    expect(m.error?.code).toBe(-32601);
    const id = nextId++;
    const ok = await request(callFrame(id, "ff_get_status", "{}"), id);
    expect(ok.result?.isError).not.toBe(true);
    expect(proc.exitCode).toBeNull();
  }, 60_000);

  it("an invalid request that carries an id gets -32600 under that id (QA-1-085)", async () => {
    const frames = [
      (id: number) => `{"jsonrpc":"1.0","id":${String(id)},"method":"ping"}`,
      (id: number) => `{"jsonrpc":"2.0","id":${String(id)},"method":"ping","params":[1]}`,
      (id: number) => `{"jsonrpc":"2.0","id":${String(id)},"method":"tools/call","params":"x"}`,
      (id: number) =>
        `{"jsonrpc":"2.0","id":${String(id)},"method":"tools/call","params":{"name":"ff_get_status","arguments":{},"_meta":{"progressToken":{}}}}`,
    ];
    for (const frame of frames) {
      const id = nextId++;
      const m = await request(frame(id), id);
      expect(m.error?.code, frame(id)).toBe(-32600);
      expect(m.result).toBeUndefined();
    }
    const id = nextId++;
    const ok = await request(callFrame(id, "ff_get_status", "{}"), id);
    expect(ok.result?.isError).not.toBe(true);
  }, 60_000);

  it("stdout carried only JSON-RPC 2.0 frames; stderr only JSON log lines", () => {
    for (const m of out) expect(m.jsonrpc).toBe("2.0");
    for (const l of rawOut) expect(l).not.toContain("AAAAAAAAAAAAAAAA");
    for (const r of logRecords(err)) expect(r).not.toHaveProperty("raw");
  });
});
