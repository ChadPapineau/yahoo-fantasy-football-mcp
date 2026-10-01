// errors.ts — the plan 01 §4.3 error-code table as data, the FfError class, and the one mapper
// from any thrown value to a tool error result (`isError: true`). Messages and hints are fixed
// strings from the table: never an upstream body, never a stack, never a thrown object's message,
// never a secret (plan 01 §4.3 rules; plan 05 §2 `mcp/errors`).
// Contract revision (critic C-02): SDK 2.2.0 validates a tool's inputSchema BEFORE the handler and
// answers a failure with its own free-text error, and returns a handler's raw `error.message` on a
// throw — so every tool registers `deferValidation(schema)` (tools/list still shows the real JSON
// Schema) with `wrapHandler(schema, fn)`, which parses, catches everything and maps it here.
import { randomBytes } from "node:crypto";
import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type { z } from "zod/v4";
import { SERVER_HINTS } from "../providers/platform.js";
import { INVALID_KEY_MESSAGE, REQUEST_ID_RE, type ToolSuccessResult } from "./envelope.js";

/** Every tool error code (plan 01 §4.3). */
export const ERROR_CODES = [
  "NOT_AUTHENTICATED",
  "TOKEN_REFRESH_FAILED",
  "NOT_PROVISIONED",
  "WRITE_NOT_AVAILABLE",
  "RATE_LIMITED",
  "UPSTREAM_UNAVAILABLE",
  "STALE_ONLY",
  "STORE_BUSY",
  "INVALID_KEY",
  "VALIDATION",
  "NOT_FOUND",
  "CONFIRMATION_REQUIRED",
  "CONFIRMATION_EXPIRED",
  "PRECONDITION_CHANGED",
  "CONFIRMATION_DENIED",
  "INTERNAL",
] as const;
/** A tool error code. */
export type ErrorCode = (typeof ERROR_CODES)[number];

/** One row of the error table. */
export interface ErrorSpec {
  /** The fixed, human-readable message. */
  readonly message: string;
  /** The fixed next step for the model/user. */
  readonly hint: string;
  /** Whether retrying the same call can succeed. */
  readonly retryable: boolean;
}

/** The error table (plan 01 §4.3). Phase 1b / Phase W codes are kept so the seam is complete. */
export const ERROR_TABLE: Readonly<Record<ErrorCode, ErrorSpec>> = Object.freeze({
  NOT_AUTHENTICATED: {
    message: "Not signed in to the fantasy platform.",
    hint: "Run `ff auth` in a terminal, then retry.",
    retryable: false,
  },
  TOKEN_REFRESH_FAILED: {
    message: "The platform rejected the saved sign-in (it was revoked or the password changed).",
    hint: "Run `ff auth` in a terminal to sign in again.",
    retryable: false,
  },
  NOT_PROVISIONED: {
    message: "This app is not provisioned for the fantasy platform's API.",
    hint: "Run `ff doctor`. Refreshing the token will not help.",
    retryable: false,
  },
  WRITE_NOT_AVAILABLE: {
    message: "Writes are not available: this server is read-only.",
    hint: "Make the change in the platform's own app or website.",
    retryable: false,
  },
  RATE_LIMITED: {
    message: "The upstream service is rate-limiting requests.",
    hint: "Wait `retry_after_s` seconds, then retry once.",
    retryable: true,
  },
  UPSTREAM_UNAVAILABLE: {
    message: "An upstream data source could not be reached.",
    hint: "Retry shortly; `ff status` shows each source's last success.",
    retryable: true,
  },
  STALE_ONLY: {
    message: "Only data older than its hard limit is available.",
    hint: "Run `ff refresh <source>` in a terminal, or retry with allow_stale: true.",
    retryable: true,
  },
  STORE_BUSY: {
    message: "The local store is busy (a refresh or a second client holds the write lock).",
    hint: "Retry in a few seconds.",
    retryable: true,
  },
  INVALID_KEY: {
    message: "An id argument does not match the expected key format.",
    hint: "Use a key returned by another ff_ tool (e.g. ff_search_players) exactly as given.",
    retryable: false,
  },
  VALIDATION: {
    message: "The arguments are invalid.",
    hint: "Check `field` and `reason`, fix the arguments, and call again.",
    retryable: false,
  },
  NOT_FOUND: {
    message: "The requested item was not found.",
    hint: "Check the key or week; list tools return valid keys.",
    retryable: false,
  },
  CONFIRMATION_REQUIRED: {
    message: "This write needs a human confirmation first.",
    hint: "Follow `how_to_confirm` from the prepare result.",
    retryable: false,
  },
  CONFIRMATION_EXPIRED: {
    message: "The prepared write expired before it was confirmed.",
    hint: "Prepare it again and show the new diff to the user.",
    retryable: false,
  },
  PRECONDITION_CHANGED: {
    message: "The roster or player state changed since the write was prepared.",
    hint: "Prepare it again and show the new diff to the user.",
    retryable: false,
  },
  CONFIRMATION_DENIED: {
    message: "The user did not approve the prepared write.",
    hint: "Do not retry unless the user asks again.",
    retryable: false,
  },
  INTERNAL: {
    message: "Internal server error.",
    hint: "The server log (stderr) has details under this request_id.",
    retryable: false,
  },
});

/** Whether a value is a known error code. */
export function isErrorCode(v: unknown): v is ErrorCode {
  return typeof v === "string" && (ERROR_CODES as readonly string[]).includes(v);
}

/** Server-authored, value-free extras an FfError may carry into the result. */
export interface FfErrorDetails {
  /** For VALIDATION / INVALID_KEY: the argument path, e.g. `players.player_keys[2]`. */
  readonly field?: string;
  /** For VALIDATION: a short fixed reason code, e.g. `too_big`. */
  readonly reason?: string;
  /** For RATE_LIMITED: seconds to wait. */
  readonly retry_after_s?: number;
  /** Upstream HTTP status, when one caused this. */
  readonly upstream_status?: number;
  /** A server-authored hint that replaces the table hint (never built from upstream text). */
  readonly hint?: string;
}

/**
 * The server's coded error. Its `message` is the table's fixed text; nothing caller-supplied goes
 * into a tool result except the value-free `details`. Other layers that may not import src/mcp
 * (store, domain) throw their own Error subclasses carrying an `ffCode` property instead — the
 * mapper honours `ffCode` on any Error (see `StoreBusyError` in src/store/types.ts).
 */
export class FfError extends Error {
  /** The error code. */
  readonly code: ErrorCode;
  /** The same code under the cross-layer property name the mapper reads. */
  readonly ffCode: ErrorCode;
  /** Value-free extras. */
  readonly details: FfErrorDetails;
  constructor(code: ErrorCode, details: FfErrorDetails = {}, options?: { cause?: unknown }) {
    super(ERROR_TABLE[code].message, options);
    this.name = "FfError";
    this.code = code;
    this.ffCode = code;
    this.details = details;
  }
}

/** The JSON body of an error result (plan 01 §4.3 shape). */
export interface ToolErrorBody {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly hint: string;
    readonly retryable: boolean;
    readonly request_id: string;
    readonly field?: string;
    readonly reason?: string;
    readonly retry_after_s?: number;
    readonly upstream_status?: number;
  };
}

/** An MCP tool error result: one text block with the serialised body, `isError: true`. */
export interface ToolErrorResult {
  /** Always true: a tool execution error the model can self-correct from (spec "Error Handling"). */
  readonly isError: true;
  /** The serialised `ToolErrorBody` (a mutable tuple: the SDK's CallToolResult type requires it). */
  readonly content: [{ type: "text"; text: string }];
  /** The same body, structured (indexable, as the SDK's CallToolResult requires). */
  readonly structuredContent: ToolErrorBody & Readonly<Record<string, unknown>>;
  /** Index signature the SDK's result type requires. */
  readonly [key: string]: unknown;
}

/** A fresh request id: `r-` + 12 hex chars (links a tool result to its stderr log lines). */
export function newRequestId(): string {
  return `r-${randomBytes(6).toString("hex")}`;
}

/**
 * The STALE_ONLY hint when a dataset was never loaded (DatasetResult `stamp: null`) — the table
 * hint ("older than its hard limit… allow_stale") would be wrong: there is nothing stale to allow
 * (critic C-14 (c)).
 */
export const DATASET_NEVER_LOADED_HINT = "Run `ff refresh nflverse` in a terminal, then retry.";

const SAFE_SEGMENT = /^[A-Za-z0-9_]{1,40}$/;
const SAFE_REASON = /^[a-z_]{1,40}$/;
const SAFE_HINT = /^[\x20-\x7e]{1,300}$/;

/** Renders a zod issue path safely: unknown/odd segments become `?` (keys may be attacker-chosen). */
export function safeFieldPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const seg of path.slice(0, 8)) {
    if (typeof seg === "number" && Number.isInteger(seg) && seg >= 0 && seg < 100_000)
      out += `[${String(seg)}]`;
    else if (typeof seg === "string" && SAFE_SEGMENT.test(seg)) out += out === "" ? seg : `.${seg}`;
    else out += out === "" ? "?" : ".?";
  }
  return out === "" ? "(root)" : out;
}

/** Network failure codes that classify as UPSTREAM_UNAVAILABLE, never INTERNAL (plan 01 §4.3, OBJ-22). */
export const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

interface ZodLikeIssue {
  code?: unknown;
  path?: unknown;
  message?: unknown;
}

function isZodError(e: unknown): e is { issues: ZodLikeIssue[] } {
  return (
    e instanceof Error && e.name === "ZodError" && Array.isArray((e as { issues?: unknown }).issues)
  );
}

function ownProp(o: object, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, key)
    ? (o as Record<string, unknown>)[key]
    : undefined;
}

/** Whether a thrown value is a network failure (Node system error, undici, fetch TypeError, abort/timeout). */
export function isNetworkError(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; cur instanceof Error && depth < 4; depth++) {
    const code = ownProp(cur, "code");
    if (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) return true;
    if (cur.name === "TimeoutError" || cur.name === "AbortError") return true;
    if (cur.name === "TypeError" && cur.message === "fetch failed") return true;
    cur = cur.cause;
  }
  return false;
}

/**
 * Classifies any thrown value to a code + value-free details. Never reads a foreign message; a
 * hostile value (throwing getters, proxies) classifies as INTERNAL instead of throwing.
 */
export function classifyError(e: unknown): { code: ErrorCode; details: FfErrorDetails } {
  try {
    return classifyUnsafe(e);
  } catch {
    return { code: "INTERNAL", details: {} };
  }
}

function classifyUnsafe(e: unknown): { code: ErrorCode; details: FfErrorDetails } {
  if (e instanceof FfError) return { code: e.code, details: e.details };
  if (isZodError(e)) {
    const first = e.issues[0];
    const path = Array.isArray(first?.path) ? (first.path as PropertyKey[]) : [];
    const reasonRaw = typeof first?.code === "string" ? first.code : "invalid";
    if (first?.message === INVALID_KEY_MESSAGE)
      return { code: "INVALID_KEY", details: { field: safeFieldPath(path) } };
    return {
      code: "VALIDATION",
      details: {
        field:
          reasonRaw === "unrecognized_keys"
            ? `${safeFieldPath(path)} (unknown key)`
            : safeFieldPath(path),
        reason: SAFE_REASON.test(reasonRaw) ? reasonRaw : "invalid",
      },
    };
  }
  if (e instanceof Error) {
    const ff = ownProp(e, "ffCode");
    if (isErrorCode(ff)) {
      // A cross-layer hint is honoured only when it is one of the fixed server hints (never text
      // that could have come from a file or upstream).
      const hint = ownProp(e, "ffHint");
      return typeof hint === "string" && SERVER_HINTS.has(hint)
        ? { code: ff, details: { hint } }
        : { code: ff, details: {} };
    }
    if (isNetworkError(e)) return { code: "UPSTREAM_UNAVAILABLE", details: {} };
  }
  return { code: "INTERNAL", details: {} };
}

/**
 * What a tool call answers with on an error, on the wire (QA-1-007): the coded body in the one text
 * block and NO `structuredContent` — a tool's outputSchema describes its success envelope, and the
 * MCP spec requires structured results to conform to it, so a structured `{error}` would be rejected
 * by any client that validates unconditionally (the TypeScript SDK only skips it for isError).
 */
export interface ToolWireErrorResult {
  readonly isError: true;
  /** The serialised `ToolErrorBody` (a mutable tuple: the SDK's CallToolResult type requires it). */
  readonly content: [{ type: "text"; text: string }];
  readonly [key: string]: unknown;
}

/** The wire form of an error result: the same text block, no structuredContent (QA-1-007). */
export function toWireError(e: unknown, requestId: string): ToolWireErrorResult {
  const { content } = toToolError(e, requestId);
  return { isError: true, content };
}

/**
 * Maps ANY thrown value to a tool error result (plan 01 §4.3). The message and hint come from the
 * table; the only caller-derived content is FfError's value-free `details`, each re-validated here.
 * Log the original with `describeForLog` under the same `requestId`. The `structuredContent` copy is
 * for in-process callers only — a tool call answers with `toWireError` (QA-1-007).
 */
export function toToolError(e: unknown, requestId: string): ToolErrorResult {
  const { code, details } = classifyError(e);
  const spec = ERROR_TABLE[code];
  const error: Record<string, unknown> = {
    code,
    message: spec.message,
    hint:
      typeof details.hint === "string" && SAFE_HINT.test(details.hint) ? details.hint : spec.hint,
    retryable: spec.retryable,
    request_id: REQUEST_ID_RE.test(requestId) ? requestId : "r-unknown",
  };
  if (typeof details.field === "string") error.field = details.field.slice(0, 120);
  if (typeof details.reason === "string" && SAFE_REASON.test(details.reason))
    error.reason = details.reason;
  if (
    typeof details.retry_after_s === "number" &&
    Number.isFinite(details.retry_after_s) &&
    details.retry_after_s >= 0
  ) {
    error.retry_after_s = Math.min(Math.ceil(details.retry_after_s), 86_400);
  }
  if (
    typeof details.upstream_status === "number" &&
    Number.isInteger(details.upstream_status) &&
    details.upstream_status >= 100 &&
    details.upstream_status <= 599
  ) {
    error.upstream_status = details.upstream_status;
  }
  const body = { error } as unknown as ToolErrorBody & Readonly<Record<string, unknown>>;
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
  };
}

/**
 * A log-safe description of a thrown value for the stderr logger (which redacts and truncates
 * further). Includes name/code/message of Errors and the cause chain — never sent to a client.
 */
export function describeForLog(e: unknown): Record<string, unknown> {
  try {
    if (!(e instanceof Error)) return { thrown: typeof e };
    const out: Record<string, unknown> = { name: e.name, message: e.message };
    const code = ownProp(e, "code") ?? ownProp(e, "ffCode");
    if (typeof code === "string") out.code = code;
    if (e.cause !== undefined) {
      out.cause =
        e.cause instanceof Error
          ? { name: e.cause.name, message: e.cause.message }
          : typeof e.cause;
    }
    return out;
  } catch {
    return { thrown: "unreadable" };
  }
}

// --- SDK integration: deferred validation + the handler wrapper (critic C-02) ------------------------

/**
 * A Standard Schema for `registerTool({ inputSchema })` that ADVERTISES `schema`'s JSON Schema in
 * tools/list but passes every argument through unvalidated, so validation happens in `wrapHandler`
 * and its failures become the coded VALIDATION / INVALID_KEY results of plan 01 §4.3 instead of the
 * SDK's free-text "Input validation error: …" (which echoes attacker-chosen paths and messages).
 */
export function deferValidation(schema: z.ZodType): StandardSchemaWithJSON<unknown, unknown> {
  const std = schema["~standard"] as unknown as StandardSchemaWithJSON["~standard"];
  return {
    "~standard": {
      version: 1,
      vendor: "ff-deferred",
      validate: (value: unknown) => ({ value }),
      jsonSchema: std.jsonSchema,
    },
  };
}

/** What `wrapHandler` gives a tool implementation besides its parsed arguments. */
export interface HandlerContext {
  /** This call's request id: put it in the envelope (`meta.request_id`) and every log line. */
  readonly requestId: string;
}

/** Options for `wrapHandler`. */
export interface WrapOptions {
  /** Called with every thrown value (log it with `describeForLog` under the same request id). */
  readonly onError?: (e: unknown, requestId: string) => void;
  /** Request-id source (tests); default `newRequestId`. */
  readonly newId?: () => string;
}

/**
 * Wraps a tool implementation so no code path can skip the error contract: mints the request id,
 * parses the raw arguments with `schema` (a failure → VALIDATION / INVALID_KEY), runs `fn`, and maps
 * ANY throw (or rejected promise) through `toToolError`. Register with `deferValidation(schema)`.
 */
export function wrapHandler<S extends z.ZodType>(
  schema: S,
  fn: (args: z.output<S>, ctx: HandlerContext) => Promise<ToolSuccessResult> | ToolSuccessResult,
  opts: WrapOptions = {},
): (raw: unknown) => Promise<ToolSuccessResult | ToolWireErrorResult> {
  return async (raw: unknown) => {
    const requestId = (opts.newId ?? newRequestId)();
    try {
      const parsed = schema.safeParse(raw ?? {});
      if (!parsed.success) return toWireError(parsed.error, requestId);
      return await fn(parsed.data, { requestId });
    } catch (e) {
      try {
        opts.onError?.(e, requestId);
      } catch {
        // a failing logger must not change the result
      }
      return toWireError(e, requestId);
    }
  };
}
