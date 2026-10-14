// inputs.ts — `data.inputs[]` for every analytics result (plan 07 §2: each contributing dataset with
// `source, as_of, age_s, freshness`; plan 01 §5.4 freshness judged by the class's basis via
// stampState, the same rule as src/mcp/envelope.ts `stampToInput` + `toDataInputs`), under the game
// calendar built from the loaded schedule (season-fresh spec §3.1–§3.2: a schedules or lines check
// inside a game's hot window ages by the short TTL; game days come from the schedule data, never from
// a weekday rule — QA-2-037). Pure.
import type { Clock } from "../clock.js";
import { freshnessClass, stampState } from "../../config/freshness.js";
import type { GameCalendar } from "../../config/game-calendar.js";
import type { PlatformStamp } from "../league/types.js";
import type { DatasetStamp, InputFreshness } from "./types.js";

/** Any stamp an engine can cite: a dataset release or a platform read. */
export type AnyStamp = DatasetStamp | PlatformStamp;

function toInput(stamp: AnyStamp, nowMs: number, cal: GameCalendar): InputFreshness {
  const isDataset = "freshness_class" in stamp;
  const cls = freshnessClass(isDataset ? stamp.freshness_class : stamp.freshness);
  const st = stampState(
    cls,
    {
      as_of: stamp.as_of,
      fetched_at: stamp.fetched_at,
      checked_at: isDataset ? stamp.checked_at : null,
    },
    nowMs,
    cal,
  );
  const fetched = Date.parse(stamp.fetched_at);
  const provisional = !isDataset && stamp.provisional;
  return {
    source: stamp.source,
    as_of: new Date(Date.parse(stamp.as_of)).toISOString(),
    age_s: Math.max(0, Math.floor((nowMs - fetched) / 1000)),
    freshness: provisional ? "provisional" : st.state === "fresh" ? "fresh" : "stale",
  };
}

/**
 * The inputs of one result: one entry per source (the newest `as_of` wins when a source appears
 * twice), ordered by source id so the output is deterministic. Null stamps (a dataset never loaded)
 * are skipped — the engine names that gap in its assumptions instead. `cal` is the game calendar of
 * the loaded schedule (`scheduleView(...).calendar`; a fallback calendar when it is missing,
 * unreadable or expired — every instant hot, never under-refreshed).
 */
export function collectInputs(
  stamps: readonly (AnyStamp | null | undefined)[],
  clock: Clock,
  cal: GameCalendar,
): InputFreshness[] {
  const nowMs = clock.nowMs();
  const bySource = new Map<string, InputFreshness>();
  for (const s of stamps) {
    if (s === null || s === undefined) continue;
    const input = toInput(s, nowMs, cal);
    const prev = bySource.get(input.source);
    if (prev === undefined || Date.parse(input.as_of) > Date.parse(prev.as_of)) {
      bySource.set(input.source, input);
    }
  }
  return [...bySource.values()].sort((a, b) => (a.source < b.source ? -1 : 1));
}

/** Merges already-built input lists (same newest-wins, sorted rule). */
export function mergeInputs(...lists: readonly (readonly InputFreshness[])[]): InputFreshness[] {
  const bySource = new Map<string, InputFreshness>();
  for (const list of lists) {
    for (const input of list) {
      const prev = bySource.get(input.source);
      if (prev === undefined || Date.parse(input.as_of) > Date.parse(prev.as_of)) {
        bySource.set(input.source, input);
      }
    }
  }
  return [...bySource.values()].sort((a, b) => (a.source < b.source ? -1 : 1));
}

/** The newest `as_of` among inputs (ISO), or `fallback` when there are none. */
export function newestAsOf(
  inputs: readonly { readonly as_of: string }[],
  fallback: string,
): string {
  let best: number | null = null;
  for (const i of inputs) {
    const t = Date.parse(i.as_of);
    if (Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  return best === null ? fallback : new Date(best).toISOString();
}
