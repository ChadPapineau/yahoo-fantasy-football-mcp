// dataset-unreadable.test.ts — QA-1-038: a dataset the refresh log lists as current whose file is
// damaged or gone is reported as exactly that — not "older than its hard limit", not "never loaded"
// — with the one command that repairs it (`ff refresh <source>`; plain refresh republishes a
// damaged file since 49ace6d). A source never loaded keeps the never-loaded hint.
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATASET_NEVER_LOADED_HINT, DATASET_UNREADABLE_MESSAGE } from "../../src/mcp/errors.js";
import { connect, makeWorld, type World } from "./helpers/env.js";

let world: World;
beforeEach(async () => {
  world = await makeWorld();
}, 60_000);
afterEach(() => {
  world.cleanup();
});

const file = (source: string): string =>
  path.join(world.cache, "ds", `${source.replace(":", "__")}.sqlite`);

async function errorOf(name: string, args: Record<string, unknown>) {
  const { client, close } = await connect(world);
  const r = await client.callTool({ name, arguments: args });
  await close();
  const text = (r.content as { text: string }[])[0]?.text ?? "";
  expect(r.isError, text.slice(0, 200)).toBe(true);
  return (JSON.parse(text) as { error: { code: string; message: string; hint: string } }).error;
}

describe("a current dataset whose file is unreadable or missing [QA-1-038]", () => {
  it("a damaged injuries file: STALE_ONLY says unreadable and names `ff refresh nflverse:injuries`", async () => {
    writeFileSync(file("nflverse:injuries"), Buffer.alloc(8192, 0x5a));
    const e = await errorOf("ff_get_injuries", {});
    expect(e.code).toBe("STALE_ONLY");
    expect(e.message).toBe(DATASET_UNREADABLE_MESSAGE);
    expect(e.message).not.toMatch(/hard limit/);
    expect(e.hint).toBe("Run `ff refresh nflverse:injuries` in a terminal, then retry.");
  });

  it("a deleted schedules file: the same, for the analytics gate", async () => {
    rmSync(file("nflverse:schedules"));
    const e = await errorOf("ff_analyze_lineup", { week: 4 });
    expect(e.code).toBe("STALE_ONLY");
    expect(e.message).toBe(DATASET_UNREADABLE_MESSAGE);
    expect(e.hint).toContain("ff refresh nflverse:schedules");
  });

  it("control: a source never loaded keeps the never-loaded hint", async () => {
    const empty = await makeWorld({ publish: false });
    try {
      const { client, close } = await connect(empty);
      const r = await client.callTool({ name: "ff_get_injuries", arguments: {} });
      await close();
      const e = (
        JSON.parse((r.content as { text: string }[])[0]?.text ?? "{}") as {
          error: { code: string; message: string; hint: string };
        }
      ).error;
      expect(e.code).toBe("STALE_ONLY");
      expect(e.hint).toBe(DATASET_NEVER_LOADED_HINT);
      expect(e.message).not.toBe(DATASET_UNREADABLE_MESSAGE);
    } finally {
      empty.cleanup();
    }
  });
});
