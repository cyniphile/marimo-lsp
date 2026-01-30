#!/usr/bin/env node
/**
 * MCP CLI Entry Point
 *
 * This is the CLI that Claude Code spawns. It communicates via STDIO with Claude Code
 * and connects to the VS Code extension via IPC to query notebook data.
 *
 * This file is intentionally kept standalone with no VS Code dependencies.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { IpcClient, type IpcResponseBody } from "./mcp/ipc-client.ts";

const server = new Server(
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

let ipcClient: IpcClient | null = null;

async function ensureConnected(): Promise<IpcClient> {
  if (!ipcClient) {
    ipcClient = new IpcClient();
    await ipcClient.connect();
  }
  return ipcClient;
}

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_notebooks",
        description:
          "List all open marimo notebooks in VS Code. Returns an array of notebook URIs, names, and cell counts.",
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
            notebook_uri: {
              type: "string",
              description:
                "The URI of the notebook (from list_notebooks output)",
            },
          },
          required: ["notebook_uri"],
        },
      },
      {
        name: "get_variable_values",
        description:
          "Get current variable values for a specific marimo notebook. Returns the name, value, and datatype of each variable.",
        inputSchema: {
          type: "object" as const,
          properties: {
            notebook_uri: {
              type: "string",
              description:
                "The URI of the notebook (from list_notebooks output)",
            },
          },
          required: ["notebook_uri"],
        },
      },
      {
        name: "get_tables",
        description:
          "Get dataset/table metadata for a specific marimo notebook. Returns table names, sources, row/column counts, and column definitions.",
        inputSchema: {
          type: "object" as const,
          properties: {
            notebook_uri: {
              type: "string",
              description:
                "The URI of the notebook (from list_notebooks output)",
            },
          },
          required: ["notebook_uri"],
        },
      },
      {
        name: "get_cell_outputs",
        description:
          "Get cell outputs for a specific marimo notebook. Returns the stdout/stderr and other outputs from each cell after execution.",
        inputSchema: {
          type: "object" as const,
          properties: {
            notebook_uri: {
              type: "string",
              description:
                "The URI of the notebook (from list_notebooks output)",
            },
          },
          required: ["notebook_uri"],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const client = await ensureConnected();
    let response: IpcResponseBody;

    switch (name) {
      case "list_notebooks":
        response = await client.request({ type: "list_notebooks" });
        break;

      case "get_variables":
        response = await client.request({
          type: "get_variables",
          notebook_uri: (args as { notebook_uri: string }).notebook_uri,
        });
        break;

      case "get_variable_values":
        response = await client.request({
          type: "get_variable_values",
          notebook_uri: (args as { notebook_uri: string }).notebook_uri,
        });
        break;

      case "get_tables":
        response = await client.request({
          type: "get_tables",
          notebook_uri: (args as { notebook_uri: string }).notebook_uri,
        });
        break;

      case "get_cell_outputs":
        response = await client.request({
          type: "get_cell_outputs",
          notebook_uri: (args as { notebook_uri: string }).notebook_uri,
        });
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
  await server.connect(transport);
}

main().catch((error) => {
  console.error("MCP server error:", error);
  process.exit(1);
});
