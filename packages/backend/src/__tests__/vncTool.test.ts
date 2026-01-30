import { describe, it, expect } from "vitest";
import { vncTool } from "../services/tools/vnc/index.js";

const validate = (args: Record<string, unknown>) => vncTool.validate!(args);

describe("vncTool definition", () => {
  it("has correct name and operations", () => {
    const def = vncTool.definition;
    expect(def.name).toBe("vnc");
    expect(def.operations.screenshot).toBeDefined();
    expect(def.operations.click).toBeDefined();
    expect(def.operations.type_text).toBeDefined();
    expect(def.operations.press_key).toBeDefined();
    expect(def.operations.get_coordinates).toBeDefined();
  });

  it("has host required in every operation", () => {
    const def = vncTool.definition;
    for (const op of Object.values(def.operations)) {
      expect(op.params.host).toBeDefined();
      expect(op.required).toContain("host");
    }
  });
});

describe("vncTool.validate", () => {
  it("screenshot with host is valid", () => {
    expect(validate({ operation: "screenshot", host: "localhost" })).toEqual({ valid: true });
  });

  it("unknown operation returns error", () => {
    const result = validate({ operation: "bogus", host: "localhost" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Unknown operation");
  });

  it("missing operation returns error", () => {
    const result = validate({ host: "localhost" });
    expect(result.valid).toBe(false);
  });

  it("press_key without key returns error", () => {
    const result = validate({ operation: "press_key", host: "localhost" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("key");
  });

  it("press_key with unknown key returns error", () => {
    const result = validate({ operation: "press_key", host: "localhost", key: "unknownkey123" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Unknown key");
  });

  it("press_key with valid key is valid", () => {
    expect(validate({ operation: "press_key", host: "localhost", key: "enter" })).toEqual({ valid: true });
    expect(validate({ operation: "press_key", host: "localhost", key: "ctrl+c" })).toEqual({ valid: true });
    expect(validate({ operation: "press_key", host: "localhost", key: "a" })).toEqual({ valid: true });
  });

  it("type_text without text returns error", () => {
    const result = validate({ operation: "type_text", host: "localhost" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("text");
  });

  it("type_text with text is valid", () => {
    expect(validate({ operation: "type_text", host: "localhost", text: "hello" })).toEqual({ valid: true });
  });

  it("click without x,y returns error", () => {
    const result = validate({ operation: "click", host: "localhost" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("x, y");
  });

  it("click with x,y is valid", () => {
    expect(validate({ operation: "click", host: "localhost", x: 100, y: 200 })).toEqual({ valid: true });
  });

  it("move_mouse without x,y returns error", () => {
    const result = validate({ operation: "move_mouse", host: "localhost" });
    expect(result.valid).toBe(false);
  });

  it("scroll without x,y returns error", () => {
    const result = validate({ operation: "scroll", host: "localhost" });
    expect(result.valid).toBe(false);
  });

  it("get_coordinates without description returns error", () => {
    const result = validate({ operation: "get_coordinates", host: "localhost" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("description");
  });

  it("get_coordinates with description is valid", () => {
    expect(validate({ operation: "get_coordinates", host: "localhost", description: "Start button" })).toEqual({ valid: true });
  });

  it("mark_screenshot without coordinates returns error", () => {
    const result = validate({ operation: "mark_screenshot", host: "localhost" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("coordinates");
  });

  it("mark_screenshot with coordinates is valid", () => {
    expect(validate({
      operation: "mark_screenshot",
      host: "localhost",
      coordinates: [{ x: 10, y: 20 }],
    })).toEqual({ valid: true });
  });
});
