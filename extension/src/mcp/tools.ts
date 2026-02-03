import * as path from "node:path";
import { Duration, Effect, Option } from "effect";
import { MarimoNotebookDocument, type NotebookId } from "../schemas.ts";
import { DatasourcesService } from "../services/datasources/DatasourcesService.ts";
import { ExecutionRegistry } from "../services/ExecutionRegistry.ts";
import { NotebookEditorRegistry } from "../services/NotebookEditorRegistry.ts";
import { VsCode } from "../services/VsCode.ts";
import { VariablesService } from "../services/variables/VariablesService.ts";
import type {
  CellOutput,
  CellStatus,
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
  NotebookInfo,
  NotebookStatus,
  RunCellsResult,
  RunStaleResult,
  TableInfo,
  VariableDeclaration,
  VariableValue,
};

/**
 * List all open marimo notebooks
 */
export function listNotebooks() {
  return Effect.gen(function* () {
    const registry = yield* NotebookEditorRegistry;
    const editors = yield* registry.getNotebookEditors();

    const notebooks: NotebookInfo[] = [];
    for (const [uri, editor] of editors) {
      const name = path.basename(editor.notebook.uri.fsPath) || "Untitled";
      notebooks.push({
        uri,
        name,
        cellCount: editor.notebook.cellCount,
      });
    }

    return notebooks;
  });
}

/**
 * Get variable declarations for a specific notebook
 */
export function getVariables(notebookUri: NotebookId) {
  return Effect.gen(function* () {
    const variablesService = yield* VariablesService;
    const variablesOpt = yield* variablesService.getVariables(notebookUri);

    return Option.match(variablesOpt, {
      onNone: () => [] as VariableDeclaration[],
      onSome: (vars) =>
        vars.map((v) => ({
          name: v.name,
          declared_by: [...v.declaredBy],
          used_by: [...v.usedBy],
        })),
    });
  });
}

/**
 * Get variable values for a specific notebook
 */
export function getVariableValues(notebookUri: NotebookId) {
  return Effect.gen(function* () {
    const variablesService = yield* VariablesService;
    const valuesOpt = yield* variablesService.getVariableValues(notebookUri);

    return Option.match(valuesOpt, {
      onNone: () => [] as VariableValue[],
      onSome: (vars) =>
        vars.map((v) => ({
          name: v.name,
          value: v.value ?? null,
          datatype: v.datatype ?? null,
        })),
    });
  });
}

/**
 * Get table/dataset metadata for a specific notebook
 */
export function getTables(notebookUri: NotebookId) {
  return Effect.gen(function* () {
    const datasourcesService = yield* DatasourcesService;
    const datasetsOpt = yield* datasourcesService.getDatasets(notebookUri);

    return Option.match(datasetsOpt, {
      onNone: () => [] as TableInfo[],
      onSome: (datasets) => {
        const tables: TableInfo[] = [];
        for (const [, table] of datasets.tables) {
          tables.push({
            name: table.name,
            source: table.source,
            source_type: table.source_type,
            num_rows: table.num_rows,
            num_columns: table.num_columns,
            variable_name: table.variable_name,
            columns: table.columns.map((c) => ({
              name: c.name,
              type: c.type,
            })),
          });
        }
        return tables;
      },
    });
  });
}

/**
 * Get cell outputs for a specific notebook
 */
export function getCellOutputs(notebookUri: NotebookId) {
  return Effect.gen(function* () {
    const registry = yield* NotebookEditorRegistry;
    const editorOpt = yield* registry.getNotebookEditor(notebookUri);

    return Option.match(editorOpt, {
      onNone: () => [] as CellOutput[],
      onSome: (editor) => {
        const results: CellOutput[] = [];
        const cells = editor.notebook.getCells();

        for (let i = 0; i < cells.length; i++) {
          const cell = cells[i];
          const outputs: Array<{ mime_type: string; text: string | null }> = [];

          for (const output of cell.outputs) {
            for (const item of output.items) {
              // Convert Uint8Array to string for text-based MIME types
              let text: string | null = null;
              const textMimeTypes = [
                "application/json",
                "application/javascript",
                "application/vnd.code.notebook.stdout",
                "application/vnd.code.notebook.stderr",
                "application/vnd.code.notebook.error",
                "application/vnd.marimo.ui+json",
              ];
              if (
                item.mime.startsWith("text/") ||
                item.mime.endsWith("+json") ||
                textMimeTypes.includes(item.mime)
              ) {
                try {
                  text = new TextDecoder().decode(item.data);
                } catch {
                  text = null;
                }
              }
              outputs.push({
                mime_type: item.mime,
                text,
              });
            }
          }

          // Get cell name from metadata if available
          let cellName: string | null = null;
          try {
            const metadata = cell.metadata as { name?: string } | undefined;
            cellName = metadata?.name ?? null;
          } catch {
            // Ignore metadata parsing errors
          }

          results.push({
            cell_index: i,
            cell_name: cellName,
            outputs,
          });
        }

        return results;
      },
    });
  });
}

/**
 * Run all stale (changed) cells in a marimo notebook.
 * Triggers execution asynchronously - returns immediately.
 * Use get_cell_outputs to check results after execution completes.
 */
export function runStale(notebookUri: NotebookId) {
  return Effect.gen(function* () {
    const registry = yield* NotebookEditorRegistry;
    const code = yield* VsCode;
    const editorOpt = yield* registry.getNotebookEditor(notebookUri);

    if (Option.isNone(editorOpt)) {
      return {
        success: false,
        error: "Notebook not found",
        cells_triggered: 0,
      } as RunStaleResult;
    }

    const editor = editorOpt.value;
    const notebook = MarimoNotebookDocument.tryFrom(editor.notebook);
    if (Option.isNone(notebook)) {
      return {
        success: false,
        error: "Not a marimo notebook",
        cells_triggered: 0,
      } as RunStaleResult;
    }

    const staleCells = notebook.value.getCells().filter((cell) => cell.isStale);
    if (staleCells.length === 0) {
      return {
        success: true,
        cells_triggered: 0,
        message: "No stale cells",
      } as RunStaleResult;
    }

    // Trigger execution (async - returns immediately)
    yield* code.commands.executeCommand("notebook.cell.execute", {
      ranges: staleCells.map((cell) => ({
        start: cell.index,
        end: cell.index + 1,
      })),
      document: editor.notebook.uri,
    });

    return {
      success: true,
      cells_triggered: staleCells.length,
    } as RunStaleResult;
  });
}

/**
 * Run specific cells by index in a marimo notebook.
 * Triggers execution asynchronously - returns immediately.
 * Use get_cell_outputs to check results after execution completes.
 */
export function runCells(notebookUri: NotebookId, cellIndices: number[]) {
  return Effect.gen(function* () {
    const registry = yield* NotebookEditorRegistry;
    const code = yield* VsCode;
    const editorOpt = yield* registry.getNotebookEditor(notebookUri);

    if (Option.isNone(editorOpt)) {
      return {
        success: false,
        error: "Notebook not found",
        cells_triggered: 0,
      } as RunCellsResult;
    }

    const editor = editorOpt.value;
    const notebook = MarimoNotebookDocument.tryFrom(editor.notebook);
    if (Option.isNone(notebook)) {
      return {
        success: false,
        error: "Not a marimo notebook",
        cells_triggered: 0,
      } as RunCellsResult;
    }

    const totalCells = notebook.value.getCells().length;

    // Validate cell indices
    const invalidIndices = cellIndices.filter((i) => i < 0 || i >= totalCells);
    if (invalidIndices.length > 0) {
      return {
        success: false,
        error: `Invalid cell indices: ${invalidIndices.join(", ")}. Notebook has ${totalCells} cells (0-${totalCells - 1}).`,
        cells_triggered: 0,
      } as RunCellsResult;
    }

    // Dedupe and sort for deterministic execution order
    const uniqueIndices = [...new Set(cellIndices)].sort((a, b) => a - b);

    if (uniqueIndices.length === 0) {
      return {
        success: true,
        cells_triggered: 0,
      } as RunCellsResult;
    }

    // Trigger execution (async - returns immediately)
    yield* code.commands.executeCommand("notebook.cell.execute", {
      ranges: uniqueIndices.map((i) => ({
        start: i,
        end: i + 1,
      })),
      document: editor.notebook.uri,
    });

    return {
      success: true,
      cells_triggered: uniqueIndices.length,
    } as RunCellsResult;
  });
}

type ExecutionState = "pending" | "running" | "completed" | "none";

/**
 * Try to get execution states from the registry with a timeout.
 * Returns empty map if ExecutionRegistry isn't available or times out.
 */
function tryGetExecutionStates(): Effect.Effect<
  Map<string, ExecutionState>,
  never,
  never
> {
  return Effect.serviceOption(ExecutionRegistry).pipe(
    Effect.flatMap((registryOpt) =>
      Option.match(registryOpt, {
        onNone: () => Effect.succeed(new Map<string, ExecutionState>()),
        onSome: (registry) =>
          registry.getCellExecutionStates().pipe(
            Effect.timeoutTo({
              duration: Duration.millis(100),
              onTimeout: () => new Map<string, ExecutionState>(),
              onSuccess: (map) => map,
            }),
            Effect.catchAll(() =>
              Effect.succeed(new Map<string, ExecutionState>()),
            ),
          ),
      }),
    ),
  );
}

/**
 * Get notebook execution status (which cells are running, queued, stale)
 */
export function getNotebookStatus(notebookUri: NotebookId) {
  return Effect.gen(function* () {
    const registry = yield* NotebookEditorRegistry;
    const editorOpt = yield* registry.getNotebookEditor(notebookUri);

    if (Option.isNone(editorOpt)) {
      return {
        cells: [],
        is_busy: false,
        running_count: 0,
        queued_count: 0,
        stale_count: 0,
      } as NotebookStatus;
    }

    const editor = editorOpt.value;
    const cells: CellStatus[] = [];
    let runningCount = 0;
    let queuedCount = 0;
    let staleCount = 0;

    // Try to get execution states (with timeout to avoid blocking)
    const executionStates = yield* tryGetExecutionStates();

    // Access raw cells directly
    const rawCells = editor.notebook.getCells();

    for (let i = 0; i < rawCells.length; i++) {
      const cell = rawCells[i];

      let state: "idle" | "queued" | "running" | "stale" | "unknown" = "idle";
      let cellName: string | null = null;

      try {
        const metadata = cell.metadata as
          | { state?: string; name?: string; stableId?: string }
          | undefined;
        cellName = metadata?.name ?? null;

        // First check execution registry for running/pending state
        const stableId = metadata?.stableId;
        if (stableId && executionStates.size > 0) {
          const execState = executionStates.get(stableId);
          if (execState === "running") {
            state = "running";
          } else if (execState === "pending") {
            state = "queued";
          }
        }

        // If not running/queued, check metadata for stale state
        if (state === "idle") {
          const rawState = metadata?.state;
          if (rawState === "stale") {
            state = "stale";
          }
        }
      } catch {
        // Ignore metadata parsing errors
        state = "unknown";
      }

      cells.push({
        cell_index: i,
        cell_name: cellName,
        state,
      });

      if (state === "running") runningCount++;
      if (state === "queued") queuedCount++;
      if (state === "stale") staleCount++;
    }

    return {
      cells,
      is_busy: runningCount > 0 || queuedCount > 0,
      running_count: runningCount,
      queued_count: queuedCount,
      stale_count: staleCount,
    } as NotebookStatus;
  });
}

/**
 * The type of services required for MCP tools
 */
export type McpToolsDeps =
  | NotebookEditorRegistry
  | VariablesService
  | DatasourcesService
  | VsCode;
