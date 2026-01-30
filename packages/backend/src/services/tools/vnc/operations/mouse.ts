import { resolveConnection } from "../VncConnection.js";
import { generateMousePath } from "../humanize/mouseMovement.js";
import { BUTTON, type Point } from "../types.js";
import { KEYSYM, charToKeysym } from "../keysym.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Track current mouse position per connection (keyed by host:port)
const mousePositions = new Map<string, Point>();

function getMousePos(args: Record<string, unknown>): Point {
  const key = `${args.host}:${args.port ?? 5900}`;
  return mousePositions.get(key) ?? { x: 0, y: 0 };
}

function setMousePos(args: Record<string, unknown>, pos: Point): void {
  const key = `${args.host}:${args.port ?? 5900}`;
  mousePositions.set(key, pos);
}

export async function moveMouse(
  args: Record<string, unknown>,
): Promise<string> {
  const x = Number(args.x);
  const y = Number(args.y);
  if (isNaN(x) || isNaN(y))
    throw new Error("Missing required arguments: x, y");

  const conn = resolveConnection(args);
  const client = await conn.getClient();
  const target: Point = { x, y };

  const { points, delays } = generateMousePath(getMousePos(args), target, {
    speedFactor: Number(args.speed_factor) || 1.0,
  });

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const cx = Math.max(0, Math.min(conn.width - 1, p.x));
    const cy = Math.max(0, Math.min(conn.height - 1, p.y));
    client.pointerEvent(cx, cy, BUTTON.NONE);
    if (i < points.length - 1 && delays[i] > 0) {
      await sleep(delays[i]);
    }
  }

  setMousePos(args, { x, y });
  return `Mouse moved to (${x}, ${y}) with ${points.length} steps`;
}

export async function click(args: Record<string, unknown>): Promise<string> {
  const x = Number(args.x);
  const y = Number(args.y);
  if (isNaN(x) || isNaN(y))
    throw new Error("Missing required arguments: x, y");

  const button = (args.button as string) || "left";
  const clickType = (args.click_type as string) || "single";
  const holdKeys = (args.hold_keys as string[]) || [];
  const dragToX =
    args.drag_to_x !== undefined ? Number(args.drag_to_x) : null;
  const dragToY =
    args.drag_to_y !== undefined ? Number(args.drag_to_y) : null;

  const conn = resolveConnection(args);
  const client = await conn.getClient();

  let buttonMask: number;
  switch (button) {
    case "right":
      buttonMask = BUTTON.RIGHT;
      break;
    case "middle":
      buttonMask = BUTTON.MIDDLE;
      break;
    default:
      buttonMask = BUTTON.LEFT;
  }

  // Move to click position
  await moveMouse(args);

  // Press modifier keys if specified
  for (const key of holdKeys) {
    const sym = KEYSYM[key] || charToKeysym(key);
    if (sym) client.keyEvent(sym, true);
    await sleep(30 + Math.random() * 40);
  }

  const clickCount =
    clickType === "double" ? 2 : clickType === "triple" ? 3 : 1;

  if (dragToX !== null && dragToY !== null) {
    // Drag: press at source, move to destination with button held, release
    client.pointerEvent(x, y, buttonMask);
    await sleep(50 + Math.random() * 50);

    const { points, delays } = generateMousePath(
      { x, y },
      { x: dragToX, y: dragToY },
      { speedFactor: 0.8 },
    );

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      client.pointerEvent(
        Math.max(0, Math.min(conn.width - 1, p.x)),
        Math.max(0, Math.min(conn.height - 1, p.y)),
        buttonMask,
      );
      if (i < points.length - 1) await sleep(delays[i]);
    }

    client.pointerEvent(dragToX, dragToY, BUTTON.NONE);
    setMousePos(args, { x: dragToX, y: dragToY });
  } else {
    // Normal click(s)
    for (let c = 0; c < clickCount; c++) {
      client.pointerEvent(x, y, buttonMask);
      await sleep(40 + Math.random() * 30);
      client.pointerEvent(x, y, BUTTON.NONE);
      if (c < clickCount - 1) {
        await sleep(50 + Math.random() * 40);
      }
    }
  }

  // Release modifier keys in reverse order
  for (const key of [...holdKeys].reverse()) {
    const sym = KEYSYM[key] || charToKeysym(key);
    if (sym) client.keyEvent(sym, false);
    await sleep(20 + Math.random() * 30);
  }

  const action =
    dragToX !== null
      ? `dragged to (${dragToX}, ${dragToY})`
      : `${clickType} ${button} clicked`;
  return `${action} at (${x}, ${y})`;
}

export async function scroll(args: Record<string, unknown>): Promise<string> {
  const x = Number(args.x);
  const y = Number(args.y);
  const direction = (args.direction as string) || "down";
  const amount = Number(args.amount) || 3;

  if (isNaN(x) || isNaN(y))
    throw new Error("Missing required arguments: x, y");

  const conn = resolveConnection(args);
  const client = await conn.getClient();

  // Move to scroll position first
  await moveMouse(args);

  let scrollButton: number;
  switch (direction) {
    case "up":
      scrollButton = BUTTON.SCROLL_UP;
      break;
    case "down":
      scrollButton = BUTTON.SCROLL_DOWN;
      break;
    default:
      scrollButton = BUTTON.SCROLL_DOWN;
  }

  for (let i = 0; i < amount; i++) {
    client.pointerEvent(x, y, scrollButton);
    await sleep(10 + Math.random() * 20);
    client.pointerEvent(x, y, BUTTON.NONE);
    await sleep(30 + Math.random() * 50);
  }

  return `Scrolled ${direction} ${amount} steps at (${x}, ${y})`;
}
