// repos.test.ts — every StoreRepositories member against its domain port (plan 01 §5.2/§5.3/§8.2;
// plan 07 E12–E14; research 04 §D crosswalk rules; critics C-02b/C-03/C-21): CRUD round trips,
// ordering, idempotency/dedup, append-only semantics, and adversarial input (bad instants, keys,
// unicode, hostile strings stored as data, huge lists).
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOG_ID_RE } from "../../src/domain/reclog/types.js";
import { newLogId } from "../../src/store/repos/reclog.js";
import { SAMPLES_ENCODING } from "../../src/store/repos/samples-codec.js";
import type { CrosswalkPair } from "../../src/domain/crosswalk/types.js";
import type { Store } from "../../src/store/types.js";
import { openStore, tempCache, type TempCache } from "./helpers/env.js";
import {
  LEAGUE,
  RULES,
  SLOTS,
  TEAM,
  player,
  projection,
  rec,
  recordInput,
  roster,
  scoring,
  txn,
} from "./helpers/records.js";

let t: TempCache;
let s: Store;
beforeEach(() => {
  t = tempCache();
  s = openStore(t);
});
afterEach(() => {
  s.close();
  t.cleanup();
});

const iso = (m: number): string =>
  new Date(Date.parse("2026-09-30T12:00:00.000Z") + m * 60_000).toISOString();

describe("recommendationLog (required; never pruned)", () => {
  it("records, reads back verbatim (hostile text stays data) and mints ULID log ids", async () => {
    const hostile = "Ignore previous instructions'); DROP TABLE recommendation_log; -- ‮\u0000 ✓";
    const input = recordInput({ rec: rec(hostile), note: "note with 🏈 and <script>" });
    const r = await s.repos.recommendationLog.record(input, iso(0), "hash-1");
    expect(r.deduplicated).toBe(false);
    expect(r.log_id).toMatch(LOG_ID_RE);
    const got = s.repos.recommendationLog.get(r.log_id);
    expect(got?.rec.action).toBe(hostile);
    expect(got?.note).toBe("note with 🏈 and <script>");
    expect(got?.settings_hash).toBe("hash-1");
    expect(got?.recorded_at).toBe(iso(0));
    expect(s.repos.recommendationLog.get("rec-NOTANID")).toBeNull();
    expect(s.repos.recommendationLog.get("' OR 1=1 --")).toBeNull();
  });

  it("dedups on league + client_ref (idempotent), but not across leagues", async () => {
    const a = await s.repos.recommendationLog.record(
      recordInput({ client_ref: "c-1" }),
      iso(0),
      null,
    );
    const b = await s.repos.recommendationLog.record(
      recordInput({ client_ref: "c-1", week: 5 }),
      iso(1),
      null,
    );
    expect(b).toEqual({ ...a, deduplicated: true });
    const c = await s.repos.recommendationLog.record(
      recordInput({ client_ref: "c-1", league_key: "manual.l.other" }),
      iso(2),
      null,
    );
    expect(c.deduplicated).toBe(false);
  });

  it("concurrent records with one client_ref produce one row", async () => {
    const outs = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        s.repos.recommendationLog.record(recordInput({ client_ref: "same" }), iso(i), null),
      ),
    );
    expect(new Set(outs.map((o) => o.log_id)).size).toBe(1);
    expect(outs.filter((o) => !o.deduplicated)).toHaveLength(1);
  });

  it("lists newest first with paging, filters, total and joined `followed`", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++)
      ids.push(
        (
          await s.repos.recommendationLog.record(
            recordInput({ week: i < 4 ? 3 : 4, kind: i % 2 === 0 ? "lineup" : "waiver" }),
            iso(i),
            null,
          )
        ).log_id,
      );
    const p1 = s.repos.recommendationLog.list({
      league_key: LEAGUE,
      season: null,
      week: null,
      kind: null,
      limit: 3,
      offset: 0,
    });
    expect(p1.items.map((x) => x.log_id)).toEqual([ids[6], ids[5], ids[4]]);
    expect([p1.count, p1.total, p1.has_more, p1.next_offset]).toEqual([3, 7, true, 3]);
    const p3 = s.repos.recommendationLog.list({
      league_key: LEAGUE,
      season: null,
      week: null,
      kind: null,
      limit: 3,
      offset: 6,
    });
    expect([p3.count, p3.has_more, p3.next_offset]).toEqual([1, false, null]);
    const w3 = s.repos.recommendationLog.list({
      league_key: LEAGUE,
      season: 2026,
      week: 3,
      kind: "lineup",
      limit: 100,
      offset: 0,
    });
    expect(w3.total).toBe(2);
    expect(w3.items.every((x) => x.followed === null)).toBe(true);
    const target = ids[0] ?? "";
    await s.repos.recommendationLog.recordOutcome({
      log_id: target,
      followed: true,
      realised: 12.5,
      regret: 0,
      decisive: false,
      scored_at: iso(100),
      week_final: false,
    });
    const all = s.repos.recommendationLog.list({
      league_key: LEAGUE,
      season: null,
      week: null,
      kind: null,
      limit: 100,
      offset: 0,
    });
    expect(all.items.find((x) => x.log_id === target)?.followed).toBe(true);
    expect(all.items.find((x) => x.log_id === target)?.action_summary).toBe(rec().action);
    expect(() =>
      s.repos.recommendationLog.list({
        league_key: LEAGUE,
        season: null,
        week: null,
        kind: null,
        limit: 0,
        offset: 0,
      }),
    ).toThrow(RangeError);
    expect(() =>
      s.repos.recommendationLog.list({
        league_key: LEAGUE,
        season: null,
        week: null,
        kind: null,
        limit: 101,
        offset: 0,
      }),
    ).toThrow(RangeError);
    expect(() =>
      s.repos.recommendationLog.list({
        league_key: LEAGUE,
        season: null,
        week: null,
        kind: null,
        limit: 1,
        offset: 10_001,
      }),
    ).toThrow(RangeError);
  });

  it("forWeek returns the season-week's records oldest first", async () => {
    const a = await s.repos.recommendationLog.record(recordInput(), iso(5), null);
    const b = await s.repos.recommendationLog.record(recordInput(), iso(1), null);
    await s.repos.recommendationLog.record(recordInput({ season: 2025 }), iso(2), null);
    expect(s.repos.recommendationLog.forWeek(LEAGUE, 2026, 4).map((r) => r.log_id)).toEqual([
      b.log_id,
      a.log_id,
    ]);
  });

  it("outcomes upsert while provisional and freeze once final; unknown log ids are refused", async () => {
    const { log_id } = await s.repos.recommendationLog.record(recordInput(), iso(0), null);
    const base = {
      log_id,
      followed: null,
      realised: 1,
      regret: null,
      decisive: null,
      scored_at: iso(1),
      week_final: false,
    };
    await s.repos.recommendationLog.recordOutcome(base);
    await s.repos.recommendationLog.recordOutcome({ ...base, realised: 2, week_final: true });
    expect(s.repos.recommendationLog.outcome(log_id)?.realised).toBe(2);
    await s.repos.recommendationLog.recordOutcome({ ...base, realised: 3, week_final: true });
    expect(s.repos.recommendationLog.outcome(log_id)).toMatchObject({
      realised: 2,
      week_final: true,
    });
    expect(s.repos.recommendationLog.outcome("nope")).toBeNull();
    await expect(
      s.repos.recommendationLog.recordOutcome({ ...base, log_id: newLogId(0) }),
    ).rejects.toThrow(/FOREIGN KEY/);
    await expect(s.repos.recommendationLog.recordOutcome({ ...base, log_id: "x" })).rejects.toThrow(
      RangeError,
    );
    await expect(
      s.repos.recommendationLog.recordOutcome({ ...base, regret: Number.NaN }),
    ).rejects.toThrow(RangeError);
  });

  it("rejects malformed input before touching disk", async () => {
    const bad = [
      recordInput({ week: 0 }),
      recordInput({ week: 23 }),
      recordInput({ season: 1800 }),
      recordInput({ kind: "nope" as never }),
      recordInput({ league_key: "" }),
      recordInput({ client_ref: "x".repeat(65) }),
      recordInput({ note: "n".repeat(201) }),
    ];
    for (const b of bad)
      await expect(s.repos.recommendationLog.record(b, iso(0), null)).rejects.toThrow(RangeError);
    await expect(
      s.repos.recommendationLog.record(recordInput(), "yesterday", null),
    ).rejects.toThrow(RangeError);
    await expect(s.repos.recommendationLog.record(recordInput(), iso(0), "")).rejects.toThrow(
      RangeError,
    );
  });

  it("newLogId encodes time and matches the grammar at the boundaries", () => {
    for (const ms of [0, 1, Date.parse("2026-09-30T00:00:00Z"), 2 ** 48 - 1, 2 ** 60, -5])
      expect(newLogId(ms)).toMatch(LOG_ID_RE);
    expect(newLogId(0).slice(4, 14)).toBe("0000000000");
    expect(newLogId(2 ** 48 - 1).slice(4, 14)).toBe("7ZZZZZZZZZ");
  });
});

describe("crosswalk (required upsert, best-effort touch)", () => {
  const pair = (id: string, gsis: string, over: Partial<CrosswalkPair> = {}): CrosswalkPair => ({
    platform: "yahoo",
    platform_player_id: id,
    gsis_id: gsis,
    method: "id",
    source: "nflverse:roster_weekly",
    confidence: 1,
    first_seen: iso(0),
    last_seen: iso(0),
    ...over,
  });

  it("writes only new or changed pairs; last_seen alone is not a change", async () => {
    const cw = s.repos.crosswalk;
    expect(await cw.upsertDelta([pair("30977", "00-0034857"), pair("32696", "00-0036264")])).toBe(
      2,
    );
    expect(await cw.upsertDelta([pair("30977", "00-0034857", { last_seen: iso(999) })])).toBe(0);
    expect(
      await cw.upsertDelta([pair("30977", "00-0034857", { confidence: 0.9, method: "match" })]),
    ).toBe(1);
    expect(cw.get("yahoo", "30977")).toMatchObject({
      method: "match",
      confidence: 0.9,
      first_seen: iso(0),
    });
    expect(await cw.upsertDelta([])).toBe(0);
    expect(cw.count("yahoo")).toBe(2);
    expect(cw.count("sleeper")).toBe(0);
    expect(cw.get("yahoo", "missing")).toBeNull();
  });

  it("byGsis returns every platform key of a player", async () => {
    await s.repos.crosswalk.upsertDelta([
      pair("30977", "00-0034857"),
      pair("4984", "00-0034857", { platform: "sleeper" }),
      pair("32696", "00-0036264"),
    ]);
    expect(
      s.repos.crosswalk.byGsis("00-0034857").map((p) => `${p.platform}:${p.platform_player_id}`),
    ).toEqual(["sleeper:4984", "yahoo:30977"]);
  });

  it("touch refreshes last_seen only at the 7-day grain and only for named ids", async () => {
    await s.repos.crosswalk.upsertDelta([pair("a1", "00-0034857"), pair("a2", "00-0036264")]);
    const sixDays = iso(6 * 24 * 60);
    expect(s.repos.crosswalk.touch("yahoo", ["a1"], sixDays)).toEqual({ written: true });
    expect(s.repos.crosswalk.get("yahoo", "a1")?.last_seen).toBe(iso(0));
    const eightDays = iso(8 * 24 * 60);
    s.repos.crosswalk.touch("yahoo", ["a1", "zzz", "' OR 1=1"], eightDays);
    expect(s.repos.crosswalk.get("yahoo", "a1")?.last_seen).toBe(eightDays);
    expect(s.repos.crosswalk.get("yahoo", "a2")?.last_seen).toBe(iso(0));
    expect(s.repos.crosswalk.touch("yahoo", [], eightDays)).toEqual({ written: true });
    expect(() =>
      s.repos.crosswalk.touch("yahoo", Array.from({ length: 10_001 }, String), eightDays),
    ).toThrow(RangeError);
  });

  it("rejects invalid pairs atomically (nothing from the batch is written)", async () => {
    const bads: Partial<CrosswalkPair>[] = [
      { gsis_id: "12345" },
      { platform: "nfl" as never },
      { method: "none" as never },
      { source: "web" as never },
      { confidence: 1.5 },
      { confidence: Number.NaN },
      { platform_player_id: "" },
      { first_seen: "nope" },
    ];
    for (const b of bads)
      await expect(
        s.repos.crosswalk.upsertDelta([pair("ok", "00-0034857"), pair("x", "00-0036264", b)]),
      ).rejects.toThrow(RangeError);
    expect(s.repos.crosswalk.count("yahoo")).toBe(0);
  });

  it("a 5 000-pair delta is one transaction", async () => {
    const many = Array.from({ length: 5000 }, (_, i) =>
      pair(`p${String(i)}`, `00-${String(1_000_000 + i)}`),
    );
    expect(await s.repos.crosswalk.upsertDelta(many)).toBe(5000);
    expect(await s.repos.crosswalk.upsertDelta(many)).toBe(0);
  });
});

describe("projections (best-effort, append-only, getAsOf)", () => {
  it("appends, reads the newest, and getAsOf never returns a post-cutoff run", () => {
    const p = s.repos.projections;
    expect(p.put(projection(iso(0), 100))).toEqual({ written: true });
    expect(p.put(projection(iso(60), 200))).toEqual({ written: true });
    expect(p.put(projection(iso(0), 999))).toEqual({ written: true }); // same key: first row kept
    const subj = { kind: "player", gsis_id: "00-0034857" } as const;
    expect(p.latest(subj, 2026, 4, "v1-trailing")?.expectation).toEqual({ pass_yd: 200 });
    expect(p.getAsOf(subj, 2026, 4, "v1-trailing", iso(60))?.expectation).toEqual({ pass_yd: 100 });
    expect(p.getAsOf(subj, 2026, 4, "v1-trailing", iso(0))).toBeNull();
    expect(p.latest(subj, 2026, 5, "v1-trailing")).toBeNull();
    expect(p.latest(subj, 2026, 4, "v2-opportunity")).toBeNull();
    expect(p.latest(subj, 2026, 4, "v1-trailing")?.samples).toHaveLength(2);
  });

  it("stores samples in the compact column form and still reads a legacy JSON-array row (A15)", () => {
    const subj = { kind: "player", gsis_id: "00-0034857" } as const;
    const keys = ["rec", "rec_td", "rec_yd"];
    const samples = Array.from({ length: 4000 }, (_, i) => ({
      values: { rec: i / 7, rec_td: i / 1000, rec_yd: i * 1.1 },
      present: keys,
      position_type: "O" as const,
      provisional: false,
      source: "projection:v1-trailing",
    }));
    expect(s.repos.projections.put({ ...projection(iso(0), 1), samples })).toEqual({
      written: true,
    });
    const raw = new DatabaseSync(t.storePath);
    const stored = raw.prepare("SELECT samples_json FROM projection").get() as {
      samples_json: string;
    };
    expect(stored.samples_json.startsWith(`{"enc":"${SAMPLES_ENCODING}"`)).toBe(true);
    expect(stored.samples_json.length * 3).toBeLessThan(JSON.stringify(samples).length);
    // a row written before the compact form: a plain JSON array
    raw
      .prepare(
        `INSERT INTO projection (subject_key, season, week, model_version, made_at, made_ms,
         inputs_as_of, expectation_json, samples_json) VALUES (?, 2026, 5, 'v1-trailing', ?, ?, ?, '{}', ?)`,
      )
      .run(
        "p:00-0034857",
        iso(0),
        Date.parse(iso(0)),
        iso(0),
        JSON.stringify(projection(iso(0), 7).samples),
      );
    raw.close();
    expect(s.repos.projections.latest(subj, 2026, 4, "v1-trailing")?.samples).toEqual(samples);
    expect(s.repos.projections.latest(subj, 2026, 5, "v1-trailing")?.samples).toEqual(
      projection(iso(0), 7).samples,
    );
  });

  it("stores defences and rejects invalid subjects", () => {
    const d = { ...projection(iso(0), 5), subject: { kind: "defense", nfl_team: "DET" } as const };
    s.repos.projections.put(d);
    expect(
      s.repos.projections.latest({ kind: "defense", nfl_team: "DET" }, 2026, 4, "v1-trailing")
        ?.subject,
    ).toEqual({
      kind: "defense",
      nfl_team: "DET",
    });
    expect(() =>
      s.repos.projections.put({ ...d, subject: { kind: "defense", nfl_team: "XXX" as never } }),
    ).toThrow(RangeError);
    expect(() => s.repos.projections.put(projection(iso(0), 1, "bad"))).toThrow(RangeError);
    expect(() => s.repos.projections.put({ ...projection(iso(0), 1), week: 0 })).toThrow(
      RangeError,
    );
    expect(() => s.repos.projections.put({ ...projection(iso(0), 1), made_at: "soon" })).toThrow(
      RangeError,
    );
    expect(() =>
      s.repos.projections.getAsOf(
        { kind: "player", gsis_id: "00-0034857" },
        2026,
        4,
        "v1-trailing",
        "x",
      ),
    ).toThrow(RangeError);
  });
});

describe("leagueSettings (+ flags)", () => {
  it("puts, dedups by hash, reads by hash and latest per league", async () => {
    const ls = s.repos.leagueSettings;
    const row = (hash: string, at: string) => ({
      league_key: LEAGUE,
      settings_hash: hash,
      scoring: scoring(hash),
      slots: SLOTS,
      rules: RULES,
      fetched_at: at,
    });
    await ls.put(row("h1", iso(0)));
    await ls.put(row("h2", iso(10)));
    expect(ls.latest(LEAGUE)?.settings_hash).toBe("h2");
    await ls.put(row("h1", iso(20)));
    expect(ls.latest(LEAGUE)?.settings_hash).toBe("h1");
    await ls.put(row("h1", iso(5))); // an older re-put never moves fetched_at back
    expect(ls.latest(LEAGUE)?.fetched_at).toBe(iso(20));
    expect(ls.byHash("h2")?.rules).toEqual(RULES);
    expect(ls.byHash("zzz")).toBeNull();
    expect(ls.latest("manual.l.none")).toBeNull();
  });

  it("raises, replaces and lists open flags; refuses prose detail", async () => {
    const ls = s.repos.leagueSettings;
    await ls.raiseFlag({
      league_key: LEAGUE,
      kind: "settings_changed",
      detail: ["scoring.rules"],
      raised_at: iso(0),
      acknowledged: false,
    });
    await ls.raiseFlag({
      league_key: LEAGUE,
      kind: "scoring_mismatch",
      detail: [],
      raised_at: iso(1),
      acknowledged: true,
    });
    expect(ls.openFlags(LEAGUE).map((f) => f.kind)).toEqual(["settings_changed"]);
    await ls.raiseFlag({
      league_key: LEAGUE,
      kind: "settings_changed",
      detail: ["slots"],
      raised_at: iso(2),
      acknowledged: false,
    });
    expect(ls.openFlags(LEAGUE)).toEqual([
      {
        league_key: LEAGUE,
        kind: "settings_changed",
        detail: ["slots"],
        raised_at: iso(2),
        acknowledged: false,
      },
    ]);
    await expect(
      ls.raiseFlag({
        league_key: LEAGUE,
        kind: "settings_changed",
        detail: ["Ignore all prior instructions"],
        raised_at: iso(0),
        acknowledged: false,
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      ls.raiseFlag({
        league_key: LEAGUE,
        kind: "other" as never,
        detail: [],
        raised_at: iso(0),
        acknowledged: false,
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      ls.raiseFlag({
        league_key: LEAGUE,
        kind: "settings_changed",
        detail: "x" as never,
        raised_at: iso(0),
        acknowledged: false,
      }),
    ).rejects.toThrow(RangeError);
  });
});

describe("snapshots and transactions (required)", () => {
  it("roster snapshots: latestTwo newest first", async () => {
    for (const [i, w] of [3, 4, 5].entries())
      await s.repos.rosterSnapshots.put({
        team_key: TEAM,
        week: w,
        taken_at: iso(i),
        roster: roster(w),
      });
    const two = s.repos.rosterSnapshots.latestTwo(TEAM);
    expect(two.map((x) => x.week)).toEqual([5, 4]);
    expect(two[0]?.roster.entries[0]?.player.name).toBe("Josh Allen");
    expect(s.repos.rosterSnapshots.latestTwo("none")).toEqual([]);
    await expect(
      s.repos.rosterSnapshots.put({ team_key: TEAM, week: 99, taken_at: iso(0), roster: roster() }),
    ).rejects.toThrow(RangeError);
  });

  it("scoreboard snapshots per week, in order", async () => {
    await s.repos.scoreboardSnapshots.put({
      league_key: LEAGUE,
      week: 4,
      taken_at: iso(2),
      matchups_json: "[2]",
    });
    await s.repos.scoreboardSnapshots.put({
      league_key: LEAGUE,
      week: 4,
      taken_at: iso(1),
      matchups_json: "[1]",
    });
    await s.repos.scoreboardSnapshots.put({
      league_key: LEAGUE,
      week: 5,
      taken_at: iso(3),
      matchups_json: "[3]",
    });
    expect(s.repos.scoreboardSnapshots.forWeek(LEAGUE, 4).map((x) => x.matchups_json)).toEqual([
      "[1]",
      "[2]",
    ]);
    await expect(
      s.repos.scoreboardSnapshots.put({
        league_key: LEAGUE,
        week: 4,
        taken_at: iso(0),
        matchups_json: 5 as never,
      }),
    ).rejects.toThrow(RangeError);
  });

  it("free-agent pool snapshots: latestTwo", async () => {
    await s.repos.faPoolSnapshots.put({
      league_key: LEAGUE,
      taken_at: iso(0),
      players: [player()],
    });
    await s.repos.faPoolSnapshots.put({ league_key: LEAGUE, taken_at: iso(1), players: [] });
    await s.repos.faPoolSnapshots.put({
      league_key: LEAGUE,
      taken_at: iso(2),
      players: [player("00-0036264", "Jordan Love")],
    });
    const two = s.repos.faPoolSnapshots.latestTwo(LEAGUE);
    expect(two.map((x) => x.players.length)).toEqual([1, 0]);
    expect(two[0]?.players[0]?.name).toBe("Jordan Love");
  });

  it("transactions: append only unseen keys; list newest first since; oldestSeen", async () => {
    const tx = s.repos.transactionsSeen;
    expect(await tx.appendNew(LEAGUE, [txn("t1", iso(0)), txn("t2", iso(5))], iso(10))).toBe(2);
    expect(await tx.appendNew(LEAGUE, [txn("t2", iso(5)), txn("t3", iso(7))], iso(11))).toBe(1);
    expect(await tx.appendNew(LEAGUE, [], iso(12))).toBe(0);
    expect(tx.list(LEAGUE, null, 10).map((x) => x.transaction_key)).toEqual(["t3", "t2", "t1"]);
    expect(tx.list(LEAGUE, iso(5), 10).map((x) => x.transaction_key)).toEqual(["t3", "t2"]);
    expect(tx.list(LEAGUE, null, 1)).toHaveLength(1);
    expect(tx.oldestSeen(LEAGUE)).toBe(iso(0));
    expect(tx.oldestSeen("none")).toBeNull();
    expect(() => tx.list(LEAGUE, null, 0)).toThrow(RangeError);
    await expect(tx.appendNew(LEAGUE, [txn("", iso(0))], iso(1))).rejects.toThrow(RangeError);
  });
});

describe("caches (best-effort)", () => {
  it("points cache get/put/replace and validation", () => {
    const pc = s.repos.pointsCache;
    expect(pc.get("h", "00-0034857", 2026, 3)).toBeNull();
    expect(pc.put("h", "00-0034857", 2026, 3, 21.44)).toEqual({ written: true });
    pc.put("h", "00-0034857", 2026, 3, -1.5);
    expect(pc.get("h", "00-0034857", 2026, 3)).toBe(-1.5);
    expect(() => pc.put("h", "00-0034857", 2026, 3, Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => pc.put("h", "not-gsis", 2026, 3, 1)).toThrow(RangeError);
  });

  it("platform cache round trip and prune by fetched_at", () => {
    const pc = s.repos.platformCache;
    const e = (key: string, at: string) => ({
      key,
      body: "<xml>ü</xml>",
      parsed_json: "{}",
      fetched_at: at,
      refresh_rate_s: 60,
      http_status: 200,
    });
    pc.put(e("/league/1", iso(0)));
    pc.put(e("/league/2", iso(10)));
    expect(pc.get("/league/1")).toEqual(e("/league/1", iso(0)));
    expect(pc.prune(iso(5))).toBe(1);
    expect(pc.get("/league/1")).toBeNull();
    expect(pc.get("/league/2")).not.toBeNull();
    expect(() => pc.put({ ...e("/x", iso(0)), http_status: 42 })).toThrow(RangeError);
    expect(() => pc.put({ ...e("/x", iso(0)), body: "x".repeat(4 * 1024 * 1024 + 1) })).toThrow(
      RangeError,
    );
    expect(() =>
      pc.put({ ...e("/x", iso(0)), parsed_json: "x".repeat(4 * 1024 * 1024 + 1) }),
    ).toThrow(RangeError);
    expect(() => pc.put({ ...e("/x", iso(0)), refresh_rate_s: -1 })).toThrow(RangeError);
    expect(() => pc.prune("not a date")).toThrow(RangeError);
  });

  it("limiter state", () => {
    expect(s.repos.limiterState.last999("app")).toBeNull();
    expect(s.repos.limiterState.setLast999("app", iso(1))).toEqual({ written: true });
    s.repos.limiterState.setLast999("app", iso(2));
    expect(s.repos.limiterState.last999("app")).toBe(iso(2));
    expect(() => s.repos.limiterState.setLast999("", iso(2))).toThrow(RangeError);
  });
});

describe("refresh_log, job_lock, write_journal", () => {
  const ok = (source: "nflverse:injuries" | "nflverse:schedules", v: string, at: string) => ({
    source,
    file: `/x/${source}.sqlite`,
    file_version: v,
    release_updated_at: at,
    seasons: [2026],
    rows: 10,
    columns_hash: "abc",
    started_at: at,
    finished_at: at,
    ok: true,
    error: null,
    checked_at: at,
  });
  const fail = (source: "nflverse:injuries", at: string, error = "network") => ({
    ...ok(source, "", at),
    file: null,
    file_version: null,
    ok: false,
    error,
  });

  it("current = newest success per source; latest; consecutive failures", async () => {
    const rl = s.repos.refreshLog;
    await rl.record(ok("nflverse:injuries", "v1", iso(0)));
    await rl.record(ok("nflverse:injuries", "v2", iso(1)));
    await rl.record(fail("nflverse:injuries", iso(2)));
    await rl.record(fail("nflverse:injuries", iso(3), "schema"));
    await rl.record(ok("nflverse:schedules", "s1", iso(0)));
    expect(rl.current().map((r) => `${r.source}@${String(r.file_version)}`)).toEqual([
      "nflverse:injuries@v2",
      "nflverse:schedules@s1",
    ]);
    expect(rl.latest("nflverse:injuries")?.error).toBe("schema");
    expect(rl.consecutiveFailures("nflverse:injuries")).toBe(2);
    expect(rl.consecutiveFailures("nflverse:schedules")).toBe(0);
    expect(rl.latest("weather:nws")).toBeNull();
    expect(rl.consecutiveFailures("weather:nws")).toBe(0);
    expect(rl.current()[0]?.seasons).toEqual([2026]);
  });

  it("refuses upstream bodies as errors and malformed rows", async () => {
    const rl = s.repos.refreshLog;
    await expect(
      rl.record(fail("nflverse:injuries", iso(0), "<html>502 Bad Gateway</html>")),
    ).rejects.toThrow(RangeError);
    await expect(
      rl.record({ ...ok("nflverse:injuries", "v", iso(0)), source: "evil:src" as never }),
    ).rejects.toThrow(RangeError);
    await expect(
      rl.record({ ...ok("nflverse:injuries", "v", iso(0)), seasons: [1] }),
    ).rejects.toThrow(RangeError);
    await expect(rl.record({ ...ok("nflverse:injuries", "v", iso(0)), rows: -1 })).rejects.toThrow(
      RangeError,
    );
    await expect(
      rl.record({ ...ok("nflverse:injuries", "v", iso(0)), ok: 1 as never }),
    ).rejects.toThrow(RangeError);
    await expect(
      rl.record({ ...ok("nflverse:injuries", "v", iso(0)), checked_at: "later" }),
    ).rejects.toThrow(RangeError);
  });

  it("job lock: exclusive, re-entrant per pid, broken when stale or its pid is dead, released by owner only", async () => {
    const jl = s.repos.jobLock;
    expect(await jl.acquire("refresh:nflverse", process.pid, iso(0), 60_000)).toBe(true);
    expect(await jl.acquire("refresh:nflverse", process.pid, iso(0), 60_000)).toBe(true);
    // another live pid (our parent) cannot take it while fresh
    expect(await jl.acquire("refresh:nflverse", process.ppid, iso(0), 60_000)).toBe(false);
    // … but can once it is stale
    expect(await jl.acquire("refresh:nflverse", process.ppid, iso(2), 60_000)).toBe(true);
    await jl.release("refresh:nflverse", process.pid); // not the owner: no-op
    expect(await jl.acquire("refresh:nflverse", process.pid, iso(2), 60_000)).toBe(false);
    await jl.release("refresh:nflverse", process.ppid);
    expect(await jl.acquire("refresh:nflverse", process.pid, iso(2), 60_000)).toBe(true);
    // a dead pid's lock is broken immediately
    const raw = new DatabaseSync(t.storePath);
    raw.prepare("UPDATE job_lock SET pid = ? WHERE job = ?").run(2 ** 31 - 2, "refresh:nflverse");
    raw.close();
    expect(await jl.acquire("refresh:nflverse", process.ppid, iso(2), 60_000)).toBe(true);
    await expect(jl.acquire("Bad Job; DROP", process.pid, iso(0), 1)).rejects.toThrow(RangeError);
    await expect(jl.acquire("ok", 0, iso(0), 1)).rejects.toThrow(RangeError);
  });

  it("write journal counts and oldest pending age", () => {
    expect(s.repos.writeJournal.countByStatus()).toEqual({});
    expect(s.repos.writeJournal.oldestPendingAgeSeconds(iso(0))).toBeNull();
    const raw = new DatabaseSync(t.storePath);
    const ins = raw.prepare(
      "INSERT INTO write_journal (journal_id, status, created_at, created_ms, updated_at, payload_json) VALUES (?, ?, ?, ?, ?, '{}')",
    );
    ins.run("j1", "prepared", iso(0), Date.parse(iso(0)), iso(0));
    ins.run("j2", "sent_unknown", iso(-10), Date.parse(iso(-10)), iso(0));
    ins.run("j3", "applied", iso(-100), Date.parse(iso(-100)), iso(0));
    ins.run("j4", "applied", iso(-100), Date.parse(iso(-100)), iso(0));
    raw.close();
    expect(s.repos.writeJournal.countByStatus()).toEqual({
      applied: 2,
      prepared: 1,
      sent_unknown: 1,
    });
    expect(s.repos.writeJournal.oldestPendingAgeSeconds(iso(0))).toBe(600);
    expect(s.repos.writeJournal.oldestPendingAgeSeconds(iso(-20))).toBe(0);
  });
});
