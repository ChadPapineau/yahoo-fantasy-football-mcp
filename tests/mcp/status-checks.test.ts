// status-checks.test.ts — G1 checks[] judge the REQUIRED datasets (the STALE_ONLY classes) apart
// from the optional drivers (the "omit" classes: weather), and name the failing source (QA-1-015;
// plan 07 §3.G "plan 03 §5 offline rows"; plan 01 §5.4 weather is an omitted driver, not an error).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, makeWorld, type World } from "./helpers/env.js";

interface Check {
  id: string;
  ok: boolean;
  detail: string;
}
interface G1 {
  data: { sources: { id: string; freshness: string }[]; checks: Check[] };
}

let world: World;
beforeAll(async () => {
  world = await makeWorld();
}, 60_000);
afterAll(() => {
  world.cleanup();
});

async function status(weather: "open-meteo" | "off"): Promise<G1["data"]> {
  const { client, close } = await connect(world, { options: { weatherSource: weather } });
  const r = await client.callTool({ name: "ff_get_status", arguments: { include_checks: true } });
  await close();
  expect(r.isError).not.toBe(true);
  return (JSON.parse((r.content as { text: string }[])[0]?.text ?? "{}") as G1).data;
}

describe("G1 checks: required datasets vs optional drivers (QA-1-015)", () => {
  it("nflverse published + weather never loaded: datasets_* ok; the optional driver is named apart", async () => {
    const d = await status("open-meteo");
    expect(d.sources.find((s) => s.id === "weather:open_meteo")?.freshness).toBe("never_loaded");
    for (const s of d.sources.filter((x) => x.id.startsWith("nflverse:")))
      expect(s.freshness, s.id).toBe("fresh");
    const byId = new Map(d.checks.map((c) => [c.id, c]));
    expect(byId.get("datasets_loaded")).toMatchObject({ ok: true, detail: "ok" });
    expect(byId.get("datasets_fresh")).toMatchObject({ ok: true, detail: "ok" });
    expect(byId.get("optional_drivers")).toMatchObject({ ok: false, detail: "weather_open_meteo" });
  });
  it("weather off: no optional driver to judge", async () => {
    const d = await status("off");
    const byId = new Map(d.checks.map((c) => [c.id, c]));
    expect(byId.get("datasets_fresh")).toMatchObject({ ok: true, detail: "ok" });
    expect(byId.get("optional_drivers")).toMatchObject({ ok: true, detail: "ok" });
  });
  it("a required dataset never loaded is named in detail", async () => {
    const empty = await makeWorld({ publish: false });
    try {
      const { client, close } = await connect(empty);
      const r = await client.callTool({
        name: "ff_get_status",
        arguments: { include_checks: true },
      });
      await close();
      const d = (JSON.parse((r.content as { text: string }[])[0]?.text ?? "{}") as G1).data;
      const byId = new Map(d.checks.map((c) => [c.id, c]));
      expect(byId.get("datasets_loaded")).toMatchObject({
        ok: false,
        detail: "nflverse_schedules",
      });
      expect(byId.get("datasets_fresh")).toMatchObject({ ok: false, detail: "nflverse_schedules" });
    } finally {
      empty.cleanup();
    }
  });
});
