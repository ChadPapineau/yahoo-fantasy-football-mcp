// client.test.ts — src/http/client.ts against an in-process fake fetch (plan 05 §2 `http/client`:
// allow-list before DNS, timeouts, redirects to a non-allow-listed host rejected; plan 02 §7, §8 #18;
// plan 01 §7 URL redaction). No sockets, no network.
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALLOWED_HOSTS } from "../../src/http/allowlist.js";
import {
  createHttpClient,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_TOTAL_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  MAX_RESPONSE_HEADERS,
} from "../../src/http/client.js";
import { HttpError } from "../../src/http/errors.js";
import { classifyError } from "../../src/mcp/errors.js";
import { MAX_REDIRECT_HOPS } from "../../src/sources/source.js";
import {
  captureLog,
  chunkedBody,
  fakeFetch,
  hangingFetch,
  netError,
  ok,
  redirect,
} from "./helpers.js";

const sig = (): AbortSignal => new AbortController().signal;
const MB = 1024 * 1024;

async function failure(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    return e as HttpError;
  }
  throw new Error("expected a failure");
}

describe("allow-list (plan 02 §7): refused before any request", () => {
  const refused: [string, string][] = [
    ["http://github.com/x", "scheme_refused"],
    ["https://github.com:8443/x", "scheme_refused"],
    ["ftp://github.com/x", "scheme_refused"],
    ["https://user:pw@github.com/x", "credentials_refused"],
    ["https://api.weather.gov@evil.example/x", "credentials_refused"],
    ["https://evil.example/x", "host_not_allowed"],
    ["https://github.com.evil.example/x", "host_not_allowed"],
    ["https://evilgithub.com/x", "host_not_allowed"],
    ["https://github.com./x", "host_not_allowed"],
    ["https://140.82.112.3/x", "host_not_allowed"],
    ["https://[::1]/x", "host_not_allowed"],
    ["https://localhost/x", "host_not_allowed"],
    ["https://gіthub.com/x", "host_not_allowed"], // Cyrillic і → punycode
    ["https://fantasysports.yahooapis.com/x", "host_not_allowed"], // Phase 1b, not built
    ["https://api.sleeper.app/v1/state/nfl", "host_not_allowed"], // Phase 2
    ["not a url", "invalid_url"],
    ["", "invalid_url"],
    [`https://github.com/${"a".repeat(5000)}`, "invalid_url"],
  ];
  it.each(refused)("%s → %s, zero fetch calls", async (url, kind) => {
    const f = fakeFetch(() => ok("x"));
    const c = createHttpClient({ fetch: f.fetch });
    const e = await failure(c.get(url, { signal: sig(), maxBytes: 10 }));
    expect(e.kind).toBe(kind);
    expect(f.calls).toHaveLength(0);
  });

  it("the credentials refusal user@ case still refuses (user only)", async () => {
    const f = fakeFetch(() => ok("x"));
    const e = await failure(
      createHttpClient({ fetch: f.fetch }).get("https://u@github.com/", {
        signal: sig(),
        maxBytes: 1,
      }),
    );
    expect(e.kind).toBe("credentials_refused");
  });

  it("every allow-listed host is reachable, case-insensitively, on :443 too", async () => {
    const f = fakeFetch(() => ok("ok"));
    const c = createHttpClient({ fetch: f.fetch });
    for (const h of ALLOWED_HOSTS) {
      const r = await c.get(`https://${h.toUpperCase()}:443/p?q=1`, {
        signal: sig(),
        maxBytes: 10,
      });
      expect(new TextDecoder().decode(r.body)).toBe("ok");
    }
    expect(f.calls).toHaveLength(ALLOWED_HOSTS.length);
  });

  it("property: a random host not on the list is never requested", async () => {
    await fc.assert(
      fc.asyncProperty(fc.domain(), async (host) => {
        fc.pre(!ALLOWED_HOSTS.includes(host.toLowerCase()));
        const f = fakeFetch(() => ok("x"));
        const c = createHttpClient({ fetch: f.fetch });
        await expect(c.get(`https://${host}/x`, { signal: sig(), maxBytes: 10 })).rejects.toThrow(
          HttpError,
        );
        expect(f.calls).toHaveLength(0);
      }),
      { numRuns: 200 },
    );
  });

  it("a narrowed client refuses the hosts it dropped; widening throws at construction", async () => {
    const f = fakeFetch(() => ok("x"));
    const c = createHttpClient({
      fetch: f.fetch,
      allowHosts: ["API.WEATHER.GOV", "api.weather.gov"],
    });
    expect(c.allowHosts).toEqual(["api.weather.gov"]);
    expect((await failure(c.get("https://github.com/", { signal: sig(), maxBytes: 1 }))).kind).toBe(
      "host_not_allowed",
    );
    await c.get("https://api.weather.gov/points/1,2", { signal: sig(), maxBytes: 1 });
    expect(() => createHttpClient({ allowHosts: ["evil.example"] })).toThrow(RangeError);
  });
});

describe("redirects (plan 02 §7, critic C-16b): manual, ≤ 3 hops, every hop re-checked", () => {
  it(`follows up to MAX_REDIRECT_HOPS (${String(MAX_REDIRECT_HOPS)}) and reports final_url`, async () => {
    const chain = [
      "https://github.com/nflverse/nflverse-data/releases/download/x/f.parquet",
      "https://objects.githubusercontent.com/a",
      "https://release-assets.githubusercontent.com/b?sig=SECRET",
      "https://raw.githubusercontent.com/c",
    ];
    const f = fakeFetch((url, _i, n) =>
      n < chain.length ? redirect(chain[n] ?? null, 302) : ok("data"),
    );
    const r = await createHttpClient({ fetch: f.fetch }).get(chain[0] ?? "", {
      signal: sig(),
      maxBytes: 100,
    });
    expect(f.calls.map((c) => c.url)).toEqual(chain);
    expect(r.final_url).toBe(chain[3]);
    expect(r.status).toBe(200);
    for (const c of f.calls) expect(c.init.redirect).toBe("manual");
  });

  it("allowed → allowed → DISALLOWED at hop 2 is refused without requesting it", async () => {
    const f = fakeFetch((_u, _i, n) =>
      n === 1
        ? redirect("https://objects.githubusercontent.com/x")
        : redirect("https://evil.example/steal"),
    );
    const e = await failure(
      createHttpClient({ fetch: f.fetch }).get("https://github.com/x", {
        signal: sig(),
        maxBytes: 9,
      }),
    );
    expect(e.kind).toBe("redirect_refused");
    expect(e.host).toBe("evil.example");
    expect(e.causeCode).toBe("HOST_NOT_ALLOWED");
    expect(f.calls.map((c) => new URL(c.url).hostname)).toEqual([
      "github.com",
      "objects.githubusercontent.com",
    ]);
    expect(classifyError(e).code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("a 4th redirect is refused (4 hops > MAX_REDIRECT_HOPS) and never followed", async () => {
    const f = fakeFetch((_u, _i, n) => redirect(`https://github.com/hop${String(n)}`, 301));
    const e = await failure(
      createHttpClient({ fetch: f.fetch }).get("https://github.com/start", {
        signal: sig(),
        maxBytes: 9,
      }),
    );
    expect(e.kind).toBe("too_many_redirects");
    expect(f.calls).toHaveLength(MAX_REDIRECT_HOPS + 1);
  });

  it.each([
    [null, "redirect_refused"],
    ["", "redirect_refused"],
    ["http://github.com/downgrade", "redirect_refused"],
    ["https://user:pw@github.com/", "redirect_refused"],
    ["https://github.com:444/", "redirect_refused"],
    ["//evil.example/protocol-relative", "redirect_refused"],
    ["http://[::1", "redirect_refused"],
  ])("Location %j → %s", async (loc, kind) => {
    const f = fakeFetch(() => redirect(loc, 307));
    const e = await failure(
      createHttpClient({ fetch: f.fetch }).get("https://github.com/", {
        signal: sig(),
        maxBytes: 9,
      }),
    );
    expect(e.kind).toBe(kind);
    expect(f.calls).toHaveLength(1);
  });

  it("a relative Location resolves against the current URL", async () => {
    const f = fakeFetch((_u, _i, n) => (n === 1 ? redirect("../b/c?x=1", 303) : ok("y")));
    const r = await createHttpClient({ fetch: f.fetch }).get("https://github.com/a/z/", {
      signal: sig(),
      maxBytes: 9,
    });
    expect(r.final_url).toBe("https://github.com/a/b/c?x=1");
  });
});

describe("header hygiene: no credentials or cookies, ever", () => {
  it("sends only user-agent, accept, accept-encoding — on every hop", async () => {
    const f = fakeFetch((_u, _i, n) =>
      n === 1
        ? new Response(null, {
            status: 302,
            headers: { location: "https://objects.githubusercontent.com/o", "set-cookie": "a=b" },
          })
        : ok("z", { "set-cookie": "sid=1", "Set-Cookie2": "x", "x-ok": "1" }),
    );
    const r = await createHttpClient({ fetch: f.fetch }).get("https://github.com/", {
      signal: sig(),
      maxBytes: 9,
      accept: "application/json",
    });
    expect(f.calls).toHaveLength(2);
    for (const c of f.calls) {
      expect(Object.keys(c.headers).sort()).toEqual(["accept", "accept-encoding", "user-agent"]);
      expect(c.headers["user-agent"]).toBe(DEFAULT_USER_AGENT);
      expect(c.headers.accept).toBe("application/json");
      expect(c.init.credentials).toBe("omit");
      expect(c.init.method).toBe("GET");
      for (const k of Object.keys(c.headers)) expect(k).not.toMatch(/authorization|cookie/i);
    }
    expect(r.headers["set-cookie"]).toBeUndefined();
    expect(r.headers["set-cookie2"]).toBeUndefined();
    expect(r.headers["x-ok"]).toBe("1");
  });

  it("the User-Agent is descriptive and carries no address", () => {
    expect(DEFAULT_USER_AGENT).toMatch(/^fantasy-football-mcp\/\d+\.\d+\.\d+ \(/);
    expect(DEFAULT_USER_AGENT).not.toMatch(/@/);
  });

  it("response headers are capped, lower-cased, and a __proto__ header cannot pollute", async () => {
    const h = new Headers();
    for (let i = 0; i < 100; i++) h.set(`x-h${String(i)}`, "v".repeat(2000));
    h.set("__proto__", "polluted");
    const f = fakeFetch(() => new Response("b", { status: 200, headers: h }));
    const r = await createHttpClient({ fetch: f.fetch }).get("https://github.com/", {
      signal: sig(),
      maxBytes: 9,
    });
    expect(Object.keys(r.headers).length).toBe(MAX_RESPONSE_HEADERS);
    for (const v of Object.values(r.headers)) expect(v.length).toBeLessThanOrEqual(1024);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(r.headers)).toBe(Object.prototype);
  });

  it("uses the global fetch when none is injected", async () => {
    const f = fakeFetch(() => ok("global"));
    vi.stubGlobal("fetch", f.fetch);
    try {
      const r = await createHttpClient().get("https://github.com/", { signal: sig(), maxBytes: 9 });
      expect(new TextDecoder().decode(r.body)).toBe("global");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("size caps (mid-stream) and gzip bombs", () => {
  it("stops reading as soon as the stream passes maxBytes", async () => {
    const body = chunkedBody(1000, 64 * 1024);
    const f = fakeFetch(() => new Response(body.stream, { status: 200 }));
    const e = await failure(
      createHttpClient({ fetch: f.fetch }).get("https://github.com/", {
        signal: sig(),
        maxBytes: MB,
      }),
    );
    expect(e.kind).toBe("too_large");
    expect(body.pulled()).toBeLessThan(40);
  });

  it("a Content-Length over the cap fails before reading", async () => {
    const body = chunkedBody(10, 10);
    const f = fakeFetch(
      () =>
        new Response(body.stream, { status: 200, headers: { "content-length": String(5 * MB) } }),
    );
    const e = await failure(
      createHttpClient({ fetch: f.fetch }).get("https://github.com/", {
        signal: sig(),
        maxBytes: MB,
      }),
    );
    expect(e.kind).toBe("too_large");
    expect(body.pulled()).toBeLessThanOrEqual(1);
  });

  it("exactly maxBytes passes", async () => {
    const f = fakeFetch(() => ok(new Uint8Array(1000)));
    const r = await createHttpClient({ fetch: f.fetch }).get("https://github.com/", {
      signal: sig(),
      maxBytes: 1000,
    });
    expect(r.body.byteLength).toBe(1000);
  });

  it("a gzip bomb (50 MB of zeros in ~50 KB) stops at the decoded cap, fast", async () => {
    const bomb = gzipSync(Buffer.alloc(50 * MB));
    expect(bomb.length).toBeLessThan(MB);
    const f = fakeFetch(() => ok(bomb, { "content-encoding": "gzip" }));
    const t0 = performance.now();
    const e = await failure(
      createHttpClient({ fetch: f.fetch }).get("https://github.com/", {
        signal: sig(),
        maxBytes: MB,
      }),
    );
    expect(e.kind).toBe("too_large");
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it("an honest gzip body is decoded; x-gzip too", async () => {
    for (const enc of ["gzip", "x-gzip", "identity, gzip"]) {
      const f = fakeFetch(() => ok(gzipSync(Buffer.from('{"a":1}')), { "content-encoding": enc }));
      const r = await createHttpClient({ fetch: f.fetch }).get("https://github.com/", {
        signal: sig(),
        maxBytes: 100,
      });
      expect(new TextDecoder().decode(r.body)).toBe('{"a":1}');
    }
  });

  it("a declared-gzip body fetch already decoded passes through; an empty one is 0 bytes", async () => {
    const f = fakeFetch((_u, _i, n) =>
      n === 1
        ? ok("plain text", { "content-encoding": "gzip" })
        : ok("", { "content-encoding": "gzip" }),
    );
    const c = createHttpClient({ fetch: f.fetch });
    const r = await c.get("https://github.com/", { signal: sig(), maxBytes: 100 });
    expect(new TextDecoder().decode(r.body)).toBe("plain text");
    const r2 = await c.get("https://github.com/", { signal: sig(), maxBytes: 100 });
    expect(r2.body.byteLength).toBe(0);
  });

  it("a corrupt gzip body is a decode failure", async () => {
    const f = fakeFetch(() =>
      ok(new Uint8Array([0x1f, 0x8b, 1, 2, 3, 4, 5]), { "content-encoding": "gzip" }),
    );
    const e = await failure(
      createHttpClient({ fetch: f.fetch }).get("https://github.com/", {
        signal: sig(),
        maxBytes: 100,
      }),
    );
    expect(e.kind).toBe("decode");
    expect(e.transient).toBe(false);
  });

  it("a null body is an empty result", async () => {
    const f = fakeFetch(() => new Response(null, { status: 204 }));
    const r = await createHttpClient({ fetch: f.fetch }).get("https://github.com/", {
      signal: sig(),
      maxBytes: 1,
    });
    expect(r.status).toBe(204);
    expect(r.body.byteLength).toBe(0);
  });
});

describe("status and network error mapping (plan 05 §4.1)", () => {
  it.each([
    [404, "http_4xx", false],
    [403, "http_4xx", false],
    [408, "http_4xx", true],
    [429, "rate_limited", true],
    [500, "http_5xx", true],
    [503, "http_5xx", true],
    [304, "http_status", false],
    [300, "http_status", false],
  ])("HTTP %i → %s (transient %s)", async (status, kind, transient) => {
    const f = fakeFetch(
      () =>
        new Response(status === 304 ? null : "body <html>secret</html>", {
          status,
          headers: { "retry-after": "7" },
        }),
    );
    const e = await failure(
      createHttpClient({ fetch: f.fetch }).get("https://api.weather.gov/x?k=v", {
        signal: sig(),
        maxBytes: 100,
      }),
    );
    expect(e.kind).toBe(kind);
    expect(e.status).toBe(status);
    expect(e.transient).toBe(transient);
    expect(e.message).not.toMatch(/secret|html|k=v/);
    if (kind === "rate_limited" || kind === "http_5xx") expect(e.retryAfterS).toBe(7);
    expect(classifyError(e).code).not.toBe("INTERNAL");
  });

  it("a non-numeric Retry-After is ignored", async () => {
    const f = fakeFetch(
      () =>
        new Response("", {
          status: 429,
          headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" },
        }),
    );
    const e = await failure(
      createHttpClient({ fetch: f.fetch }).get("https://github.com/", {
        signal: sig(),
        maxBytes: 1,
      }),
    );
    expect(e.retryAfterS).toBeNull();
    expect(classifyError(e).code).toBe("RATE_LIMITED");
  });

  it.each([
    ["ENOTFOUND", "dns"],
    ["EAI_AGAIN", "dns"],
    ["ECONNREFUSED", "connect"],
    ["EHOSTUNREACH", "connect"],
    ["ECONNRESET", "reset"],
    ["UND_ERR_SOCKET", "reset"],
    ["ETIMEDOUT", "timeout"],
    ["UND_ERR_CONNECT_TIMEOUT", "timeout"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "tls"],
    ["CERT_HAS_EXPIRED", "tls"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls"],
    ["ERR_SSL_WRONG_VERSION_NUMBER", "tls"],
    ["EWHATEVER", "network"],
  ])("fetch failing with %s → %s, never INTERNAL", async (code, kind) => {
    const f = fakeFetch(() => {
      throw netError(code);
    });
    const e = await failure(
      createHttpClient({ fetch: f.fetch }).get("https://github.com/", {
        signal: sig(),
        maxBytes: 1,
      }),
    );
    expect(e.kind).toBe(kind);
    expect(classifyError(e).code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("a reset in the middle of the body is a reset", async () => {
    let n = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        n++;
        if (n > 2) c.error(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
        else c.enqueue(new Uint8Array(10));
      },
    });
    const f = fakeFetch(() => new Response(stream, { status: 200 }));
    const e = await failure(
      createHttpClient({ fetch: f.fetch }).get("https://github.com/", {
        signal: sig(),
        maxBytes: 1000,
      }),
    );
    expect(e.kind).toBe("reset");
  });

  it("a fetch rejecting with a non-Error is a network failure", async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the hostile case under test
    const c = createHttpClient({ fetch: () => Promise.reject("boom") });
    expect((await failure(c.get("https://github.com/", { signal: sig(), maxBytes: 1 }))).kind).toBe(
      "network",
    );
  });
});

describe("timeouts and aborts (fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("connect timeout: no headers within connectTimeoutMs", async () => {
    const h = hangingFetch();
    const p = failure(
      createHttpClient({ fetch: h.fetch }).get("https://github.com/", {
        signal: sig(),
        maxBytes: 1,
      }),
    );
    await vi.advanceTimersByTimeAsync(DEFAULT_CONNECT_TIMEOUT_MS + 1);
    const e = await p;
    expect(e.kind).toBe("timeout");
    expect(e.causeCode).toBe("CONNECT_TIMEOUT");
    expect(e.transient).toBe(true);
  });

  it("connect timeout also fires on a fetch that ignores its signal", async () => {
    const c = createHttpClient({
      fetch: () => new Promise<Response>(() => undefined),
      connectTimeoutMs: 50,
    });
    const p = failure(c.get("https://github.com/", { signal: sig(), maxBytes: 1 }));
    await vi.advanceTimersByTimeAsync(60);
    expect((await p).kind).toBe("timeout");
  });

  it("total timeout: headers arrive but the body never ends", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
    });
    const f = fakeFetch(() => new Response(stream, { status: 200 }));
    const p = failure(
      createHttpClient({ fetch: f.fetch }).get("https://github.com/", {
        signal: sig(),
        maxBytes: 9,
      }),
    );
    await vi.advanceTimersByTimeAsync(DEFAULT_TOTAL_TIMEOUT_MS + 1);
    const e = await p;
    expect(e.kind).toBe("timeout");
    expect(e.causeCode).toBe("TOTAL_TIMEOUT");
  });

  it("the caller's signal aborts mid-flight → aborted (not retryable)", async () => {
    const ac = new AbortController();
    const h = hangingFetch();
    const p = failure(
      createHttpClient({ fetch: h.fetch }).get("https://github.com/", {
        signal: ac.signal,
        maxBytes: 1,
      }),
    );
    await vi.advanceTimersByTimeAsync(10);
    ac.abort();
    const e = await p;
    expect(e.kind).toBe("aborted");
    expect(e.transient).toBe(false);
  });

  it("a caller abort that lands while fetch is being called is still an abort", async () => {
    const ac = new AbortController();
    const c = createHttpClient({
      fetch: () => {
        ac.abort();
        return Promise.reject(new DOMException("aborted", "AbortError"));
      },
    });
    const e = await failure(c.get("https://github.com/", { signal: ac.signal, maxBytes: 1 }));
    expect(e.kind).toBe("aborted");
  });

  it("an already-aborted signal never calls fetch", async () => {
    const ac = new AbortController();
    ac.abort();
    const f = fakeFetch(() => ok("x"));
    const e = await failure(
      createHttpClient({ fetch: f.fetch }).get("https://github.com/", {
        signal: ac.signal,
        maxBytes: 1,
      }),
    );
    expect(e.kind).toBe("aborted");
    expect(f.calls).toHaveLength(0);
  });

  it("timers are cleared on success (no pending timers left)", async () => {
    const f = fakeFetch(() => ok("x"));
    await createHttpClient({ fetch: f.fetch }).get("https://github.com/", {
      signal: sig(),
      maxBytes: 9,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("validation of options", () => {
  const f = fakeFetch(() => ok("x"));
  const c = createHttpClient({ fetch: f.fetch });
  it.each([0, -1, 1.5, Number.NaN, 2 * 1024 * 1024 * 1024])(
    "maxBytes %s → RangeError",
    async (m) => {
      await expect(c.get("https://github.com/", { signal: sig(), maxBytes: m })).rejects.toThrow(
        RangeError,
      );
    },
  );
  it("header injection through accept is refused", async () => {
    await expect(
      c.get("https://github.com/", { signal: sig(), maxBytes: 9, accept: "a\r\nAuthorization: x" }),
    ).rejects.toThrow(RangeError);
  });
  it("a missing signal is refused", async () => {
    await expect(
      c.get("https://github.com/", { signal: undefined as unknown as AbortSignal, maxBytes: 9 }),
    ).rejects.toThrow(RangeError);
  });
  it("bad construction options throw", () => {
    expect(() => createHttpClient({ userAgent: "bad\nua" })).toThrow(RangeError);
    expect(() => createHttpClient({ connectTimeoutMs: 0 })).toThrow(RangeError);
    expect(() => createHttpClient({ totalTimeoutMs: Number.POSITIVE_INFINITY })).toThrow(
      RangeError,
    );
    expect(createHttpClient({ userAgent: "x/1" }).userAgent).toBe("x/1");
  });
});

describe("logging: URLs without query strings (plan 01 §7)", () => {
  it("success and failure lines carry origin + path only", async () => {
    const cap = captureLog();
    const f = fakeFetch((_u, _i, n) =>
      n === 1
        ? redirect("https://objects.githubusercontent.com/o?X-Amz-Signature=SIGSECRET")
        : n === 2
          ? ok("x")
          : new Response("", { status: 500 }),
    );
    let now = 0;
    const c = createHttpClient({ fetch: f.fetch, log: cap.log, now: () => (now += 5) });
    await c.get("https://github.com/p?token=TOKSECRET&latitude=1", { signal: sig(), maxBytes: 9 });
    await expect(
      c.get("https://api.open-meteo.com/v1/forecast?apikey=KEYSECRET", {
        signal: sig(),
        maxBytes: 9,
      }),
    ).rejects.toThrow(HttpError);
    const text = JSON.stringify(cap.lines);
    for (const s of ["SIGSECRET", "TOKSECRET", "KEYSECRET", "latitude", "?"])
      expect(text).not.toContain(s);
    expect(cap.lines.map((l) => l.event)).toEqual(["http.redirect", "http.get", "http.error"]);
    expect(cap.lines[1]?.fields.url).toBe("https://objects.githubusercontent.com/o");
    expect(cap.lines[2]?.fields).toMatchObject({ kind: "http_5xx", status: 500 });
  });
});

describe("download: streamed to a 0600 file, removed on failure", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ff-http-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the body and reports bytes / final_url / path", async () => {
    const body = chunkedBody(5, 1000);
    const f = fakeFetch((_u, _i, n) =>
      n === 1
        ? redirect("https://release-assets.githubusercontent.com/f")
        : new Response(body.stream),
    );
    const dest = join(dir, "f.parquet");
    const r = await createHttpClient({ fetch: f.fetch }).download("https://github.com/f", {
      signal: sig(),
      maxBytes: MB,
      dest,
    });
    expect(r).toMatchObject({ status: 200, bytes: 5000, path: dest });
    expect(r.final_url).toBe("https://release-assets.githubusercontent.com/f");
    expect((await readFile(dest)).length).toBe(5000);
    expect((await stat(dest)).mode & 0o777).toBe(0o600);
  });

  it("a gzip-encoded download is decoded before it is written", async () => {
    const f = fakeFetch(() => ok(gzipSync(Buffer.from("hello")), { "content-encoding": "gzip" }));
    const dest = join(dir, "g.txt");
    await createHttpClient({ fetch: f.fetch }).download("https://github.com/g", {
      signal: sig(),
      maxBytes: 100,
      dest,
    });
    expect(await readFile(dest, "utf8")).toBe("hello");
  });

  it("too large mid-stream → the partial file is removed", async () => {
    const body = chunkedBody(100, 64 * 1024);
    const f = fakeFetch(() => new Response(body.stream));
    const dest = join(dir, "big.bin");
    const e = await failure(
      createHttpClient({ fetch: f.fetch }).download("https://github.com/b", {
        signal: sig(),
        maxBytes: 200 * 1024,
        dest,
      }),
    );
    expect(e.kind).toBe("too_large");
    expect(await readdir(dir)).toEqual([]);
  });

  it("a refused host creates no file; an existing dest is never overwritten", async () => {
    const f = fakeFetch(() => ok("x"));
    const c = createHttpClient({ fetch: f.fetch });
    await expect(
      c.download("https://evil.example/", { signal: sig(), maxBytes: 9, dest: join(dir, "a") }),
    ).rejects.toThrow(HttpError);
    expect(await readdir(dir)).toEqual([]);
    const existing = join(dir, "keep");
    await writeFile(existing, "original");
    await expect(
      c.download("https://github.com/", { signal: sig(), maxBytes: 9, dest: existing }),
    ).rejects.toThrow(/EEXIST/);
    expect(await readFile(existing, "utf8")).toBe("original");
    expect(f.calls).toHaveLength(0);
  });

  it("a relative dest is refused", async () => {
    const c = createHttpClient({ fetch: fakeFetch(() => ok("x")).fetch });
    await expect(
      c.download("https://github.com/", { signal: sig(), maxBytes: 9, dest: "rel/path" }),
    ).rejects.toThrow(RangeError);
  });

  it("an upstream 404 leaves no file behind", async () => {
    const f = fakeFetch(() => new Response("nope", { status: 404 }));
    const dest = join(dir, "missing.parquet");
    const e = await failure(
      createHttpClient({ fetch: f.fetch }).download("https://github.com/m", {
        signal: sig(),
        maxBytes: 9,
        dest,
      }),
    );
    expect(e.kind).toBe("http_4xx");
    expect(await readdir(dir)).toEqual([]);
  });
});
