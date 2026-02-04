import * as NodePath from "node:path";
import { Effect } from "effect";
import { ExtensionContext } from "../services/Storage.ts";
import { VsCode } from "../services/VsCode.ts";

export const showMcpConfig = Effect.fn("command.showMcpConfig")(function* () {
  const code = yield* VsCode;
  const extensionContext = yield* ExtensionContext;

  const cliPath = NodePath.join(
    extensionContext.extensionUri.fsPath,
    "dist",
    "mcp-cli.js",
  );

  const config = {
    mcpServers: {
      marimo: {
        type: "stdio",
        command: "node",
        args: [cliPath],
      },
    },
  };

  const doc = yield* code.workspace.openUntitledTextDocument({
    language: "json",
    content: JSON.stringify(config, null, 2),
  });
  yield* code.window.showTextDocument(doc);
  yield* code.window.showInformationMessage(
    "Paste this into your Claude Code MCP settings.",
  );
});
