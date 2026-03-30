import { Effect, Layer } from "effect";

import { VsCode } from "../platform/VsCode.ts";
import { createIpcServer } from "./ipc.ts";

/**
 * MCP Server Layer
 *
 * This layer starts an IPC server when the extension activates.
 * The MCP CLI connects to this IPC server to query notebook data.
 *
 * Each VS Code window gets its own socket, identified by vscode.env.sessionId.
 * The MCP CLI discovers all active sockets and aggregates responses.
 *
 * Dependencies are provided through the Effect context, same as other
 * views/layers.
 */
export const McpServerLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;
    const sessionId = code.env.sessionId;

    yield* createIpcServer(sessionId).pipe(
      Effect.tap(({ socketPath }) =>
        Effect.logInfo("MCP Server initialized").pipe(
          Effect.annotateLogs({ socketPath, sessionId }),
        ),
      ),
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          const message =
            "Marimo MCP server failed to start. Claude Code integration is disabled for this window.";
          yield* Effect.logWarning(message).pipe(
            Effect.annotateLogs({ sessionId, error }),
          );
          yield* code.window.showWarningMessage(
            `${message} See marimo logs for details.`,
          );
        }),
      ),
    );
  }),
);
