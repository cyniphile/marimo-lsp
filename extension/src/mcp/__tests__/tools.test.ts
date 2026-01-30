import { expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref, TestClock } from "effect";
import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import {
  createTestNotebookDocument,
  createTestNotebookEditor,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import type { NotebookId } from "../../schemas.ts";
import { NotebookEditorRegistry } from "../../services/NotebookEditorRegistry.ts";
import { VsCode } from "../../services/VsCode.ts";
import { getCellOutputs, runStale } from "../tools.ts";

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

        const cell1 = {
          kind: 2, // NotebookCellKind.Code
          value: "x = 1",
          languageId: "python",
          metadata: { name: "cell_one" },
          outputs: [
            {
              items: [{ mime: "text/plain", data: encoder.encode("hello") }],
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

        const cell2 = {
          kind: 2, // NotebookCellKind.Code
          value: "y = 2",
          languageId: "python",
          outputs: [],
        };

        const notebookData = {
          cells: [cell1, cell2],
        };

        const notebook = createTestNotebookDocument(
          code.Uri.file("/test/notebook.py"),
          { data: notebookData },
        );
        const editor = createTestNotebookEditor(notebook);

        yield* vscode.setActiveNotebookEditor(Option.some(editor));
        yield* TestClock.adjust("10 millis");

        return yield* getCellOutputs(notebook.uri.toString() as NotebookId);
      }),
      makeLayer(vscode),
    );

    expect(outputs).toEqual([
      {
        cell_index: 0,
        cell_name: "cell_one",
        outputs: [
          { mime_type: "text/plain", text: "hello" },
          { mime_type: "application/json", text: '{"a":1}' },
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

it.effect(
  "runStale returns error when notebook is not found",
  Effect.fnUntraced(function* () {
    const vscode = yield* TestVsCode.make();

    const result = yield* Effect.provide(
      runStale("file:///missing.ipynb" as NotebookId),
      makeLayer(vscode),
    );

    expect(result).toEqual({
      success: false,
      error: "Notebook not found",
      cells_triggered: 0,
    });
  }),
);

it.effect(
  "runStale returns success with zero cells when no stale cells",
  Effect.fnUntraced(function* () {
    const vscode = yield* TestVsCode.make();

    const result = yield* Effect.provide(
      Effect.gen(function* () {
        const code = yield* VsCode;

        // Create a marimo notebook with cells that are not stale
        const notebookData = {
          cells: [
            {
              kind: 2,
              value: "x = 1",
              languageId: "python",
              metadata: { state: "idle", cellId: "cell1" },
            },
          ],
        };

        const notebook = createTestNotebookDocument(
          code.Uri.file("/test/notebook.py"),
          { data: notebookData },
        );
        const editor = createTestNotebookEditor(notebook);

        yield* vscode.setActiveNotebookEditor(Option.some(editor));
        yield* TestClock.adjust("10 millis");

        return yield* runStale(notebook.uri.toString() as NotebookId);
      }),
      makeLayer(vscode),
    );

    expect(result).toEqual({
      success: true,
      cells_triggered: 0,
      message: "No stale cells",
    });
  }),
);

it.effect(
  "runStale triggers execution for stale cells",
  Effect.fnUntraced(function* () {
    const vscode = yield* TestVsCode.make();

    const result = yield* Effect.provide(
      Effect.gen(function* () {
        const code = yield* VsCode;

        // Create a marimo notebook with stale cells
        const notebookData = {
          cells: [
            {
              kind: 2,
              value: "x = 1",
              languageId: "python",
              metadata: { state: "stale", cellId: "cell1" },
            },
            {
              kind: 2,
              value: "y = 2",
              languageId: "python",
              metadata: { state: "idle", cellId: "cell2" },
            },
            {
              kind: 2,
              value: "z = 3",
              languageId: "python",
              metadata: { state: "stale", cellId: "cell3" },
            },
          ],
        };

        const notebook = createTestNotebookDocument(
          code.Uri.file("/test/notebook.py"),
          { data: notebookData },
        );
        const editor = createTestNotebookEditor(notebook);

        yield* vscode.setActiveNotebookEditor(Option.some(editor));
        yield* TestClock.adjust("10 millis");

        return yield* runStale(notebook.uri.toString() as NotebookId);
      }),
      makeLayer(vscode),
    );

    expect(result).toEqual({
      success: true,
      cells_triggered: 2,
    });

    // Verify that notebook.cell.execute was called
    const executions = yield* Ref.get(vscode.executions);
    const executeCall = executions.find(
      (e) => e.command === "notebook.cell.execute",
    );
    expect(executeCall).toBeDefined();
    expect(executeCall?.args[0]).toEqual({
      ranges: [
        { start: 0, end: 1 },
        { start: 2, end: 3 },
      ],
    });
  }),
);
