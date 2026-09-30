// fixture-fetch.test.ts — fixture mode's transport (config FF_FIXTURE_DIR; plan 05 §3.2): only files
// under the fixture dir, never a symlink leaf, never a `..` escape, 404 for anything unknown, and
// the real http client (allow-list included) runs on top of it.
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  fixtureFetch,
  NFLVERSE_RELEASE_BASE,
  nflverseRoutes,
  readFixture,
  weatherRoute,
} from "../../src/cli/fixture-fetch.js";
import { createHttpClient } from "../../src/http/client.js";
import { FIXTURES, sandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox | undefined;
afterEach(() => {
  sb?.cleanup();
  sb = undefined;
});

describe("fixtureFetch", () => {
  it("serves nflverse timestamp.txt and release files from the manifest", async () => {
    const f = fixtureFetch(FIXTURES);
    const ts = await f(`${NFLVERSE_RELEASE_BASE}/injuries/timestamp.txt`, {});
    expect(ts.status).toBe(200);
    expect((await ts.text()).trim()).toMatch(/^\d{4}-\d{2}-\d{2} /);
    const pq = await f(`${NFLVERSE_RELEASE_BASE}/injuries/injuries_2026.parquet`, {});
    expect(pq.status).toBe(200);
    expect(new Uint8Array(await pq.arrayBuffer()).slice(0, 4)).toEqual(
      new Uint8Array([0x50, 0x41, 0x52, 0x31]),
    );
  });

  it("404s unknown URLs and never reaches the network", async () => {
    const f = fixtureFetch(FIXTURES);
    expect((await f(`${NFLVERSE_RELEASE_BASE}/injuries/injuries_1999.parquet`, {})).status).toBe(
      404,
    );
    expect((await f("https://example.com/", {})).status).toBe(404);
    expect((await f("not a url", {})).status).toBe(404);
  });

  it("serves the weather fixtures by host", async () => {
    expect(weatherRoute("https://api.open-meteo.com/v1/forecast?latitude=1")).toBe(
      path.join("weather", "open-meteo-forecast.json"),
    );
    expect(weatherRoute("https://api.weather.gov/points/41.5,-81.6")).toBe(
      path.join("weather", "nws-points.json"),
    );
    expect(weatherRoute("https://api.weather.gov/gridpoints/CLE/83,65/forecast/hourly")).toBe(
      path.join("weather", "nws-forecast-hourly.json"),
    );
    const f = fixtureFetch(FIXTURES);
    const r = await f("https://api.open-meteo.com/v1/forecast?latitude=41&longitude=-81", {});
    expect(r.headers.get("content-type")).toBe("application/json");
  });

  it("rejects an already-aborted request like fetch does", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      fixtureFetch(FIXTURES)("https://api.open-meteo.com/v1/forecast", { signal: ac.signal }),
    ).rejects.toThrow(/abort/i);
  });

  it("the real http client over it still enforces the host allow-list", async () => {
    const http = createHttpClient({ fetch: fixtureFetch(FIXTURES) });
    await expect(
      http.get("https://evil.example/x", { signal: new AbortController().signal, maxBytes: 100 }),
    ).rejects.toThrow();
    const r = await http.get(`${NFLVERSE_RELEASE_BASE}/schedules/timestamp.txt`, {
      signal: new AbortController().signal,
      maxBytes: 1000,
    });
    expect(r.status).toBe(200);
  });
});

describe("a hostile fixture tree", () => {
  it("manifest entries escaping the tree, symlink leaves and oversized/odd entries are refused", async () => {
    sb = sandbox();
    const root = path.join(sb.dir, "fx");
    mkdirSync(path.join(root, "nflverse"), { recursive: true });
    writeFileSync(path.join(sb.dir, "secret.txt"), "outside");
    symlinkSync(path.join(sb.dir, "secret.txt"), path.join(root, "nflverse", "link.txt"));
    writeFileSync(
      path.join(root, "nflverse", "manifest.json"),
      JSON.stringify({
        timestamps: { injuries: "../../secret.txt", schedules: "link.txt", "../x": "a", ok: 5 },
        files: [
          { url: `${NFLVERSE_RELEASE_BASE}/x/y.parquet`, path: "../../secret.txt" },
          { url: "https://other.example/z", path: "a" },
          { url: 1, path: "b" },
        ],
      }),
    );
    const routes = nflverseRoutes(root);
    expect([...routes.keys()].sort()).toEqual([
      `${NFLVERSE_RELEASE_BASE}/injuries/timestamp.txt`,
      `${NFLVERSE_RELEASE_BASE}/schedules/timestamp.txt`,
      `${NFLVERSE_RELEASE_BASE}/x/y.parquet`,
    ]);
    const f = fixtureFetch(root);
    for (const u of [...routes.keys()]) expect((await f(u, {})).status, u).toBe(404);
    expect(readFixture(root, ".")).toBeNull();
    expect(readFixture(root, "nflverse")).toBeNull();
  });

  it("a missing or malformed manifest yields no routes", () => {
    sb = sandbox();
    expect(nflverseRoutes(sb.dir).size).toBe(0);
    mkdirSync(path.join(sb.dir, "nflverse"));
    writeFileSync(path.join(sb.dir, "nflverse", "manifest.json"), "{not json");
    expect(nflverseRoutes(sb.dir).size).toBe(0);
    writeFileSync(path.join(sb.dir, "nflverse", "manifest.json"), "{}");
    expect(nflverseRoutes(sb.dir).size).toBe(0);
  });
});
