import { formatInTimeZone } from "date-fns-tz";

export const DEFAULT_TIMEZONE = "America/New_York";

const LABEL_OVERRIDES: Record<string, string> = {
  "America/New_York": "Eastern",
  "America/Chicago": "Central",
  "America/Denver": "Mountain",
  "America/Los_Angeles": "Pacific",
  "America/Toronto": "Eastern",
  "Europe/London": "London",
  UTC: "UTC",
};

/** e.g. "UTC-4 Eastern (EDT)" */
export function formatTimezoneLabel(
  timeZone: string,
  at: Date = new Date(),
): string {
  const offset = formatInTimeZone(at, timeZone, "xxx"); // -04:00
  const abbr = formatInTimeZone(at, timeZone, "zzz");
  const name = LABEL_OVERRIDES[timeZone] ?? timeZone.split("/").pop() ?? timeZone;
  const utcOffset = `UTC${offset.replace(":00", "").replace("-0", "-").replace("+0", "+")}`;
  return `${utcOffset} ${name} (${abbr})`;
}

export function countryFlag(countryCode: string): string {
  const code = countryCode.toUpperCase();
  if (code.length !== 2) return "🏳️";
  const A = 0x1f1e6;
  return String.fromCodePoint(
    A + code.charCodeAt(0) - 65,
    A + code.charCodeAt(1) - 65,
  );
}
