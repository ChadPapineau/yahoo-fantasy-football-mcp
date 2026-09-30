// parquet-writer.ts — a minimal, dependency-free parquet WRITER for tests and fixture generation
// only (plan 05 §3.2: hyparquet reads only; "parquet excerpts would need a writer"). One row group,
// one v1 data page per column, PLAIN values, RLE definition levels, flat OPTIONAL/REQUIRED columns.
// Pages are stored raw (UNCOMPRESSED) or as literal-only SNAPPY (a valid snappy stream hyparquet
// decodes); `codecLabel` can claim any codec so the loader's codec assertion can be exercised.
// Never shipped: it lives under tests/ and nothing in src/ imports it.

export type PhysicalType = "BOOLEAN" | "INT32" | "INT64" | "DOUBLE" | "BYTE_ARRAY";
export type Codec = "UNCOMPRESSED" | "SNAPPY" | "GZIP" | "LZO" | "BROTLI" | "LZ4" | "ZSTD";

/** One column to write. `values[i]` null/undefined = null (OPTIONAL columns only). */
export interface WriterColumn {
  readonly name: string;
  readonly type: PhysicalType;
  /** STRING (UTF8) for BYTE_ARRAY text; DATE for an INT32 day count. */
  readonly logical?: "STRING" | "DATE";
  readonly required?: boolean;
  readonly values: readonly unknown[];
  /** Codec written into this chunk's metadata (default: the file's). */
  readonly codecLabel?: Codec;
}

export interface WriteOptions {
  /** How pages are actually stored: raw or literal-only snappy. Default SNAPPY. */
  readonly storage?: "UNCOMPRESSED" | "SNAPPY";
  readonly keyValue?: Readonly<Record<string, string>>;
  readonly createdBy?: string;
}

const TYPE_ID: Record<PhysicalType, number> = {
  BOOLEAN: 0,
  INT32: 1,
  INT64: 2,
  DOUBLE: 5,
  BYTE_ARRAY: 6,
};
const CODEC_ID: Record<Codec, number> = {
  UNCOMPRESSED: 0,
  SNAPPY: 1,
  GZIP: 2,
  LZO: 3,
  BROTLI: 4,
  LZ4: 5,
  ZSTD: 6,
};

// --- byte sink ---------------------------------------------------------------------------------------

class Sink {
  private buf = new Uint8Array(1024);
  private len = 0;
  private reserve(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  byte(b: number): void {
    this.reserve(1);
    this.buf[this.len++] = b & 0xff;
  }
  bytes(u: Uint8Array | readonly number[]): void {
    this.reserve(u.length);
    this.buf.set(u, this.len);
    this.len += u.length;
  }
  uvarint(n: bigint | number): void {
    let v = BigInt(n);
    if (v < 0n) throw new Error("uvarint: negative");
    do {
      let b = Number(v & 0x7fn);
      v >>= 7n;
      if (v > 0n) b |= 0x80;
      this.byte(b);
    } while (v > 0n);
  }
  zigzag(n: bigint | number): void {
    const v = BigInt(n);
    this.uvarint(v >= 0n ? v << 1n : (-v << 1n) - 1n);
  }
  private scratch = new DataView(new ArrayBuffer(8));
  private scratchBytes = new Uint8Array(this.scratch.buffer);
  u32le(n: number): void {
    this.scratch.setUint32(0, n, true);
    this.bytes(this.scratchBytes.subarray(0, 4));
  }
  i32le(n: number): void {
    this.scratch.setInt32(0, n, true);
    this.bytes(this.scratchBytes.subarray(0, 4));
  }
  i64le(n: bigint): void {
    this.scratch.setBigInt64(0, n, true);
    this.bytes(this.scratchBytes);
  }
  f64le(n: number): void {
    this.scratch.setFloat64(0, n, true);
    this.bytes(this.scratchBytes);
  }
  get length(): number {
    return this.len;
  }
  toBytes(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

// --- thrift compact protocol (just what parquet metadata needs) --------------------------------------

type TValue =
  | { t: "i32"; v: number }
  | { t: "i64"; v: bigint | number }
  | { t: "bin"; v: string | Uint8Array }
  | { t: "struct"; v: readonly (readonly [number, TValue])[] }
  | { t: "list"; elem: "i32" | "bin" | "struct"; v: readonly TValue[] };

const CT = { i32: 5, i64: 6, bin: 8, list: 9, struct: 12 } as const;

function writeValue(s: Sink, val: TValue): void {
  switch (val.t) {
    case "i32":
    case "i64":
      s.zigzag(val.v);
      return;
    case "bin": {
      const b = typeof val.v === "string" ? new TextEncoder().encode(val.v) : val.v;
      s.uvarint(b.length);
      s.bytes(b);
      return;
    }
    case "struct":
      writeStruct(s, val.v);
      return;
    case "list": {
      const n = val.v.length;
      const et = CT[val.elem];
      if (n < 15) s.byte((n << 4) | et);
      else {
        s.byte(0xf0 | et);
        s.uvarint(n);
      }
      for (const x of val.v) writeValue(s, x);
      return;
    }
  }
}

function writeStruct(s: Sink, fields: readonly (readonly [number, TValue])[]): void {
  let last = 0;
  for (const [id, val] of fields) {
    const delta = id - last;
    const type = CT[val.t];
    if (delta > 0 && delta <= 15) s.byte((delta << 4) | type);
    else {
      s.byte(type);
      s.zigzag(id);
    }
    writeValue(s, val);
    last = id;
  }
  s.byte(0);
}

const i32 = (v: number): TValue => ({ t: "i32", v });
const i64 = (v: bigint | number): TValue => ({ t: "i64", v });
const bin = (v: string | Uint8Array): TValue => ({ t: "bin", v });
const struct = (v: readonly (readonly [number, TValue])[]): TValue => ({ t: "struct", v });

// --- encoders -----------------------------------------------------------------------------------------

/** Literal-only snappy: varint length, then literal elements of ≤ 65 536 bytes each. */
export function snappyLiteral(raw: Uint8Array): Uint8Array {
  const s = new Sink();
  s.uvarint(raw.length);
  for (let off = 0; off < raw.length; off += 65536) {
    const part = raw.subarray(off, Math.min(raw.length, off + 65536));
    const n = part.length - 1;
    if (n < 60) s.byte(n << 2);
    else if (n < 0x100) {
      s.byte(60 << 2);
      s.byte(n);
    } else {
      s.byte(61 << 2);
      s.byte(n & 0xff);
      s.byte(n >> 8);
    }
    s.bytes(part);
  }
  return s.toBytes();
}

/** RLE runs of definition levels (bit width 1), without the 4-byte length prefix. */
function rleLevels(levels: readonly number[]): Uint8Array {
  const s = new Sink();
  let i = 0;
  while (i < levels.length) {
    const v = levels[i] ?? 0;
    let j = i;
    while (j < levels.length && levels[j] === v) j++;
    s.uvarint((j - i) << 1);
    s.byte(v);
    i = j;
  }
  return s.toBytes();
}

function plainValues(col: WriterColumn, present: readonly unknown[]): Uint8Array {
  const s = new Sink();
  if (col.type === "BOOLEAN") {
    let cur = 0;
    let bit = 0;
    for (const v of present) {
      if (v === true) cur |= 1 << bit;
      bit++;
      if (bit === 8) {
        s.byte(cur);
        cur = 0;
        bit = 0;
      }
    }
    if (bit > 0) s.byte(cur);
    return s.toBytes();
  }
  const enc = new TextEncoder();
  for (const v of present) {
    switch (col.type) {
      case "INT32": {
        const n = v instanceof Date ? Math.round(v.getTime() / 86_400_000) : Number(v);
        if (!Number.isInteger(n)) throw new Error(`INT32 column ${col.name}: ${String(v)}`);
        s.i32le(n);
        break;
      }
      case "INT64":
        s.i64le(BigInt(v as bigint | number));
        break;
      case "DOUBLE":
        s.f64le(Number(v));
        break;
      case "BYTE_ARRAY": {
        const b = v instanceof Uint8Array ? v : enc.encode(String(v));
        s.u32le(b.length);
        s.bytes(b);
        break;
      }
    }
  }
  return s.toBytes();
}

// --- the writer -----------------------------------------------------------------------------------------

/** Writes a one-row-group parquet file. All columns must have the same number of values. */
export function writeParquet(
  columns: readonly WriterColumn[],
  opts: WriteOptions = {},
): Uint8Array {
  const storage = opts.storage ?? "SNAPPY";
  const numRows = columns[0]?.values.length ?? 0;
  for (const c of columns) {
    if (c.values.length !== numRows) throw new Error(`column ${c.name}: ragged length`);
  }
  const out = new Sink();
  out.bytes(new TextEncoder().encode("PAR1"));
  const chunks: TValue[] = [];
  let totalBytes = 0;
  for (const c of columns) {
    const levels = c.values.map((v) => (v === null || v === undefined ? 0 : 1));
    if (c.required && levels.includes(0)) throw new Error(`required column ${c.name} has nulls`);
    const present = c.values.filter((v) => v !== null && v !== undefined);
    const body = new Sink();
    if (!c.required) {
      const rle = rleLevels(levels);
      body.u32le(rle.length);
      body.bytes(rle);
    }
    body.bytes(plainValues(c, present));
    const raw = body.toBytes();
    const stored = storage === "SNAPPY" ? snappyLiteral(raw) : raw;
    const header = new Sink();
    writeStruct(header, [
      [1, i32(0)], // DATA_PAGE
      [2, i32(raw.length)],
      [3, i32(stored.length)],
      [
        5,
        struct([
          [1, i32(numRows)],
          [2, i32(0)], // PLAIN
          [3, i32(3)], // RLE
          [4, i32(3)],
        ]),
      ],
    ]);
    const offset = out.length;
    const hb = header.toBytes();
    out.bytes(hb);
    out.bytes(stored);
    const size = hb.length + stored.length;
    const uncompressed = hb.length + raw.length;
    totalBytes += uncompressed;
    const codec = c.codecLabel ?? storage;
    chunks.push(
      struct([
        [2, i64(offset)],
        [
          3,
          struct([
            [1, i32(TYPE_ID[c.type])],
            [2, { t: "list", elem: "i32", v: [i32(0), i32(3)] }],
            [3, { t: "list", elem: "bin", v: [bin(c.name)] }],
            [4, i32(CODEC_ID[codec])],
            [5, i64(numRows)],
            [6, i64(uncompressed)],
            [7, i64(size)],
            [9, i64(offset)],
          ]),
        ],
      ]),
    );
  }
  const schema: TValue[] = [
    struct([
      [4, bin("schema")],
      [5, i32(columns.length)],
    ]),
    ...columns.map((c) => {
      const f: (readonly [number, TValue])[] = [
        [1, i32(TYPE_ID[c.type])],
        [3, i32(c.required ? 0 : 1)],
        [4, bin(c.name)],
      ];
      if (c.logical === "STRING") f.push([6, i32(0)], [10, struct([[1, struct([])]])]);
      if (c.logical === "DATE") f.push([6, i32(6)], [10, struct([[6, struct([])]])]);
      return struct(f);
    }),
  ];
  const kv = Object.entries(opts.keyValue ?? {}).map(([k, v]) =>
    struct([
      [1, bin(k)],
      [2, bin(v)],
    ]),
  );
  const meta: (readonly [number, TValue])[] = [
    [1, i32(2)],
    [2, { t: "list", elem: "struct", v: schema }],
    [3, i64(numRows)],
    [
      4,
      {
        t: "list",
        elem: "struct",
        v: [
          struct([
            [1, { t: "list", elem: "struct", v: chunks }],
            [2, i64(totalBytes)],
            [3, i64(numRows)],
          ]),
        ],
      },
    ],
  ];
  if (kv.length > 0) meta.push([5, { t: "list", elem: "struct", v: kv }]);
  meta.push([6, bin(opts.createdBy ?? "fantasy-football-mcp test writer")]);
  const footer = new Sink();
  writeStruct(footer, meta);
  const fb = footer.toBytes();
  out.bytes(fb);
  out.u32le(fb.length);
  out.bytes(new TextEncoder().encode("PAR1"));
  return out.toBytes();
}
