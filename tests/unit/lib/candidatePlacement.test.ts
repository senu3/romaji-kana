import { describe, expect, it } from "vitest";
import { placeCandidate } from "../../../src/lib/candidatePlacement";

const bounds = { left: 8, right: 382, top: 100, bottom: 600 };
describe("candidate placement", () => {
  it("keeps a short offer beside the caret without moving the document", () => {
    expect(placeCandidate({ left: 100, right: 100, top: 150, bottom: 174 }, bounds, { width: 150, height: 24 }, true))
      .toMatchObject({ inline: true, left: 106, top: 150 });
  });
  it("moves a full offer below the caret at the right edge instead of hiding or clipping it", () => {
    const placed = placeCandidate({ left: 375, right: 375, top: 150, bottom: 174 }, bounds, { width: 220, height: 40 }, true)!;
    expect(placed.inline).toBe(false);
    expect(placed.left + 220).toBeLessThanOrEqual(bounds.right);
    expect(placed.top).toBeGreaterThanOrEqual(174);
  });
  it("moves tall menus above the last visible line", () => {
    const placed = placeCandidate({ left: 200, right: 200, top: 560, bottom: 584 }, bounds, { width: 280, height: 300 })!;
    expect(placed.top + 300).toBeLessThan(560);
    expect(placed.top).toBeGreaterThanOrEqual(bounds.top);
  });
  it("bounds long offers on narrow and shortened viewports", () => {
    const placed = placeCandidate({ left: 200, right: 200, top: 220, bottom: 244 },
      { ...bounds, bottom: 340 }, { width: 600, height: 900 })!;
    expect(placed.left).toBe(bounds.left);
    expect(placed.maxWidth).toBe(374);
    expect(placed.top + placed.maxHeight).toBeLessThanOrEqual(340);
  });
  it("hides when its source leaves the viewport", () => {
    expect(placeCandidate({ left: 100, right: 100, top: 50, bottom: 74 }, bounds, { width: 150, height: 24 })).toBeNull();
  });
});
