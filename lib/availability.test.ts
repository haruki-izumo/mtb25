import { describe, expect, it } from "vitest";
import {
  formatAvailabilityText,
  getBookableSlots,
  getOpenIntervalsForDay,
  localMinutesToUtc,
  rangesOverlap,
  zonedDateKey,
  zonedWeekday,
} from "./availability";

describe("localMinutesToUtc / zoned helpers", () => {
  it("converts America/New_York winter time (EST, UTC-5)", () => {
    // 2024-01-15 10:00 EST = 15:00 UTC
    const utc = localMinutesToUtc("2024-01-15", 10 * 60, "America/New_York");
    expect(utc.toISOString()).toBe("2024-01-15T15:00:00.000Z");
  });

  it("converts America/New_York summer time (EDT, UTC-4)", () => {
    // 2024-07-15 10:00 EDT = 14:00 UTC
    const utc = localMinutesToUtc("2024-07-15", 10 * 60, "America/New_York");
    expect(utc.toISOString()).toBe("2024-07-15T14:00:00.000Z");
  });

  it("handles DST spring-forward boundary (missing 2am hour)", () => {
    // 2024-03-10 clocks jump 2:00 → 3:00 EDT
    const before = localMinutesToUtc("2024-03-10", 1 * 60, "America/New_York");
    const after = localMinutesToUtc("2024-03-10", 3 * 60, "America/New_York");
    expect(before.toISOString()).toBe("2024-03-10T06:00:00.000Z"); // EST
    expect(after.toISOString()).toBe("2024-03-10T07:00:00.000Z"); // EDT
    expect(after.getTime() - before.getTime()).toBe(60 * 60 * 1000);
  });

  it("handles DST fall-back boundary", () => {
    // 2024-11-03 clocks fall 2:00 → 1:00 EST
    const oneAm = localMinutesToUtc("2024-11-03", 1 * 60, "America/New_York");
    // Ambiguous 1:00 — fromZonedTime picks the first (EDT) occurrence
    expect(oneAm.toISOString()).toBe("2024-11-03T05:00:00.000Z");
    const threeAm = localMinutesToUtc("2024-11-03", 3 * 60, "America/New_York");
    expect(threeAm.toISOString()).toBe("2024-11-03T08:00:00.000Z");
  });
});

describe("cross-midnight / weekday in timezone", () => {
  it("UTC Monday early morning is still Sunday evening in US/Pacific", () => {
    const utcMonday = new Date("2024-06-10T05:00:00.000Z"); // 10pm Sun PDT
    expect(zonedDateKey(utcMonday, "America/Los_Angeles")).toBe("2024-06-09");
    expect(zonedWeekday(utcMonday, "America/Los_Angeles")).toBe(0); // Sunday
    expect(zonedWeekday(utcMonday, "UTC")).toBe(1); // Monday
  });

  it("builds open intervals that stay on the correct local day across UTC midnight", () => {
    // Monday 9pm–11pm Tokyo = Monday 12:00–14:00 UTC
    const open = getOpenIntervalsForDay({
      dateKey: "2024-06-10", // Monday
      timeZone: "Asia/Tokyo",
      rules: [{ weekday: 1, startMinute: 21 * 60, endMinute: 23 * 60 }],
      overrides: [],
      busy: [],
    });
    expect(open).toHaveLength(1);
    expect(open[0].startAt.toISOString()).toBe("2024-06-10T12:00:00.000Z");
    expect(open[0].endAt.toISOString()).toBe("2024-06-10T14:00:00.000Z");
  });
});

describe("getOpenIntervalsForDay", () => {
  const rules = [
    { weekday: 1, startMinute: 9 * 60, endMinute: 12 * 60 },
    { weekday: 1, startMinute: 13 * 60, endMinute: 17 * 60 },
  ];

  it("returns recurring rule windows in UTC", () => {
    const open = getOpenIntervalsForDay({
      dateKey: "2024-01-15", // Monday
      timeZone: "America/New_York",
      rules,
      overrides: [],
      busy: [],
    });
    expect(open).toHaveLength(2);
    expect(open[0].startAt.toISOString()).toBe("2024-01-15T14:00:00.000Z");
    expect(open[0].endAt.toISOString()).toBe("2024-01-15T17:00:00.000Z");
  });

  it("subtracts BLOCK override from open windows", () => {
    const open = getOpenIntervalsForDay({
      dateKey: "2024-01-15",
      timeZone: "America/New_York",
      rules,
      overrides: [
        {
          date: "2024-01-15",
          type: "BLOCK",
          startMinute: 10 * 60,
          endMinute: 11 * 60,
        },
      ],
      busy: [],
    });
    expect(open).toHaveLength(3);
    expect(open[0].endAt.toISOString()).toBe("2024-01-15T15:00:00.000Z");
    expect(open[1].startAt.toISOString()).toBe("2024-01-15T16:00:00.000Z");
  });

  it("full-day BLOCK clears all availability", () => {
    const open = getOpenIntervalsForDay({
      dateKey: "2024-01-15",
      timeZone: "America/New_York",
      rules,
      overrides: [
        { date: "2024-01-15", type: "BLOCK", startMinute: null, endMinute: null },
      ],
      busy: [],
    });
    expect(open).toHaveLength(0);
  });

  it("OPEN override adds a window on a closed day", () => {
    const open = getOpenIntervalsForDay({
      dateKey: "2024-01-14", // Sunday — no rules
      timeZone: "America/New_York",
      rules,
      overrides: [
        {
          date: "2024-01-14",
          type: "OPEN",
          startMinute: 10 * 60,
          endMinute: 14 * 60,
        },
      ],
      busy: [],
    });
    expect(open).toHaveLength(1);
    expect(open[0].startAt.toISOString()).toBe("2024-01-14T15:00:00.000Z");
    expect(open[0].endAt.toISOString()).toBe("2024-01-14T19:00:00.000Z");
  });

  it("subtracts busy (booked) rounds", () => {
    const open = getOpenIntervalsForDay({
      dateKey: "2024-01-15",
      timeZone: "America/New_York",
      rules: [{ weekday: 1, startMinute: 9 * 60, endMinute: 12 * 60 }],
      overrides: [],
      busy: [
        {
          startAt: new Date("2024-01-15T15:00:00.000Z"), // 10:00 EST
          endAt: new Date("2024-01-15T16:00:00.000Z"),
        },
      ],
    });
    expect(open).toHaveLength(2);
    expect(open[0].endAt.toISOString()).toBe("2024-01-15T15:00:00.000Z");
    expect(open[1].startAt.toISOString()).toBe("2024-01-15T16:00:00.000Z");
  });
});

describe("getBookableSlots", () => {
  it("steps by 15 minutes for a 60-minute duration", () => {
    const slots = getBookableSlots(
      [
        {
          startAt: new Date("2024-01-15T14:00:00.000Z"),
          endAt: new Date("2024-01-15T16:00:00.000Z"),
        },
      ],
      60,
    );
    expect(slots.map((s) => s.toISOString())).toEqual([
      "2024-01-15T14:00:00.000Z",
      "2024-01-15T14:15:00.000Z",
      "2024-01-15T14:30:00.000Z",
      "2024-01-15T14:45:00.000Z",
      "2024-01-15T15:00:00.000Z",
    ]);
  });
});

describe("rangesOverlap", () => {
  it("detects overlap with the booking conflict formula", () => {
    expect(
      rangesOverlap(
        new Date("2024-01-15T14:00:00Z"),
        new Date("2024-01-15T15:00:00Z"),
        new Date("2024-01-15T14:30:00Z"),
        new Date("2024-01-15T15:30:00Z"),
      ),
    ).toBe(true);
    expect(
      rangesOverlap(
        new Date("2024-01-15T14:00:00Z"),
        new Date("2024-01-15T15:00:00Z"),
        new Date("2024-01-15T15:00:00Z"),
        new Date("2024-01-15T16:00:00Z"),
      ),
    ).toBe(false);
  });
});

describe("formatAvailabilityText", () => {
  it("formats a readable weekly summary", () => {
    const text = formatAvailabilityText({
      fromDateKey: "2024-09-23", // Monday
      days: 2,
      timeZone: "America/New_York",
      timeZoneLabel: "EST",
      rules: [{ weekday: 1, startMinute: 10 * 60, endMinute: 15 * 60 }],
      overrides: [],
      busy: [],
    });
    expect(text).toContain("Mon Sep 23: 10:00am–3:00pm EST");
    expect(text).toContain("Tue Sep 24: unavailable");
  });
});
