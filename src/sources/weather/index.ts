// index.ts — the weather DataSource chosen by FF_WEATHER_SOURCE (plan 01 §5.2 weather row; plan 06
// §1.2 `refresh weather` "Open-Meteo or NWS per FF_WEATHER_SOURCE"; config/schema.ts WEATHER_SOURCES).
import type { WeatherSource } from "../../config/schema.js";
import type { DataSource } from "../source.js";
import type { WeatherSourceOptions } from "./common.js";
import { createNwsSource } from "./nws.js";
import { createOpenMeteoSource } from "./open-meteo.js";

export { createNwsSource, NWS_PROVIDER } from "./nws.js";
export { createOpenMeteoSource, OPEN_METEO_PROVIDER } from "./open-meteo.js";
export type { WeatherSourceOptions } from "./common.js";

/** The source for a FF_WEATHER_SOURCE setting; null for `off` (the driver is then named as omitted). */
export function weatherSourceFor(
  setting: WeatherSource,
  opts: WeatherSourceOptions = {},
): DataSource | null {
  switch (setting) {
    case "open-meteo":
      return createOpenMeteoSource(opts);
    case "nws":
      return createNwsSource(opts);
    case "off":
      return null;
  }
}
