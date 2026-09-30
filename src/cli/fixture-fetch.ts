// fixture-fetch.ts — fixture mode for `ff refresh` (config FF_FIXTURE_DIR: "serve recorded fixtures
// from this absolute directory (tests, smoke, debug tools)"; plan 05 §3.2 nflverse excerpts, §8 "no
// network"). A FetchLike that answers the Phase-1a upstream URLs from the fixture tree, so the REAL
// http client (allow-list, redirects, size caps, error mapping), the runner and the publisher all
// run unchanged — only the socket is replaced. It is not a test hook: it is the documented fixture
// mode, it can only ever read files under FF_FIXTURE_DIR, and it never opens a connection.
import { closeSync, constants as fsc, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { isInside } from "../config/paths.js";
import type { FetchLike } from "../http/client.js";

/** The nflverse release base the sources request (src/sources/nflverse/release.ts). */
export const NFLVERSE_RELEASE_BASE = "https://github.com/nflverse/nflverse-data/releases/download";
/** Largest fixture file served (the excerpts are ≤ 1 MB; this only bounds a hostile tree). */
export const MAX_FIXTURE_BYTES = 32 * 1024 * 1024;

interface NflverseManifest {
  readonly timestamps?: Readonly<Record<string, unknown>>;
  readonly files?: readonly { readonly path?: unknown; readonly url?: unknown }[];
  readonly default_seasons?: unknown;
}

/** Reads a regular file under `root` (no symlink at the leaf, no `..` escape), bounded. */
export function readFixture(root: string, rel: string): Uint8Array | null {
  const file = path.resolve(root, rel);
  if (!isInside(file, root) || file === path.resolve(root)) return null;
  let fd: number;
  try {
    fd = openSync(file, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_FIXTURE_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return new Uint8Array(buf.subarray(0, off));
  } finally {
    closeSync(fd);
  }
}

/** `<fixtureDir>/nflverse/manifest.json`, parsed; null when missing or malformed. */
function readManifest(fixtureDir: string): NflverseManifest | null {
  const bytes = readFixture(fixtureDir, path.join("nflverse", "manifest.json"));
  if (bytes === null) return null;
  try {
    const m: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    return m !== null && typeof m === "object" && !Array.isArray(m) ? m : null;
  } catch {
    return null;
  }
}

/**
 * The seasons fixture mode refreshes by default, per source id (manifest `default_seasons`): the
 * seasons the tree actually records, so a bare `ff refresh all` in fixture mode requests only files
 * it holds (the clock-derived production defaults ask for last season's stats, which the ≤ 300 KB
 * excerpts do not carry). An entry that is not a `<provider>:<dataset>` id with 1–30 ascending,
 * distinct 1999–2100 seasons is ignored (that source keeps the production default).
 */
export function fixtureDefaultSeasons(fixtureDir: string): ReadonlyMap<string, readonly number[]> {
  const out = new Map<string, readonly number[]>();
  const m = readManifest(path.resolve(fixtureDir));
  const raw = m?.default_seasons;
  if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw))
    return out;
  for (const [id, v] of Object.entries(raw)) {
    if (!/^[a-z_]{1,20}:[a-z_]{1,40}$/.test(id) || !Array.isArray(v)) continue;
    const seasons = v as unknown[];
    const ok =
      seasons.length >= 1 &&
      seasons.length <= 30 &&
      seasons.every(
        (x, i) =>
          typeof x === "number" &&
          Number.isInteger(x) &&
          x >= 1999 &&
          x <= 2100 &&
          (i === 0 || (seasons[i - 1] as number) < x),
      );
    if (ok) out.set(id, Object.freeze([...(seasons as number[])]));
  }
  return out;
}

/** URL → fixture-relative path, from `<fixtureDir>/nflverse/manifest.json` (missing → empty). */
export function nflverseRoutes(fixtureDir: string): Map<string, string> {
  const routes = new Map<string, string>();
  const m = readManifest(fixtureDir);
  if (m === null) return routes;
  const TAG = /^[a-z0-9_]{1,40}$/;
  for (const [tag, rel] of Object.entries(m.timestamps ?? {})) {
    if (TAG.test(tag) && typeof rel === "string")
      routes.set(`${NFLVERSE_RELEASE_BASE}/${tag}/timestamp.txt`, path.join("nflverse", rel));
  }
  for (const f of m.files ?? []) {
    if (
      typeof f.url === "string" &&
      typeof f.path === "string" &&
      f.url.startsWith(`${NFLVERSE_RELEASE_BASE}/`)
    )
      routes.set(f.url, path.join("nflverse", f.path));
  }
  return routes;
}

/** The weather fixture for a URL (Open-Meteo forecast; NWS points → hourly), or null. */
export function weatherRoute(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname === "api.open-meteo.com") return path.join("weather", "open-meteo-forecast.json");
  if (u.hostname === "api.weather.gov")
    return u.pathname.startsWith("/points/")
      ? path.join("weather", "nws-points.json")
      : path.join("weather", "nws-forecast-hourly.json");
  return null;
}

function contentType(rel: string): string {
  if (rel.endsWith(".json")) return "application/json";
  if (rel.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

/**
 * A FetchLike over the fixture tree: 200 + bytes for a known URL, 404 otherwise. Honours the
 * request's abort signal like a real fetch.
 */
export function fixtureFetch(fixtureDir: string): FetchLike {
  const root = path.resolve(fixtureDir);
  const routes = nflverseRoutes(root);
  return (url, init) => {
    if (init.signal?.aborted === true)
      return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
    const bare = url.split("#")[0] ?? url;
    const rel = routes.get(bare.split("?")[0] ?? bare) ?? weatherRoute(bare);
    const bytes = rel === null ? null : readFixture(root, rel);
    if (rel === null || bytes === null)
      return Promise.resolve(new Response(null, { status: 404, statusText: "Not Found" }));
    return Promise.resolve(
      new Response(bytes, {
        status: 200,
        headers: { "content-type": contentType(rel), "content-length": String(bytes.byteLength) },
      }),
    );
  };
}
