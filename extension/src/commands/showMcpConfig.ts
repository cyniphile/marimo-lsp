import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import { Effect, Either } from "effect";

import { ExtensionContext } from "../platform/Storage.ts";
import { VsCode } from "../platform/VsCode.ts";

export const showMcpConfig = Effect.fn("command.showMcpConfig")(function* () {
  const code = yield* VsCode;
  const extensionContext = yield* ExtensionContext;

  const sourceCliPath = NodePath.join(
    extensionContext.extensionUri.fsPath,
    "dist",
    "mcp-cli.js",
  );
  const storageDir = NodePath.join(
    extensionContext.globalStorageUri.fsPath,
    "mcp",
  );
  const storedCliPath = NodePath.join(storageDir, "mcp-cli.js");

  const copiedCliPath = yield* Effect.either(
    Effect.try({
      try: () => {
        NodeFs.mkdirSync(storageDir, { recursive: true });
        NodeFs.copyFileSync(sourceCliPath, storedCliPath);
        return storedCliPath;
      },
      catch: (cause) => cause,
    }),
  );

  const cliPath = Either.match(copiedCliPath, {
    onLeft: () => sourceCliPath,
    onRight: (path) => path,
  });

  const config = {
    mcpServers: {
      marimo: {
        type: "stdio",
        command: process.execPath,
        args: [cliPath],
        env: {
          ELECTRON_RUN_AS_NODE: "1",
        },
      },
    },
  };

  const doc = yield* code.workspace.openUntitledTextDocument({
    language: "json",
    content: JSON.stringify(config, null, 2),
  });
  yield* code.window.showTextDocument(doc);
  if (Either.isLeft(copiedCliPath)) {
    yield* Effect.forkScoped(
      code.window.showWarningMessage(
        "Failed to copy MCP CLI to global storage. Using the extension path instead.",
      ),
    );
  }
  yield* Effect.forkScoped(
    code.window.showInformationMessage(
      "Paste this into your Claude Code MCP settings.",
    ),
  );
});
