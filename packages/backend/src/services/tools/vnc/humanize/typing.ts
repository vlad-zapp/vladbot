function gaussianRandom(mean: number, sigma: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * sigma;
}

interface TypingTimingOptions {
  baseDelay?: number; // ms, default 80
  variation?: number; // stddev in ms, default 30
  pauseChance?: number; // per-char thinking pause probability, default 0.06
  pauseMin?: number; // ms, default 200
  pauseMax?: number; // ms, default 500
}

export function generateTypingDelays(
  text: string,
  options: TypingTimingOptions = {},
): number[] {
  const {
    baseDelay = 80,
    variation = 30,
    pauseChance = 0.06,
    pauseMin = 200,
    pauseMax = 500,
  } = options;

  const delays: number[] = [];

  for (let i = 0; i < text.length; i++) {
    let delay = Math.max(20, gaussianRandom(baseDelay, variation));

    // Occasional thinking pause
    if (Math.random() < pauseChance) {
      delay += pauseMin + Math.random() * (pauseMax - pauseMin);
    }

    // Slightly longer delay after spaces and punctuation
    if (i > 0 && /[\s.,!?;:]/.test(text[i - 1])) {
      delay += Math.random() * 40;
    }

    delays.push(Math.round(delay));
  }

  return delays;
}

export function generateShortcutDelays(): {
  betweenKeys: number;
  holdRelease: number;
} {
  return {
    betweenKeys: Math.round(30 + Math.random() * 50),
    holdRelease: Math.round(40 + Math.random() * 60),
  };
}
