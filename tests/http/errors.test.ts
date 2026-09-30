// errors.test.ts — the HTTP failure taxonomy (plan 01 §4.3 / OBJ-22: a network failure is never
// INTERNAL; plan 05 §4.1 network rows). Hostile thrown values never make the classifier throw.
import { describe, expect, it } from "vitest";
import {
  classifyFetchError,
  HTTP_ERROR_KINDS,
  HttpError,
  isNetworkFailure,
  isTransientNetworkError,
  kindForCode,
} from "../../src/http/errors.js";
import { classifyError, toToolError } from "../../src/mcp/errors.js";
import { netError } from "./helpers.js";

describe("HttpError", () => {
  it("maps every kind to an error-contract code; only policy refusals are INTERNAL", () => {
    const policy = new Set([
      "invalid_url",
      "scheme_refused",
      "credentials_refused",
      "host_not_allowed",
    ]);
    for (const kind of HTTP_ERROR_KINDS) {
      const e = new HttpError({ kind });
      const code = classifyError(e).code;
      if (policy.has(kind)) expect(code).toBe("INTERNAL");
      else if (kind === "rate_limited" || kind === "quota_exhausted")
        expect(code).toBe("RATE_LIMITED");
      else expect(code).toBe("UPSTREAM_UNAVAILABLE");
      expect(e.code).toBe(`FF_HTTP_${kind.toUpperCase()}`);
      expect(e.name).toBe("HttpError");
    }
  });

  it("transient: network-shaped kinds and 408 only", () => {
    const transient = HTTP_ERROR_KINDS.filter((k) => new HttpError({ kind: k }).transient);
    expect(transient.sort()).toEqual(
      ["connect", "dns", "http_5xx", "network", "rate_limited", "reset", "timeout"].sort(),
    );
    expect(new HttpError({ kind: "http_4xx", status: 408 }).transient).toBe(true);
    expect(new HttpError({ kind: "http_4xx", status: 404 }).transient).toBe(false);
  });

  it("sanitises host, status, retry-after and cause code", () => {
    const e = new HttpError({
      kind: "http_5xx",
      host: "evil host\n<script>",
      status: 5.5,
      retryAfterS: -3,
      causeCode: "bad code; rm -rf",
    });
    expect(e.host).toBeNull();
    expect(e.status).toBeNull();
    expect(e.retryAfterS).toBeNull();
    expect(e.causeCode).toBeNull();
    const g = new HttpError({
      kind: "http_5xx",
      host: "github.com",
      status: 503,
      retryAfterS: 2,
      causeCode: "X_1",
    });
    expect([g.host, g.status, g.retryAfterS, g.causeCode]).toEqual(["github.com", 503, 2, "X_1"]);
  });

  it("the tool error never carries the upstream text", () => {
    const e = new HttpError({
      kind: "http_5xx",
      status: 500,
      cause: new Error("<html>secret body</html>"),
    });
    expect(JSON.stringify(toToolError(e, "r-abc123"))).not.toContain("secret");
  });
});

describe("classifyFetchError", () => {
  it("passes an HttpError through; our timers and the caller's abort win over the AbortError", () => {
    const h = new HttpError({ kind: "dns" });
    expect(classifyFetchError(h, "caller", null)).toBe(h);
    const abortErr = new DOMException("aborted", "AbortError");
    expect(classifyFetchError(abortErr, "connect_timeout", "github.com").causeCode).toBe(
      "CONNECT_TIMEOUT",
    );
    expect(classifyFetchError(abortErr, "total_timeout", "github.com").kind).toBe("timeout");
    expect(classifyFetchError(abortErr, "caller", "github.com").kind).toBe("aborted");
    expect(classifyFetchError(abortErr, null, "github.com").kind).toBe("network");
  });

  it("walks the cause chain for a code; TimeoutError is a timeout", () => {
    expect(classifyFetchError(netError("ENOTFOUND"), null, "github.com")).toMatchObject({
      kind: "dns",
      causeCode: "ENOTFOUND",
      host: "github.com",
    });
    const deep = new Error("a", { cause: new Error("b", { cause: netError("ECONNRESET") }) });
    expect(classifyFetchError(deep, null, null).kind).toBe("reset");
    expect(classifyFetchError(new DOMException("t", "TimeoutError"), null, null).kind).toBe(
      "timeout",
    );
  });

  it("hostile errors (throwing getters, cycles, non-errors) classify as network, never throw", () => {
    const evil = new Error("x");
    Object.defineProperty(evil, "code", {
      get() {
        throw new Error("gotcha");
      },
    });
    Object.defineProperty(evil, "cause", {
      get() {
        throw new Error("gotcha");
      },
    });
    expect(classifyFetchError(evil, null, null).kind).toBe("network");
    const cyc = new Error("c") as Error & { cause?: unknown };
    cyc.cause = cyc;
    expect(classifyFetchError(cyc, null, null).kind).toBe("network");
    expect(classifyFetchError("string", null, null).kind).toBe("network");
    expect(classifyFetchError(Object.assign(new Error("n"), { code: 42 }), null, null).kind).toBe(
      "network",
    );
  });

  it("kindForCode knows TLS prefixes and nothing else by accident", () => {
    expect(kindForCode("ERR_TLS_ANYTHING")).toBe("tls");
    expect(kindForCode("ERR_SSL_X")).toBe("tls");
    expect(kindForCode("EPROTO")).toBe("tls");
    expect(kindForCode("ENOENT")).toBeNull();
  });
});

describe("isTransientNetworkError / isNetworkFailure", () => {
  it("transient: HttpError.transient, raw network codes, TimeoutError, bare 'fetch failed'", () => {
    expect(isTransientNetworkError(new HttpError({ kind: "reset" }))).toBe(true);
    expect(isTransientNetworkError(new HttpError({ kind: "tls" }))).toBe(false);
    expect(isTransientNetworkError(netError("ECONNREFUSED"))).toBe(true);
    expect(isTransientNetworkError(netError("CERT_HAS_EXPIRED"))).toBe(false);
    expect(isTransientNetworkError(new DOMException("t", "TimeoutError"))).toBe(true);
    expect(isTransientNetworkError(new TypeError("fetch failed"))).toBe(true);
    expect(isTransientNetworkError(new TypeError("other"))).toBe(false);
    expect(isTransientNetworkError(new Error("parse error"))).toBe(false);
    expect(isTransientNetworkError(null)).toBe(false);
    const evil = new Error("x");
    Object.defineProperty(evil, "cause", {
      get() {
        throw new Error("gotcha");
      },
    });
    expect(isTransientNetworkError(evil)).toBe(false);
  });

  it("network failure: any HttpError except a policy refusal; raw transient network errors", () => {
    expect(isNetworkFailure(new HttpError({ kind: "http_4xx", status: 404 }))).toBe(true);
    expect(isNetworkFailure(new HttpError({ kind: "tls" }))).toBe(true);
    expect(isNetworkFailure(new HttpError({ kind: "host_not_allowed" }))).toBe(false);
    expect(isNetworkFailure(netError("ENOTFOUND"))).toBe(true);
    expect(isNetworkFailure(new Error("x"))).toBe(false);
  });
});
