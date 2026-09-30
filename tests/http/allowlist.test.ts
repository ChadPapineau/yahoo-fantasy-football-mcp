// allowlist.test.ts — the Phase-1a host allow-list (plan 02 §7; brief: incl. api.open-meteo.com,
// api.weather.gov, github.com, objects/release-assets/raw.githubusercontent.com — NOT Yahoo, NOT
// Sleeper yet) and query-free URL redaction for logs (plan 01 §7).
import { describe, expect, it } from "vitest";
import { ALLOWED_HOSTS, checkUrl, narrowAllowList, redactUrl } from "../../src/http/allowlist.js";

describe("ALLOWED_HOSTS", () => {
  it("is exactly the Phase-1a set, frozen", () => {
    expect([...ALLOWED_HOSTS].sort()).toEqual(
      [
        "api.open-meteo.com",
        "api.weather.gov",
        "github.com",
        "objects.githubusercontent.com",
        "raw.githubusercontent.com",
        "release-assets.githubusercontent.com",
      ].sort(),
    );
    expect(Object.isFrozen(ALLOWED_HOSTS)).toBe(true);
    for (const h of ALLOWED_HOSTS) expect(h).not.toMatch(/yahoo|sleeper/);
  });
  it("narrowAllowList dedupes and lower-cases; never widens", () => {
    expect(narrowAllowList(["GitHub.com", "github.com"])).toEqual(["github.com"]);
    expect(() => narrowAllowList(["api.sleeper.app"])).toThrow(RangeError);
  });
  it("checkUrl returns the parsed URL for an allowed https URL", () => {
    expect(checkUrl("https://api.weather.gov/points/1,2", ALLOWED_HOSTS).hostname).toBe(
      "api.weather.gov",
    );
    expect(() => checkUrl(42 as unknown as string, ALLOWED_HOSTS)).toThrow();
  });
  it("redactUrl drops query, fragment and credentials", () => {
    expect(redactUrl(new URL("https://u:p@github.com/a/b?token=x#frag"))).toBe(
      "https://github.com/a/b",
    );
  });
});
