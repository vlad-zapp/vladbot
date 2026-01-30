export interface Point {
  x: number;
  y: number;
}

export interface ScreenshotResult {
  type: "screenshot";
  width: number;
  height: number;
  image_base64?: string;
  image_url?: string;
}

export interface CoordinateResult {
  type: "coordinates";
  x: number;
  y: number;
  confidence?: number;
  description: string;
  image_base64?: string;
  image_url?: string;
}

export const BUTTON = {
  NONE: 0,
  LEFT: 1,
  MIDDLE: 2,
  RIGHT: 4,
  SCROLL_UP: 8,
  SCROLL_DOWN: 16,
} as const;
