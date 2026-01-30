/**
 * Shared MCP (Model Context Protocol) Type Definitions
 *
 * These types are used by both the IPC server (extension side) and
 * the IPC client (CLI side) for communication.
 */

/**
 * Information about an open marimo notebook
 */
export interface NotebookInfo {
  uri: string;
  name: string;
  cellCount: number;
}

/**
 * Variable declaration information showing which cells declare and use a variable
 */
export interface VariableDeclaration {
  name: string;
  declared_by: string[];
  used_by: string[];
}

/**
 * Current value and type of a variable
 */
export interface VariableValue {
  name: string;
  value: string | null;
  datatype: string | null;
}

/**
 * Table/dataset metadata from datasources
 */
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

/**
 * Output from a notebook cell
 */
export interface CellOutput {
  cell_index: number;
  cell_name: string | null;
  outputs: Array<{
    mime_type: string;
    text: string | null;
  }>;
}

/**
 * Result of running stale cells
 */
export interface RunStaleResult {
  success: boolean;
  cells_triggered: number;
  error?: string;
  message?: string;
}

/**
 * IPC request body types (without the id field)
 */
export type IpcRequestBody =
  | { type: "list_notebooks" }
  | { type: "get_variables"; notebook_uri: string }
  | { type: "get_variable_values"; notebook_uri: string }
  | { type: "get_tables"; notebook_uri: string }
  | { type: "get_cell_outputs"; notebook_uri: string }
  | { type: "run_stale"; notebook_uri: string };

/**
 * IPC request with id for request/response correlation
 */
export type IpcRequest = IpcRequestBody & { id: number };

/**
 * IPC response body types (without the id field)
 */
export type IpcResponseBody =
  | { type: "list_notebooks"; notebooks: NotebookInfo[] }
  | { type: "get_variables"; variables: VariableDeclaration[] }
  | { type: "get_variable_values"; variables: VariableValue[] }
  | { type: "get_tables"; tables: TableInfo[] }
  | { type: "get_cell_outputs"; outputs: CellOutput[] }
  | { type: "run_stale"; result: RunStaleResult }
  | { type: "error"; message: string };

/**
 * IPC response with id for request/response correlation
 */
export type IpcResponse = IpcResponseBody & { id: number };
