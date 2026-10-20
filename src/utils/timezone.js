/**
 * Timezone helpers built on Intl — the project has no date library, and
 * pulling one in for two functions is not worth the dependency.
 *
 * "End of day" has to be the client's day, not the server's. The server runs
 * in UTC while the businesses are in Asia/Kolkata, so a post due at 17:30 IST
 * sits at 12:00 UTC: using the server's midnight would cut the retry window
 * 5.5 hours early and skip posts that still had most of their evening left.
 */

/**
 * How far `tz` is from UTC at the given instant, in milliseconds.
 * Derived from the instant itself, so DST is handled wherever it applies.
 */
const tzOffsetMs = (date, tz) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(date)
    .reduce((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});

  // Intl can render midnight as hour "24" — Date.UTC would roll that into the
  // next day and shift the offset by exactly one day.
  const hour = Number(parts.hour) % 24;
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second)
  );
  return asIfUtc - date.getTime();
};

/**
 * The instant at which the calendar day containing `at` ends in `tz`
 * (i.e. the following midnight, local to that zone).
 *
 * @param {Date} at
 * @param {string} tz  IANA zone; falls back to UTC if the zone is unknown
 * @returns {Date}
 */
const endOfDayInTz = (at, tz = "UTC") => {
  let offset;
  try {
    offset = tzOffsetMs(at, tz);
  } catch {
    offset = 0; // unknown zone — treat as UTC rather than throwing
  }

  const wall = new Date(at.getTime() + offset);
  const nextMidnightWall = Date.UTC(
    wall.getUTCFullYear(),
    wall.getUTCMonth(),
    wall.getUTCDate() + 1,
    0,
    0,
    0,
    0
  );

  let instant = new Date(nextMidnightWall - offset);
  // The offset can differ on the far side of a DST boundary; re-derive once.
  try {
    const corrected = tzOffsetMs(instant, tz);
    if (corrected !== offset) instant = new Date(nextMidnightWall - corrected);
  } catch {
    /* keep the first estimate */
  }
  return instant;
};

/** Whether `a` and `b` fall on the same calendar day in `tz`. */
const isSameDayInTz = (a, b, tz = "UTC") =>
  endOfDayInTz(a, tz).getTime() === endOfDayInTz(b, tz).getTime();

module.exports = { tzOffsetMs, endOfDayInTz, isSameDayInTz };
