import { expect, it } from "@effect/vitest";
import { Effect, Layer, Option, TestClock } from "effect";
import type * as vscode from "vscode";
import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import {
  createTestNotebookDocument,
  createTestNotebookEditor,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import { type NotebookId } from "../../schemas.ts";
import { NotebookEditorRegistry } from "../../services/NotebookEditorRegistry.ts";
import { VsCode } from "../../services/VsCode.ts";
import { getCellOutputs } from "../tools.ts";

function makeLayer(vscode: TestVsCode) {
  return Layer.empty.pipe(
    Layer.merge(NotebookEditorRegistry.Default),
    Layer.provide(TestTelemetryLive),
    Layer.provideMerge(vscode.layer),
  );
}

it.effect(
  "getCellOutputs returns decoded text outputs per cell",
  Effect.fnUntraced(function* () {
    const vscode = yield* TestVsCode.make();

    const outputs = yield* Effect.provide(
      Effect.gen(function* () {
        const code = yield* VsCode;
        const encoder = new TextEncoder();

        const cell1: vscode.NotebookCellData = {
          kind: 2, // NotebookCellKind.Code
          value: "x = 1",
          languageId: "python",
          metadata: { name: "cell_one" },
          outputs: [
            {
              items: [
                { mime: "text/plain", data: encoder.encode("hello") },
              ],
            },
            {
              items: [
                {
                  mime: "application/json",
                  data: encoder.encode(JSON.stringify({ a: 1 })),
                },
              ],
            },
            {
              items: [{ mime: "image/png", data: new Uint8Array([1, 2, 3]) }],
            },
            {
              items: [
                {
                  mime: "application/vnd.code.notebook.stdout",
                  data: encoder.encode("stdout"),
                },
              ],
            },
            {
              items: [
                {
                  mime: "application/vnd.code.notebook.stderr",
                  data: encoder.encode("stderr"),
                },
              ],
            },
          ],
        };

        const cell2: vscode.NotebookCellData = {
          kind: 2, // NotebookCellKind.Code
          value: "y = 2",
          languageId: "python",
          outputs: [],
        };

        const notebookData: vscode.NotebookData = {
          cells: [cell1, cell2],
        };

        const notebook = createTestNotebookDocument(
          code.Uri.file("/test/notebook.py"),
          { data: notebookData },
        );
        const editor = createTestNotebookEditor(notebook);

        yield* vscode.setActiveNotebookEditor(Option.some(editor));
        yield* TestClock.adjust("10 millis");

        return yield* getCellOutputs(
          notebook.uri.toString() as NotebookId,
        );
      }),
      makeLayer(vscode),
    );

    expect(outputs).toEqual([
      {
        cell_index: 0,
        cell_name: "cell_one",
        outputs: [
          { mime_type: "text/plain", text: "hello" },
          { mime_type: "application/json", text: "{\"a\":1}" },
          { mime_type: "image/png", text: null },
          { mime_type: "application/vnd.code.notebook.stdout", text: "stdout" },
          { mime_type: "application/vnd.code.notebook.stderr", text: "stderr" },
        ],
      },
      {
        cell_index: 1,
        cell_name: null,
        outputs: [],
      },
    ]);
  }),
);

it.effect(
  "getCellOutputs returns an empty array when notebook is not tracked",
  Effect.fnUntraced(function* () {
    const vscode = yield* TestVsCode.make();

    const outputs = yield* Effect.provide(
      getCellOutputs("file:///missing.ipynb" as NotebookId),
      makeLayer(vscode),
    );

    expect(outputs).toEqual([]);
  }),
);
