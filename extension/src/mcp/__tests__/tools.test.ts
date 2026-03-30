import { expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref, TestClock } from "effect";

import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import {
  createTestNotebookDocument,
  createTestNotebookEditor,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import { ControllerRegistry } from "../../kernel/ControllerRegistry.ts";
import { NotebookEditorRegistry } from "../../notebook/NotebookEditorRegistry.ts";
import { VsCode } from "../../platform/VsCode.ts";
import type { NotebookId } from "../../schemas.ts";
import {
  getCellOutputs,
  getNotebookStatus,
  runCells,
  runStale,
} from "../tools.ts";

function makeLayer(vscode: TestVsCode, kernelActive?: boolean) {
  const base = Layer.empty.pipe(
    Layer.merge(NotebookEditorRegistry.Default),
    Layer.provide(TestTelemetryLive),
    Layer.provideMerge(vscode.layer),
  );

  if (kernelActive === undefined) {
    return base;
  }

  const controllerLayer = Layer.succeed(
    ControllerRegistry,
    ControllerRegistry.make({
      getActiveController: (_notebook) =>
        Effect.succeed(kernelActive ? Option.some({} as never) : Option.none()),
      snapshot: () =>
        Effect.succeed({
          controllers: [],
          selections: [],
        }),
    }),
  );

  return Layer.merge(base, controllerLayer);
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
  "runStale returns a helpful error when notebook is open but no kernel is active",
  Effect.fnUntraced(function* () {
    const vscode = yield* TestVsCode.make();

    const result = yield* Effect.provide(
      Effect.gen(function* () {
        const code = yield* VsCode;

        const notebookData = {
          cells: [
            {
              kind: 2,
              value: "x = 1",
              languageId: "python",
              metadata: { state: "stale", cellId: "cell1" },
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
      makeLayer(vscode, false),
    );

    expect(result.success).toBe(false);
    expect(result.cells_triggered).toBe(0);
    expect(result.error).toContain("no active kernel/controller");
    expect(result.error).toContain("Select a notebook kernel");
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
      makeLayer(vscode, true),
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
    expect(executeCall?.args[0]).toMatchObject({
      ranges: [
        { start: 0, end: 1 },
        { start: 2, end: 3 },
      ],
    });
  }),
);

it.effect(
  "runCells returns error when notebook is not found",
  Effect.fnUntraced(function* () {
    const vscode = yield* TestVsCode.make();

    const result = yield* Effect.provide(
      runCells("file:///missing.ipynb" as NotebookId, [0, 1]),
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
  "runCells returns success with zero cells when empty array passed",
  Effect.fnUntraced(function* () {
    const vscode = yield* TestVsCode.make();

    const result = yield* Effect.provide(
      Effect.gen(function* () {
        const code = yield* VsCode;

        const notebookData = {
          cells: [
            {
              kind: 2,
              value: "x = 1",
              languageId: "python",
              metadata: { cellId: "cell1" },
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

        return yield* runCells(notebook.uri.toString() as NotebookId, []);
      }),
      makeLayer(vscode),
    );

    expect(result).toEqual({
      success: true,
      cells_triggered: 0,
    });
  }),
);

it.effect(
  "runCells returns error for invalid cell indices",
  Effect.fnUntraced(function* () {
    const vscode = yield* TestVsCode.make();

    const result = yield* Effect.provide(
      Effect.gen(function* () {
        const code = yield* VsCode;

        const notebookData = {
          cells: [
            {
              kind: 2,
              value: "x = 1",
              languageId: "python",
              metadata: { cellId: "cell1" },
            },
            {
              kind: 2,
              value: "y = 2",
              languageId: "python",
              metadata: { cellId: "cell2" },
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

        // Try to run cell index 5 which doesn't exist (only 2 cells)
        return yield* runCells(notebook.uri.toString() as NotebookId, [0, 5]);
      }),
      makeLayer(vscode),
    );

    expect(result).toEqual({
      success: false,
      error: "Invalid cell indices: 5. Notebook has 2 cells (0-1).",
      cells_triggered: 0,
    });
  }),
);

it.effect(
  "runCells returns a helpful error when notebook is open but no kernel is active",
  Effect.fnUntraced(function* () {
    const vscode = yield* TestVsCode.make();

    const result = yield* Effect.provide(
      Effect.gen(function* () {
        const code = yield* VsCode;

        const notebookData = {
          cells: [
            {
              kind: 2,
              value: "x = 1",
              languageId: "python",
              metadata: { cellId: "cell1" },
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

        return yield* runCells(notebook.uri.toString() as NotebookId, [0]);
      }),
      makeLayer(vscode, false),
    );

    expect(result.success).toBe(false);
    expect(result.cells_triggered).toBe(0);
    expect(result.error).toContain("no active kernel/controller");
    expect(result.error).toContain("Select a notebook kernel");
  }),
);

it.effect(
  "runCells triggers execution for specified cells",
  Effect.fnUntraced(function* () {
    const vscode = yield* TestVsCode.make();

    const result = yield* Effect.provide(
      Effect.gen(function* () {
        const code = yield* VsCode;

        const notebookData = {
          cells: [
            {
              kind: 2,
              value: "x = 1",
              languageId: "python",
              metadata: { cellId: "cell1" },
            },
            {
              kind: 2,
              value: "y = 2",
              languageId: "python",
              metadata: { cellId: "cell2" },
            },
            {
              kind: 2,
              value: "z = 3",
              languageId: "python",
              metadata: { cellId: "cell3" },
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

        // Run cells 0 and 2 (skipping cell 1)
        return yield* runCells(notebook.uri.toString() as NotebookId, [0, 2]);
      }),
      makeLayer(vscode, true),
    );

    expect(result).toEqual({
      success: true,
      cells_triggered: 2,
    });

    // Verify that notebook.cell.execute was called with correct ranges
    const executions = yield* Ref.get(vscode.executions);
    const executeCall = executions.find(
      (e) => e.command === "notebook.cell.execute",
    );
    expect(executeCall).toBeDefined();
    expect(executeCall?.args[0]).toMatchObject({
      ranges: [
        { start: 0, end: 1 },
        { start: 2, end: 3 },
      ],
    });
  }),
);

it.effect(
  "getNotebookStatus returns empty status when notebook is not found",
  Effect.fnUntraced(function* () {
    const vscode = yield* TestVsCode.make();

    const status = yield* Effect.provide(
      getNotebookStatus("file:///missing.ipynb" as NotebookId),
      makeLayer(vscode),
    );

    expect(status).toEqual({
      cells: [],
      is_busy: false,
      running_count: 0,
      queued_count: 0,
      stale_count: 0,
    });
  }),
);

it.effect(
  "getNotebookStatus returns cell states and counts",
  Effect.fnUntraced(function* () {
    const vscode = yield* TestVsCode.make();

    const status = yield* Effect.provide(
      Effect.gen(function* () {
        const code = yield* VsCode;

        // Create a notebook with cells - only "stale" is reliably detectable from metadata
        const notebookData = {
          cells: [
            {
              kind: 2,
              value: "x = 1",
              languageId: "python",
              metadata: { name: "cell_a" },
            },
            {
              kind: 2,
              value: "y = 2",
              languageId: "python",
              metadata: {},
            },
            {
              kind: 2,
              value: "z = 3",
              languageId: "python",
              metadata: { state: "stale", name: "cell_c" },
            },
            {
              kind: 2,
              value: "w = 4",
              languageId: "python",
              metadata: {},
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

        return yield* getNotebookStatus(notebook.uri.toString() as NotebookId);
      }),
      makeLayer(vscode),
    );

    // Only stale state is detectable from metadata; others show as idle
    expect(status).toEqual({
      cells: [
        { cell_index: 0, cell_name: "cell_a", state: "idle" },
        { cell_index: 1, cell_name: null, state: "idle" },
        { cell_index: 2, cell_name: "cell_c", state: "stale" },
        { cell_index: 3, cell_name: null, state: "idle" },
      ],
      is_busy: false,
      running_count: 0,
      queued_count: 0,
      stale_count: 1,
    });
  }),
);

it.effect(
  "getNotebookStatus returns is_busy=false when no cells are running or queued",
  Effect.fnUntraced(function* () {
    const vscode = yield* TestVsCode.make();

    const status = yield* Effect.provide(
      Effect.gen(function* () {
        const code = yield* VsCode;

        const notebookData = {
          cells: [
            {
              kind: 2,
              value: "x = 1",
              languageId: "python",
              metadata: { state: "idle" },
            },
            {
              kind: 2,
              value: "y = 2",
              languageId: "python",
              metadata: { state: "stale" },
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

        return yield* getNotebookStatus(notebook.uri.toString() as NotebookId);
      }),
      makeLayer(vscode),
    );

    expect(status.is_busy).toBe(false);
    expect(status.running_count).toBe(0);
    expect(status.queued_count).toBe(0);
    expect(status.stale_count).toBe(1);
  }),
);
