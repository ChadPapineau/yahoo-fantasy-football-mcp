// allowlist.ts — the host allow-list every outbound request (and every redirect hop) is checked
// against BEFORE it is made (plan 02 §7 "Host allow-list"; §8 threat 18 "data exfiltration to
// undeclared hosts"; plan 05 §2 `http/client` "rejected before DNS"). Phase 1a hosts only: Yahoo
// (1b) and Sleeper/RSS/odds (2+) join when their phase lands. `release-assets.githubusercontent.com`
// is a recorded plan deviation (GitHub release downloads 302 there, verified 2026-09-30).
import { HttpError } from "./errors.js";

/** The Phase-1a allow-list: nflverse releases on GitHub, Open-Meteo, NWS. */
export const ALLOWED_HOSTS: readonly string[] = Object.freeze([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "raw.githubusercontent.com",
  "api.open-meteo.com",
  "api.weather.gov",
]);

/**
 * Validates `raw` for a request: parses it, requires `https:` on the default port, refuses
 * embedded credentials, and requires the host to be EXACTLY one of `allow` (no suffix matching,
 * no IP literals, no trailing-dot variants). Returns the parsed URL; throws HttpError otherwise.
 */
export function checkUrl(raw: string, allow: readonly string[]): URL {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096)
    throw new HttpError({ kind: "invalid_url" });
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError({ kind: "invalid_url" });
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || (u.port !== "" && u.port !== "443"))
    throw new HttpError({ kind: "scheme_refused", host });
  if (u.username !== "" || u.password !== "")
    throw new HttpError({ kind: "credentials_refused", host });
  if (!allow.includes(host)) throw new HttpError({ kind: "host_not_allowed", host });
  return u;
}

/**
 * Validates a caller-supplied allow-list: it may only NARROW `ALLOWED_HOSTS` (a per-source client
 * never widens the policy). Returns a frozen, lower-cased copy; throws on an unknown host.
 */
export function narrowAllowList(hosts: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const h of hosts) {
    const lc = h.toLowerCase();
    if (!ALLOWED_HOSTS.includes(lc))
      throw new RangeError("http: an allow-list may only narrow ALLOWED_HOSTS");
    if (!out.includes(lc)) out.push(lc);
  }
  return Object.freeze(out);
}

/** A URL for logs: origin + path, never the query string or fragment (plan 01 §7). */
export function redactUrl(u: URL): string {
  return `${u.protocol}//${u.host}${u.pathname}`;
}
