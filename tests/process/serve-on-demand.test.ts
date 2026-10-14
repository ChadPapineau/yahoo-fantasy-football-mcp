// serve-on-demand.test.ts — answer-time refresh with real processes (season-fresh spec §6.3, §6.6;
// plan 05 §4.2): the BUILT server in fixture mode with FF_ON_DEMAND_REFRESH=wait starts with no
// child; a tool whose fast sources were last checked 2 h ago starts a real `ff refresh --on-demand`
// child (fixture transport — no network) and answers within the 6 s budget with `meta.refresh`
// revalidated; and stdin EOF while a child hangs exits 0 within 3 s, the child gets SIGTERM, leaves
// no temp file in ds/ and is gone 5 s later. Wall-clock budgets are judged in CI (the process job).
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHILD_ENV_KEYS } from "../../src/cli/on-demand-refresh.js";
import {
  ROOT,
  alive,
  logRecords,
  makeHome,
  publishFixtures,
  requireDist,
  serve,
  waitFor,
  type E2eHome,
} from "../e2e/helpers.js";

const H = 3_600_000;

/** Ages every refresh_log row by `ms` (as if the last checks were that long ago). */
function ageRefreshLog(home: E2eHome, ms: number): void {
  const db = new DatabaseSync(path.join(home.env.FF_CACHE_DIR ?? "", "store.sqlite"));
  try {
    const rows = db
      .prepare("SELECT rowid AS id, started_at, finished_at, checked_at FROM refresh_log")
      .all() as { id: number; started_at: string; finished_at: string; checked_at: string }[];
    const back = (iso: string): string => new Date(Date.parse(iso) - ms).toISOString();
    const upd = db.prepare(
      "UPDATE refresh_log SET started_at = ?, finished_at = ?, checked_at = ? WHERE rowid = ?",
    );
    for (const r of rows)
      upd.run(back(r.started_at), back(r.finished_at), back(r.checked_at), r.id);
  } finally {
    db.close();
  }
}

let home: E2eHome;
beforeAll(async () => {
  requireDist();
  home = makeHome();
  await publishFixtures(home);
}, 180_000);
afterAll(() => {
  home.cleanup();
});

describe("a real on-demand child (built dist, fixture mode)", () => {
  it("startup starts no child; a stale fast source is revalidated within the budget", async () => {
    ageRefreshLog(home, 2 * H);
    const srv = await serve({ ...home.env, FF_ON_DEMAND_REFRESH: "wait" });
    try {
      const status = await srv.client.callTool({ name: "ff_get_status", arguments: {} });
      expect(status.isError).not.toBe(true);
      // diagnostics never refresh; nothing was spawned at startup
      expect(logRecords(srv.stderr).some((l) => l.event === "refresh.child_started")).toBe(false);
      const t0 = performance.now();
      const r = await srv.client.callTool({ name: "ff_get_injuries", arguments: {} });
      const ms = performance.now() - t0;
      const text = (r.content as { text: string }[])[0]?.text ?? "";
      expect(r.isError, text.slice(0, 400)).not.toBe(true);
      const env = JSON.parse(text) as {
        meta: { refresh?: { sources: { source: string; outcome: string }[] } };
      };
      process.stdout.write(`on-demand ff_get_injuries (2 h stale): ${ms.toFixed(0)} ms\n`);
      const injuries = env.meta.refresh?.sources.find((s) => s.source === "nflverse:injuries");
      expect(injuries?.outcome).toBe("revalidated");
      expect(ms).toBeLessThan(6_000);
      expect(logRecords(srv.stderr).some((l) => l.event === "refresh.child_started")).toBe(true);
    } finally {
      await srv.close();
    }
  }, 60_000);
});

describe("shutdown with a hung child (server from source, a stand-in child)", () => {
  it("stdin EOF → exit 0 within 3 s; the child gets SIGTERM and is gone 5 s later", async () => {
    ageRefreshLog(home, 2 * H);
    const cache = home.env.FF_CACHE_DIR ?? "";
    const proc = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(ROOT, "tests", "process", "fixtures", "serve-on-demand-entry.mjs"),
      ],
      {
        cwd: ROOT,
        env: {
          ...home.env,
          FF_ON_DEMAND_REFRESH: "wait",
          FF_TEST_CHILD_ENTRY: path.join(ROOT, "tests", "process", "fixtures", "hung-refresh.mjs"),
          YAHOO_CLIENT_SECRET: "fake-child-secret",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const out: string[] = [];
    let buf = "";
    proc.stdout.on("data", (b: Buffer) => {
      buf += b.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      out.push(...lines.filter(Boolean));
    });
    const exited = new Promise<{ code: number | null; at: number }>((resolve) => {
      proc.on("exit", (code) => {
        resolve({ code, at: Date.now() });
      });
    });
    try {
      const send = (o: unknown): void => {
        proc.stdin.write(`${JSON.stringify(o)}\n`);
      };
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "p", version: "0" },
        },
      });
      await waitFor(() => out.length >= 1, 30_000);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "ff_get_injuries", arguments: {} },
      });
      const marker = path.join(cache, "hung-child.json");
      await waitFor(() => existsSync(marker), 30_000);
      const child = JSON.parse(readFileSync(marker, "utf8")) as {
        pid: number;
        argv: string[];
        env: string[];
      };
      expect(child.argv.slice(0, 7)).toEqual([
        "refresh",
        "--on-demand",
        "--no-migrate",
        "--expect-version",
        expect.any(String),
        "--json",
        "--notify",
      ]);
      // only the allow-list (macOS adds its own __CF_USER_TEXT_ENCODING to every process)
      const inherited = child.env.filter((k) => k !== "__CF_USER_TEXT_ENCODING");
      expect(inherited.filter((k) => !CHILD_ENV_KEYS.includes(k))).toEqual([]);
      expect(child.env).not.toContain("YAHOO_CLIENT_SECRET");
      expect(child.env).not.toContain("PATH");
      // the answer arrives at the 6 s budget with the refresh still running (never killed by it)
      await waitFor(() => out.length >= 2, 30_000);
      expect(out[1]).toContain("in_progress");
      expect(alive(child.pid)).toBe(true);
      const t0 = Date.now();
      proc.stdin.end();
      const { code, at } = await exited;
      expect(code).toBe(0);
      expect(at - t0).toBeLessThan(3_000);
      await waitFor(() => existsSync(path.join(cache, "hung-child.sigterm")), 5_000);
      await waitFor(() => !alive(child.pid), 5_000);
      const ds = path.join(cache, "ds");
      expect(readdirSync(ds).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    } finally {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }
  }, 90_000);
});
