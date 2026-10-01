// store-access.ts — how the non-serve subcommands open the store (plan 03 §1.1 step 3, §7: a store
// newer than the binary → exit 1 with the message; plan 01 §5.1 paths). `ff refresh`, `prune` and
// `backup` open it (creating and migrating as the server does); `ff status` and `ff doctor` are
// diagnostics and never create or migrate a store — a missing store or a pending migration is a
// finding, not a side effect.
import { lstatSync } from "node:fs";
import { backupDir, datasetDir, storePath } from "../config/paths.js";
import type { Config, WeatherSource } from "../config/schema.js";
import type { Clock } from "../domain/clock.js";
import { storeFactory } from "../store/index.js";
import {
  StoreMigrationPendingError,
  StoreVersionError,
  type Store,
  type StoreFactory,
} from "../store/types.js";
import type { Logger } from "./log.js";

/** FF_WEATHER_SOURCE → the store's weather reader preference. */
export function storeWeatherSource(
  ws: WeatherSource,
): "weather:open_meteo" | "weather:nws" | undefined {
  return ws === "open-meteo" ? "weather:open_meteo" : ws === "nws" ? "weather:nws" : undefined;
}

/** Opens (creating/migrating when `migrate`) the store for `config`. */
export function openStore(
  config: Config,
  clock: Clock,
  log: Logger,
  opts: { readonly migrate: boolean; readonly factory?: StoreFactory },
): Store {
  const ws = storeWeatherSource(config.weatherSource);
  return (opts.factory ?? storeFactory).open({
    path: storePath(config.cacheDir),
    datasetDir: datasetDir(config.cacheDir),
    backupDir: backupDir(config.cacheDir),
    clock,
    migrate: opts.migrate,
    ...(ws === undefined ? {} : { weatherSource: ws }),
    onWarning: (code) => {
      log.warn("store.warning", { code });
    },
  });
}

/**
 * Why a store could not be opened, as a fixed vocabulary (safe in a log line or a doctor row):
 * SQLite's primary result code of a `node:sqlite` error (`errcode & 0xff`: 26 NOTADB, 11 CORRUPT,
 * 8 READONLY, 5/6 BUSY/LOCKED, 14 CANTOPEN), a Node without the `node:sqlite` API this build uses,
 * or `other`.
 */
export type StoreOpenReason =
  "not_a_database" | "corrupt" | "readonly" | "busy" | "cannot_open" | "unsupported_node" | "other";

/** Classifies a store-open failure (see `StoreOpenReason`). Never throws. */
export function storeOpenReason(e: unknown): StoreOpenReason {
  const errcode = (e as { errcode?: unknown } | null)?.errcode;
  if (typeof errcode === "number") {
    switch (errcode & 0xff) {
      case 26:
        return "not_a_database";
      case 11:
        return "corrupt";
      case 8:
        return "readonly";
      case 5:
      case 6:
        return "busy";
      case 14:
        return "cannot_open";
      default:
        return "other";
    }
  }
  // an older Node's node:sqlite lacks a method this build calls (e.g. enableDefensive)
  if (e instanceof TypeError && e.message.includes("is not a function")) return "unsupported_node";
  return "other";
}

/** The outcome of opening an existing store without side effects. */
export type ExistingStore =
  | { readonly kind: "open"; readonly store: Store }
  | { readonly kind: "missing" }
  | { readonly kind: "newer"; readonly storeVersion: number; readonly binaryVersion: number }
  | { readonly kind: "pending"; readonly storeVersion: number; readonly binaryVersion: number }
  | { readonly kind: "error"; readonly message: string; readonly reason?: StoreOpenReason };

/** Opens the store only if its file exists, never migrating (status/doctor). */
export function openExistingStore(
  config: Config,
  clock: Clock,
  log: Logger,
  factory?: StoreFactory,
): ExistingStore {
  try {
    lstatSync(storePath(config.cacheDir));
  } catch {
    return { kind: "missing" };
  }
  try {
    return {
      kind: "open",
      store: openStore(config, clock, log, { migrate: false, ...(factory ? { factory } : {}) }),
    };
  } catch (e) {
    if (e instanceof StoreVersionError)
      return { kind: "newer", storeVersion: e.storeVersion, binaryVersion: e.binaryVersion };
    if (e instanceof StoreMigrationPendingError)
      return { kind: "pending", storeVersion: e.storeVersion, binaryVersion: e.binaryVersion };
    return { kind: "error", message: errorText(e), reason: storeOpenReason(e) };
  }
}

/** A one-line, value-free description of an error for CLI output. */
export function errorText(e: unknown): string {
  if (e instanceof Error) {
    const detail = (e as { detail?: unknown }).detail;
    if (typeof detail === "string") return `${e.name}: ${detail}`;
    return `${e.name}: ${e.message.slice(0, 200)}`;
  }
  return "unknown error";
}
