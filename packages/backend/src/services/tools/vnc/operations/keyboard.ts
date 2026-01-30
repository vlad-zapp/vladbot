import { resolveConnection } from "../VncConnection.js";
import { charToKeysym, parseShortcut, KEYSYM } from "../keysym.js";
import {
  generateTypingDelays,
  generateShortcutDelays,
} from "../humanize/typing.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send a key press/release via VNC using standard keyEvent.
 */
function sendKey(
  client: { keyEvent(keysym: number, isDown: boolean | number): void },
  keysym: number,
  isDown: boolean,
): void {
  client.keyEvent(keysym, isDown ? 1 : 0);
}

export async function typeText(
  args: Record<string, unknown>,
): Promise<string> {
  const text = args.text as string;
  if (!text) throw new Error("Missing required argument: text");

  const conn = resolveConnection(args);
  const client = await conn.getClient();
  const delays = generateTypingDelays(text);

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const keysym = charToKeysym(char);

    // Uppercase letters need Shift held
    const needsShift = /[A-Z]/.test(char);

    if (needsShift) {
      sendKey(client, KEYSYM.Shift_L, true);
      await sleep(20 + Math.random() * 20);
    }

    sendKey(client, keysym, true);
    await sleep(20 + Math.random() * 30);
    sendKey(client, keysym, false);

    if (needsShift) {
      await sleep(10 + Math.random() * 15);
      sendKey(client, KEYSYM.Shift_L, false);
    }

    if (i < text.length - 1) {
      await sleep(delays[i]);
    }
  }

  return `Typed ${text.length} characters`;
}

export async function pressKey(
  args: Record<string, unknown>,
): Promise<string> {
  const key = args.key as string;
  if (!key) throw new Error("Missing required argument: key");

  const conn = resolveConnection(args);
  const client = await conn.getClient();
  const keysyms = parseShortcut(key);

  if (keysyms.length === 0) {
    throw new Error(`Unknown key: ${key}`);
  }

  console.log(
    `[VNC] pressKey "${key}" → keysyms [${keysyms.map((k) => `0x${k.toString(16)}`).join(", ")}]`,
  );

  const timing = generateShortcutDelays();

  if (keysyms.length === 1) {
    const isModifier = keysyms[0] >= 0xffe1 && keysyms[0] <= 0xffee;
    const holdMs = isModifier
      ? 150 + Math.random() * 100
      : 40 + Math.random() * 40;

    sendKey(client, keysyms[0], true);
    await sleep(holdMs);
    sendKey(client, keysyms[0], false);
  } else {
    // Press modifiers in order
    for (let i = 0; i < keysyms.length - 1; i++) {
      sendKey(client, keysyms[i], true);
      await sleep(timing.betweenKeys);
    }

    // Press and release the final key
    const lastKey = keysyms[keysyms.length - 1];
    sendKey(client, lastKey, true);
    await sleep(timing.holdRelease);
    sendKey(client, lastKey, false);

    // Release modifiers in reverse order
    for (let i = keysyms.length - 2; i >= 0; i--) {
      await sleep(20 + Math.random() * 20);
      sendKey(client, keysyms[i], false);
    }
  }

  // Warn if Super_L/Super_R is used as a modifier in a combo — TightVNC
  // does not propagate VK_LWIN/VK_RWIN modifier state for shortcuts.
  if (keysyms.length > 1) {
    const hasWinModifier = keysyms
      .slice(0, -1)
      .some((k) => k === KEYSYM.Super_L || k === KEYSYM.Super_R);
    if (hasWinModifier) {
      return `Pressed key: ${key} (WARNING: Win+key combos are not supported by TightVNC — the Win key was sent but likely not recognized as a modifier. Only standalone Win key works.)`;
    }
  }

  return `Pressed key: ${key}`;
}
