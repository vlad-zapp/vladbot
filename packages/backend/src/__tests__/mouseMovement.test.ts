import { describe, it, expect } from "vitest";
import { generateMousePath } from "../services/tools/vnc/humanize/mouseMovement.js";

describe("generateMousePath", () => {
  it("returns points including start and end", () => {
    const start = { x: 0, y: 0 };
    const end = { x: 500, y: 300 };
    const { points } = generateMousePath(start, end, { overshootChance: 0 });

    expect(points.length).toBeGreaterThan(2);
    expect(points[0]).toEqual(start);
    // Last point should be close to end (exact if no overshoot)
    const last = points[points.length - 1];
    expect(Math.abs(last.x - end.x)).toBeLessThan(20);
    expect(Math.abs(last.y - end.y)).toBeLessThan(20);
  });

  it("returns 2 points for very short distance", () => {
    const start = { x: 100, y: 100 };
    const end = { x: 101, y: 100 };
    const { points, delays } = generateMousePath(start, end);

    expect(points).toHaveLength(2);
    expect(delays).toHaveLength(1);
  });

  it("delays array matches points array length", () => {
    const { points, delays } = generateMousePath(
      { x: 0, y: 0 },
      { x: 200, y: 200 },
      { overshootChance: 0 },
    );
    // Both are pushed in every loop iteration (0..steps inclusive)
    expect(delays).toHaveLength(points.length);
  });

  it("all points have non-negative coordinates", () => {
    const { points } = generateMousePath(
      { x: 10, y: 10 },
      { x: 500, y: 500 },
    );
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
    }
  });

  it("custom steps option controls point count", () => {
    const { points } = generateMousePath(
      { x: 0, y: 0 },
      { x: 1000, y: 1000 },
      { steps: 10, overshootChance: 0 },
    );
    // steps + 1 points (0..steps inclusive)
    expect(points).toHaveLength(11);
  });

  it("longer distance produces more points by default", () => {
    const short = generateMousePath(
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { overshootChance: 0 },
    );
    const long = generateMousePath(
      { x: 0, y: 0 },
      { x: 800, y: 0 },
      { overshootChance: 0 },
    );
    expect(long.points.length).toBeGreaterThanOrEqual(short.points.length);
  });

  it("all delays are positive numbers", () => {
    const { delays } = generateMousePath(
      { x: 0, y: 0 },
      { x: 300, y: 300 },
    );
    for (const d of delays) {
      expect(d).toBeGreaterThan(0);
    }
  });
});
