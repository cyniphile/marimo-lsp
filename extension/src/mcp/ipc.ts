import * as fs from "node:fs";
import * as net from "node:net";
import { Effect, Option, Queue, Runtime } from "effect";
import type { NotebookId } from "../schemas.ts";
import type { DatasourcesService } from "../services/datasources/DatasourcesService.ts";
import { NotebookEditorRegistry } from "../services/NotebookEditorRegistry.ts";
import { VsCode } from "../services/VsCode.ts";
import type { VariablesService } from "../services/variables/VariablesService.ts";
import { Log } from "../utils/log.ts";
import {
  getSocketPath,
  type IpcRequest,
  type IpcRequestBody,
  type IpcResponse,
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
 * Check if a notebook is open and running, return a helpful error message if not.
 * Returns Option.none() if notebook is ready, Option.some(errorMessage) if not.
 */
function checkNotebookOpen(notebookUri: NotebookId) {
  return Effect.gen(function* () {
    const registry = yield* NotebookEditorRegistry;
    const editorOpt = yield* registry.getNotebookEditor(notebookUri);

    if (Option.isNone(editorOpt)) {
      return Option.some(
        `Notebook is not open or not running. To use MCP tools:\n` +
          `1. Open the notebook in VS Code (click the marimo icon or use "Open as marimo notebook")\n` +
          `2. Wait for the kernel to start (run a cell or wait for auto-instantiate)\n` +
          `3. Use list_notebooks to verify it appears in the list\n` +
          `Requested: ${notebookUri}`,
      );
    }

    return Option.none();
  });
}

// Re-export for convenience
export {
  getSocketPath,
  type IpcRequest,
  type IpcResponse,
} from "./ipc-client.ts";

type IpcServerDeps =
  | NotebookEditorRegistry
  | VariablesService
  | DatasourcesService
  | VsCode;

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
 * Check if a socket is in use by attempting to connect to it
 */
function isSocketInUse(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath, () => {
      // Connection succeeded - socket is in use
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      // Connection failed - socket is stale or doesn't exist
      resolve(false);
    });
  });
}

/**
 * Create the IPC server that listens for requests from the MCP CLI
 */
export function createIpcServer() {
  return Effect.gen(function* () {
    const socketPath = getSocketPath();

    // Check if another instance is already using this socket
    const inUse = yield* Effect.promise(() => isSocketInUse(socketPath));
    if (inUse) {
      yield* Log.warn(
        "MCP IPC socket already in use by another VS Code instance",
        { socketPath },
      );
      // Return without starting the server - another instance will handle MCP
      return { socketPath, active: false };
    }

    // Clean up stale socket file if it exists
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

    yield* Log.info("MCP IPC server started", { socketPath });

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
        try {
          fs.unlinkSync(socketPath);
        } catch {
          // Ignore cleanup errors
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
