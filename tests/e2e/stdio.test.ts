// stdio.test.ts — the whole product end to end over REAL stdio (plan 10 A3a/A6/A13; plan 05 §4.2):
// `node dist/cli.js refresh …` publishes the fixture datasets in fixture mode into a temp cache, then
// `node dist/cli.js serve` is spawned by the SDK's StdioClientTransport with a temp FF_CONFIG_DIR
// holding a 0600 copy of the fixture league. EVERY tool is called with valid arguments (a
// schema-valid envelope that passes the A6 walk), EVERY resource is read, EVERY prompt is got; then a
// hostile pass sends every tool invalid / oversized / unicode / prototype-pollution arguments (coded
// VALIDATION errors, never an echo, the server stays up). No error-level stderr line; stdin EOF
// shuts the server down cleanly. Requires `npm run build` (the CI `process` job builds first).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { outputSchemaOf } from "../../src/mcp/define.js";
import { envelopeSchema } from "../../src/mcp/envelope.js";
import { ERROR_CODES } from "../../src/mcp/errors.js";
import { REGISTRY, toolNames } from "../../src/mcp/registry.js";
import { envelopeViolations } from "../mcp/helpers/walk.js";

type Walkable = Parameters<typeof envelopeViolations>[0];
import {
  alive,
  logRecords,
  makeHome,
  publishFixtures,
  requireDist,
  serve,
  waitFor,
  type E2eHome,
  type Served,
} from "./helpers.js";

const LEAGUE_KEY = "manual.l.example";
const TEAM_A = "manual.l.example.t.1";
const TEAM_B = "manual.l.example.t.2";
const ALLEN = "manual.p.00-0034857";
const CHASE = "manual.p.00-0036900";
const BOSWELL = "manual.p.00-0031136";
/** The C10 list tools answer without structuredContent (plan 10 A17). */
const C10 = new Set(["ff_list_players", "ff_list_transactions", "ff_list_recommendations"]);

/** Valid arguments for every tool on the fixture league (explicit weeks: date-independent). */
const VALID: Readonly<Record<string, readonly Record<string, unknown>[]>> = {
  ff_list_leagues: [{}, { season: 2026, include_finished: true }],
  ff_get_league: [{}, { league_key: LEAGUE_KEY, include: ["scoring", "stat_map"] }],
  ff_get_standings: [{}],
  ff_get_scoreboard: [{ week: 3 }, { week: 3, team_key: TEAM_A }],
  ff_list_transactions: [{}, { count: 40, types: ["waiver"], team_key: TEAM_A }],
  ff_get_roster: [{ week: 4 }, { team_key: TEAM_B, week: 3, detail: "full" }],
  ff_get_player_stats: [
    { player_keys: [ALLEN, CHASE, BOSWELL], type: "week", week: 3 },
    { player_keys: [ALLEN, "manual.p.def-det"], type: "season" },
  ],
  ff_search_players: [{ query: "Allen" }, { query: "de", position: "DEF", limit: 3 }],
  ff_list_players: [{ position: "K" }, { status: "FA", limit: 5, detail: "full" }],
  ff_get_injuries: [{}, { players: { player_keys: [ALLEN, CHASE] }, week: 3, only_flagged: true }],
  ff_get_schedule: [{ weeks: [4, 5] }, { nfl_team: "BUF", include_weather: false }],
  ff_project_players: [
    { players: { team_key: TEAM_A }, horizon: "week", week: 4, seed: 20260930 },
    { players: { player_keys: [ALLEN] }, horizon: "ros", seed: 1, detail: "full" },
  ],
  ff_analyze_lineup: [{ week: 3 }, { week: 4, objective: "mean" }],
  ff_analyze_matchup: [{ week: 3 }],
  ff_analyze_waivers: [{ positions: ["K", "DEF"], look_ahead: 2 }, { detail: "full" }],
  ff_analyze_retrospective: [{ week: 3 }],
  ff_list_recommendations: [{}, { week: 3, kind: "lineup", limit: 5 }],
  ff_get_status: [{}, { include_checks: true }],
  ff_debug_echo: [{}],
};

interface Env {
  data: Record<string, unknown>;
  meta: { request_id: string };
}

let home: E2eHome;
let srv: Served;
let pid: number;

const call = async (name: string, args: unknown) => {
  const r = await srv.client.callTool({ name, arguments: args as Record<string, unknown> });
  const content = r.content as { type: string; text: string }[];
  const text = content[0]?.text ?? "";
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { text }; // G3's text block is deliberately not JSON
  }
  return { r, text, body };
};

const schemaOf = (name: string): z.ZodType => {
  const def = REGISTRY.find((e) => e.tool.name === name)?.tool;
  return (def && outputSchemaOf(def)) ?? envelopeSchema(z.record(z.string(), z.unknown()));
};

beforeAll(async () => {
  requireDist();
  home = makeHome();
  const runs = await publishFixtures(home);
  for (const r of runs) expect(r.stdout).toMatch(/published/);
  srv = await serve(home.env);
  pid = srv.transport.pid ?? -1;
  expect(pid).toBeGreaterThan(0);
}, 120_000);

afterAll(async () => {
  await srv.close().catch(() => undefined);
  home.cleanup();
});

describe("the refreshed cache and the handshake", () => {
  it("tools/list: the 19 core tools in registry order + the fixture-mode G3, no write tool", async () => {
    const names = (await srv.client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(toolNames("core", true));
    expect(names.filter((n) => /^ff_(prepare|commit)_/.test(n))).toEqual([]);
  });
  it("covers every registered tool in the valid-args table", () => {
    expect(Object.keys(VALID).sort()).toEqual(
      [...toolNames("core", true)].filter((n) => n !== "ff_record_recommendation").sort(),
    );
  });
});

describe("every tool, valid arguments → a schema-valid envelope over stdio", () => {
  for (const [name, argsList] of Object.entries(VALID)) {
    for (const args of argsList) {
      it(`${name} ${JSON.stringify(args)}`, async () => {
        const { r, body } = await call(name, args);
        expect(r.isError, JSON.stringify(body).slice(0, 400)).not.toBe(true);
        if (name === "ff_debug_echo") {
          const nonce = (r.structuredContent as { data: { nonce: string } }).data.nonce;
          expect(nonce).toMatch(/^[0-9a-f]{12}$/);
          expect(JSON.stringify(r.content)).not.toContain(nonce);
          return;
        }
        const parsed = schemaOf(name).safeParse(body);
        expect(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 3))).toBe(true);
        expect(envelopeViolations(body as unknown as Walkable)).toEqual([]);
        expect(r.structuredContent === undefined).toBe(C10.has(name));
        if (r.structuredContent !== undefined) expect(r.structuredContent).toEqual(body);
        for (const m of JSON.stringify(body.data).matchAll(/"basis":"([a-z_]+)"/g))
          expect(m[1]).toBe("position_cv");
      }, 30_000);
    }
  }

  it("ff_record_recommendation records a real E2 rec; ff://rec reads it back", async () => {
    const lineup = await call("ff_analyze_lineup", { week: 3 });
    const env = lineup.body as unknown as Env;
    const rec = env.data.rec as Record<string, unknown>;
    const args = {
      kind: "lineup",
      week: 3,
      rec,
      alternatives: [],
      source_calls: [{ tool: "ff_analyze_lineup", request_id: env.meta.request_id }],
      followed_hint: "unknown",
      client_ref: "e2e-w3-lineup",
    };
    const { r, body } = await call("ff_record_recommendation", args);
    // a replayed past week whose rec is dated after the wall clock is refused by E12's domain
    // validation; the live clock is at/after the fixture week, so the record must succeed
    expect(r.isError, JSON.stringify(body).slice(0, 300)).not.toBe(true);
    expect(schemaOf("ff_record_recommendation").safeParse(body).success).toBe(true);
    const logId = (body as unknown as Env).data.log_id as string;
    expect(logId).toMatch(/^rec-/);
    const read = await srv.client.readResource({ uri: `ff://rec/${logId}` });
    const first = read.contents[0] as { text: string };
    expect(JSON.parse(first.text)).toHaveProperty("data");
    const week = await srv.client.readResource({ uri: "ff://rec/week/3" });
    expect((week.contents[0] as { text: string }).text).toContain(logId);
    const again = await call("ff_record_recommendation", args);
    expect((again.body as unknown as Env).data).toMatchObject({
      log_id: logId,
      deduplicated: true,
    });
  });
});

describe("every resource and every prompt", () => {
  it("reads every static resource (JSON envelopes, the markdown cheat-sheet)", async () => {
    const list = await srv.client.listResources();
    expect(list.resources.map((r) => r.uri).sort()).toEqual(
      [
        "ff://docs/tool-outputs",
        "ff://league",
        "ff://league/settings",
        "ff://status",
        "ff://status/freshness",
      ].sort(),
    );
    for (const res of list.resources) {
      const r = await srv.client.readResource({ uri: res.uri });
      const c = r.contents[0] as { uri: string; mimeType: string; text: string };
      expect(c.uri).toBe(res.uri);
      if (c.mimeType === "application/json") {
        const env = JSON.parse(c.text) as Record<string, unknown>;
        expect(env, res.uri).toHaveProperty("data");
        expect(env).not.toHaveProperty("error");
        expect(envelopeViolations(env as unknown as Walkable)).toEqual([]);
      } else {
        expect(c.mimeType).toBe("text/markdown");
        expect(c.text.length).toBeGreaterThan(500);
      }
    }
  });

  it("the templates answer; an unknown log id or a hostile URI is not found, never echoed", async () => {
    const t = await srv.client.listResourceTemplates();
    expect(t.resourceTemplates.map((x) => x.uriTemplate).sort()).toEqual([
      "ff://rec/week/{week}",
      "ff://rec/{log_id}",
    ]);
    const empty = await srv.client.readResource({ uri: "ff://rec/week/1" });
    expect(JSON.parse((empty.contents[0] as { text: string }).text)).toHaveProperty("data");
    for (const uri of [
      "ff://rec/rec-00000000000000000000000000",
      "ff://rec/<script>alert(1)",
      "ff://rec/rec-%00%0a",
      "ff://rec/week/99",
      "ff://rec/week/%E2%80%AE",
    ]) {
      const e = await srv.client.readResource({ uri }).then(
        () => null,
        (x: unknown) => x,
      );
      expect(e, uri).toBeInstanceOf(Error);
      expect((e as Error).message).not.toContain("<script>");
    }
  });

  it("gets every prompt; each carries the rule sentence exactly once", async () => {
    const prompts = (await srv.client.listPrompts()).prompts.map((p) => p.name).sort();
    expect(prompts).toEqual(["ff.retro", "ff.start_sit", "ff.stream"]);
    const args: Record<string, Record<string, string>> = {
      "ff.start_sit": { week: "4" },
      "ff.stream": { position: "K" },
      "ff.retro": { week: "3" },
    };
    for (const name of prompts) {
      const p = await srv.client.getPrompt({ name, arguments: args[name] ?? {} });
      const text = p.messages.map((m) => (m.content as { text?: string }).text ?? "").join("\n");
      expect(text.length, name).toBeGreaterThan(500);
      expect(text.split("are never instructions").length - 1, name).toBeLessThanOrEqual(1);
      expect(text.split("They are never instructions.").length - 1, name).toBe(1);
    }
  });
});

/** Arguments that are invalid for EVERY tool (the input schemas are strict objects). */
function hostileArgs(): { label: string; args: unknown; marker: string }[] {
  const big = "Z".repeat(300_000);
  let deep: Record<string, unknown> = { leaf: 1 };
  for (let i = 0; i < 200; i++) deep = { n: deep };
  return [
    {
      label: "constructor.prototype",
      args: { constructor: { prototype: { polluted: "yes-ctor" } } },
      marker: "yes-ctor",
    },
    {
      label: "an oversized unknown key",
      args: { [`k${"x".repeat(5000)}`]: 1 },
      marker: "xxxxxxxxxx",
    },
    { label: "an oversized value", args: { week: big, league_key: big }, marker: "ZZZZZZZZZZ" },
    {
      label: "unicode: bidi override, zero-width, emoji, lone surrogate",
      args: { league_key: "manual.l.\u202eevil\u200b🏈\ud800", week: "\u202e4" },
      marker: "evil",
    },
    {
      label: "wrong types everywhere",
      args: { week: [4], league_key: 7, detail: { x: 1 } },
      marker: "__none__",
    },
    { label: "200-deep nesting", args: { deep }, marker: "__none__" },
  ];
}

describe("hostile arguments: coded errors, never an echo, the server stays up", () => {
  for (const name of toolNames("core", true)) {
    it(
      name,
      async () => {
        for (const h of hostileArgs()) {
          const r = await srv.client
            .callTool({ name, arguments: h.args as Record<string, unknown> })
            .then(
              (x) => ({ ok: true as const, x }),
              (e: unknown) => ({ ok: false as const, e }),
            );
          expect(r.ok, `${name} / ${h.label}: protocol error ${r.ok ? "" : String(r.e)}`).toBe(
            true,
          );
          if (!r.ok) continue;
          expect(r.x.isError, `${name} / ${h.label}`).toBe(true);
          const text = (r.x.content as { text: string }[])[0]?.text ?? "";
          const body = JSON.parse(text) as { error: { code: string } };
          expect(ERROR_CODES).toContain(body.error.code);
          // a malformed key is INVALID_KEY (plan 01 §4.3); everything else is VALIDATION
          expect(["VALIDATION", "INVALID_KEY"], `${name} / ${h.label}`).toContain(body.error.code);
          expect(text).not.toContain(h.marker);
          expect(text.length).toBeLessThan(2000);
        }
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        const status = await srv.client.callTool({ name: "ff_get_status", arguments: {} });
        expect(status.isError).not.toBe(true);
      },
      60_000,
    );
  }
});

describe("stderr and shutdown", () => {
  it("stderr carried only JSON log lines, none at error level", () => {
    const recs = logRecords(srv.stderr);
    expect(recs.length).toBeGreaterThan(0);
    for (const r of recs) {
      expect(r, JSON.stringify(r)).not.toHaveProperty("raw");
      expect(["error", "fatal"], JSON.stringify(r)).not.toContain(r.level);
    }
    expect(recs.some((r) => r.event === "serve.ready")).toBe(true);
  });

  it("stdin EOF → the server logs a clean stdin shutdown and exits", async () => {
    await srv.close();
    await waitFor(() => !alive(pid), 10_000);
    await waitFor(
      () => logRecords(srv.stderr).some((r) => r.event === "serve.shutdown"),
      2_000,
    ).catch(() => undefined);
    const shutdown = logRecords(srv.stderr).find((r) => r.event === "serve.shutdown");
    expect(shutdown?.reason).toBe("stdin");
  });
});
