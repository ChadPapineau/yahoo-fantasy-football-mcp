// client.ts — the one outbound HTTP client (plan 02 §7 host allow-list + supply chain "built-ins
// preferred": global fetch, zlib; §8 threat 18; plan 01 §6 "all HTTP goes through one httpClient",
// §7 URLs logged without query strings; plan 05 §2 `http/client`, §4.1 network rows). Implements the
// src/sources/source.ts HttpGet (in memory) and HttpDownload (streamed to a file) contracts.
//
// Rules: HTTPS on the default port only; the host must be on the allow-list, checked before the
// request and again for EVERY redirect hop (`redirect: "manual"`, at most MAX_REDIRECT_HOPS — a hop
// to a refused URL fails without being requested); connect (until headers) and total timeouts; the
// per-call `maxBytes` is enforced while streaming, on the wire AND after gzip decoding (a gzip
// bomb stops at the cap); the only request headers are User-Agent, Accept and Accept-Encoding —
// never Authorization or Cookie, and `Set-Cookie` is dropped from responses; every non-2xx or
// network failure becomes an HttpError (src/http/errors.ts).
import { open, unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { gunzipSync } from "node:zlib";
import { MAX_REDIRECT_HOPS, type HttpDownload, type HttpGet } from "../sources/source.js";
import { VERSION } from "../version.js";
import { ALLOWED_HOSTS, checkUrl, narrowAllowList, redactUrl } from "./allowlist.js";
import { classifyFetchError, HttpError, type AbortReason } from "./errors.js";

/** Until response headers arrive, per hop (plan 01 §6: 15 s). */
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
/** The whole call, body included (plan 01 §6: 60 s for release downloads). */
export const DEFAULT_TOTAL_TIMEOUT_MS = 60_000;
/** No call may ask for more than 1 GiB. */
export const MAX_BYTES_CEILING = 1024 * 1024 * 1024;
/** At most this many response headers are kept, each value cut to 1 024 chars. */
export const MAX_RESPONSE_HEADERS = 64;
/** The descriptive User-Agent (NWS requires one — research 04 §B8). No contact address: no PII. */
export const DEFAULT_USER_AGENT = `fantasy-football-mcp/${VERSION} (personal non-commercial use; local MCP server)`;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const DROPPED_RESPONSE_HEADERS: ReadonlySet<string> = new Set(["set-cookie", "set-cookie2"]);
const PRINTABLE = /^[\x20-\x7e]{1,256}$/;

/** The subset of `fetch` the client uses (tests inject a fake; no sockets). */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** The logger surface the client needs (src/cli/log.ts's Logger satisfies it). */
export interface HttpLog {
  debug(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

/** How to build a client. */
export interface HttpClientOptions {
  /** Default: the global fetch. */
  readonly fetch?: FetchLike;
  /** A NARROWING of ALLOWED_HOSTS (default: all of it); a host outside it throws at construction. */
  readonly allowHosts?: readonly string[];
  readonly userAgent?: string;
  readonly connectTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
  readonly log?: HttpLog;
  /** Monotonic ms for the `ms` log field; default performance.now. */
  readonly now?: () => number;
}

/** An HTTP client: the two contract functions plus its effective policy. */
export interface HttpClient {
  readonly get: HttpGet;
  readonly download: HttpDownload;
  readonly allowHosts: readonly string[];
  readonly userAgent: string;
}

interface Config {
  readonly fetch: FetchLike;
  readonly allow: readonly string[];
  readonly userAgent: string;
  readonly connectTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly log: HttpLog | null;
  readonly now: () => number;
}

interface CallOpts {
  readonly signal: AbortSignal;
  readonly maxBytes: number;
  readonly accept?: string;
}

interface Meta {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly final_url: string;
  readonly bytes: number;
}

type Sink = (chunk: Uint8Array) => Promise<void> | void;

function positiveMs(v: number | undefined, dflt: number, what: string): number {
  if (v === undefined) return dflt;
  if (!Number.isFinite(v) || v <= 0)
    throw new RangeError(`http: ${what} must be a positive number`);
  return v;
}

/** Validates the per-call options; throws RangeError on a programming error. */
function validateCall(opts: CallOpts): string {
  if (!(opts.signal instanceof AbortSignal)) throw new RangeError("http: signal is required");
  if (
    !Number.isSafeInteger(opts.maxBytes) ||
    opts.maxBytes <= 0 ||
    opts.maxBytes > MAX_BYTES_CEILING
  )
    throw new RangeError("http: maxBytes must be an integer in 1..1 GiB");
  const accept = opts.accept ?? "*/*";
  if (!PRINTABLE.test(accept)) throw new RangeError("http: accept must be printable ASCII");
  return accept;
}

/** Rejects as soon as `signal` aborts, even when `p` ignores the signal (a hung fake or socket). */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  const abortErr = (): DOMException => new DOMException("The operation was aborted", "AbortError");
  if (signal.aborted) {
    p.catch(() => undefined);
    return Promise.reject(abortErr());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortErr());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e instanceof Error ? e : new Error("fetch rejected with a non-Error"));
      },
    );
  });
}

/** Frees a response we will not read (a redirect, an error status). Never throws. */
function discard(res: Response): void {
  try {
    res.body?.cancel().catch(() => undefined);
  } catch {
    // a body already locked or a hostile getter: nothing to free
  }
}

function retryAfterSeconds(res: Response): number | null {
  const v = res.headers.get("retry-after");
  return v !== null && /^\s*\d{1,6}\s*$/.test(v) ? Number(v.trim()) : null;
}

function statusError(res: Response, host: string): HttpError {
  const status = res.status;
  if (status === 429)
    return new HttpError({
      kind: "rate_limited",
      host,
      status,
      retryAfterS: retryAfterSeconds(res),
    });
  if (status >= 500 && status <= 599)
    return new HttpError({ kind: "http_5xx", host, status, retryAfterS: retryAfterSeconds(res) });
  if (status >= 400 && status <= 499) return new HttpError({ kind: "http_4xx", host, status });
  return new HttpError({ kind: "http_status", host, status });
}

function collectHeaders(h: Headers): Readonly<Record<string, string>> {
  const entries: [string, string][] = [];
  h.forEach((value, key) => {
    const k = key.toLowerCase();
    if (DROPPED_RESPONSE_HEADERS.has(k) || entries.length >= MAX_RESPONSE_HEADERS) return;
    entries.push([k, value.length > 1024 ? value.slice(0, 1024) : value]);
  });
  // fromEntries defines own data properties, so a `__proto__` header cannot touch the prototype.
  return Object.freeze(Object.fromEntries(entries));
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * Streams the body into `sink`, enforcing `maxBytes` on the wire. A body the server declares as
 * gzip AND that still starts with the gzip magic (a fetch that did not decode it) is decoded here
 * with `maxOutputLength = maxBytes`, so decompression stops at the cap; a declared-gzip body that
 * fetch already decoded (undici does) passes through. Returns the bytes delivered to the sink.
 */
async function readBody(
  res: Response,
  maxBytes: number,
  sink: Sink,
  signal: AbortSignal,
  host: string,
): Promise<number> {
  const len = res.headers.get("content-length");
  if (len !== null && /^\s*\d+\s*$/.test(len) && Number(len.trim()) > maxBytes) {
    discard(res);
    throw new HttpError({ kind: "too_large", host, status: res.status });
  }
  const body = res.body;
  if (body === null) return 0;
  const gzipDeclared = /(^|[\s,])(x-)?gzip($|[\s,;])/i.test(
    res.headers.get("content-encoding") ?? "",
  );
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const held: Uint8Array[] = [];
  let wire = 0;
  try {
    for (;;) {
      const r = await raceAbort(reader.read(), signal);
      if (r.done) break;
      wire += r.value.byteLength;
      if (wire > maxBytes) throw new HttpError({ kind: "too_large", host, status: res.status });
      if (gzipDeclared) held.push(r.value);
      else await sink(r.value);
    }
  } catch (e) {
    reader.cancel().catch(() => undefined);
    throw e;
  }
  if (!gzipDeclared) return wire;
  const buf = concat(held, wire);
  if (buf.length < 2 || buf[0] !== 0x1f || buf[1] !== 0x8b) {
    if (buf.length > 0) await sink(buf);
    return buf.length;
  }
  let out: Uint8Array;
  try {
    out = gunzipSync(buf, { maxOutputLength: maxBytes });
  } catch (e) {
    const tooLarge =
      e instanceof RangeError ||
      (e instanceof Error && (e as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE");
    throw new HttpError({
      kind: tooLarge ? "too_large" : "decode",
      host,
      status: res.status,
      cause: e,
    });
  }
  await sink(out);
  return out.length;
}

async function request(
  cfg: Config,
  start: URL,
  opts: CallOpts,
  accept: string,
  sink: Sink,
): Promise<Meta> {
  let url = start;
  let hops = 0;
  const controller = new AbortController();
  let reason: AbortReason = null;
  const abort = (r: Exclude<AbortReason, null>): void => {
    if (reason !== null) return;
    reason = r;
    controller.abort();
  };
  const onCaller = (): void => {
    abort("caller");
  };
  if (opts.signal.aborted) throw new HttpError({ kind: "aborted", host: url.hostname });
  opts.signal.addEventListener("abort", onCaller, { once: true });
  const totalTimer = setTimeout(() => {
    abort("total_timeout");
  }, cfg.totalTimeoutMs);
  const t0 = cfg.now();
  const headers = {
    "user-agent": cfg.userAgent,
    accept,
    "accept-encoding": "gzip",
  };
  try {
    for (;;) {
      const host = url.hostname;
      const connectTimer = setTimeout(() => {
        abort("connect_timeout");
      }, cfg.connectTimeoutMs);
      let res: Response;
      try {
        res = await raceAbort(
          cfg.fetch(url.href, {
            method: "GET",
            redirect: "manual",
            credentials: "omit",
            headers: { ...headers },
            signal: controller.signal,
          }),
          controller.signal,
        );
      } catch (e) {
        throw classifyFetchError(e, reason, host);
      } finally {
        clearTimeout(connectTimer);
      }
      if (REDIRECT_STATUSES.has(res.status)) {
        discard(res);
        if (hops >= MAX_REDIRECT_HOPS)
          throw new HttpError({ kind: "too_many_redirects", host, status: res.status });
        const loc = res.headers.get("location");
        let next: URL;
        try {
          if (loc === null || loc === "") throw new Error("no location");
          next = new URL(loc, url);
        } catch {
          throw new HttpError({ kind: "redirect_refused", host, status: res.status });
        }
        try {
          next = checkUrl(next.href, cfg.allow);
        } catch (e) {
          throw new HttpError({
            kind: "redirect_refused",
            host: next.hostname.toLowerCase(),
            status: res.status,
            causeCode: e instanceof HttpError ? e.kind.toUpperCase() : null,
          });
        }
        cfg.log?.debug("http.redirect", {
          from: redactUrl(url),
          to: redactUrl(next),
          status: res.status,
        });
        url = next;
        hops++;
        continue;
      }
      if (res.status < 200 || res.status > 299) {
        discard(res);
        throw statusError(res, host);
      }
      const bytes = await readBody(res, opts.maxBytes, sink, controller.signal, host);
      cfg.log?.debug("http.get", {
        url: redactUrl(url),
        status: res.status,
        bytes,
        hops,
        ms: Math.round(cfg.now() - t0),
      });
      return {
        status: res.status,
        headers: collectHeaders(res.headers),
        final_url: url.href,
        bytes,
      };
    }
  } catch (e) {
    const err = e instanceof HttpError ? e : classifyFetchError(e, reason, url.hostname);
    cfg.log?.warn("http.error", {
      url: redactUrl(url),
      kind: err.kind,
      status: err.status,
      cause_code: err.causeCode,
      hops,
      ms: Math.round(cfg.now() - t0),
    });
    throw err;
  } finally {
    clearTimeout(totalTimer);
    opts.signal.removeEventListener("abort", onCaller);
  }
}

/** Builds the client. Options are validated here (a bad timeout or host is a programming error). */
export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  if (!PRINTABLE.test(userAgent)) throw new RangeError("http: userAgent must be printable ASCII");
  const allow =
    options.allowHosts === undefined ? ALLOWED_HOSTS : narrowAllowList(options.allowHosts);
  const cfg: Config = {
    fetch: options.fetch ?? ((url, init) => fetch(url, init)),
    allow,
    userAgent,
    connectTimeoutMs: positiveMs(
      options.connectTimeoutMs,
      DEFAULT_CONNECT_TIMEOUT_MS,
      "connectTimeoutMs",
    ),
    totalTimeoutMs: positiveMs(options.totalTimeoutMs, DEFAULT_TOTAL_TIMEOUT_MS, "totalTimeoutMs"),
    log: options.log ?? null,
    now: options.now ?? (() => performance.now()),
  };

  const get: HttpGet = async (url, opts) => {
    const accept = validateCall(opts);
    const start = checkUrl(url, cfg.allow);
    const chunks: Uint8Array[] = [];
    let total = 0;
    const meta = await request(cfg, start, opts, accept, (c) => {
      chunks.push(c);
      total += c.byteLength;
    });
    return {
      status: meta.status,
      body: concat(chunks, total),
      headers: meta.headers,
      final_url: meta.final_url,
    };
  };

  const download: HttpDownload = async (url, opts) => {
    const accept = validateCall(opts);
    if (typeof opts.dest !== "string" || !isAbsolute(opts.dest))
      throw new RangeError("http: download dest must be an absolute path");
    const start = checkUrl(url, cfg.allow);
    const fh = await open(opts.dest, "wx", 0o600);
    try {
      const meta = await request(cfg, start, opts, accept, async (c) => {
        let off = 0;
        while (off < c.byteLength) {
          const { bytesWritten } = await fh.write(c, off, c.byteLength - off);
          off += bytesWritten;
        }
      });
      await fh.close();
      return { ...meta, path: opts.dest };
    } catch (e) {
      await fh.close().catch(() => undefined);
      await unlink(opts.dest).catch(() => undefined);
      throw e;
    }
  };

  return Object.freeze({ get, download, allowHosts: allow, userAgent });
}
