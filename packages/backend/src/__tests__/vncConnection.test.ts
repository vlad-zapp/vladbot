import { describe, it, expect } from "vitest";
import { resolveTarget, getVncConnection } from "../services/tools/vnc/VncConnection.js";

describe("resolveTarget", () => {
  it("extracts host with default port 5900", () => {
    const target = resolveTarget({ host: "myhost" });
    expect(target.host).toBe("myhost");
    expect(target.port).toBe(5900);
    expect(target.password).toBeUndefined();
  });

  it("uses custom port", () => {
    const target = resolveTarget({ host: "myhost", port: 5901 });
    expect(target.port).toBe(5901);
  });

  it("includes password when provided", () => {
    const target = resolveTarget({ host: "myhost", password: "secret" });
    expect(target.password).toBe("secret");
  });

  it("throws on missing host", () => {
    expect(() => resolveTarget({})).toThrow("Missing required argument: host");
  });

  it("treats empty string password as undefined", () => {
    const target = resolveTarget({ host: "myhost", password: "" });
    expect(target.password).toBeUndefined();
  });
});

describe("getVncConnection pool", () => {
  it("returns same instance for same host:port", () => {
    const conn1 = getVncConnection({ host: "pool-test-same", port: 5900 });
    const conn2 = getVncConnection({ host: "pool-test-same", port: 5900 });
    expect(conn1).toBe(conn2);
  });

  it("returns different instances for different hosts", () => {
    const conn1 = getVncConnection({ host: "pool-test-a", port: 5900 });
    const conn2 = getVncConnection({ host: "pool-test-b", port: 5900 });
    expect(conn1).not.toBe(conn2);
  });

  it("returns different instances for different ports", () => {
    const conn1 = getVncConnection({ host: "pool-test-port", port: 5900 });
    const conn2 = getVncConnection({ host: "pool-test-port", port: 5901 });
    expect(conn1).not.toBe(conn2);
  });
});
