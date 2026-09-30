// samples-codec.ts — the on-disk form of a projection's samples (plan 08 §5: "compressed; canonical
// names only"; plan 10 A15): one column header + a row-major little-endian Float64 matrix, base64.
import { CANONICAL_NAME_RE, POSITION_TYPES, type StatLine } from "../../domain/scoring/types.js";

/** The format tag of the compact encoding (a legacy/fallback column is a JSON array: `[`…). */
export const SAMPLES_ENCODING = "f64le-b64:1";

/** The compact column: every sample shares the header fields; NaN in `data` = stat absent. */
interface Compact {
  readonly enc: typeof SAMPLES_ENCODING;
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
  const width = keys.length;
  const buf = Buffer.alloc(lines.length * width * 8, ABSENT);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (const [r, l] of lines.entries()) {
    const values = l.values;
    for (const [j, k] of keys.entries()) {
      const v = values[k];
      if (v !== undefined && Object.hasOwn(values, k))
        view.setFloat64((r * width + j) * 8, v, true);
    }
  }
  const out: Compact = {
    enc: SAMPLES_ENCODING,
    n: lines.length,
    position_type: first.position_type,
    provisional: first.provisional,
    source: first.source,
    keys,
    data: buf.toString("base64"),
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
    c.enc !== SAMPLES_ENCODING ||
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
  const buf = Buffer.from(c.data, "base64");
  if (buf.length !== c.n * keys.length * 8) throw corrupt();
  const out: StatLine[] = [];
  for (let r = 0; r < c.n; r++) {
    const values: Record<string, number> = {};
    const present: string[] = [];
    for (const [j, k] of keys.entries()) {
      const v = buf.readDoubleLE((r * keys.length + j) * 8);
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
