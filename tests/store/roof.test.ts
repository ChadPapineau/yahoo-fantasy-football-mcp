// roof.test.ts — the games reader's roof rule (store/readers.ts gameRoof): for a season the venue
// table is verified through, the venue's physical roof decides for open-air and fixed-roof venues
// and a retractable venue's game row carries its own state; for a later season the game row's roof
// wins whenever it is known (the table may be out of date). The same rule as the weather sources'
// needsWeather (src/sources/weather/common.ts), for every venue, game roof and season.
import { describe, expect, it } from "vitest";
import { REFERENCE_VINTAGES } from "../../src/config/reference-vintage.js";
import { gameRoof } from "../../src/store/readers.js";
import { needsWeather } from "../../src/sources/weather/common.js";
import { VENUES } from "../../src/sources/venues.js";

/** The last season the venue table is verified for, and a spread of seasons on both sides. */
const V = REFERENCE_VINTAGES.venues.verified_through_season;
const VERIFIED = [V - 3, V - 1, V];
const PAST = [V + 1, V + 2, V + 4];

describe("gameRoof, seasons the venue table is verified for", () => {
  for (const s of VERIFIED) {
    it(`${String(s)}: an open-air venue is outdoors even when nflverse says dome (MCG, Stade de France, Allianz)`, () => {
      expect(gameRoof("dome", "outdoors", s)).toBe("outdoors");
      expect(gameRoof(null, "outdoors", s)).toBe("outdoors");
    });
    it(`${String(s)}: a fixed dome stays a dome whatever the game row says`, () => {
      expect(gameRoof("outdoors", "dome", s)).toBe("dome");
      expect(gameRoof("open", "dome", s)).toBe("dome");
    });
    it(`${String(s)}: a retractable venue: the game row's state wins, else the venue default (closed)`, () => {
      expect(gameRoof("open", "closed", s)).toBe("open");
      expect(gameRoof("outdoors", "closed", s)).toBe("outdoors");
      expect(gameRoof(null, "closed", s)).toBe("closed");
    });
    it(`${String(s)}: an unknown venue keeps the game row's value`, () => {
      expect(gameRoof("dome", null, s)).toBe("dome");
      expect(gameRoof(null, null, s)).toBeNull();
    });
  }
});

describe("gameRoof, seasons past the venue table's vintage: a known game roof wins", () => {
  for (const s of PAST) {
    it(String(s), () => {
      // a renovated open-air stadium (the table still says outdoors) now reported as a dome
      expect(gameRoof("dome", "outdoors", s)).toBe("dome");
      expect(gameRoof("outdoors", "dome", s)).toBe("outdoors");
      expect(gameRoof("open", "closed", s)).toBe("open");
      // unknown game roof: the table is still the best guess
      expect(gameRoof(null, "outdoors", s)).toBe("outdoors");
      expect(gameRoof(null, "dome", s)).toBe("dome");
      expect(gameRoof(null, null, s)).toBeNull();
    });
  }
});

describe("the reader and the weather sources agree: indoor ⇔ no forecast", () => {
  it("for every venue, game roof and season on both sides of the vintage", () => {
    for (const season of [...VERIFIED, ...PAST]) {
      for (const v of VENUES) {
        for (const g of [null, "dome", "closed", "open", "outdoors"]) {
          const roof = gameRoof(g, v.roof_default, season);
          const indoor = roof === "dome" || roof === "closed";
          expect(
            needsWeather({ roof: g, season }, v),
            `${String(season)} ${v.stadium_id} ${String(g)}`,
          ).toBe(!indoor);
        }
      }
    }
  });
});
