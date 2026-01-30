// X11 keysym codes for VNC keyboard events
export const KEYSYM: Record<string, number> = {
  // Modifiers
  Shift_L: 0xffe1,
  Shift_R: 0xffe2,
  Control_L: 0xffe3,
  Control_R: 0xffe4,
  Alt_L: 0xffe9,
  Alt_R: 0xffea,
  Meta_L: 0xffe7,
  Meta_R: 0xffe8,
  Super_L: 0xffeb,
  Super_R: 0xffec,

  // Function keys
  F1: 0xffbe,
  F2: 0xffbf,
  F3: 0xffc0,
  F4: 0xffc1,
  F5: 0xffc2,
  F6: 0xffc3,
  F7: 0xffc4,
  F8: 0xffc5,
  F9: 0xffc6,
  F10: 0xffc7,
  F11: 0xffc8,
  F12: 0xffc9,

  // Navigation
  Return: 0xff0d,
  Escape: 0xff1b,
  Tab: 0xff09,
  BackSpace: 0xff08,
  Delete: 0xffff,
  Home: 0xff50,
  End: 0xff57,
  Page_Up: 0xff55,
  Page_Down: 0xff56,
  Left: 0xff51,
  Up: 0xff52,
  Right: 0xff53,
  Down: 0xff54,
  Insert: 0xff63,
  space: 0x0020,

  // Misc
  Caps_Lock: 0xffe5,
  Num_Lock: 0xff7f,
  Scroll_Lock: 0xff14,
  Print: 0xff61,
  Pause: 0xff13,
  Menu: 0xff67,
};

/**
 * Maps lowercase aliases/synonyms → KEYSYM key name.
 * All lookups happen after lowercasing the input.
 */
const KEY_ALIASES: Record<string, string> = {
  // Modifiers
  ctrl: "Control_L",
  control: "Control_L",
  lctrl: "Control_L",
  leftctrl: "Control_L",
  left_ctrl: "Control_L",
  l_ctrl: "Control_L",
  rctrl: "Control_R",
  rightctrl: "Control_R",
  right_ctrl: "Control_R",
  r_ctrl: "Control_R",

  shift: "Shift_L",
  lshift: "Shift_L",
  leftshift: "Shift_L",
  left_shift: "Shift_L",
  l_shift: "Shift_L",
  rshift: "Shift_R",
  rightshift: "Shift_R",
  right_shift: "Shift_R",
  r_shift: "Shift_R",

  alt: "Alt_L",
  lalt: "Alt_L",
  leftalt: "Alt_L",
  left_alt: "Alt_L",
  l_alt: "Alt_L",
  ralt: "Alt_R",
  rightalt: "Alt_R",
  right_alt: "Alt_R",
  r_alt: "Alt_R",
  altgr: "Alt_R",

  // Use Super_L/R for the Windows key. TightVNC recognizes Super_L as
  // VK_LWIN for standalone taps (opens Start menu). Win+key combos
  // (Win+D, Win+R, etc.) are a known TightVNC limitation — the server
  // does not propagate VK_LWIN modifier state for shortcuts.
  meta: "Super_L",
  super: "Super_L",
  win: "Super_L",
  windows: "Super_L",
  cmd: "Super_L",
  command: "Super_L",
  meta_l: "Super_L",
  lmeta: "Super_L",
  l_meta: "Super_L",
  leftmeta: "Super_L",
  left_meta: "Super_L",
  lwin: "Super_L",
  l_win: "Super_L",
  lsuper: "Super_L",
  l_super: "Super_L",
  meta_r: "Super_R",
  rmeta: "Super_R",
  r_meta: "Super_R",
  rightmeta: "Super_R",
  right_meta: "Super_R",
  rwin: "Super_R",
  r_win: "Super_R",
  rsuper: "Super_R",
  r_super: "Super_R",

  // Enter / Return
  enter: "Return",
  return: "Return",
  cr: "Return",

  // Escape
  esc: "Escape",
  escape: "Escape",

  // Tab
  tab: "Tab",

  // Backspace
  backspace: "BackSpace",
  bksp: "BackSpace",
  bs: "BackSpace",

  // Delete
  delete: "Delete",
  del: "Delete",

  // Space
  space: "space",
  spacebar: "space",
  " ": "space",

  // Arrow keys
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  arrow_up: "Up",
  arrow_down: "Down",
  arrow_left: "Left",
  arrow_right: "Right",

  // Navigation
  home: "Home",
  end: "End",
  pageup: "Page_Up",
  page_up: "Page_Up",
  pgup: "Page_Up",
  pagedown: "Page_Down",
  page_down: "Page_Down",
  pgdn: "Page_Down",
  pgdown: "Page_Down",
  insert: "Insert",
  ins: "Insert",

  // Lock keys
  capslock: "Caps_Lock",
  caps_lock: "Caps_Lock",
  caps: "Caps_Lock",
  numlock: "Num_Lock",
  num_lock: "Num_Lock",
  scrolllock: "Scroll_Lock",
  scroll_lock: "Scroll_Lock",

  // Misc
  print: "Print",
  printscreen: "Print",
  prtsc: "Print",
  prtscn: "Print",
  sysrq: "Print",
  pause: "Pause",
  break: "Pause",
  menu: "Menu",
  apps: "Menu",
  context: "Menu",
  contextmenu: "Menu",
};

// Build lowercase KEYSYM name lookup (e.g. "shift_l" → "Shift_L")
const KEYSYM_BY_LOWER = new Map<string, string>();
for (const key of Object.keys(KEYSYM)) {
  KEYSYM_BY_LOWER.set(key.toLowerCase(), key);
}

export function charToKeysym(char: string): number {
  const code = char.charCodeAt(0);
  // ASCII printable range maps directly
  if (code >= 0x20 && code <= 0x7e) return code;
  // Latin-1 supplement
  if (code >= 0xa0 && code <= 0xff) return code;
  // Unicode BMP: 0x01000000 + code point
  return 0x01000000 + code;
}

/**
 * Resolve a single key part (after lowercasing) to its keysym value.
 * Returns the keysym number or undefined if unrecognized.
 */
function resolveKey(part: string): number | undefined {
  // 1. Check alias table
  const aliasName = KEY_ALIASES[part];
  if (aliasName) return KEYSYM[aliasName];

  // 2. Check exact KEYSYM name (case-insensitive)
  const exactName = KEYSYM_BY_LOWER.get(part);
  if (exactName) return KEYSYM[exactName];

  // 3. F-key pattern: "f1" .. "f12"
  if (/^f\d{1,2}$/.test(part)) {
    const fKey = `F${part.slice(1)}`;
    if (KEYSYM[fKey] !== undefined) return KEYSYM[fKey];
  }

  // 4. Single character → charToKeysym
  if (part.length === 1) return charToKeysym(part);

  return undefined;
}

export function parseShortcut(shortcut: string): number[] {
  const parts = shortcut.split("+");
  const keysyms: number[] = [];

  for (const part of parts) {
    const trimmed = part.trim().toLowerCase();
    const sym = resolveKey(trimmed);
    if (sym !== undefined) {
      keysyms.push(sym);
    }
  }

  return keysyms;
}

