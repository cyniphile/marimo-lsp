import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import type {
  CellOutput,
  CellStatus,
  IpcRequest,
  IpcRequestBody,
  IpcResponse,
  IpcResponseBody,
  NotebookInfo,
  NotebookStatus,
  RunCellsResult,
  RunStaleResult,
  TableInfo,
  VariableDeclaration,
  VariableValue,
} from "./types.ts";

// Re-export types for convenience
export type {
  CellOutput,
  CellStatus,
  IpcRequest,
  IpcRequestBody,
  IpcResponse,
  IpcResponseBody,
  NotebookInfo,
  NotebookStatus,
  RunCellsResult,
  RunStaleResult,
  TableInfo,
  VariableDeclaration,
  VariableValue,
};

function getUid(): string {
  return String(
    process.getuid?.() ?? process.env.USER ?? process.env.USERNAME ?? "default",
  );
}

const WINDOWS_SOCKET_MARKER_EXT = ".pipe";
const SESSION_TOKEN_LENGTH = 16;
const DEFAULT_IPC_REQUEST_TIMEOUT_MS = 15_000;

let cachedDarwinUserTempDir: string | null | undefined;

function getSessionToken(sessionId: string): string {
  return crypto
    .createHash("sha256")
    .update(sessionId)
    .digest("hex")
    .slice(0, SESSION_TOKEN_LENGTH);
}

export function getWindowId(sessionId: string): string {
  return getSessionToken(sessionId);
}

function getWindowsSocketMarkerPath(sessionId: string): string {
  return path.join(getSocketDir(), `${sessionId}${WINDOWS_SOCKET_MARKER_EXT}`);
}

function getRequestTimeoutMs(): number {
  const fromEnv = Number(process.env.MARIMO_MCP_IPC_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return DEFAULT_IPC_REQUEST_TIMEOUT_MS;
}

function normalizeTempDir(tmpDir: string): string {
  if (tmpDir.length > 1 && tmpDir.endsWith(path.sep)) {
    return tmpDir.slice(0, -1);
  }
  return tmpDir;
}

function getDarwinUserTempDir(): string | null {
  if (cachedDarwinUserTempDir !== undefined) {
    return cachedDarwinUserTempDir;
  }

  try {
    const value = execFileSync("getconf", ["DARWIN_USER_TEMP_DIR"], {
      encoding: "utf8",
    }).trim();
    cachedDarwinUserTempDir = value.length > 0 ? normalizeTempDir(value) : null;
  } catch {
    cachedDarwinUserTempDir = null;
  }

  return cachedDarwinUserTempDir;
}

function getUnixTempDirs(): string[] {
  const dirs = new Set<string>();
  const add = (tmpDir: string | undefined | null) => {
    if (!tmpDir) {
      return;
    }
    dirs.add(normalizeTempDir(tmpDir));
  };

  add(process.env.TMPDIR);
  add(os.tmpdir());
  if (process.platform === "darwin") {
    add(getDarwinUserTempDir());
  }
  // Stdio MCP clients often sanitize env vars (dropping TMPDIR), so include
  // canonical /tmp for compatibility with spawned child processes.
  add("/tmp");

  return [...dirs];
}

/**
 * Get the socket directory for multi-window IPC.
 * On Unix, this stores per-window socket files.
 * On Windows, this stores per-window marker files for named pipe discovery.
 */
export function getSocketDir(): string {
  const uid = getUid();
  return path.join(os.tmpdir(), `marimo-mcp-${uid}`);
}

/**
 * Get the IPC socket/pipe path.
 *
 * With a sessionId, returns a per-window socket path inside the socket directory.
 * Without a sessionId, returns the legacy single-socket path for backward compat.
 * Can be overridden via MARIMO_MCP_SOCKET environment variable.
 */
export function getSocketPath(sessionId?: string): string {
  // Allow override via environment variable
  const envPath = process.env.MARIMO_MCP_SOCKET;
  if (envPath) {
    return envPath;
  }

  const uid = getUid();

  if (process.platform === "win32") {
    if (sessionId) {
      // Keep pipe names short and deterministic to avoid platform path limits.
      return `\\\\.\\pipe\\marimo-mcp-${uid}-${getWindowId(sessionId)}`;
    }
    return `\\\\.\\pipe\\marimo-mcp-${uid}`;
  }

  // Unix domain socket
  if (sessionId) {
    // Use a compact token because full VS Code session IDs can exceed sun_path limits.
    return path.join(getSocketDir(), `${getWindowId(sessionId)}.sock`);
  }
  return path.join(os.tmpdir(), `marimo-mcp-${uid}.sock`);
}

/**
 * Register a session socket/pipe so CLI discovery can find it.
 * On Windows, this writes a marker file with the named pipe path.
 * On Unix, this is a no-op (socket files are discovered directly).
 */
export function registerSocket(sessionId: string, socketPath: string): void {
  if (process.env.MARIMO_MCP_SOCKET || process.platform !== "win32") {
    return;
  }

  fs.mkdirSync(getSocketDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(getWindowsSocketMarkerPath(sessionId), socketPath, "utf8");
}

/**
 * Remove a session socket registration.
 * On Unix, this is a no-op.
 */
export function unregisterSocket(sessionId: string): void {
  if (process.env.MARIMO_MCP_SOCKET || process.platform !== "win32") {
    return;
  }

  try {
    fs.unlinkSync(getWindowsSocketMarkerPath(sessionId));
  } catch {
    // Ignore if already gone
  }
}

/**
 * Remove stale Windows marker files that point to a dead named pipe.
 */
export function unregisterSocketByPath(socketPath: string): void {
  if (process.env.MARIMO_MCP_SOCKET || process.platform !== "win32") {
    return;
  }

  try {
    const entries = fs.readdirSync(getSocketDir());
    for (const entry of entries) {
      if (!entry.endsWith(WINDOWS_SOCKET_MARKER_EXT)) {
        continue;
      }
      const markerPath = path.join(getSocketDir(), entry);
      try {
        const markerValue = fs.readFileSync(markerPath, "utf8").trim();
        if (markerValue === socketPath) {
          fs.unlinkSync(markerPath);
        }
      } catch {
        // Ignore marker read/unlink errors
      }
    }
  } catch {
    // Registration directory may not exist
  }
}

/**
 * Discover all active extension sockets by scanning the socket directory.
 * Returns a list of socket file paths.
 */
export function discoverSockets(): string[] {
  // If env override is set, only use that single socket
  if (process.env.MARIMO_MCP_SOCKET) {
    return [process.env.MARIMO_MCP_SOCKET];
  }

  if (process.platform === "win32") {
    // On Windows, discover active named pipes via session marker files.
    try {
      const entries = fs.readdirSync(getSocketDir());
      const sockets = entries
        .filter((entry) => entry.endsWith(WINDOWS_SOCKET_MARKER_EXT))
        .map((entry) => {
          const markerPath = path.join(getSocketDir(), entry);
          try {
            const markerValue = fs.readFileSync(markerPath, "utf8").trim();
            if (markerValue.length > 0) {
              return markerValue;
            }
          } catch {
            // Fall through to session-derived pipe name below
          }

          const sessionId = entry.slice(0, -WINDOWS_SOCKET_MARKER_EXT.length);
          return sessionId.length > 0 ? getSocketPath(sessionId) : null;
        })
        .filter((socketPath): socketPath is string => socketPath !== null);

      if (sockets.length > 0) {
        return [...new Set(sockets)];
      }
    } catch {
      // Registration directory may not exist yet
    }

    // Backward compat fallback for pre-marker single-socket servers
    return [getSocketPath()];
  }

  const uid = getUid();
  const sockets = new Set<string>();

  // Discover per-session sockets across plausible temp roots.
  for (const tmpDir of getUnixTempDirs()) {
    const socketDir = path.join(tmpDir, `marimo-mcp-${uid}`);
    try {
      const entries = fs.readdirSync(socketDir);
      for (const entry of entries) {
        if (entry.endsWith(".sock")) {
          sockets.add(path.join(socketDir, entry));
        }
      }
    } catch {
      // Directory may not exist for this temp root
    }
  }

  // Backward compatibility: include legacy single-socket path if present.
  for (const tmpDir of getUnixTempDirs()) {
    const legacySocket = path.join(tmpDir, `marimo-mcp-${uid}.sock`);
    try {
      if (fs.existsSync(legacySocket)) {
        sockets.add(legacySocket);
      }
    } catch {
      // Ignore stat errors
    }
  }

  return [...sockets];
}

/**
 * IPC Client for the CLI to connect to the extension
 */
export class IpcClient {
  private socket: net.Socket | null = null;
  private responseBuffer = "";
  private pendingRequests: Map<
    number,
    {
      resolve: (value: IpcResponseBody) => void;
      reject: (error: Error) => void;
    }
  > = new Map();
  private requestId = 0;

  async connect(socketPath?: string): Promise<void> {
    const target = socketPath ?? getSocketPath();

    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(target, () => {
        resolve();
      });

      this.socket.on("error", (err) => {
        reject(err);
        this.rejectPending(err);
      });

      this.socket.on("close", () => {
        this.rejectPending(new Error("Socket closed"));
      });

      this.socket.on("data", (data) => {
        this.responseBuffer += data.toString();
        this.processResponses();
      });
    });
  }

  private rejectPending(err: Error): void {
    for (const [_id, pending] of this.pendingRequests) {
      pending.reject(err);
    }
    this.pendingRequests.clear();
  }

  private processResponses(): void {
    const lines = this.responseBuffer.split("\n");
    this.responseBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.trim()) {
        try {
          const response = JSON.parse(line) as IpcResponse;
          const pending = this.pendingRequests.get(response.id);
          if (pending) {
            this.pendingRequests.delete(response.id);
            pending.resolve(response);
          }
        } catch {
          // Ignore parse errors
        }
      }
    }
  }

  async request(req: IpcRequestBody): Promise<IpcResponseBody> {
    if (!this.socket) {
      throw new Error("Not connected");
    }

    const id = this.requestId++;
    const requestWithId: IpcRequest = { ...req, id };
    const timeoutMs = getRequestTimeoutMs();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`IPC request timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      this.socket?.write(`${JSON.stringify(requestWithId)}\n`);
    });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}
