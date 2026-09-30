// harness.ts — test plumbing for the nflverse sources: the fixture manifest, a fake HttpGet serving
// fixture bytes by release URL (no network, ever), a SourceContext on a temp dir and a fixed clock,
// and a real DatasetWriter over node:sqlite built from the contract's own DDL (ddlFor, STRICT).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixedClock } from "../../../../src/domain/clock.js";
import type { HttpGet, SourceContext } from "../../../../src/sources/source.js";
import { ddlFor } from "../../../../src/store/datasets/tables.js";
import type { DatasetRow, DatasetTableSpec, DatasetWriter } from "../../../../src/store/types.js";

export const FIXTURES = new URL("../../../../fixtures/nflverse/", import.meta.url).pathname;
export const REL = "https://github.com/nflverse/nflverse-data/releases/download";

interface Manifest {
  timestamps: Record<string, string>;
  files: { path: string; url: string; kind: string; rows: number; sha256: string }[];
}
export const manifest = JSON.parse(
  readFileSync(join(FIXTURES, "manifest.json"), "utf8"),
) as Manifest;

/** Fixture bytes by release URL (timestamp.txt per tag + every manifest file). */
export function fixtureRoutes(): Map<string, Uint8Array> {
  const routes = new Map<string, Uint8Array>();
  for (const [tag, rel] of Object.entries(manifest.timestamps)) {
    routes.set(`${REL}/${tag}/timestamp.txt`, readFileSync(join(FIXTURES, rel)));
  }
  for (const f of manifest.files) routes.set(f.url, readFileSync(join(FIXTURES, f.path)));
  return routes;
}

/** Bytes of one fixture file. */
export function fixtureBytes(rel: string): Uint8Array {
  return readFileSync(join(FIXTURES, rel));
}

export interface FakeHttp {
  readonly http: HttpGet;
  readonly calls: string[];
}

/** A fake HttpGet: 200 + bytes for a known route, 404 otherwise; `final_url` on the asset host. */
export function fakeHttp(routes: Map<string, Uint8Array | Error | number>): FakeHttp {
  const calls: string[] = [];
  const http: HttpGet = (url, opts) => {
    calls.push(url);
    if (opts.signal.aborted) return Promise.reject(new Error("aborted"));
    const r = routes.get(url);
    if (r instanceof Error) return Promise.reject(r);
    const status = typeof r === "number" ? r : r === undefined ? 404 : 200;
    const body = r instanceof Uint8Array ? r : new Uint8Array(0);
    if (body.length > opts.maxBytes) return Promise.reject(new Error("too_large"));
    return Promise.resolve({
      status,
      body,
      headers: {},
      final_url: `https://release-assets.githubusercontent.com/x/${String(calls.length)}`,
    });
  };
  return { http, calls };
}

export interface Ctx {
  readonly ctx: SourceContext;
  readonly tempDir: string;
  readonly calls: string[];
  readonly abort: AbortController;
  cleanup(): void;
}

/** A SourceContext over a fake HttpGet and a fresh temp dir. */
export function makeCtx(
  seasons: readonly number[],
  routes: Map<string, Uint8Array | Error | number> = fixtureRoutes(),
  extra: Record<string, unknown> = {},
): Ctx {
  const tempDir = mkdtempSync(join(tmpdir(), "ff-nflverse-test-"));
  const { http, calls } = fakeHttp(routes);
  const abort = new AbortController();
  const ctx = {
    http,
    signal: abort.signal,
    clock: fixedClock("2026-09-30T18:00:00.000Z"),
    seasons,
    week: null,
    datasets: {
      schedules: {
        games: () => {
          throw new Error("not used");
        },
        firstKickoff: () => {
          throw new Error("not used");
        },
      },
    },
    tempDir,
    ...extra,
  } as unknown as SourceContext;
  return {
    ctx,
    tempDir,
    calls,
    abort,
    cleanup: () => {
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

type SqlValue = string | number | null | Uint8Array;

/** A DatasetWriter over a real SQLite file (the contract's STRICT DDL), recording batch sizes. */
export class SqliteWriter implements DatasetWriter {
  readonly path: string;
  readonly db: DatabaseSync;
  readonly batches: { table: string; rows: number }[] = [];
  readonly created: string[] = [];

  constructor(dir: string) {
    this.path = join(dir, `staging-${String(Math.floor(performance.now() * 1000))}.sqlite`);
    this.db = new DatabaseSync(this.path);
  }

  createTable(spec: DatasetTableSpec): void {
    for (const sql of ddlFor(spec)) this.db.exec(sql);
    this.created.push(spec.name);
  }

  insert(table: string, rows: readonly DatasetRow[]): number {
    if (rows.length === 0) return 0;
    const cols = Object.keys(rows[0] ?? {});
    const stmt = this.db.prepare(
      `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols
        .map(() => "?")
        .join(", ")})`,
    );
    this.db.exec("BEGIN");
    try {
      for (const r of rows) stmt.run(...cols.map((c): SqlValue => r[c] ?? null));
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.batches.push({ table, rows: rows.length });
    return rows.length;
  }

  all(sql: string, ...params: SqlValue[]): Record<string, unknown>[] {
    return this.db.prepare(sql).all(...params);
  }

  close(): void {
    this.db.close();
  }
}
