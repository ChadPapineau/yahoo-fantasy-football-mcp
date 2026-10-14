// zones.ts — one IANA zone per distinct real UTC offset (season-fresh spec §12 B1 helpers), for the
// zone-invariance properties: every function built on epoch-ms windows must return the same result
// whatever the process's local zone is. `withTz` sets and restores `process.env.TZ` (Node re-reads
// it on assignment).

/** One zone per distinct UTC offset in use, UTC−12 to UTC+14 (half and three-quarter hours too). */
export const ALL_UTC_OFFSET_ZONES = [
  "Etc/GMT+12",
  "Pacific/Pago_Pago",
  "Pacific/Honolulu",
  "Pacific/Marquesas",
  "America/Anchorage",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Caracas",
  "America/St_Johns",
  "America/Sao_Paulo",
  "America/Noronha",
  "Atlantic/Azores",
  "UTC",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Athens",
  "Asia/Tehran",
  "Asia/Dubai",
  "Asia/Kabul",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Kathmandu",
  "Asia/Dhaka",
  "Asia/Yangon",
  "Asia/Bangkok",
  "Asia/Shanghai",
  "Australia/Eucla",
  "Asia/Tokyo",
  "Australia/Adelaide",
  "Australia/Sydney",
  "Australia/Lord_Howe",
  "Pacific/Noumea",
  "Pacific/Auckland",
  "Pacific/Chatham",
  "Pacific/Tongatapu",
  "Pacific/Kiritimati",
] as const;

/** One of the zones. */
export type OffsetZone = (typeof ALL_UTC_OFFSET_ZONES)[number];

/** Runs `fn` with `process.env.TZ = tz`, restoring the previous value (or its absence) after. */
export function withTz<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

/** Runs `fn` once per zone and returns the results keyed by zone. */
export function inEveryZone<T>(fn: (tz: OffsetZone) => T): Map<OffsetZone, T> {
  const out = new Map<OffsetZone, T>();
  for (const tz of ALL_UTC_OFFSET_ZONES)
    out.set(
      tz,
      withTz(tz, () => fn(tz)),
    );
  return out;
}
