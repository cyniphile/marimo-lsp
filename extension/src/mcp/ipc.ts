import * as fs from "node:fs";
import * as net from "node:net";

import { Effect, Option, Queue, Runtime } from "effect";

import type { DatasourcesService } from "../panel/datasources/DatasourcesService.ts";
import type { VariablesService } from "../panel/variables/VariablesService.ts";
import { VsCode } from "../platform/VsCode.ts";
import {
  MarimoNotebookDocument,
  type NotebookId,
} from "../schemas/MarimoNotebookDocument.ts";
import {
  discoverSockets,
  getSocketDir,
  getSocketPath,
  type IpcRequest,
  type IpcRequestBody,
  type IpcResponse,
  registerSocket,
  unregisterSocket,
  unregisterSocketByPath,
} from "./ipc-client.ts";
import {
  getCellOutputs,
  getNotebookStatus,
  getTables,
  getVariables,
  getVariableValues,
  listNotebooks,
  runCells,
  runStale,
} from "./tools.ts";
import type { RunCellsResult, RunStaleResult } from "./types.ts";

/**
 * Check if a marimo notebook document is currently open, returning a helpful
 * error message if not.
 * Returns Option.none() if notebook is ready, Option.some(errorMessage) if not.
 */
function checkNotebookOpen(notebookUri: NotebookId) {
  return Effect.gen(function* () {
    const code = yield* VsCode;
    const notebookDocs = yield* code.workspace.getNotebookDocuments();
    const isOpen = notebookDocs.some((doc) => {
      if (doc.uri.toString() !== notebookUri) {
        return false;
      }
      return Option.isSome(MarimoNotebookDocument.tryFrom(doc));
    });

    if (!isOpen) {
      return Option.some(
        `Notebook is not currently open as a marimo notebook. To use MCP tools:\n` +
          `1. Open the notebook in VS Code (click the marimo icon or use "Open as marimo notebook")\n` +
          `2. Use list_notebooks to verify it appears in the list\n` +
          `Requested: ${notebookUri}`,
      );
    }

    return Option.none();
  });
}

// Re-export for convenience
export {
  getSocketDir,
  getSocketPath,
  type IpcRequest,
  type IpcResponse,
} from "./ipc-client.ts";

type IpcServerDeps = VariablesService | DatasourcesService | VsCode;

/**
 * Handle an IPC request and return a response body
 */
function handleRequestBody(request: IpcRequestBody) {
  return Effect.gen(function* () {
    switch (request.type) {
      case "list_notebooks": {
        const notebooks = yield* listNotebooks();
        return { type: "list_notebooks" as const, notebooks };
      }
      case "get_variables": {
        const notebookError = yield* checkNotebookOpen(
          request.notebook_uri as NotebookId,
        );
        if (Option.isSome(notebookError)) {
          return { type: "error" as const, message: notebookError.value };
        }
        const variables = yield* getVariables(
          request.notebook_uri as NotebookId,
        );
        return { type: "get_variables" as const, variables };
      }
      case "get_variable_values": {
        const notebookError = yield* checkNotebookOpen(
          request.notebook_uri as NotebookId,
        );
        if (Option.isSome(notebookError)) {
          return { type: "error" as const, message: notebookError.value };
        }
        const variables = yield* getVariableValues(
          request.notebook_uri as NotebookId,
        );
        return { type: "get_variable_values" as const, variables };
      }
      case "get_tables": {
        const notebookError = yield* checkNotebookOpen(
          request.notebook_uri as NotebookId,
        );
        if (Option.isSome(notebookError)) {
          return { type: "error" as const, message: notebookError.value };
        }
        const tables = yield* getTables(request.notebook_uri as NotebookId);
        return { type: "get_tables" as const, tables };
      }
      case "get_cell_outputs": {
        const notebookError = yield* checkNotebookOpen(
          request.notebook_uri as NotebookId,
        );
        if (Option.isSome(notebookError)) {
          return { type: "error" as const, message: notebookError.value };
        }
        const outputs = yield* getCellOutputs(
          request.notebook_uri as NotebookId,
        );
        return { type: "get_cell_outputs" as const, outputs };
      }
      case "get_notebook_status": {
        const notebookError = yield* checkNotebookOpen(
          request.notebook_uri as NotebookId,
        );
        if (Option.isSome(notebookError)) {
          return { type: "error" as const, message: notebookError.value };
        }
        const status = yield* getNotebookStatus(
          request.notebook_uri as NotebookId,
        );
        return { type: "get_notebook_status" as const, status };
      }
      case "run_stale": {
        // Check if run is enabled in settings (disabled by default for security)
        const code = yield* VsCode;
        const config = yield* code.workspace.getConfiguration("marimo.mcp");
        const enableRun = config.get<boolean>("enableRun") ?? false;

        if (!enableRun) {
          const result: RunStaleResult = {
            success: false,
            cells_triggered: 0,
            error:
              "Cell execution is disabled. Enable 'marimo.mcp.enableRun' in VS Code settings to allow MCP clients to execute notebook cells.",
          };
          return { type: "run_stale" as const, result };
        }

        const result = yield* runStale(request.notebook_uri as NotebookId);
        return { type: "run_stale" as const, result };
      }
      case "run_cells": {
        // Check if run is enabled in settings (disabled by default for security)
        const code = yield* VsCode;
        const config = yield* code.workspace.getConfiguration("marimo.mcp");
        const enableRun = config.get<boolean>("enableRun") ?? false;

        if (!enableRun) {
          const result: RunCellsResult = {
            success: false,
            cells_triggered: 0,
            error:
              "Cell execution is disabled. Enable 'marimo.mcp.enableRun' in VS Code settings to allow MCP clients to execute notebook cells.",
          };
          return { type: "run_cells" as const, result };
        }

        const result = yield* runCells(
          request.notebook_uri as NotebookId,
          request.cell_indices,
        );
        return { type: "run_cells" as const, result };
      }
    }
  });
}

/**
 * Check if a socket is alive by attempting to connect to it.
 * Used to clean up stale sockets from crashed extensions.
 */
function isSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      resolve(false);
    });
  });
}

/**
 * Clean up stale sockets in the socket directory.
 * Tries to connect to each discovered socket; removes those that are dead.
 */
function cleanupStaleSockets() {
  return Effect.gen(function* () {
    const sockets = discoverSockets();
    for (const socketPath of sockets) {
      const alive = yield* Effect.promise(() => isSocketAlive(socketPath));
      if (!alive) {
        yield* Effect.sync(() => {
          if (process.platform === "win32") {
            unregisterSocketByPath(socketPath);
          } else {
            try {
              fs.unlinkSync(socketPath);
            } catch {
              // Ignore — already gone
            }
          }
        });
        yield* Effect.logDebug("Cleaned up stale socket").pipe(
          Effect.annotateLogs({ socketPath }),
        );
      }
    }
  });
}

/**
 * Create the IPC server that listens for requests from the MCP CLI.
 * Each VS Code window gets its own socket identified by sessionId.
 */
export function createIpcServer(sessionId: string) {
  return Effect.gen(function* () {
    const socketPath = getSocketPath(sessionId);

    // Ensure socket directory exists (Unix only, no-op for env override)
    if (!process.env.MARIMO_MCP_SOCKET && process.platform !== "win32") {
      yield* Effect.sync(() => {
        fs.mkdirSync(getSocketDir(), { recursive: true, mode: 0o700 });
      });
    }

    // Clean up stale sockets from previous crashed extensions
    yield* cleanupStaleSockets();

    // Remove our own socket if it exists (stale from a previous crash)
    yield* Effect.sync(() => {
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // Ignore errors if file doesn't exist
      }
    });

    const server = net.createServer();
    const connectionQueue = yield* Queue.unbounded<net.Socket>();

    // Get the runtime so we can run effects inside socket handlers
    const runtime = yield* Effect.runtime<IpcServerDeps>();

    // Handle incoming connections
    server.on("connection", (socket) => {
      Runtime.runSync(runtime)(Queue.offer(connectionQueue, socket));
    });

    // Start listening
    yield* Effect.async<void, Error>((resume) => {
      server.listen(socketPath, () => {
        resume(Effect.void);
      });
      server.on("error", (err) => {
        resume(Effect.fail(err));
      });
    });

    yield* Effect.sync(() => {
      registerSocket(sessionId, socketPath);
    });

    yield* Effect.logInfo("MCP IPC server started").pipe(
      Effect.annotateLogs({ socketPath, sessionId }),
    );

    // Process connections in the background
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        while (true) {
          const socket = yield* Queue.take(connectionQueue);
          yield* Effect.fork(handleConnection(socket, runtime));
        }
      }),
    );

    // Register cleanup
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        server.close();
        unregisterSocket(sessionId);
        if (process.platform !== "win32") {
          try {
            fs.unlinkSync(socketPath);
          } catch {
            // Ignore cleanup errors
          }
        }
      }),
    );

    return { socketPath, active: true };
  });
}

/**
 * Handle a single client connection
 */
function handleConnection(
  socket: net.Socket,
  runtime: Runtime.Runtime<IpcServerDeps>,
) {
  return Effect.gen(function* () {
    let buffer = "";

    yield* Effect.async<void, Error>((resume) => {
      socket.on("data", (data) => {
        buffer += data.toString();

        // Process complete messages (newline-delimited JSON)
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.trim()) {
            // Run the request handler with the runtime that has services
            let requestId = 0;
            try {
              const parsed = JSON.parse(line) as IpcRequest;
              requestId = parsed.id;
            } catch {
              // Will handle below
            }

            Runtime.runPromise(runtime)(
              Effect.gen(function* () {
                try {
                  const request = JSON.parse(line) as IpcRequest;
                  const { id, ...body } = request;
                  const responseBody = yield* handleRequestBody(
                    body as IpcRequestBody,
                  );
                  const response: IpcResponse = { ...responseBody, id };
                  socket.write(`${JSON.stringify(response)}\n`);
                } catch (error) {
                  const errorResponse: IpcResponse = {
                    type: "error",
                    message:
                      error instanceof Error ? error.message : "Unknown error",
                    id: requestId,
                  };
                  socket.write(`${JSON.stringify(errorResponse)}\n`);
                }
              }),
            ).catch((error) => {
              const errorResponse: IpcResponse = {
                type: "error",
                message:
                  error instanceof Error ? error.message : "Unknown error",
                id: requestId,
              };
              socket.write(`${JSON.stringify(errorResponse)}\n`);
            });
          }
        }
      });

      socket.on("close", () => {
        resume(Effect.void);
      });

      socket.on("error", (err) => {
        resume(Effect.fail(err));
      });
    });
  }).pipe(Effect.catchAll(() => Effect.void));
}
