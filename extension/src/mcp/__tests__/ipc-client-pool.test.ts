import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import type { IpcRequest, IpcResponseBody } from "../types.ts";

// Mock discoverSockets so we control which socket paths the pool sees
vi.mock("../ipc-client.ts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../ipc-client.ts")>();
  return {
    ...orig,
    discoverSockets: vi.fn(() => []),
  };
});

// Import after mock setup
import { discoverSockets } from "../ipc-client.ts";
import { IpcClientPool } from "../ipc-client-pool.ts";

const mockedDiscoverSockets = discoverSockets as Mock;

// ── Helpers ──────────────────────────────────────────────────────────────

interface MockServer {
  server: net.Server;
  connections: net.Socket[];
}

/**
 * Start a mock extension server on a Unix domain socket.
 * The handler receives the parsed request body and returns a response body.
 * Tracks connected sockets so they can be destroyed on shutdown.
 */
function createMockExtension(
  socketPath: string,
  handler: (req: IpcRequest) => IpcResponseBody,
): Promise<MockServer> {
  return new Promise((resolve) => {
    const connections: net.Socket[] = [];
    const server = net.createServer((socket) => {
      connections.push(socket);
      socket.on("close", () => {
        const idx = connections.indexOf(socket);
        if (idx !== -1) connections.splice(idx, 1);
      });

      let buffer = "";
      socket.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) {
            const request = JSON.parse(line) as IpcRequest;
            const responseBody = handler(request);
            const response = { ...responseBody, id: request.id };
            socket.write(`${JSON.stringify(response)}\n`);
          }
        }
      });
    });
    server.listen(socketPath, () => resolve({ server, connections }));
  });
}

/** Close a server and destroy all its active connections. */
function shutdownServer(mock: MockServer): Promise<void> {
  for (const conn of mock.connections) {
    conn.destroy();
  }
  mock.connections.length = 0;
  return new Promise((resolve) => mock.server.close(() => resolve()));
}

function popMockServerOrThrow(mockServers: MockServer[]): MockServer {
  const server = mockServers.pop();
  if (!server) {
    throw new Error("Expected a mock server to be available");
  }
  return server;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("IpcClientPool", () => {
  let tmpDir: string;
  let mockServers: MockServer[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "marimo-pool-test-"));
    mockServers = [];
    mockedDiscoverSockets.mockReturnValue([]);
  });

  afterEach(async () => {
    for (const ms of mockServers) {
      await shutdownServer(ms);
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function socketPath(name: string): string {
    return path.join(tmpDir, `${name}.sock`);
  }

  async function startServer(
    name: string,
    handler: (req: IpcRequest) => IpcResponseBody,
  ): Promise<string> {
    const sp = socketPath(name);
    const mock = await createMockExtension(sp, handler);
    mockServers.push(mock);
    return sp;
  }

  // ── refresh ──

  describe("refresh", () => {
    it("discovers and connects to sockets", async () => {
      const sp = await startServer("ext1", () => ({
        type: "list_notebooks",
        notebooks: [],
      }));

      mockedDiscoverSockets.mockReturnValue([sp]);

      const pool = new IpcClientPool();
      await pool.refresh();
      expect(pool.size).toBe(1);
    });

    it("removes clients when socket file disappears", async () => {
      const sp = await startServer("ext1", () => ({
        type: "list_notebooks",
        notebooks: [],
      }));

      mockedDiscoverSockets.mockReturnValue([sp]);
      const pool = new IpcClientPool();
      await pool.refresh();
      expect(pool.size).toBe(1);

      // Socket disappears from discovery
      mockedDiscoverSockets.mockReturnValue([]);
      await pool.refresh();
      expect(pool.size).toBe(0);
    });

    it("skips sockets that refuse connections (stale)", async () => {
      // Create a socket path that doesn't have a server behind it
      const stalePath = socketPath("stale");
      fs.writeFileSync(stalePath, "");

      mockedDiscoverSockets.mockReturnValue([stalePath]);

      const pool = new IpcClientPool();
      await pool.refresh();
      expect(pool.size).toBe(0);
    });
  });

  // ── requestAll ──

  describe("requestAll", () => {
    it("sends to all connected servers and returns paired results", async () => {
      const sp1 = await startServer("ext1", () => ({
        type: "list_notebooks",
        notebooks: [{ uri: "file:///a.py", name: "a.py", cellCount: 1 }],
      }));
      const sp2 = await startServer("ext2", () => ({
        type: "list_notebooks",
        notebooks: [{ uri: "file:///b.py", name: "b.py", cellCount: 2 }],
      }));

      mockedDiscoverSockets.mockReturnValue([sp1, sp2]);
      const pool = new IpcClientPool();
      await pool.refresh();

      const results = await pool.requestAll({ type: "list_notebooks" });
      expect(results).toHaveLength(2);

      const uris = results.flatMap((r) =>
        r.response.type === "list_notebooks"
          ? r.response.notebooks.map((n) => n.uri)
          : [],
      );
      expect(uris).toContain("file:///a.py");
      expect(uris).toContain("file:///b.py");
    });

    it("removes dead connections on error", async () => {
      const sp1 = await startServer("ext1", () => ({
        type: "list_notebooks",
        notebooks: [],
      }));

      mockedDiscoverSockets.mockReturnValue([sp1]);
      const pool = new IpcClientPool();
      await pool.refresh();
      expect(pool.size).toBe(1);

      // Shut down the server AND destroy connections so client gets an error
      await shutdownServer(popMockServerOrThrow(mockServers));

      const results = await pool.requestAll({ type: "list_notebooks" });
      // The request to the dead server should fail and be removed
      expect(results).toHaveLength(0);
      expect(pool.size).toBe(0);
    });

    it("empty pool returns empty array", async () => {
      const pool = new IpcClientPool();
      const results = await pool.requestAll({ type: "list_notebooks" });
      expect(results).toEqual([]);
    });
  });

  // ── requestOne ──

  describe("requestOne", () => {
    it("finds correct server for a notebook URI", async () => {
      const sp1 = await startServer("ext1", (req) => {
        if (
          req.type === "get_variables" &&
          req.notebook_uri === "file:///a.py"
        ) {
          return {
            type: "get_variables",
            variables: [{ name: "x", declared_by: ["cell1"], used_by: [] }],
          };
        }
        return { type: "error", message: "Notebook not found" };
      });
      const sp2 = await startServer("ext2", (req) => {
        if (
          req.type === "get_variables" &&
          req.notebook_uri === "file:///b.py"
        ) {
          return {
            type: "get_variables",
            variables: [{ name: "y", declared_by: ["cell2"], used_by: [] }],
          };
        }
        return { type: "error", message: "Notebook not found" };
      });

      mockedDiscoverSockets.mockReturnValue([sp1, sp2]);
      const pool = new IpcClientPool();
      await pool.refresh();

      const res = await pool.requestOne({
        type: "get_variables",
        notebook_uri: "file:///b.py",
      });

      expect(res.type).toBe("get_variables");
      if (res.type === "get_variables") {
        expect(res.variables[0].name).toBe("y");
      }
    });

    it("uses cached route on subsequent calls", async () => {
      let requestCount = 0;
      const sp1 = await startServer("ext1", (req) => {
        requestCount++;
        if (
          req.type === "get_variables" &&
          req.notebook_uri === "file:///a.py"
        ) {
          return {
            type: "get_variables",
            variables: [{ name: "x", declared_by: [], used_by: [] }],
          };
        }
        return { type: "error", message: "Notebook not found" };
      });
      // Second server that should NOT be tried once route is cached
      const sp2 = await startServer("ext2", () => ({
        type: "error",
        message: "Notebook not found",
      }));

      mockedDiscoverSockets.mockReturnValue([sp1, sp2]);
      const pool = new IpcClientPool();
      await pool.refresh();

      // First call — discovers the route
      await pool.requestOne({
        type: "get_variables",
        notebook_uri: "file:///a.py",
      });

      // Second call — should use cached route, only hitting ext1
      requestCount = 0;
      const res = await pool.requestOne({
        type: "get_variables",
        notebook_uri: "file:///a.py",
      });

      expect(res.type).toBe("get_variables");
      // Only the cached server should have been hit
      expect(requestCount).toBe(1);
    });

    it("falls back when cached route is stale", async () => {
      const sp1 = await startServer("ext1", (req) => {
        if (
          req.type === "get_variables" &&
          req.notebook_uri === "file:///a.py"
        ) {
          return {
            type: "get_variables",
            variables: [{ name: "x", declared_by: [], used_by: [] }],
          };
        }
        return { type: "error", message: "Notebook not found" };
      });

      mockedDiscoverSockets.mockReturnValue([sp1]);
      const pool = new IpcClientPool();
      await pool.refresh();

      // Prime the cache
      pool.updateRoutes(sp1, [
        { uri: "file:///a.py", name: "a.py", cellCount: 1 },
      ]);

      // Shut down the first server (destroys connections so client gets error)
      await shutdownServer(popMockServerOrThrow(mockServers));

      // Start a replacement server on a new socket
      const sp2 = await startServer("ext2", (req) => {
        if (
          req.type === "get_variables" &&
          req.notebook_uri === "file:///a.py"
        ) {
          return {
            type: "get_variables",
            variables: [{ name: "x_new", declared_by: [], used_by: [] }],
          };
        }
        return { type: "error", message: "Notebook not found" };
      });

      mockedDiscoverSockets.mockReturnValue([sp2]);
      await pool.refresh();

      const res = await pool.requestOne({
        type: "get_variables",
        notebook_uri: "file:///a.py",
      });

      expect(res.type).toBe("get_variables");
      if (res.type === "get_variables") {
        expect(res.variables[0].name).toBe("x_new");
      }
    });

    it("returns error when no server has the notebook", async () => {
      const sp1 = await startServer("ext1", () => ({
        type: "error",
        message: "Notebook not found",
      }));

      mockedDiscoverSockets.mockReturnValue([sp1]);
      const pool = new IpcClientPool();
      await pool.refresh();

      const res = await pool.requestOne({
        type: "get_variables",
        notebook_uri: "file:///missing.py",
      });

      expect(res.type).toBe("error");
      if (res.type === "error") {
        expect(res.message).toContain("file:///missing.py");
      }
    });

    it("preserves non-notebook errors from cached route", async () => {
      let ext2Requests = 0;
      const sp1 = await startServer("ext1", (req) => {
        if (
          req.type === "get_variables" &&
          req.notebook_uri === "file:///a.py"
        ) {
          return { type: "error", message: "backend exploded" };
        }
        return { type: "error", message: "Notebook not found" };
      });
      const sp2 = await startServer("ext2", (req) => {
        ext2Requests++;
        if (
          req.type === "get_variables" &&
          req.notebook_uri === "file:///a.py"
        ) {
          return {
            type: "get_variables",
            variables: [{ name: "x", declared_by: [], used_by: [] }],
          };
        }
        return { type: "error", message: "Notebook not found" };
      });

      mockedDiscoverSockets.mockReturnValue([sp1, sp2]);
      const pool = new IpcClientPool();
      await pool.refresh();
      pool.updateRoutes(sp1, [
        { uri: "file:///a.py", name: "a.py", cellCount: 1 },
      ]);

      const res = await pool.requestOne({
        type: "get_variables",
        notebook_uri: "file:///a.py",
      });

      expect(res.type).toBe("error");
      if (res.type === "error") {
        expect(res.message).toBe("backend exploded");
      }
      expect(ext2Requests).toBe(0);
    });
  });

  // ── updateRoutes ──

  describe("updateRoutes", () => {
    it("caches notebook→socket mapping used by requestOne", async () => {
      let ext1Requests = 0;
      const sp1 = await startServer("ext1", (req) => {
        ext1Requests++;
        if (
          req.type === "get_variables" &&
          req.notebook_uri === "file:///a.py"
        ) {
          return {
            type: "get_variables",
            variables: [{ name: "x", declared_by: [], used_by: [] }],
          };
        }
        return { type: "error", message: "Notebook not found" };
      });
      // ext2 would also return success, but should never be reached
      const sp2 = await startServer("ext2", (req) => {
        if (
          req.type === "get_variables" &&
          req.notebook_uri === "file:///a.py"
        ) {
          return {
            type: "get_variables",
            variables: [{ name: "wrong", declared_by: [], used_by: [] }],
          };
        }
        return { type: "error", message: "Notebook not found" };
      });

      mockedDiscoverSockets.mockReturnValue([sp1, sp2]);
      const pool = new IpcClientPool();
      await pool.refresh();

      // Pre-cache the route to ext1
      pool.updateRoutes(sp1, [
        { uri: "file:///a.py", name: "a.py", cellCount: 1 },
      ]);

      const res = await pool.requestOne({
        type: "get_variables",
        notebook_uri: "file:///a.py",
      });

      expect(res.type).toBe("get_variables");
      if (res.type === "get_variables") {
        expect(res.variables[0].name).toBe("x");
      }
      // Should have gone directly to ext1 via cached route
      expect(ext1Requests).toBe(1);
    });
  });

  // ── size ──

  describe("size", () => {
    it("reflects connected client count", async () => {
      const pool = new IpcClientPool();
      expect(pool.size).toBe(0);

      const sp1 = await startServer("ext1", () => ({
        type: "list_notebooks",
        notebooks: [],
      }));
      const sp2 = await startServer("ext2", () => ({
        type: "list_notebooks",
        notebooks: [],
      }));

      mockedDiscoverSockets.mockReturnValue([sp1, sp2]);
      await pool.refresh();
      expect(pool.size).toBe(2);

      // Remove one
      mockedDiscoverSockets.mockReturnValue([sp1]);
      await pool.refresh();
      expect(pool.size).toBe(1);
    });
  });
});
