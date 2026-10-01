// error-output-schema.test.ts — a tool error result never carries structuredContent that its own
// advertised outputSchema rejects (QA-1-007; MCP spec "Servers MUST provide structured results that
// conform to this schema", plan 01 §4.2/§4.3): the coded error lives in the one text block, and a
// client that validates structuredContent unconditionally still reads every error.
import { Ajv } from "@modelcontextprotocol/client/validators/ajv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, makeWorld, type World } from "./helpers/env.js";

/** One call per error code reachable on the fixture league, across tool families. */
const ERRORS: readonly [string, Record<string, unknown>, string][] = [
  ["ff_analyze_matchup", {}, "NOT_FOUND"],
  ["ff_get_roster", { week: 0 }, "VALIDATION"],
  ["ff_get_roster", { team_key: "not a key" }, "INVALID_KEY"],
  ["ff_get_player_stats", { player_keys: ["manual.p.99-9999999"], type: "season" }, "NOT_FOUND"],
  ["ff_get_status", { include_checks: "yes" }, "VALIDATION"],
  ["ff_list_players", { limit: -1 }, "VALIDATION"],
  ["ff_get_injuries", { bogus: 1 }, "VALIDATION"],
];

describe("tool error results conform to the advertised outputSchema (QA-1-007)", () => {
  let world: World;
  beforeAll(async () => {
    world = await makeWorld();
  }, 60_000);
  afterAll(() => {
    world.cleanup();
  });

  for (const modern of [false, true])
    it(`${modern ? "2026" : "legacy"} era: no structuredContent on isError; the text holds the code`, async () => {
      const { client, close } = await connect(world, { modern });
      const tools = (await client.listTools()).tools;
      const ajv = new Ajv({ strict: false });
      for (const [name, args, code] of ERRORS) {
        const r = (await client.request({
          method: "tools/call",
          params: { name, arguments: args },
        })) as { isError?: boolean; content: { text: string }[]; structuredContent?: unknown };
        expect(r.isError, name).toBe(true);
        const body = JSON.parse(r.content[0]?.text ?? "{}") as { error: { code: string } };
        expect(body.error.code, `${name} ${JSON.stringify(args)}`).toBe(code);
        const schema = tools.find((t) => t.name === name)?.outputSchema;
        if (r.structuredContent !== undefined && schema !== undefined)
          expect(
            ajv.compile(schema as Parameters<typeof ajv.compile>[0])(r.structuredContent),
            `${name}: structured error vs outputSchema`,
          ).toBe(true);
        expect(r.structuredContent, name).toBeUndefined();
      }
      await close();
    });
});
