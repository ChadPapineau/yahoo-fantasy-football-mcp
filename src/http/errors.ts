// errors.ts — the HTTP failure taxonomy (plan 01 §4.3 UPSTREAM_UNAVAILABLE for every network error,
// round 1 OBJ-22; plan 05 §4.1 network fault rows; plan 02 §7 host allow-list). Messages are fixed
// strings: never an upstream body, never a URL query string.

/** Every way an HttpGet/HttpDownload call can fail. */
export const HTTP_ERROR_KINDS = [
  /** The URL does not parse. */
  "invalid_url",
  /** Not `https:` (or a non-default port). */
  "scheme_refused",
  /** The URL carries `user:password@`. */
  "credentials_refused",
  /** The host is not on the allow-list (refused before any DNS lookup). */
  "host_not_allowed",
  /** A redirect without a usable Location, or to a URL the allow-list refuses (never fetched). */
  "redirect_refused",
  /** More than MAX_REDIRECT_HOPS redirects. */
  "too_many_redirects",
  "dns",
  /** Connection refused / host or network unreachable. */
  "connect",
  /** Connection reset or closed mid-response. */
  "reset",
  /** Connect (headers) or total timeout. */
  "timeout",
  "tls",
  /** A 4xx other than 429 (408 is transient). */
  "http_4xx",
  "http_5xx",
  /** Any other non-2xx status (1xx, a 3xx that is not a followable redirect). */
  "http_status",
  /** Upstream 429. */
  "rate_limited",
  /** The per-source daily cap of this process is spent (not retryable in this run). */
  "quota_exhausted",
  /** The body (wire or decoded) exceeds the call's maxBytes. */
  "too_large",
  /** A gzip body that does not decode. */
  "decode",
  /** The caller's signal aborted the call. */
  "aborted",
  /** Any other network failure (`fetch failed` without a known cause). */
  "network",
] as const;
/** An HTTP failure kind. */
export type HttpErrorKind = (typeof HTTP_ERROR_KINDS)[number];

/** Kinds a retry inside the same run can cure (plan 01 §5.7 "retry 3× with jitter"). */
const TRANSIENT_KINDS: ReadonlySet<HttpErrorKind> = new Set<HttpErrorKind>([
  "dns",
  "connect",
  "reset",
  "timeout",
  "http_5xx",
  "rate_limited",
  "network",
]);

/** Kinds that are our own policy refusing a request (a bug or a hostile redirect, not an outage). */
const POLICY_KINDS: ReadonlySet<HttpErrorKind> = new Set<HttpErrorKind>([
  "invalid_url",
  "scheme_refused",
  "credentials_refused",
  "host_not_allowed",
]);

const MESSAGES: Readonly<Record<HttpErrorKind, string>> = Object.freeze({
  invalid_url: "http: the URL does not parse",
  scheme_refused: "http: only https on the default port is allowed",
  credentials_refused: "http: URLs carrying credentials are refused",
  host_not_allowed: "http: host is not on the allow-list",
  redirect_refused: "http: redirect refused",
  too_many_redirects: "http: too many redirects",
  dns: "http: DNS lookup failed",
  connect: "http: connection refused or unreachable",
  reset: "http: connection reset",
  timeout: "http: request timed out",
  tls: "http: TLS failure",
  http_4xx: "http: upstream answered with a client error",
  http_5xx: "http: upstream answered with a server error",
  http_status: "http: upstream answered with an unexpected status",
  rate_limited: "http: upstream is rate-limiting",
  quota_exhausted: "http: per-source request cap reached",
  too_large: "http: response exceeds the size cap",
  decode: "http: response body could not be decoded",
  aborted: "http: request aborted",
  network: "http: network failure",
});

/** A value-free description of a failed call. */
export interface HttpErrorInit {
  readonly kind: HttpErrorKind;
  /** The host the failing request targeted (lower-case, from a parsed URL). */
  readonly host?: string | null;
  readonly status?: number | null;
  /** Seconds from `Retry-After` on a 429/503, when numeric. */
  readonly retryAfterS?: number | null;
  /** The underlying system/undici code (`ENOTFOUND`, `ERR_TLS_…`), when one was seen. */
  readonly causeCode?: string | null;
  readonly cause?: unknown;
}

const SAFE_CODE = /^[A-Z0-9_]{1,48}$/;
const SAFE_HOST = /^[a-z0-9.-]{1,253}$/;

/**
 * An HTTP failure. `ffCode` lets src/mcp/errors.ts map it (policy refusals → INTERNAL, 429 and a
 * spent quota → RATE_LIMITED, everything else → UPSTREAM_UNAVAILABLE — never INTERNAL for an
 * outage, OBJ-22). `transient` is what the refresh runner retries on.
 */
export class HttpError extends Error {
  readonly kind: HttpErrorKind;
  readonly code: string;
  readonly ffCode: "INTERNAL" | "RATE_LIMITED" | "UPSTREAM_UNAVAILABLE";
  readonly transient: boolean;
  readonly host: string | null;
  readonly status: number | null;
  readonly retryAfterS: number | null;
  readonly causeCode: string | null;

  constructor(init: HttpErrorInit) {
    super(MESSAGES[init.kind], init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "HttpError";
    this.kind = init.kind;
    this.code = `FF_HTTP_${init.kind.toUpperCase()}`;
    const status = init.status ?? null;
    this.status = status !== null && Number.isInteger(status) ? status : null;
    this.transient =
      TRANSIENT_KINDS.has(init.kind) || (init.kind === "http_4xx" && this.status === 408);
    this.ffCode = POLICY_KINDS.has(init.kind)
      ? "INTERNAL"
      : init.kind === "rate_limited" || init.kind === "quota_exhausted"
        ? "RATE_LIMITED"
        : "UPSTREAM_UNAVAILABLE";
    const host = init.host ?? null;
    this.host = host !== null && SAFE_HOST.test(host) ? host : null;
    const ra = init.retryAfterS ?? null;
    this.retryAfterS = ra !== null && Number.isFinite(ra) && ra >= 0 ? ra : null;
    const cc = init.causeCode ?? null;
    this.causeCode = cc !== null && SAFE_CODE.test(cc) ? cc : null;
  }
}

const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NONAME", "EAI_NODATA"]);
const CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EHOSTDOWN",
  "ENETDOWN",
]);
const RESET_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ECONNABORTED",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
]);
const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
const TLS_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "CERT_UNTRUSTED",
  "CERT_SIGNATURE_FAILURE",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "HOSTNAME_MISMATCH",
  "EPROTO",
]);

/** The kind a system/undici error code denotes, or null when the code is unknown. */
export function kindForCode(code: string): HttpErrorKind | null {
  if (DNS_CODES.has(code)) return "dns";
  if (CONNECT_CODES.has(code)) return "connect";
  if (RESET_CODES.has(code)) return "reset";
  if (TIMEOUT_CODES.has(code)) return "timeout";
  if (TLS_CODES.has(code) || code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_"))
    return "tls";
  return null;
}

function ownString(o: object, key: string): string | null {
  try {
    if (!Object.prototype.hasOwnProperty.call(o, key)) return null;
    const v = (o as Record<string, unknown>)[key];
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** Why an in-flight call was aborted by the client itself, when it was. */
export type AbortReason = "connect_timeout" | "total_timeout" | "caller" | null;

/**
 * Maps anything `fetch` (or a body read) threw to an HttpError. Walks the `cause` chain (undici
 * wraps the system error as `TypeError: fetch failed` → `cause`) for a known code; our own timers
 * and the caller's signal take precedence over the AbortError they produce. Never throws.
 */
export function classifyFetchError(e: unknown, abort: AbortReason, host: string | null): HttpError {
  if (e instanceof HttpError) return e;
  if (abort === "connect_timeout" || abort === "total_timeout")
    return new HttpError({ kind: "timeout", host, causeCode: abort.toUpperCase(), cause: e });
  if (abort === "caller") return new HttpError({ kind: "aborted", host, cause: e });
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && cur instanceof Error; depth++) {
    const code = ownString(cur, "code");
    if (code !== null) {
      const kind = kindForCode(code);
      if (kind !== null) return new HttpError({ kind, host, causeCode: code, cause: e });
    }
    if (cur.name === "TimeoutError") return new HttpError({ kind: "timeout", host, cause: e });
    let next: unknown;
    try {
      next = cur.cause;
    } catch {
      break;
    }
    cur = next;
  }
  return new HttpError({ kind: "network", host, cause: e });
}

/**
 * Whether a thrown value is a network failure worth retrying in the same run: a transient
 * HttpError, or a raw error whose `cause` chain carries a known transient network code (a source
 * that did not go through src/http).
 */
export function isTransientNetworkError(e: unknown): boolean {
  if (e instanceof HttpError) return e.transient;
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && cur instanceof Error; depth++) {
    const code = ownString(cur, "code");
    if (code !== null) {
      const kind = kindForCode(code);
      if (kind !== null && TRANSIENT_KINDS.has(kind)) return true;
    }
    if (cur.name === "TimeoutError") return true;
    if (cur.name === "TypeError" && cur.message === "fetch failed") return true;
    let next: unknown;
    try {
      next = cur.cause;
    } catch {
      return false;
    }
    cur = next;
  }
  return false;
}

/** Whether a thrown value is any network failure (transient or not) — refresh_log `error: "network"`. */
export function isNetworkFailure(e: unknown): boolean {
  if (e instanceof HttpError) return !POLICY_KINDS.has(e.kind);
  return isTransientNetworkError(e);
}
