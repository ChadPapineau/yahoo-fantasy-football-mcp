// positions.ts — position families for the crosswalk's "position agrees" test (research 04 §D step 2).
// The plan is silent on equivalences; this table is the stated set (decision: FB→RB because platforms
// list fullbacks as RB; PK→K; IDP detail positions → Yahoo's DB/LB/DL). Anything absent never matches.

/** Position (upper case) → family. */
export const POSITION_FAMILIES: Readonly<Record<string, string>> = Object.freeze({
  QB: "QB",
  RB: "RB",
  HB: "RB",
  FB: "RB",
  WR: "WR",
  TE: "TE",
  K: "K",
  PK: "K",
  P: "P",
  LS: "LS",
  DB: "DB",
  CB: "DB",
  S: "DB",
  SAF: "DB",
  FS: "DB",
  SS: "DB",
  LB: "LB",
  OLB: "LB",
  ILB: "LB",
  MLB: "LB",
  DL: "DL",
  DE: "DL",
  DT: "DL",
  NT: "DL",
  OL: "OL",
  OT: "OL",
  OG: "OL",
  T: "OL",
  G: "OL",
  C: "OL",
});

const FAMILY_TABLE: ReadonlyMap<string, string> = new Map(Object.entries(POSITION_FAMILIES));

/** The family of a position, or null when the position is unknown or malformed. */
export function positionFamily(position: unknown): string | null {
  if (typeof position !== "string" || position.length > 8) return null;
  return FAMILY_TABLE.get(position.trim().toUpperCase()) ?? null;
}

/** Whether two positions are in the same (known) family. */
export function samePositionFamily(a: unknown, b: unknown): boolean {
  const fa = positionFamily(a);
  return fa !== null && fa === positionFamily(b);
}
