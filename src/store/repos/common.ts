// common.ts — shared input checks for the store repositories (plan 01 §5.3: the store is the last
// line before disk — a malformed instant or key is a programming error, never silently stored).
import type { DatabaseSync } from "node:sqlite";
import type { WriteExecutor } from "../sqlite.js";

/** What every repository is built from. */
export interface RepoDeps {
  readonly db: DatabaseSync;
  readonly writes: WriteExecutor;
}

/** Epoch ms of an ISO-8601 instant; RangeError when it is not one. */
export function isoMs(iso: unknown, what: string): number {
  if (typeof iso !== "string" || iso.length === 0 || iso.length > 64)
    throw new RangeError(`store: ${what} must be an ISO-8601 instant`);
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new RangeError(`store: ${what} must be an ISO-8601 instant`);
  return ms;
}

/** A non-empty string of at most `max` UTF-16 units without NUL; RangeError otherwise. */
export function keyString(v: unknown, what: string, max = 128): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max || v.includes("\0"))
    throw new RangeError(
      `store: ${what} must be a non-empty string of at most ${String(max)} chars`,
    );
  return v;
}

/** An integer in [lo, hi]; RangeError otherwise. */
export function intIn(v: unknown, lo: number, hi: number, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi)
    throw new RangeError(`store: ${what} must be an integer in ${String(lo)}..${String(hi)}`);
  return v;
}

/** A finite number; RangeError otherwise. */
export function finite(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v))
    throw new RangeError(`store: ${what} must be a finite number`);
  return v;
}

/** The season bound every repository accepts. */
export const SEASON_MIN = 1990;
export const SEASON_MAX = 2100;
/** Week bound (plan 02 §5): 1..22. */
export const WEEK_MAX = 22;

/** Parses JSON the store itself wrote (its shape is the one the same repository serialised). */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the shape it wrote
export function parseJson<T>(text: unknown): T {
  if (typeof text !== "string") throw new Error("store: corrupt JSON column");
  return JSON.parse(text) as T;
}

/** 1/0/null → boolean/null. */
export function boolOrNull(v: unknown): boolean | null {
  return v === null || v === undefined ? null : v === 1 || v === 1n;
}

/** boolean/null → 1/0/null. */
export function bitOrNull(v: boolean | null): number | null {
  return v === null ? null : v ? 1 : 0;
}
