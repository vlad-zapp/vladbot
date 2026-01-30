import type { Tool } from "../ToolExecutor.js";
import { buildOperationToolDef } from "../buildToolDef.js";
import type { JsonSchemaProperty } from "@vladbot/shared";
import { takeScreenshot, markScreenshot } from "./operations/screenshot.js";
import { moveMouse, click, scroll } from "./operations/mouse.js";
import { typeText, pressKey } from "./operations/keyboard.js";
import { getCoordinates } from "./operations/coordinates.js";
import { parseShortcut } from "./keysym.js";

const P = {
  host:         { type: "string", description: "VNC server hostname or IP address." },
  port:         { type: "number", description: "VNC server port. Default: 5900." },
  password:     { type: "string", description: "VNC server password (if required)." },
  x:            { type: "number", description: "X coordinate." },
  y:            { type: "number", description: "Y coordinate." },
  text:         { type: "string", description: "Text to type." },
  key:          { type: "string", description: "Key or shortcut. Examples: 'Return', 'ctrl+c', 'alt+f4'." },
  button:       { type: "string", description: "Mouse button: 'left', 'right', or 'middle'. Default: 'left'.", enum: ["left", "right", "middle"] },
  click_type:   { type: "string", description: "Click type: 'single', 'double', or 'triple'. Default: 'single'.", enum: ["single", "double", "triple"] },
  direction:    { type: "string", description: "Scroll direction: 'up' or 'down'. Default: 'down'.", enum: ["up", "down"] },
  amount:       { type: "number", description: "Number of scroll steps. Default: 3." },
  speed_factor: { type: "number", description: "Mouse movement speed multiplier. Default: 1.0." },
  coordinates:  { type: "array", description: "Array of {x, y} objects for mark_screenshot.", items: { type: "object", properties: { x: { type: "number", description: "X coordinate" }, y: { type: "number", description: "Y coordinate" } }, required: ["x", "y"] } },
  hold_keys:    { type: "array", description: "Modifier keys to hold during click (e.g. ['Shift_L', 'Control_L']).", items: { type: "string" } },
  drag_to_x:    { type: "number", description: "Destination X for drag-and-drop." },
  drag_to_y:    { type: "number", description: "Destination Y for drag-and-drop." },
  description:  { type: "string", description: "Natural language description of UI element to find." },
} satisfies Record<string, JsonSchemaProperty>;

export const vncTool: Tool = {
  definition: buildOperationToolDef({
    name: "vnc",
    description: `Control a remote computer via VNC. Provides mouse, keyboard, and screen capture capabilities for remote desktop interaction. The LLM decides which host to connect to based on user instructions.

Every call requires "host" (the VNC server address). Connections are pooled and reused automatically.

Supported operations:
- screenshot: Capture the current screen.
- mark_screenshot: Take a screenshot and overlay visual markers. Params: coordinates (required, array of {x, y} objects)
- move_mouse: Move mouse cursor with human-like motion. Params: x, y (required), speed_factor (optional)
- click: Click at coordinates. Params: x, y (required), button/click_type/hold_keys/drag_to_x/drag_to_y (optional)
- scroll: Scroll the mouse wheel. Params: x, y (required), direction/amount (optional)
- type_text: Type text with human-like timing. Params: text (required)
- press_key: Press a key or shortcut combo. Params: key (required). Use "+" for combos.
- get_coordinates: Find a UI element's pixel coordinates using the configured vision model. Params: description (required). IMPORTANT: describe WHAT the element is, never WHERE.

Key names for press_key (case-insensitive, many synonyms accepted):
  Modifiers: ctrl, shift, alt, win/windows/super/meta/cmd
  Editing: enter/return, escape/esc, tab, backspace/bksp, delete/del, insert/ins, space
  Arrows: up, down, left, right
  Navigation: home, end, pageup/pgup, pagedown/pgdn
  Function: F1-F12
  Locks: capslock, numlock, scrolllock
  Other: printscreen/prtsc, pause/break, menu/apps
  Any single character works directly (a-z, 0-9, punctuation).
  Combos: "ctrl+a", "ctrl+shift+s", "alt+F4", "win+d", "win+r"`,
    params: P,
    common: { params: ["host", "port", "password"], required: ["host"] },
    operations: {
      screenshot:      { params: [] },
      mark_screenshot: { params: ["coordinates"], required: ["coordinates"] },
      move_mouse:      { params: ["x", "y", "speed_factor"], required: ["x", "y"] },
      click:           { params: ["x", "y", "button", "click_type", "hold_keys", "drag_to_x", "drag_to_y"], required: ["x", "y"] },
      scroll:          { params: ["x", "y", "direction", "amount"], required: ["x", "y"] },
      type_text:       { params: ["text"], required: ["text"] },
      press_key:       { params: ["key"], required: ["key"] },
      get_coordinates: { params: ["description"], required: ["description"] },
    },
  }),

  validate(args: Record<string, unknown>): { valid: boolean; error?: string } {
    const op = args.operation as string;
    const validOps = Object.keys(vncTool.definition.operations);
    if (!op || !validOps.includes(op)) {
      return { valid: false, error: `Unknown operation: ${op}` };
    }
    switch (op) {
      case "press_key": {
        const key = args.key as string;
        if (!key) return { valid: false, error: "Missing required argument: key" };
        const keysyms = parseShortcut(key);
        if (keysyms.length === 0)
          return { valid: false, error: `Unknown key: "${key}"` };
        break;
      }
      case "type_text":
        if (!args.text)
          return { valid: false, error: "Missing required argument: text" };
        break;
      case "click":
      case "move_mouse":
      case "scroll":
        if (args.x == null || args.y == null)
          return {
            valid: false,
            error: "Missing required arguments: x, y",
          };
        break;
      case "get_coordinates":
        if (!args.description)
          return {
            valid: false,
            error: "Missing required argument: description",
          };
        break;
      case "mark_screenshot":
        if (!args.coordinates)
          return {
            valid: false,
            error: "Missing required argument: coordinates",
          };
        break;
    }
    return { valid: true };
  },

  async execute(args: Record<string, unknown>, sessionId?: string): Promise<string> {
    const op = args.operation as string;
    switch (op) {
      case "screenshot":
        return takeScreenshot(args, sessionId);
      case "mark_screenshot":
        return markScreenshot(args, sessionId);
      case "move_mouse":
        return moveMouse(args);
      case "click":
        return click(args);
      case "scroll":
        return scroll(args);
      case "type_text":
        return typeText(args);
      case "press_key":
        return pressKey(args);
      case "get_coordinates":
        return getCoordinates(args, sessionId);
      default:
        throw new Error(`Unknown VNC operation: ${op}`);
    }
  },
};
