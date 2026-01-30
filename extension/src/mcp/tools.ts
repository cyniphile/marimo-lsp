import { Effect, HashMap, Option } from "effect";
import { MarimoNotebookDocument, type NotebookId } from "../schemas.ts";
import { DatasourcesService } from "../services/datasources/DatasourcesService.ts";
import { NotebookEditorRegistry } from "../services/NotebookEditorRegistry.ts";
import { VariablesService } from "../services/variables/VariablesService.ts";
import { VsCode } from "../services/VsCode.ts";

/**
 * MCP Tool Definitions for exposing marimo notebook data to Claude Code
 */

export interface NotebookInfo {
  uri: string;
  name: string;
  cellCount: number;
}

export interface VariableDeclaration {
  name: string;
  declared_by: string[];
  used_by: string[];
}

export interface VariableValue {
  name: string;
  value: string | null;
  datatype: string | null;
}

export interface TableInfo {
  name: string;
  source: string;
  source_type: "catalog" | "connection" | "duckdb" | "local";
  num_rows: number | null;
  num_columns: number | null;
  variable_name: string | null;
  columns: Array<{
    name: string;
    type: string;
  }>;
}

export interface CellOutput {
  cell_index: number;
  cell_name: string | null;
  outputs: Array<{
    mime_type: string;
    text: string | null;
  }>;
}

/**
 * List all open marimo notebooks
 */
export function listNotebooks() {
  return Effect.gen(function* () {
    const registry = yield* NotebookEditorRegistry;
    const editors = yield* registry.getNotebookEditors();

    const notebooks: NotebookInfo[] = [];
    for (const [uri, editor] of editors) {
      const name = editor.notebook.uri.fsPath.split("/").pop() ?? "Untitled";
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

export interface RunStaleResult {
  success: boolean;
  cells_triggered: number;
  error?: string;
  message?: string;
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

    const staleCells = notebook.value
      .getCells()
      .filter((cell) => cell.isStale);
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
    });

    return {
      success: true,
      cells_triggered: staleCells.length,
    } as RunStaleResult;
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
