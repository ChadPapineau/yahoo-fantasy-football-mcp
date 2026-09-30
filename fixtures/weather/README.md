# fixtures/weather — authored weather responses

Hand-authored (generated once, deterministically) from the **documented response shapes** of the
two Phase-1a weather providers; the numbers are synthetic, not a real forecast. Used by
`tests/sources/weather/**` (fixture response → published `ds_weather_*` rows) through an injected
`fetch`, so no test touches the network.

| File | Shape | Notes |
|---|---|---|
| `open-meteo-forecast.json` | `GET api.open-meteo.com/v1/forecast` (`hourly`, °F, mph, `timezone=GMT`) | 192 hours from 2026-10-01T00:00Z; pinned values at 2026-10-04T17:00Z (index 89) and 2026-10-05T00:00Z (index 96) |
| `open-meteo-no-gusts.json` | same | `wind_gusts_10m` absent and one `precipitation_probability` null — the "missing fields tolerated" case |
| `nws-points.json` | `GET api.weather.gov/points/{lat},{lon}` (GeoJSON) | `properties.forecastHourly` → `gridpoints/CLE/83,65/forecast/hourly` |
| `nws-forecast-hourly.json` | `GET …/forecast/hourly` (GeoJSON, `units=us`) | 156 one-hour periods from 2026-10-01T12:00Z; `updateTime` 2026-10-01T10:43:12Z; pinned periods at 2026-10-04T17:00Z ("10 to 15 mph") and 2026-10-05T00:00Z (null precipitation) |

Licensing of the real services these imitate (research 04 §B7/§B8): Open-Meteo data is CC BY 4.0
and its free API is for non-commercial use only; NWS data is US-government public domain.
