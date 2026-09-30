// roof.test.ts — the games reader's roof rule (store/readers.ts gameRoof): the venue's physical roof
// decides for open-air and fixed-roof venues, a retractable venue's game row carries its own state
// (the same rule as the weather sources' needsWeather, src/sources/weather/common.ts).
import { describe, expect, it } from "vitest";
import { gameRoof } from "../../src/store/readers.js";
import { needsWeather } from "../../src/sources/weather/common.js";
import { VENUES } from "../../src/sources/venues.js";

describe("gameRoof", () => {
  it("an open-air venue is outdoors even when nflverse says dome (MCG, Stade de France, Allianz)", () => {
    expect(gameRoof("dome", "outdoors")).toBe("outdoors");
    expect(gameRoof(null, "outdoors")).toBe("outdoors");
  });
  it("a fixed dome stays a dome whatever the game row says", () => {
    expect(gameRoof("outdoors", "dome")).toBe("dome");
    expect(gameRoof("open", "dome")).toBe("dome");
  });
  it("a retractable venue: the game row's state wins, else the venue default (closed)", () => {
    expect(gameRoof("open", "closed")).toBe("open");
    expect(gameRoof("outdoors", "closed")).toBe("outdoors");
    expect(gameRoof(null, "closed")).toBe("closed");
  });
  it("an unknown venue keeps the game row's value", () => {
    expect(gameRoof("dome", null)).toBe("dome");
    expect(gameRoof(null, null)).toBeNull();
  });
  it("agrees with the weather sources: indoor ⇔ no forecast, for every venue and game roof", () => {
    for (const v of VENUES) {
      for (const g of [null, "dome", "closed", "open", "outdoors"]) {
        const roof = gameRoof(g, v.roof_default);
        const indoor = roof === "dome" || roof === "closed";
        expect(needsWeather({ roof: g }, v), `${v.stadium_id} ${String(g)}`).toBe(!indoor);
      }
    }
  });
});
