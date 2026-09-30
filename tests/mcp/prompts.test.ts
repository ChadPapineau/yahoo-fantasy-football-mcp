// prompts.test.ts — the three Phase-1a prompts (plan 07 §4.2): the Skill body as the user message
// with the plan 02 §6.3 sentence exactly once, the embedded ff://league/settings resource, argument
// bounds, and the fallbacks when a Skill body or the league is missing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UNTRUSTED_TEXT_RULE } from "../../src/mcp/envelope.js";
import { PROMPTS, promptText } from "../../src/mcp/prompts/index.js";
import { connect, makeWorld, type World } from "./helpers/env.js";

let world: World;
beforeAll(async () => {
  world = await makeWorld({ publish: false });
});
afterAll(() => {
  world.cleanup();
});

const textOf = (m: { content: unknown }): string =>
  (m.content as { type: string; text?: string }).text ?? "";

describe("prompts/get", () => {
  it("ff.start_sit: rule once, the start-sit Skill body, the week, the embedded settings", async () => {
    const c = await connect(world);
    const r = await c.client.getPrompt({ name: "ff.start_sit", arguments: { week: "4" } });
    const t = textOf(r.messages[0] as { content: unknown });
    expect(t.split(UNTRUSTED_TEXT_RULE).length - 1).toBe(1);
    expect(t).toContain(world.options.texts.start_sit?.trim().slice(0, 40) ?? "");
    expect(t).toContain("Arguments: week=4");
    expect(t.startsWith("---")).toBe(false);
    const res = (
      r.messages[1] as { content: { type: string; resource: { uri: string; text: string } } }
    ).content;
    expect(res.type).toBe("resource");
    expect(res.resource.uri).toBe("ff://league/settings");
    expect(JSON.parse(res.resource.text)).toHaveProperty("data.scoring.settings_hash");
    await c.close();
  });
  it("ff.stream needs K or DEF; ff.retro takes an optional week", async () => {
    const c = await connect(world);
    const s = await c.client.getPrompt({ name: "ff.stream", arguments: { position: "DEF" } });
    expect(textOf(s.messages[0] as { content: unknown })).toContain("position=DEF");
    await expect(
      c.client.getPrompt({ name: "ff.stream", arguments: { position: "RB" } }),
    ).rejects.toThrow();
    await expect(c.client.getPrompt({ name: "ff.stream", arguments: {} })).rejects.toThrow();
    const r = await c.client.getPrompt({ name: "ff.retro", arguments: {} });
    expect(textOf(r.messages[0] as { content: unknown })).not.toContain("Arguments:");
    await expect(
      c.client.getPrompt({ name: "ff.retro", arguments: { week: "23" } }),
    ).rejects.toThrow();
    await c.close();
  });
  it("without a league file the settings resource is simply not embedded", async () => {
    const w = await makeWorld({ publish: false, noLeague: true });
    const c = await connect(w);
    const r = await c.client.getPrompt({ name: "ff.retro", arguments: { week: "3" } });
    expect(r.messages).toHaveLength(1);
    await c.close();
    w.cleanup();
  });
  it("a missing Skill body falls back to a fixed line (still with the rule)", () => {
    const t = promptText(
      { start_sit: null, stream: null, retro: null, tool_outputs: null },
      "retro",
      {},
    );
    expect(t).toContain(UNTRUSTED_TEXT_RULE);
    expect(t).toContain("not installed");
    expect(PROMPTS.map((p) => p.name)).toEqual(["ff.start_sit", "ff.stream", "ff.retro"]);
  });
});
