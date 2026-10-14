// roof.test.ts — the games reader's roof rule (store/readers.ts gameRoof, over
// src/domain/league/roof.ts): a venue whose roof cannot change under its id — an open-air venue
// abroad, a fixed dome — keeps its physical roof in EVERY season (nflverse codes the open-air MCG,
// Stade de France and Allianz Arena as `dome`; past the venue table's vintage they were once served
// as indoor games: no forecast, no weather multiplier); for a season the table is verified through, a
// US open-air venue's physical roof decides too and a retractable venue's game row carries its own
// state; past the vintage a known game roof wins for a venue that may have changed (a US team
// stadium rebuilt with a roof) or that the table does not know. The same rule as the weather
// sources' needsWeather (src/sources/weather/common.ts), for every venue, game roof and season.
import { describe, expect, it } from "vitest";
import { REFERENCE_VINTAGES } from "../../src/config/reference-vintage.js";
import { isRoofFixed } from "../../src/domain/league/roof.js";
import { gameRoof } from "../../src/store/readers.js";
import { needsWeather, selectGames } from "../../src/sources/weather/common.js";
import { VENUES, venueById } from "../../src/sources/venues.js";
import { venueWarnings } from "../../src/sources/nflverse/schedules.js";

/** The last season the venue table is verified for, and a spread of seasons on both sides. */
const V = REFERENCE_VINTAGES.venues.verified_through_season;
const VERIFIED = [V - 3, V - 1, V];
const PAST = [V + 1, V + 2, V + 4];

const venue = (id: string) => {
  const x = venueById(id);
  if (x === null) throw new Error(id);
  return x;
};
/** A table entry with the given facts (an unlisted stadium otherwise like the named kind). */
const facts = (roof_default: string, country = "US", retractable = false) => ({
  roof_default,
  country,
  retractable,
});

describe("which venues keep their physical roof in every season", () => {
  it("open-air venues abroad and fixed domes; never a retractable venue or a US open-air one", () => {
    for (const id of ["MEL00", "PAR00", "GER00", "MUN01", "LON00", "LON02", "SAO00", "MEX00"])
      expect(isRoofFixed(venue(id)), id).toBe(true);
    for (const id of ["DET00", "LAX01", "MIN01", "NOR00", "VEG00"])
      expect(isRoofFixed(venue(id)), id).toBe(true);
    for (const id of ["NAS00", "CHI98", "CLE00", "BUF00", "ATL97", "MAD01", "HOU00"])
      expect(isRoofFixed(venue(id)), id).toBe(false);
    for (const x of VENUES) expect(x.roof_fixed, x.stadium_id).toBe(isRoofFixed(x));
  });
});

describe("gameRoof, seasons the venue table is verified for", () => {
  for (const s of VERIFIED) {
    it(`${String(s)}: an open-air venue is outdoors even when nflverse says dome`, () => {
      for (const id of ["MEL00", "PAR00", "GER00", "NAS00"]) {
        expect(gameRoof("dome", venue(id), s), id).toBe("outdoors");
        expect(gameRoof(null, venue(id), s), id).toBe("outdoors");
      }
    });
    it(`${String(s)}: a fixed dome stays a dome whatever the game row says`, () => {
      expect(gameRoof("outdoors", venue("DET00"), s)).toBe("dome");
      expect(gameRoof("open", venue("DET00"), s)).toBe("dome");
    });
    it(`${String(s)}: a retractable venue: the game row's state wins, else the venue default (closed)`, () => {
      expect(gameRoof("open", venue("ATL97"), s)).toBe("open");
      expect(gameRoof("outdoors", venue("ATL97"), s)).toBe("outdoors");
      expect(gameRoof(null, venue("ATL97"), s)).toBe("closed");
    });
    it(`${String(s)}: an unknown venue keeps the game row's value`, () => {
      expect(gameRoof("dome", null, s)).toBe("dome");
      expect(gameRoof(null, null, s)).toBeNull();
    });
  }
});

describe("gameRoof, seasons past the venue table's vintage", () => {
  for (const s of PAST) {
    it(`${String(s)}: the MCG, Stade de France and Allianz Arena stay open-air (nflverse's 'dome' is its mislabel)`, () => {
      for (const id of ["MEL00", "PAR00", "GER00", "MUN01"]) {
        expect(gameRoof("dome", venue(id), s), id).toBe("outdoors");
        expect(needsWeather({ roof: "dome", season: s }, venue(id)), id).toBe(true);
      }
      expect(gameRoof("outdoors", venue("DET00"), s)).toBe("dome");
    });
    it(`${String(s)}: a venue that may have changed (a US team stadium) or is unknown: a known game roof wins`, () => {
      // a US open-air stadium rebuilt with a roof under its id, now reported as a dome
      expect(gameRoof("dome", venue("NAS00"), s)).toBe("dome");
      expect(gameRoof("dome", facts("outdoors"), s)).toBe("dome");
      expect(gameRoof("open", venue("ATL97"), s)).toBe("open");
      // unknown game roof: the table is still the best guess
      expect(gameRoof(null, venue("NAS00"), s)).toBe("outdoors");
      expect(gameRoof(null, venue("DET00"), s)).toBe("dome");
      expect(gameRoof("dome", null, s)).toBe("dome");
      expect(gameRoof(null, null, s)).toBeNull();
    });
  }
});

describe("the reader and the weather sources agree: indoor ⇔ no forecast", () => {
  it("for every venue, game roof and season on both sides of the vintage", () => {
    for (const season of [...VERIFIED, ...PAST]) {
      for (const v of VENUES) {
        for (const g of [null, "", "dome", "closed", "open", "outdoors", " Dome "]) {
          const roof = gameRoof(g, v, season);
          const indoor = roof === "dome" || roof === "closed";
          expect(
            needsWeather({ roof: g, season }, v),
            `${String(season)} ${v.stadium_id} ${String(g)}`,
          ).toBe(!indoor);
        }
      }
    }
  });

  it("an international game past the vintage is forecast, and the publish still warns about the label", () => {
    const s = V + 1;
    expect(
      venueWarnings([
        {
          season: s,
          venue_id: "MEL00",
          roof: "dome",
          location: "Neutral",
          home_team: "PHI",
          game_type: "REG",
        },
      ]),
    ).toEqual([
      `ds_games: 1 game(s) whose roof disagrees with the venue table (season ${String(s)})`,
    ]);
    const kickoff = Date.parse(`${String(s)}-09-12T10:00:00.000Z`);
    const picked = selectGames(
      { clock: { nowMs: () => kickoff - 3_600_000 }, seasons: [s], week: null } as never,
      { usOnly: false, horizonHours: 168 },
      {
        games: () => [
          {
            game_id: `${String(s)}_01_PHI_LAR`,
            season: s,
            week: 1,
            kickoff: new Date(kickoff).toISOString(),
            away: "PHI",
            home: "LA",
            stadium_id: "MEL00",
            stadium: "Melbourne Cricket Ground",
            venue_tz: "Australia/Melbourne",
            roof: "dome",
            surface: null,
            divisional: false,
            rest_days: { away: null, home: null },
            lines: null,
            is_final: false,
            score: null,
          },
        ],
      },
    );
    expect(picked.games.map((g) => g.game_id)).toEqual([`${String(s)}_01_PHI_LAR`]);
  });
});
