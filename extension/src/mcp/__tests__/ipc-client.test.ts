import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  discoverSockets,
  getSocketDir,
  getSocketPath,
  registerSocket,
  unregisterSocket,
  unregisterSocketByPath,
} from "../ipc-client.ts";

let originalEnv: string | undefined;
let originalPlatform: NodeJS.Platform;
let originalGetUid: typeof process.getuid;
let sandboxSocketDir: string | null = null;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform });
}

function useSandboxSocketDir(): string {
  if (sandboxSocketDir !== null) {
    return sandboxSocketDir;
  }
  const uid = Math.floor(Math.random() * 1_000_000_000);
  process.getuid = () => uid;
  const dir = path.join(os.tmpdir(), `marimo-mcp-${uid}`);
  sandboxSocketDir = dir;
  return dir;
}

function restoreEnv(): void {
  if (originalEnv === undefined) {
    delete process.env.MARIMO_MCP_SOCKET;
  } else {
    process.env.MARIMO_MCP_SOCKET = originalEnv;
  }
}

beforeEach(() => {
  originalEnv = process.env.MARIMO_MCP_SOCKET;
  originalPlatform = process.platform;
  originalGetUid = process.getuid;
  sandboxSocketDir = null;
});

afterEach(() => {
  restoreEnv();
  Object.defineProperty(process, "platform", { value: originalPlatform });
  Object.defineProperty(process, "getuid", { value: originalGetUid });
  if (sandboxSocketDir) {
    fs.rmSync(sandboxSocketDir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("getSocketDir", () => {
  it("returns a path containing the uid", () => {
    const dir = getSocketDir();
    expect(dir).toContain("marimo-mcp-");
    // Should not end with .sock — it's a directory, not a socket file
    expect(dir).not.toMatch(/\.sock$/);
  });
});

describe("getSocketPath", () => {
  it("without sessionId returns legacy path ending in .sock", () => {
    setPlatform("darwin");
    delete process.env.MARIMO_MCP_SOCKET;
    const p = getSocketPath();
    expect(p).toMatch(/\.sock$/);
    expect(path.dirname(p)).toBe(os.tmpdir());
  });

  it("with sessionId returns per-window path inside socket dir", () => {
    setPlatform("darwin");
    delete process.env.MARIMO_MCP_SOCKET;
    const p = getSocketPath("abc-123");
    const pAgain = getSocketPath("abc-123");
    const pOther = getSocketPath("xyz-999");
    expect(p).toMatch(/\.sock$/);
    expect(p).toContain(getSocketDir());
    expect(p).toBe(pAgain);
    expect(p).not.toBe(pOther);
    expect(p).not.toContain("abc-123");
  });

  it("on Windows returns a named pipe path", () => {
    setPlatform("win32");
    delete process.env.MARIMO_MCP_SOCKET;
    const p = getSocketPath("abc-123");
    const pAgain = getSocketPath("abc-123");
    const pOther = getSocketPath("xyz-999");
    expect(p).toContain("\\\\.\\pipe\\marimo-mcp-");
    expect(p).toBe(pAgain);
    expect(p).not.toBe(pOther);
    expect(p).not.toContain("abc-123");
  });

  it("uses compact Unix socket names to stay below macOS path limits", () => {
    setPlatform("darwin");
    useSandboxSocketDir();
    delete process.env.MARIMO_MCP_SOCKET;

    const veryLongSessionId = "x".repeat(256);
    const p = getSocketPath(veryLongSessionId);

    // macOS Unix domain sockets are constrained by sun_path (~103 usable bytes).
    expect(Buffer.byteLength(p)).toBeLessThanOrEqual(103);
  });

  it("with MARIMO_MCP_SOCKET env returns env value regardless of sessionId", () => {
    process.env.MARIMO_MCP_SOCKET = "/custom/path.sock";
    expect(getSocketPath()).toBe("/custom/path.sock");
    expect(getSocketPath("any-session")).toBe("/custom/path.sock");
  });
});

describe("discoverSockets", () => {
  it("returns empty array for non-existent directory", () => {
    setPlatform("darwin");
    useSandboxSocketDir();
    delete process.env.MARIMO_MCP_SOCKET;
    const sockets = discoverSockets();
    expect(sockets).toEqual([]);
  });

  it("returns .sock files and ignores non-.sock files", () => {
    setPlatform("darwin");
    useSandboxSocketDir();
    delete process.env.MARIMO_MCP_SOCKET;

    const socketDir = getSocketDir();
    fs.mkdirSync(socketDir, { recursive: true });
    const testSock1 = path.join(socketDir, "test-session-1.sock");
    const testSock2 = path.join(socketDir, "test-session-2.sock");
    const testTxt = path.join(socketDir, "test-not-socket.txt");
    fs.writeFileSync(testSock1, "");
    fs.writeFileSync(testSock2, "");
    fs.writeFileSync(testTxt, "");

    try {
      const sockets = discoverSockets();
      expect(sockets).toContain(testSock1);
      expect(sockets).toContain(testSock2);
      // Should not include non-.sock files
      expect(sockets).not.toContain(testTxt);
      // All returned paths should end in .sock
      for (const s of sockets) {
        expect(s).toMatch(/\.sock$/);
      }
    } finally {
      fs.rmSync(testSock1, { force: true });
      fs.rmSync(testSock2, { force: true });
      fs.rmSync(testTxt, { force: true });
    }
  });

  it("with MARIMO_MCP_SOCKET env returns single-element array", () => {
    process.env.MARIMO_MCP_SOCKET = "/override/socket.sock";
    const sockets = discoverSockets();
    expect(sockets).toEqual(["/override/socket.sock"]);
  });

  it("on Windows discovers named pipes via marker files", () => {
    setPlatform("win32");
    useSandboxSocketDir();
    delete process.env.MARIMO_MCP_SOCKET;

    const socketA = getSocketPath("session-a");
    const socketB = getSocketPath("session-b");
    registerSocket("session-a", socketA);
    registerSocket("session-b", socketB);

    const sockets = discoverSockets();
    expect(sockets).toEqual(expect.arrayContaining([socketA, socketB]));
    expect(sockets).toHaveLength(2);
  });

  it("on Windows falls back to legacy pipe when marker dir is empty", () => {
    setPlatform("win32");
    useSandboxSocketDir();
    delete process.env.MARIMO_MCP_SOCKET;

    const sockets = discoverSockets();
    expect(sockets).toEqual([getSocketPath()]);
  });
});

describe("Windows marker registration", () => {
  it("unregisterSocket removes the specific session marker", () => {
    setPlatform("win32");
    useSandboxSocketDir();
    delete process.env.MARIMO_MCP_SOCKET;

    const socketA = getSocketPath("session-a");
    const socketB = getSocketPath("session-b");
    registerSocket("session-a", socketA);
    registerSocket("session-b", socketB);

    unregisterSocket("session-a");
    const sockets = discoverSockets();

    expect(sockets).toEqual([socketB]);
  });

  it("unregisterSocketByPath removes stale marker by pipe path", () => {
    setPlatform("win32");
    useSandboxSocketDir();
    delete process.env.MARIMO_MCP_SOCKET;

    const socketA = getSocketPath("session-a");
    const socketB = getSocketPath("session-b");
    registerSocket("session-a", socketA);
    registerSocket("session-b", socketB);

    unregisterSocketByPath(socketA);
    const sockets = discoverSockets();

    expect(sockets).toEqual([socketB]);
  });
});
