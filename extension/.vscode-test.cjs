const { defineConfig } = require("@vscode/test-cli");
const os = require("node:os");
const path = require("node:path");

const mcpSocketPath =
  process.platform === "win32"
    ? `\\\\.\\pipe\\marimo-mcp-vscode-test-${process.pid}`
    : path.join(os.tmpdir(), `marimo-mcp-vscode-test-${process.pid}.sock`);

module.exports = defineConfig([
  {
    label: "extension",
    files: ["tests/extension.test.cjs", "tests/*.test.cjs"],
    version: "insiders",
    workspaceFolder: "./tests/sampleWorkspace",
    installExtensions: ["ms-python.python"],
    env: {
      MARIMO_MCP_SOCKET: mcpSocketPath,
    },
    mocha: {
      ui: "tdd",
      timeout: 30_000,
      require: ["./tests/setup.cjs"],
    },
  },
]);
