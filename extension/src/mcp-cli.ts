#!/usr/bin/env node
/**
 * MCP CLI Entry Point
 *
 * This is the CLI that Claude Code spawns. It communicates via STDIO with Claude Code
 * and connects to VS Code extension instances via IPC to query notebook data.
 *
 * Supports multiple VS Code windows: discovers all active extension sockets
 * and aggregates responses across them.
 *
 * This file is intentionally kept standalone with no VS Code dependencies.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { IpcClientPool } from "./mcp/ipc-client-pool.ts";
import type { IpcRequestBody, NotebookInfo } from "./mcp/ipc-client.ts";

// ── MCP Server ─────────────────────────────────────────────────────────────

const notebookUriProperty = {
  type: "string",
  description: "The URI of the notebook (from list_notebooks output)",
} as const;

const windowIdProperty = {
  type: "string",
  description:
    "Optional opaque per-window token from list_notebooks. Provide this when the same notebook URI is open in multiple VS Code windows.",
} as const;

const mcpServer = new Server(
  {
    name: "marimo-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

const pool = new IpcClientPool();

async function ensureConnected(): Promise<void> {
  await pool.refresh();
  if (pool.size === 0) {
    throw new Error(
      "No VS Code windows with marimo notebooks found. Make sure at least one VS Code window with a marimo notebook is open.",
    );
  }
}

// List available tools
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_notebooks",
        description:
          "List all open marimo notebooks in VS Code. Returns notebook URIs, names, cell counts, and window_id values for disambiguating the same notebook across multiple VS Code windows.",
        inputSchema: {
          type: "object" as const,
          properties: {},
          required: [],
        },
      },
      {
        name: "get_variables",
        description:
          "Get variable declarations for a specific marimo notebook. Returns which cells declare and use each variable.",
        inputSchema: {
          type: "object" as const,
          properties: {
            notebook_uri: notebookUriProperty,
            window_id: windowIdProperty,
          },
          required: ["notebook_uri"],
        },
      },
      {
        name: "get_variable_values",
        description:
          "Get current variable values for a specific marimo notebook. Returns the name, value, and datatype of each variable. Note: Large DataFrames will show truncated representations. If you need to inspect large data, first add a summary cell (df.head(), df.describe()) to the notebook and run it.",
        inputSchema: {
          type: "object" as const,
          properties: {
            notebook_uri: notebookUriProperty,
            window_id: windowIdProperty,
          },
          required: ["notebook_uri"],
        },
      },
      {
        name: "get_tables",
        description:
          "Get dataset/table metadata for a specific marimo notebook. Returns table names, sources, row/column counts, and column definitions. Use this FIRST to check data sizes before trying to inspect full outputs - if a table has many rows, add filtering/summary cells to the notebook instead of loading raw data.",
        inputSchema: {
          type: "object" as const,
          properties: {
            notebook_uri: notebookUriProperty,
            window_id: windowIdProperty,
          },
          required: ["notebook_uri"],
        },
      },
      {
        name: "get_cell_outputs",
        description:
          "Get cell outputs for a specific marimo notebook. Returns the stdout/stderr and other outputs from each cell after execution. WARNING: Can return very large results if cells output large DataFrames or long logs. If outputs are too large, edit the notebook to add summary/filter cells (e.g., df.head(10), df.describe()) and run those instead of trying to load raw data.",
        inputSchema: {
          type: "object" as const,
          properties: {
            notebook_uri: notebookUriProperty,
            window_id: windowIdProperty,
          },
          required: ["notebook_uri"],
        },
      },
      {
        name: "run_stale",
        description:
          "Run all stale (changed) cells in a marimo notebook. Returns immediately - use get_cell_outputs to check results after execution completes.",
        inputSchema: {
          type: "object" as const,
          properties: {
            notebook_uri: notebookUriProperty,
            window_id: windowIdProperty,
          },
          required: ["notebook_uri"],
        },
      },
      {
        name: "run_cells",
        description:
          "Run specific cells by index in a marimo notebook. Returns immediately - use get_cell_outputs to check results after execution completes.",
        inputSchema: {
          type: "object" as const,
          properties: {
            notebook_uri: notebookUriProperty,
            window_id: windowIdProperty,
            cell_indices: {
              type: "array",
              items: { type: "number" },
              description:
                "Array of cell indices to run (0-based). Use list_notebooks to get cell count.",
            },
          },
          required: ["notebook_uri", "cell_indices"],
        },
      },
      {
        name: "get_notebook_status",
        description:
          "Get execution status for a marimo notebook. Returns cell states (idle, queued, running, stale) and counts. Use this after run_stale or run_cells to check if execution has completed (is_busy = false means all cells finished).",
        inputSchema: {
          type: "object" as const,
          properties: {
            notebook_uri: notebookUriProperty,
            window_id: windowIdProperty,
          },
          required: ["notebook_uri"],
        },
      },
    ],
  };
});

// Handle tool calls
mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    await ensureConnected();

    // ── list_notebooks: aggregate across all windows ──
    if (name === "list_notebooks") {
      const results = await pool.requestAll({ type: "list_notebooks" });
      const allNotebooks: NotebookInfo[] = [];
      for (const { socketPath, response } of results) {
        if (response.type === "list_notebooks") {
          allNotebooks.push(...response.notebooks);
          // Cache notebook→socket routing for faster subsequent requests
          pool.updateRoutes(socketPath, response.notebooks);
        }
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(allNotebooks, null, 2),
          },
        ],
      };
    }

    // ── notebook-specific tools: route to the right window ──
    let body: IpcRequestBody & { notebook_uri: string; window_id?: string };
    const notebookTarget = args as {
      notebook_uri: string;
      window_id?: string;
    };

    switch (name) {
      case "get_variables":
      case "get_variable_values":
      case "get_tables":
      case "get_cell_outputs":
      case "get_notebook_status":
      case "run_stale":
        body = {
          type: name,
          notebook_uri: notebookTarget.notebook_uri,
          window_id: notebookTarget.window_id,
        };
        break;

      case "run_cells":
        body = {
          type: "run_cells",
          notebook_uri: notebookTarget.notebook_uri,
          window_id: notebookTarget.window_id,
          cell_indices: (args as { cell_indices: number[] }).cell_indices,
        };
        break;

      default:
        return {
          content: [
            {
              type: "text" as const,
              text: `Unknown tool: ${name}`,
            },
          ],
          isError: true,
        };
    }

    const response = await pool.requestOne(body);

    if (response.type === "error") {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${response.message}`,
          },
        ],
        isError: true,
      };
    }

    // Return the appropriate data based on response type
    let resultData: unknown;
    switch (response.type) {
      case "list_notebooks":
        resultData = response.notebooks;
        break;
      case "get_variables":
        resultData = response.variables;
        break;
      case "get_variable_values":
        resultData = response.variables;
        break;
      case "get_tables":
        resultData = response.tables;
        break;
      case "get_cell_outputs":
        resultData = response.outputs;
        break;
      case "run_stale":
        resultData = response.result;
        break;
      case "run_cells":
        resultData = response.result;
        break;
      case "get_notebook_status":
        resultData = response.status;
        break;
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(resultData, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Failed to connect to VS Code extension. Make sure a marimo notebook is open in VS Code.\n\nError: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}

main().catch((error) => {
  console.error("MCP server error:", error);
  process.exit(1);
});
