import type { Point } from "../types.js";

interface MouseMovementOptions {
  steps?: number;
  deviation?: number; // control point deviation factor (0-1), default 0.3
  noise?: number; // pixel noise sigma, default 2
  overshootChance?: number; // 0-1, default 0.15
  speedFactor?: number; // overall speed multiplier, default 1.0
}

function gaussianRandom(mean: number, sigma: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * sigma;
}

function cubicBezier(t: number, p0: Point, p1: Point, p2: Point, p3: Point): Point {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

function easeInOutSine(t: number): number {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

export function generateMousePath(
  start: Point,
  end: Point,
  options: MouseMovementOptions = {},
): { points: Point[]; delays: number[] } {
  const {
    deviation = 0.3,
    noise = 2,
    overshootChance = 0.15,
    speedFactor = 1.0,
  } = options;

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  if (distance < 2) {
    return { points: [start, end], delays: [10] };
  }

  const steps = options.steps ?? Math.max(20, Math.min(80, Math.round(distance / 10)));

  // Perpendicular direction for control point offsets
  const perpX = -dy / distance;
  const perpY = dx / distance;

  const d1 = gaussianRandom(0, distance * deviation);
  const d2 = gaussianRandom(0, distance * deviation);

  const cp1: Point = {
    x: start.x + dx * 0.33 + perpX * d1,
    y: start.y + dy * 0.33 + perpY * d1,
  };
  const cp2: Point = {
    x: start.x + dx * 0.66 + perpX * d2,
    y: start.y + dy * 0.66 + perpY * d2,
  };

  // Possibly overshoot the target
  const doOvershoot = Math.random() < overshootChance && distance > 50;
  let actualEnd = end;
  if (doOvershoot) {
    const overshootFactor = 1 + (Math.random() * 0.1 + 0.05);
    actualEnd = {
      x: start.x + dx * overshootFactor,
      y: start.y + dy * overshootFactor,
    };
  }

  const points: Point[] = [];
  const delays: number[] = [];

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const easedT = easeInOutSine(t);
    const point = cubicBezier(easedT, start, cp1, cp2, actualEnd);

    // Add noise to intermediate points
    if (i > 0 && i < steps) {
      point.x += gaussianRandom(0, noise);
      point.y += gaussianRandom(0, noise);
    }

    points.push({
      x: Math.round(Math.max(0, point.x)),
      y: Math.round(Math.max(0, point.y)),
    });

    // Variable delay: slower at start/end, faster in middle
    const baseDelay = 5 + Math.random() * 15;
    const speedProfile = 1 - 0.5 * Math.sin(Math.PI * t);
    delays.push(Math.round((baseDelay * speedProfile) / speedFactor));
  }

  // Overshoot correction path
  if (doOvershoot) {
    const correctionSteps = Math.round(steps * 0.2);
    for (let i = 1; i <= correctionSteps; i++) {
      const t = i / correctionSteps;
      const point: Point = {
        x: Math.round(
          actualEnd.x +
            (end.x - actualEnd.x) * easeInOutSine(t) +
            gaussianRandom(0, noise * 0.5),
        ),
        y: Math.round(
          actualEnd.y +
            (end.y - actualEnd.y) * easeInOutSine(t) +
            gaussianRandom(0, noise * 0.5),
        ),
      };
      points.push(point);
      delays.push(Math.round((8 + Math.random() * 10) / speedFactor));
    }
  }

  return { points, delays };
}
