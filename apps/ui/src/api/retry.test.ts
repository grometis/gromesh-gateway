import { describe, expect, it } from "vitest";
import { ApiError, retryNetworkErrorsOnly } from "./client";

describe("retryNetworkErrorsOnly", () => {
  it("retries a request that got no answer, at most twice", () => {
    expect(retryNetworkErrorsOnly(0, new TypeError("Failed to fetch"))).toBe(true);
    expect(retryNetworkErrorsOnly(1, new TypeError("Failed to fetch"))).toBe(true);
    expect(retryNetworkErrorsOnly(2, new TypeError("Failed to fetch"))).toBe(false);
  });
  it("never retries an HTTP answer, 5xx included", () => {
    expect(retryNetworkErrorsOnly(0, new ApiError(502, undefined))).toBe(false);
    expect(retryNetworkErrorsOnly(0, new ApiError(503, undefined))).toBe(false);
    expect(retryNetworkErrorsOnly(0, new ApiError(404, undefined))).toBe(false);
  });
});
