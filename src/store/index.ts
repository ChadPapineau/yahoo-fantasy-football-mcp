// index.ts — the store's public entry (plan 01 §5; plan 04 §1 `db.ts` role): the StoreFactory the
// composition root (src/cli) calls — `open` for the server, `openPublisher` for `ff refresh`.
import { openPublisher, type PublisherInternals } from "./publisher.js";
import { openStore, type StoreInternals } from "./store.js";
import type { StoreFactory } from "./types.js";

export { statementGuardOf, lockPathOf } from "./store.js";
export { MIGRATIONS, type Migration } from "./migrations/index.js";
export { PUBLISH_LOCK_STALE_MS, publishJob } from "./publisher.js";
export { DATASET_META_TABLE, DS_SCHEMA_VERSION, readOnlyUri } from "./attach.js";
export { playerRowToStatLine, defenseRowToStatLine } from "./datasets/statline.js";
export type { TraceEntry } from "./sqlite.js";
export * from "./types.js";

/** Builds a StoreFactory; `internals` are test hooks (migration list, write budget, fault points). */
export function createStoreFactory(
  internals: StoreInternals & PublisherInternals = {},
): StoreFactory {
  const factory: StoreFactory = {
    open: (opts) => openStore(opts, internals),
    openPublisher: (opts) => openPublisher(opts, internals),
  };
  return Object.freeze(factory);
}

/** The production StoreFactory. */
export const storeFactory: StoreFactory = createStoreFactory();
