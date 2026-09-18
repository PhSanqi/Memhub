import { describe, expect, it } from "vitest";
import { sameProjectScope } from "../../../src/service/namespace/namespace-scope.js";

describe("project/global evolution scope", () => {
  it("keeps account-level and project-level skill products separate", () => {
    expect(sameProjectScope(undefined, undefined)).toBe(true);
    expect(sameProjectScope(null, "")).toBe(true);
    expect(sameProjectScope("aide", "aide")).toBe(true);
    expect(sameProjectScope(" aide ", "aide")).toBe(true);
    expect(sameProjectScope(undefined, "aide")).toBe(false);
    expect(sameProjectScope("aide", undefined)).toBe(false);
    expect(sameProjectScope("aide", "memhub")).toBe(false);
  });
});
