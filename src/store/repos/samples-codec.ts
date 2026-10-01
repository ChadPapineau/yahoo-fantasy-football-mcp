// samples-codec.ts — the on-disk form of a projection's samples (plan 08 §5: "compressed; canonical
// names only"; plan 10 A15): one column header + the little-endian Float64 matrix, written
// column-major, byte-shuffled (byte b of every cell together) and raw-DEFLATEd, base64 — lossless,
// and many times smaller for count stats (K/DEF), where a raw f64 matrix was ~96 KB per player-week
// in a never-pruned table (QA-1-031/QA-1-081). Rows written before it (row-major, uncompressed,
// SAMPLES_ENCODING_V1) and legacy JSON arrays still read.
import { constants as Z, deflateRawSync, inflateRawSync } from "node:zlib";
import { CANONICAL_NAME_RE, POSITION_TYPES, type StatLine } from "../../domain/scoring/types.js";

/** The format tag this build writes (a legacy/fallback column is a JSON array: `[`…). */
export const SAMPLES_ENCODING = "f64-shuf-deflate-b64:2";
/** The earlier compact form (row-major, uncompressed), still read. */
export const SAMPLES_ENCODING_V1 = "f64le-b64:1";

/** The compact column: every sample shares the header fields; NaN in `data` = stat absent. */
interface Compact {
  readonly enc: typeof SAMPLES_ENCODING | typeof SAMPLES_ENCODING_V1;
  readonly n: number;
  readonly position_type: StatLine["position_type"];
  readonly provisional: boolean;
  readonly source: string;
  readonly keys: readonly string[];
  readonly data: string;
}

const corrupt = (): Error => new Error("store: corrupt samples column");

/** The most rows a compact column holds (10× plan 07's n_sims ceiling); larger batches stay JSON. */
export const MAX_COMPACT_SAMPLES = 200_000;

/** One absent cell (NaN, little-endian) — the fill pattern of a fresh matrix. */
const ABSENT = Buffer.alloc(8);
ABSENT.writeDoubleLE(Number.NaN, 0);

/**
 * The sorted union of keys when every line fits the compact form exactly — one shared
 * position_type / provisional / source, canonical-name keys only, finite numbers only, and
 * `present` = the sorted own keys of `values` (so decoding rebuilds `present` losslessly) — else
 * null. A `present` array shared by many lines (the engine reuses one per player-week) is checked
 * once; each distinct key is pattern-checked once.
 */
function compactKeys(lines: readonly StatLine[], first: StatLine): string[] | null {
  const seen = new Set<readonly string[]>();
  const union = new Set<string>();
  for (const l of lines) {
    if (
      l.position_type !== first.position_type ||
      l.provisional !== first.provisional ||
      l.source !== first.source
    )
      return null;
    const p = l.present;
    if (!seen.has(p)) {
      let prev = "";
      for (const k of p) {
        if (!(prev < k)) return null; // strictly ascending (and never "")
        prev = k;
        if (!union.has(k)) {
          if (!CANONICAL_NAME_RE.test(k)) return null;
          union.add(k);
        }
      }
      seen.add(p);
    }
    let own = 0;
    for (const k in l.values) if (Object.hasOwn(l.values, k)) own += 1;
    if (own !== p.length) return null;
    for (const k of p) {
      const v = Object.hasOwn(l.values, k) ? l.values[k] : undefined;
      if (typeof v !== "number" || !Number.isFinite(v)) return null;
    }
  }
  return [...union].sort();
}

/** Byte-shuffles `cells` 8-byte cells: byte b of cell k goes to `b * cells + k`. */
function shuffle(raw: Buffer, cells: number): Buffer {
  const out = Buffer.allocUnsafe(raw.length);
  for (let k = 0; k < cells; k++)
    for (let b = 0; b < 8; b++) out[b * cells + k] = raw[k * 8 + b] ?? 0;
  return out;
}

/** The inverse of `shuffle`. */
function unshuffle(sh: Buffer, cells: number): Buffer {
  const out = Buffer.allocUnsafe(sh.length);
  for (let k = 0; k < cells; k++)
    for (let b = 0; b < 8; b++) out[k * 8 + b] = sh[b * cells + k] ?? 0;
  return out;
}

/**
 * The decoded f64 matrix of a compact column, as a cell reader `(row, col) → value`, or a thrown
 * corrupt error. The compressed form's inflated size is bounded by the header (no inflate bomb).
 */
function matrix(c: Compact, keys: readonly string[]): (r: number, j: number) => number {
  const cells = c.n * keys.length;
  const bytes = cells * 8;
  const data = Buffer.from(c.data, "base64");
  if (c.enc === SAMPLES_ENCODING_V1) {
    if (data.length !== bytes) throw corrupt();
    return (r, j) => data.readDoubleLE((r * keys.length + j) * 8);
  }
  let sh: Buffer;
  try {
    sh = inflateRawSync(data, { maxOutputLength: Math.max(1, bytes) });
  } catch {
    throw corrupt();
  }
  if (sh.length !== bytes) throw corrupt();
  const raw = unshuffle(sh, cells);
  return (r, j) => raw.readDoubleLE((j * c.n + r) * 8);
}

/**
 * Serialises samples for the `samples_json` column: the compact form when every line fits it
 * (every projection the engine makes does — several times smaller and cheaper than JSON), else
 * plain JSON (exact for anything else a caller may store).
 */
export function encodeSamples(lines: readonly StatLine[]): string {
  const first = lines[0];
  const keys =
    first === undefined || lines.length > MAX_COMPACT_SAMPLES ? null : compactKeys(lines, first);
  if (first === undefined || keys === null) return JSON.stringify(lines);
  const n = lines.length;
  const width = keys.length;
  const cells = n * width;
  const raw = Buffer.alloc(cells * 8, ABSENT);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  for (const [r, l] of lines.entries()) {
    const values = l.values;
    for (const [j, k] of keys.entries()) {
      const v = values[k];
      if (v !== undefined && Object.hasOwn(values, k)) view.setFloat64((j * n + r) * 8, v, true);
    }
  }
  const out: Compact = {
    enc: SAMPLES_ENCODING,
    n: lines.length,
    position_type: first.position_type,
    provisional: first.provisional,
    source: first.source,
    keys,
    // Z_RLE: the shuffled planes of count stats are long runs; it is several times faster than the
    // default strategy at nearly its ratio, and cheap on the high-entropy planes it cannot shrink.
    data: deflateRawSync(shuffle(raw, cells), { strategy: Z.Z_RLE }).toString("base64"),
  };
  return JSON.stringify(out);
}

/** Reads a `samples_json` column written by `encodeSamples` (either form); Error when corrupt. */
export function decodeSamples(text: unknown): StatLine[] {
  if (typeof text !== "string") throw corrupt();
  const parsed: unknown = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed as StatLine[];
  const c = parsed as Partial<Compact> | null;
  if (
    c === null ||
    typeof c !== "object" ||
    (c.enc !== SAMPLES_ENCODING && c.enc !== SAMPLES_ENCODING_V1) ||
    typeof c.n !== "number" ||
    !Number.isInteger(c.n) ||
    c.n < 1 ||
    c.n > MAX_COMPACT_SAMPLES ||
    typeof c.position_type !== "string" ||
    !POSITION_TYPES.includes(c.position_type) ||
    typeof c.provisional !== "boolean" ||
    typeof c.source !== "string" ||
    !Array.isArray(c.keys) ||
    !c.keys.every(
      (k, i, ks) =>
        typeof k === "string" &&
        CANONICAL_NAME_RE.test(k) &&
        (i === 0 || (ks[i - 1] as string) < k),
    ) ||
    typeof c.data !== "string"
  )
    throw corrupt();
  const keys = c.keys as readonly string[];
  const cell = matrix(c as Compact, keys);
  const out: StatLine[] = [];
  for (let r = 0; r < c.n; r++) {
    const values: Record<string, number> = {};
    const present: string[] = [];
    for (const [j, k] of keys.entries()) {
      const v = cell(r, j);
      if (Number.isNaN(v)) continue;
      if (!Number.isFinite(v)) throw corrupt();
      values[k] = v;
      present.push(k);
    }
    out.push({
      values,
      present,
      position_type: c.position_type,
      provisional: c.provisional,
      source: c.source,
    });
  }
  return out;
}
