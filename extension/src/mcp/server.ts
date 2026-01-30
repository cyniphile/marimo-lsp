import { Effect, Layer } from "effect";
import { Log } from "../utils/log.ts";
import { createIpcServer } from "./ipc.ts";

/**
 * MCP Server Layer
 *
 * This layer starts an IPC server when the extension activates.
 * The MCP CLI connects to this IPC server to query notebook data.
 *
 * Dependencies (NotebookEditorRegistry, VariablesService, DatasourcesService)
 * are provided through the Effect context, same as other views/layers.
 */
export const McpServerLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const { socketPath, active } = yield* createIpcServer();
    if (active) {
      yield* Log.info("MCP Server initialized", { socketPath });
    }
  }),
);
