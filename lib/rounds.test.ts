import { describe, expect, it } from "vitest";
import { roundHasRatingAndFeedback, roundNeedsUpdate } from "./rounds";

const past = new Date("2026-11-01T15:00:00.000Z");
const now = new Date("2026-11-26T15:00:00.000Z");

describe("roundNeedsUpdate", () => {
  it("keeps a past pending meeting in needs update until both rating and feedback exist", () => {
    expect(
      roundNeedsUpdate(
        { endAt: past, outcome: "PENDING", rating: 4, feedback: null },
        now,
      ),
    ).toBe(true);
    expect(
      roundNeedsUpdate(
        { endAt: past, outcome: "PENDING", rating: null, feedback: "Clear answers." },
        now,
      ),
    ).toBe(true);
  });

  it("drops a meeting from needs update once it has a rating and feedback", () => {
    expect(
      roundNeedsUpdate(
        {
          endAt: past,
          outcome: "PENDING",
          rating: 5,
          feedback: "Strong system design.",
        },
        now,
      ),
    ).toBe(false);
    expect(
      roundHasRatingAndFeedback({ rating: 5, feedback: "  Strong system design.  " }),
    ).toBe(true);
  });

  it("ignores upcoming and already recorded meetings", () => {
    expect(
      roundNeedsUpdate(
        {
          endAt: new Date("2026-12-01T15:00:00.000Z"),
          outcome: "PENDING",
          rating: null,
          feedback: null,
        },
        now,
      ),
    ).toBe(false);
    expect(
      roundNeedsUpdate(
        { endAt: past, outcome: "PASSED", rating: null, feedback: null },
        now,
      ),
    ).toBe(false);
  });
});
