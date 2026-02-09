// @ts-check
/// <reference types="mocha" />

const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StdioClientTransport,
} = require("@modelcontextprotocol/sdk/client/stdio.js");

const MARIMO_EXTENSION_ID = "marimo-team.vscode-marimo";
const MARIMO_SANDBOX_KERNEL_ID = "marimo-sandbox";

const SAMPLE_NOTEBOOK = `# /// script
# dependencies = [
#   "marimo>=0.13.0",
#   "pyzmq",
# ]
# ///

import marimo

__generated_with = "0.0.0"
app = marimo.App()


@app.cell
def _():
    import time
    print("MCP_RUN_MARKER")
    time.sleep(2.5)
    x = 1
    return (x,)


if __name__ == "__main__":
    app.run()
`;

function getExtension() {
  const ext = vscode.extensions.getExtension("marimo-team.vscode-marimo");
  assert.ok(ext, "Extension should be found");
  if (!ext) {
    throw new Error("Extension should be found");
  }
  return ext;
}

/**
 * @param {ReturnType<typeof getExtension>} extension
 */
function getKernelApi(extension) {
  const api = extension.exports;
  const kernels = api?.experimental?.kernels;
  assert.ok(kernels, "Extension API should expose experimental.kernels");
  assert.strictEqual(
    typeof kernels.getKernel,
    "function",
    "experimental.kernels.getKernel should be a function",
  );
  return kernels;
}

/**
 * @param {string} command
 */
function commandAvailable(command) {
  const result = spawnSync(command, ["-e", "process.exit(0)"], {
    stdio: "ignore",
  });
  return result.error === undefined && result.status === 0;
}

function resolveNodeCommand() {
  const candidates = [
    process.env.MARIMO_MCP_NODE,
    process.env.NODE,
    "node",
    process.execPath,
  ].filter(Boolean);

  for (const command of candidates) {
    if (commandAvailable(command)) {
      return command;
    }
  }

  return process.execPath;
}

function shouldPause() {
  return process.env.MARIMO_VSCODE_TEST_PAUSE === "1";
}

async function maybePause(label) {
  if (!shouldPause()) {
    return;
  }
  const raw = process.env.MARIMO_VSCODE_TEST_PAUSE_MS;
  const ms = raw ? Number(raw) : 300000;
  const pauseMs = Number.isFinite(ms) && ms > 0 ? ms : 300000;
  // Keep the extension-host test window alive for manual log inspection.
  console.log(`[mcp.test] pause(${label}) for ${pauseMs}ms`);
  await new Promise((resolve) => setTimeout(resolve, pauseMs));
}

async function ensureActivated() {
  const extension = getExtension();
  if (!extension.isActive) {
    await extension.activate();
  }
  return extension;
}

async function waitFor(label, predicate, timeoutMs = 10000, intervalMs = 100) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await predicate();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/**
 * @param {import("@modelcontextprotocol/sdk/types.js").CallToolResult} result
 */
function getTextPayload(result) {
  const text = result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  assert.ok(text.length > 0, "Tool response should include text content");
  return text;
}

/**
 * @param {import("@modelcontextprotocol/sdk/types.js").CallToolResult} result
 */
function getJsonPayload(result) {
  const text = getTextPayload(result);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Expected JSON tool payload, got:\n${text}\n\nError: ${String(error)}`,
    );
  }
}

async function connectMcpClient(extension) {
  const cliPath = path.join(extension.extensionPath, "dist", "mcp-cli.js");
  assert.ok(
    fs.existsSync(cliPath),
    `MCP CLI should exist at ${cliPath}. Run extension build if missing.`,
  );

  const nodeCommand = resolveNodeCommand();
  const transport = new StdioClientTransport({
    command: nodeCommand,
    args: [cliPath],
    stderr: "pipe",
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      MARIMO_MCP_SOCKET: process.env.MARIMO_MCP_SOCKET,
    },
  });
  const stderrChunks = [];
  transport.stderr?.on("data", (chunk) => stderrChunks.push(chunk.toString()));

  const client = new Client({
    name: "marimo-mcp-extension-tests",
    version: "1.0.0",
  });
  await client.connect(transport);

  return {
    client,
    close: async () => {
      await client.close();
    },
    command: nodeCommand,
    stderr: () => stderrChunks.join(""),
  };
}

async function waitForSocketReady() {
  const socketPath = process.env.MARIMO_MCP_SOCKET;
  if (!socketPath || socketPath.startsWith("\\\\.\\pipe\\")) {
    return;
  }
  await waitFor(
    `MCP socket file ${socketPath}`,
    async () => fs.existsSync(socketPath),
    30000,
    200,
  );
}

async function openTempMarimoNotebook() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "marimo-mcp-e2e-"));
  const filePath = path.join(tempDir, "mcp-test.py");
  fs.writeFileSync(filePath, SAMPLE_NOTEBOOK, "utf8");

  const uri = vscode.Uri.file(filePath);
  await vscode.commands.executeCommand(
    "vscode.openWith",
    uri,
    "marimo-notebook",
  );

  const notebook = await waitFor("marimo notebook to open", () => {
    return (
      vscode.workspace.notebookDocuments.find(
        (doc) =>
          doc.uri.toString() === uri.toString() &&
          doc.notebookType === "marimo-notebook",
      ) ?? null
    );
  });

  const notebookEditor = await vscode.window.showNotebookDocument(notebook, {
    preserveFocus: false,
    preview: false,
  });

  return {
    notebook,
    notebookEditor,
    cleanup: async () => {
      await vscode.commands.executeCommand(
        "workbench.action.closeActiveEditor",
      );
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

/**
 * @param {ReturnType<typeof getExtension>} extension
 * @param {vscode.NotebookEditor} notebookEditor
 */
async function selectKernelForNotebook(notebookEditor) {
  try {
    await vscode.commands.executeCommand("notebook.selectKernel", {
      notebookEditor,
      id: MARIMO_SANDBOX_KERNEL_ID,
      extension: MARIMO_EXTENSION_ID,
    });
  } catch (error) {
    throw new Error(
      `Failed to select expected marimo kernel '${MARIMO_SANDBOX_KERNEL_ID}' from '${MARIMO_EXTENSION_ID}'. ${String(error)}`,
    );
  }
}

/**
 * @param {ReturnType<typeof getExtension>} extension
 * @param {vscode.NotebookDocument} notebook
 * @param {vscode.NotebookEditor} notebookEditor
 */
async function waitForActiveKernel(extension, notebook, notebookEditor) {
  await selectKernelForNotebook(notebookEditor);
  const kernels = getKernelApi(extension);
  try {
    const kernel = await waitFor(
      `active kernel for ${notebook.uri.toString()}`,
      async () => (await kernels.getKernel(notebook.uri)) ?? null,
      30000,
      1000,
    );
    return kernel;
  } catch (error) {
    throw new Error(
      `Expected active marimo kernel '${MARIMO_SANDBOX_KERNEL_ID}' for notebook ${notebook.uri.toString()}, but no active kernel became available. ${String(error)}`,
    );
  }
}

suite("marimo MCP extension-host integration", () => {
  test("calls MCP tools against a real opened marimo notebook", async () => {
    const extension = await ensureActivated();
    const opened = await openTempMarimoNotebook();
    await waitForActiveKernel(
      extension,
      opened.notebook,
      opened.notebookEditor,
    );
    await waitForSocketReady();
    const mcp = await connectMcpClient(extension);
    const mcpConfig = vscode.workspace.getConfiguration("marimo.mcp");
    const originalEnableRun = mcpConfig.get("enableRun");

    try {
      // Start from a known secure baseline regardless of persisted user-data.
      await mcpConfig.update(
        "enableRun",
        false,
        vscode.ConfigurationTarget.Global,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));

      const toolList = await mcp.client.listTools();
      const toolNames = new Set(toolList.tools.map((tool) => tool.name));
      const expected = [
        "list_notebooks",
        "get_variables",
        "get_variable_values",
        "get_tables",
        "get_cell_outputs",
        "run_stale",
        "run_cells",
        "get_notebook_status",
      ];
      for (const toolName of expected) {
        assert.ok(toolNames.has(toolName), `Missing MCP tool: ${toolName}`);
      }

      const target = await waitFor(
        "MCP notebook discovery",
        async () => {
          const listResult = await mcp.client.callTool({
            name: "list_notebooks",
            arguments: {},
          });
          if (listResult.isError) {
            return null;
          }
          const notebooks = getJsonPayload(listResult);
          return (
            notebooks.find((nb) => nb.uri === opened.notebook.uri.toString()) ??
            null
          );
        },
        30000,
        250,
      );

      assert.strictEqual(target.uri, opened.notebook.uri.toString());
      assert.ok(target.cellCount >= 1);

      const statusResult = await mcp.client.callTool({
        name: "get_notebook_status",
        arguments: { notebook_uri: target.uri },
      });
      const status = getJsonPayload(statusResult);
      assert.ok(Array.isArray(status.cells));
      assert.ok(status.cells.length >= 1);
      assert.strictEqual(typeof status.is_busy, "boolean");

      const variablesResult = await mcp.client.callTool({
        name: "get_variables",
        arguments: { notebook_uri: target.uri },
      });
      const variables = getJsonPayload(variablesResult);
      assert.ok(Array.isArray(variables));

      const variableValuesResult = await mcp.client.callTool({
        name: "get_variable_values",
        arguments: { notebook_uri: target.uri },
      });
      const variableValues = getJsonPayload(variableValuesResult);
      assert.ok(Array.isArray(variableValues));

      const tablesResult = await mcp.client.callTool({
        name: "get_tables",
        arguments: { notebook_uri: target.uri },
      });
      const tables = getJsonPayload(tablesResult);
      assert.ok(Array.isArray(tables));

      const outputsResult = await mcp.client.callTool({
        name: "get_cell_outputs",
        arguments: { notebook_uri: target.uri },
      });
      const outputs = getJsonPayload(outputsResult);
      assert.ok(Array.isArray(outputs));
      assert.ok(outputs.length >= 1);
      assert.strictEqual(typeof outputs[0].cell_index, "number");
      assert.ok(Array.isArray(outputs[0].outputs));

      const runStaleResult = await mcp.client.callTool({
        name: "run_stale",
        arguments: { notebook_uri: target.uri },
      });
      const runStale = getJsonPayload(runStaleResult);
      assert.notStrictEqual(runStaleResult.isError, true);
      assert.strictEqual(runStale.success, false);
      assert.strictEqual(runStale.cells_triggered, 0);
      assert.match(runStale.error, /Cell execution is disabled/);

      const runCellsResult = await mcp.client.callTool({
        name: "run_cells",
        arguments: { notebook_uri: target.uri, cell_indices: [0] },
      });
      const runCells = getJsonPayload(runCellsResult);
      assert.notStrictEqual(runCellsResult.isError, true);
      assert.strictEqual(runCells.success, false);
      assert.strictEqual(runCells.cells_triggered, 0);
      assert.match(runCells.error, /Cell execution is disabled/);

      // Enable MCP execution and verify run tools actually route through.
      await mcpConfig.update(
        "enableRun",
        true,
        vscode.ConfigurationTarget.Global,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));

      const runCellsEnabledResult = await mcp.client.callTool({
        name: "run_cells",
        arguments: { notebook_uri: target.uri, cell_indices: [0] },
      });
      const runCellsEnabled = getJsonPayload(runCellsEnabledResult);
      assert.notStrictEqual(runCellsEnabledResult.isError, true);
      assert.strictEqual(runCellsEnabled.success, true);
      assert.strictEqual(runCellsEnabled.cells_triggered, 1);

      const statusWhileRunning = await waitFor(
        "busy notebook status after run_cells",
        async () => {
          const statusResult = await mcp.client.callTool({
            name: "get_notebook_status",
            arguments: { notebook_uri: target.uri },
          });
          if (statusResult.isError) {
            return null;
          }
          const nextStatus = getJsonPayload(statusResult);
          return nextStatus.is_busy ? nextStatus : null;
        },
        20000,
        100,
      );
      assert.strictEqual(statusWhileRunning.is_busy, true);

      const statusAfterRun = await waitFor(
        "idle notebook status after run_cells",
        async () => {
          const statusResult = await mcp.client.callTool({
            name: "get_notebook_status",
            arguments: { notebook_uri: target.uri },
          });
          if (statusResult.isError) {
            return null;
          }
          const nextStatus = getJsonPayload(statusResult);
          return nextStatus.is_busy ? null : nextStatus;
        },
        20000,
        100,
      );
      assert.strictEqual(statusAfterRun.is_busy, false);

      const outputsAfterRun = await waitFor(
        "cell outputs containing MCP_RUN_MARKER",
        async () => {
          const outputsResult = await mcp.client.callTool({
            name: "get_cell_outputs",
            arguments: { notebook_uri: target.uri },
          });
          if (outputsResult.isError) {
            return null;
          }
          const nextOutputs = getJsonPayload(outputsResult);
          if (!Array.isArray(nextOutputs)) {
            return null;
          }
          const firstCell = nextOutputs.find((o) => o.cell_index === 0);
          if (!firstCell || !Array.isArray(firstCell.outputs)) {
            return null;
          }
          const mergedText = firstCell.outputs
            .map((item) => item.text ?? "")
            .join("\n");
          return mergedText.includes("MCP_RUN_MARKER") ? nextOutputs : null;
        },
        20000,
        200,
      );
      assert.ok(Array.isArray(outputsAfterRun));

      const runStaleEnabledResult = await mcp.client.callTool({
        name: "run_stale",
        arguments: { notebook_uri: target.uri },
      });
      const runStaleEnabled = getJsonPayload(runStaleEnabledResult);
      assert.notStrictEqual(runStaleEnabledResult.isError, true);
      assert.strictEqual(runStaleEnabled.success, true);
      assert.strictEqual(typeof runStaleEnabled.cells_triggered, "number");

      const missingNotebookResult = await mcp.client.callTool({
        name: "get_variables",
        arguments: { notebook_uri: "file:///does-not-exist.py" },
      });
      assert.strictEqual(missingNotebookResult.isError, true);
      assert.match(getTextPayload(missingNotebookResult), /notebook/i);
    } catch (error) {
      const stderr = mcp.stderr();
      if (stderr.trim().length > 0) {
        throw new Error(
          `${String(error)}\n\nMCP command: ${mcp.command}\nMCP CLI stderr:\n${stderr}`,
        );
      }
      throw error;
    } finally {
      await mcpConfig.update(
        "enableRun",
        originalEnableRun,
        vscode.ConfigurationTarget.Global,
      );
      await maybePause("before-cleanup");
      await opened.cleanup();
      await mcp.close();
    }
  });
});
