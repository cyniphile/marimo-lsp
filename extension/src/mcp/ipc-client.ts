import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type {
  CellOutput,
  IpcRequest,
  IpcRequestBody,
  IpcResponse,
  IpcResponseBody,
  NotebookInfo,
  RunStaleResult,
  TableInfo,
  VariableDeclaration,
  VariableValue,
} from "./types.ts";

// Re-export types for convenience
export type {
  CellOutput,
  IpcRequest,
  IpcRequestBody,
  IpcResponse,
  IpcResponseBody,
  NotebookInfo,
  RunStaleResult,
  TableInfo,
  VariableDeclaration,
  VariableValue,
};

/**
 * Get the IPC socket/pipe path.
 *
 * Uses a per-user path to avoid collisions between users.
 * Can be overridden via MARIMO_MCP_SOCKET environment variable.
 *
 * On Windows, uses named pipes. On Unix, uses Unix domain sockets.
 */
export function getSocketPath(): string {
  // Allow override via environment variable
  const envPath = process.env.MARIMO_MCP_SOCKET;
  if (envPath) {
    return envPath;
  }

  // Use per-user socket to avoid collisions
  const uid = process.getuid?.() ?? process.env.USER ?? "default";

  if (process.platform === "win32") {
    // Windows named pipe
    return `\\\\.\\pipe\\marimo-mcp-${uid}`;
  }

  // Unix domain socket
  const tmpDir = os.tmpdir();
  return path.join(tmpDir, `marimo-mcp-${uid}.sock`);
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

  async connect(): Promise<void> {
    const socketPath = getSocketPath();

    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(socketPath, () => {
        resolve();
      });

      this.socket.on("error", (err) => {
        reject(err);
      });

      this.socket.on("data", (data) => {
        this.responseBuffer += data.toString();
        this.processResponses();
      });
    });
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

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.socket?.write(`${JSON.stringify(requestWithId)}\n`);
    });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}
