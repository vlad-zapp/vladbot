import { describe, it, expect } from "vitest";
import { charToKeysym, parseShortcut, KEYSYM } from "../services/tools/vnc/keysym.js";

describe("charToKeysym", () => {
  it("maps ASCII printable characters to their char code", () => {
    expect(charToKeysym("a")).toBe(0x61);
    expect(charToKeysym("A")).toBe(0x41);
    expect(charToKeysym("0")).toBe(0x30);
    expect(charToKeysym(" ")).toBe(0x20);
    expect(charToKeysym("~")).toBe(0x7e);
  });

  it("maps Latin-1 supplement characters directly", () => {
    expect(charToKeysym("é")).toBe(0xe9);
    expect(charToKeysym("ñ")).toBe(0xf1);
    expect(charToKeysym("ü")).toBe(0xfc);
  });

  it("maps Unicode BMP characters with offset", () => {
    // Japanese character
    const code = "あ".charCodeAt(0);
    expect(charToKeysym("あ")).toBe(0x01000000 + code);
  });
});

describe("parseShortcut", () => {
  it("parses single key: enter", () => {
    const result = parseShortcut("enter");
    expect(result).toEqual([KEYSYM.Return]);
  });

  it("parses single key: escape", () => {
    const result = parseShortcut("esc");
    expect(result).toEqual([KEYSYM.Escape]);
  });

  it("parses combo: ctrl+c", () => {
    const result = parseShortcut("ctrl+c");
    expect(result).toEqual([KEYSYM.Control_L, 0x63]);
  });

  it("parses combo: ctrl+shift+s", () => {
    const result = parseShortcut("ctrl+shift+s");
    expect(result).toEqual([KEYSYM.Control_L, KEYSYM.Shift_L, 0x73]);
  });

  it("parses F-keys", () => {
    expect(parseShortcut("f5")).toEqual([KEYSYM.F5]);
    expect(parseShortcut("F1")).toEqual([KEYSYM.F1]);
    expect(parseShortcut("f12")).toEqual([KEYSYM.F12]);
  });

  it("parses alt+F4", () => {
    const result = parseShortcut("alt+F4");
    expect(result).toEqual([KEYSYM.Alt_L, KEYSYM.F4]);
  });

  it("parses modifier aliases", () => {
    expect(parseShortcut("ctrl")).toEqual([KEYSYM.Control_L]);
    expect(parseShortcut("shift")).toEqual([KEYSYM.Shift_L]);
    expect(parseShortcut("alt")).toEqual([KEYSYM.Alt_L]);
    expect(parseShortcut("win")).toEqual([KEYSYM.Super_L]);
    expect(parseShortcut("windows")).toEqual([KEYSYM.Super_L]);
    expect(parseShortcut("super")).toEqual([KEYSYM.Super_L]);
    expect(parseShortcut("meta")).toEqual([KEYSYM.Super_L]);
    expect(parseShortcut("cmd")).toEqual([KEYSYM.Super_L]);
  });

  it("parses navigation keys", () => {
    expect(parseShortcut("tab")).toEqual([KEYSYM.Tab]);
    expect(parseShortcut("backspace")).toEqual([KEYSYM.BackSpace]);
    expect(parseShortcut("bksp")).toEqual([KEYSYM.BackSpace]);
    expect(parseShortcut("delete")).toEqual([KEYSYM.Delete]);
    expect(parseShortcut("del")).toEqual([KEYSYM.Delete]);
    expect(parseShortcut("space")).toEqual([KEYSYM.space]);
    expect(parseShortcut("insert")).toEqual([KEYSYM.Insert]);
    expect(parseShortcut("ins")).toEqual([KEYSYM.Insert]);
  });

  it("parses arrow keys", () => {
    expect(parseShortcut("up")).toEqual([KEYSYM.Up]);
    expect(parseShortcut("down")).toEqual([KEYSYM.Down]);
    expect(parseShortcut("left")).toEqual([KEYSYM.Left]);
    expect(parseShortcut("right")).toEqual([KEYSYM.Right]);
    expect(parseShortcut("arrowup")).toEqual([KEYSYM.Up]);
  });

  it("parses page navigation", () => {
    expect(parseShortcut("home")).toEqual([KEYSYM.Home]);
    expect(parseShortcut("end")).toEqual([KEYSYM.End]);
    expect(parseShortcut("pageup")).toEqual([KEYSYM.Page_Up]);
    expect(parseShortcut("pgup")).toEqual([KEYSYM.Page_Up]);
    expect(parseShortcut("pagedown")).toEqual([KEYSYM.Page_Down]);
    expect(parseShortcut("pgdn")).toEqual([KEYSYM.Page_Down]);
  });

  it("parses misc keys", () => {
    expect(parseShortcut("capslock")).toEqual([KEYSYM.Caps_Lock]);
    expect(parseShortcut("numlock")).toEqual([KEYSYM.Num_Lock]);
    expect(parseShortcut("printscreen")).toEqual([KEYSYM.Print]);
    expect(parseShortcut("prtsc")).toEqual([KEYSYM.Print]);
    expect(parseShortcut("pause")).toEqual([KEYSYM.Pause]);
    expect(parseShortcut("menu")).toEqual([KEYSYM.Menu]);
    expect(parseShortcut("apps")).toEqual([KEYSYM.Menu]);
  });

  it("is case insensitive", () => {
    expect(parseShortcut("CTRL+C")).toEqual(parseShortcut("ctrl+c"));
    expect(parseShortcut("Enter")).toEqual(parseShortcut("enter"));
    expect(parseShortcut("ESCAPE")).toEqual(parseShortcut("escape"));
  });

  it("parses single characters", () => {
    expect(parseShortcut("a")).toEqual([0x61]);
    expect(parseShortcut("z")).toEqual([0x7a]);
    expect(parseShortcut("1")).toEqual([0x31]);
  });

  it("excludes unknown keys from result", () => {
    // "unknownkey" has length > 1, not in aliases, not F-key, not in KEYSYM
    const result = parseShortcut("unknownkey");
    expect(result).toEqual([]);
  });
});
