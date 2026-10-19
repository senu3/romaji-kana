import { afterEach, describe, expect, it, vi } from "vitest";
import { createId } from "../../../src/lib/id";

describe("createId", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses randomUUID when the browser supports it", () => {
    expect(createId("test", { randomUUID: () => "native-uuid" })).toBe("native-uuid");
  });

  it("uses getRandomValues when randomUUID is unavailable on an HTTP origin", () => {
    const id = createId("test", {
      getRandomValues(array) {
        array.set(Array.from({ length: 16 }, (_, index) => index));
        return array;
      },
    });

    expect(id).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });

  it("falls back without Web Crypto", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    vi.spyOn(Math, "random").mockReturnValue(0.25);

    expect(createId("mobile", null)).toMatch(/^mobile-[a-z0-9]+-[a-z0-9]+$/);
  });
});
