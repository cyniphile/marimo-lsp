# marimo-lsp

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/marimo-team.vscode-marimo?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=marimo-team.vscode-marimo)
[![Open VSX](https://img.shields.io/open-vsx/v/marimo-team/vscode-marimo?label=Open%20VSX)](https://open-vsx.org/extension/marimo-team/vscode-marimo)

A language server and VS Code extension for
[marimo](https://github.com/marimo-team/marimo).

**[Learn more about the extension](extension/README.md)** | **[Contributing](CONTRIBUTING.md)**

## Claude Code (MCP) setup

This repo does not check in `.mcp.json` because it contains machine-specific
paths.

1) Install the VS Code extension.
2) Run the command `Marimo: Show Claude Code MCP config` to open a JSON snippet
   with the correct local path (it copies the MCP CLI into VS Code's global
   storage for a stable path).
3) Copy that snippet into your Claude Code MCP settings (or save it as
   `.mcp.json` locally).

If you're developing from source, run `pnpm -C extension build:mcp-cli` once
before step 2.

The config uses VS Code's bundled Node runtime, so users don't need a separate
Node installation just for MCP.
