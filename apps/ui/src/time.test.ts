import { describe, expect, it } from "vitest";
import { relativeTime } from "./time";

describe("relativeTime", () => {
  const now = Date.parse("2026-10-17T12:00:00Z");
  it("speaks in seconds, minutes, hours and days", () => {
    expect(relativeTime("2026-10-17T11:59:56Z", now)).toBe("há 4 s");
    expect(relativeTime("2026-10-17T11:48:00Z", now)).toBe("há 12 min");
    expect(relativeTime("2026-10-17T09:00:00Z", now)).toBe("há 3 h");
    expect(relativeTime("2026-10-15T11:00:00Z", now)).toBe("há 2 d");
  });
  it("never says a negative time (clock skew between the browser and the node)", () => {
    expect(relativeTime("2026-10-17T12:00:05Z", now)).toBe("há 0 s");
  });
});
