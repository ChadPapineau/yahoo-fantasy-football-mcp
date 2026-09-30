// helpers.ts — an in-process fake `fetch` for src/http tests: no sockets, no network. Every call is
// recorded (url + init) so tests can assert header hygiene and exactly which hops were requested.
import type { FetchLike } from "../../src/http/client.js";

export interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit;
  readonly headers: Readonly<Record<string, string>>;
}

export type Handler = (url: string, init: RequestInit, n: number) => Response | Promise<Response>;

/** A fake fetch that answers with `handler` and records every call. */
export function fakeFetch(handler: Handler): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = (url, init) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    calls.push({ url, init, headers });
    try {
      return Promise.resolve(handler(url, init, calls.length));
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error("handler threw"));
    }
  };
  return { fetch, calls };
}

/** A fetch that never answers until its signal aborts (then rejects like undici: AbortError). */
export function hangingFetch(): { fetch: FetchLike; calls: number } {
  const state = { calls: 0 };
  const fetch: FetchLike = (_url, init) => {
    state.calls++;
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        reject(new DOMException("This operation was aborted", "AbortError"));
      });
    });
  };
  return {
    fetch,
    get calls() {
      return state.calls;
    },
  };
}

/** A 30x response pointing at `location`. */
export function redirect(location: string | null, status = 302): Response {
  return new Response(null, {
    status,
    headers: location === null ? {} : { location },
  });
}

/** A 200 with a text/bytes body. */
export function ok(body: string | Uint8Array, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers });
}

/** A body stream that yields `n` chunks of `size` bytes, counting how many were pulled. */
export function chunkedBody(
  n: number,
  size: number,
): { stream: ReadableStream<Uint8Array>; pulled: () => number } {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (pulled >= n) {
        c.close();
        return;
      }
      pulled++;
      c.enqueue(new Uint8Array(size).fill(65));
    },
  });
  return { stream, pulled: () => pulled };
}

/** A system-style network error as undici reports it: TypeError("fetch failed") → cause.code. */
export function netError(code: string): TypeError {
  const cause = Object.assign(new Error(`connect ${code}`), { code });
  return new TypeError("fetch failed", { cause });
}

/** A capturing logger. */
export function captureLog(): {
  log: {
    debug: (e: string, f?: Readonly<Record<string, unknown>>) => void;
    warn: (e: string, f?: Readonly<Record<string, unknown>>) => void;
    info: (e: string, f?: Readonly<Record<string, unknown>>) => void;
  };
  lines: { level: string; event: string; fields: Readonly<Record<string, unknown>> }[];
} {
  const lines: { level: string; event: string; fields: Readonly<Record<string, unknown>> }[] = [];
  const mk =
    (level: string) =>
    (event: string, fields: Readonly<Record<string, unknown>> = {}) => {
      lines.push({ level, event, fields });
    };
  return { log: { debug: mk("debug"), warn: mk("warn"), info: mk("info") }, lines };
}
