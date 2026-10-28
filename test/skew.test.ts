import { describe, expect, it } from "vitest";
import {
  isStale,
  parseVersionOutput,
  shortVersion,
  skewWarning,
  TESTED_WITH,
  VERSION_CHECK_TTL_MS,
} from "../src/skew.js";

describe("version skew (decision A10)", () => {
  it("records the tested CLI version", () => {
    expect(TESTED_WITH).toBe("v3.3.6");
  });

  it("parses argocd version output", () => {
    expect(
      parseVersionOutput({
        client: { Version: "v3.3.6+abc" },
        server: { Version: "v2.13.1+def" },
      }),
    ).toEqual({
      client: "v3.3.6+abc",
      server: "v2.13.1+def",
    });
    expect(parseVersionOutput({ client: { version: "v3.3.6" } })).toEqual({
      client: "v3.3.6",
      server: undefined,
    });
    expect(shortVersion("v3.3.6+abc")).toBe("v3.3.6");
  });

  it("warns on major skew only", () => {
    expect(skewWarning("v3.3.6", "v3.1.0")).toBeUndefined();
    expect(skewWarning("v3.3.6+x", "v2.13.1+y")).toMatch(
      /argocd CLI v3.3.6 and server v2.13.1 differ by a major version/,
    );
  });

  it("refreshes after 12 hours", () => {
    const now = Date.parse("2026-10-28T12:00:00Z");
    const at = (ms: number) => ({
      client: "v3",
      server: "v3",
      checkedAt: new Date(now - ms).toISOString(),
    });
    expect(VERSION_CHECK_TTL_MS).toBe(12 * 3600 * 1000);
    expect(isStale(undefined, now)).toBe(true);
    expect(isStale(at(11 * 3600 * 1000), now)).toBe(false);
    expect(isStale(at(13 * 3600 * 1000), now)).toBe(true);
  });
});
