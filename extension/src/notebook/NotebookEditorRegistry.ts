import { Effect, HashMap, Option, Ref, Stream, SubscriptionRef } from "effect";
import type * as vscode from "vscode";

import { VsCode } from "../platform/VsCode.ts";
import { MarimoNotebookDocument } from "../schemas/MarimoNotebookDocument.ts";
import type { NotebookId } from "../schemas/MarimoNotebookDocument.ts";
import { Telemetry } from "../telemetry/Telemetry.ts";

export class NotebookEditorRegistry extends Effect.Service<NotebookEditorRegistry>()(
  "NotebookEditorRegistry",
  {
    scoped: Effect.gen(function* () {
      const code = yield* VsCode;
      const telemetry = yield* Telemetry;
      const ref = yield* Ref.make(
        HashMap.empty<NotebookId, vscode.NotebookEditor>(),
      );

      // Track the currently active notebook URI
      const activeNotebookRef = yield* SubscriptionRef.make(
        Option.none<NotebookId>(),
      );

      // Helper to process an editor (either initial or from stream)
      const processEditor = Effect.fn(function* (
        editor: Option.Option<vscode.NotebookEditor>,
      ) {
        const notebook = Option.filterMap(editor, (ed) =>
          MarimoNotebookDocument.tryFrom(ed.notebook),
        );
        if (Option.isNone(editor) || Option.isNone(notebook)) {
          yield* SubscriptionRef.set(activeNotebookRef, Option.none());
          return;
        }

        const isAlreadyTracked = HashMap.has(
          yield* Ref.get(ref),
          notebook.value.id,
        );

        yield* Ref.update(ref, (map) =>
          HashMap.set(map, notebook.value.id, editor.value),
        );

        yield* Effect.logInfo("Active notebook changed").pipe(
          Effect.annotateLogs({ notebookUri: notebook.value.id }),
        );

        // Track notebook opened event (only for new notebooks)
        if (!isAlreadyTracked) {
          yield* telemetry.capture("notebook_opened", {
            cellCount: editor.value.notebook.cellCount,
          });
        }

        yield* SubscriptionRef.set(
          activeNotebookRef,
          Option.some(notebook.value.id),
        );
      });

      // Process the currently active notebook editor at startup
      const initialEditor = yield* code.window.getActiveNotebookEditor();
      yield* processEditor(initialEditor);

      // Subscribe to future changes
      yield* Effect.forkScoped(
        code.window
          .activeNotebookEditorChanges()
          .pipe(Stream.mapEffect(processEditor), Stream.runDrain),
      );

      return {
        getNotebookEditors() {
          return Effect.map(Ref.get(ref), HashMap.toEntries);
        },
        /**
         * Get the last notebook editor for a given notebook URI
         */
        getLastNotebookEditor(id: NotebookId) {
          return Effect.map(Ref.get(ref), HashMap.get(id));
        },

        /**
         * Get the currently active notebook URI
         */
        getActiveNotebookUri() {
          return SubscriptionRef.get(activeNotebookRef);
        },

        /**
         * Get the notebook editor for a given notebook URI
         */
        getNotebookEditor(uri: NotebookId) {
          return Effect.map(Ref.get(ref), HashMap.get(uri));
        },

        /**
         * Get the currently active notebook editor
         */
        getActiveNotebookEditor() {
          return Effect.gen(function* () {
            const activeNotebookUri =
              yield* SubscriptionRef.get(activeNotebookRef);

            if (Option.isNone(activeNotebookUri)) {
              yield* Effect.logWarning("No active notebook editor");
              return Option.none();
            }

            const editors = yield* Ref.get(ref);
            return HashMap.get(editors, activeNotebookUri.value);
          });
        },

        /**
         * Stream of active notebook URI changes.
         *
         * Emits the current value on subscription, then all subsequent changes.
         * Filters consecutive duplicates via Stream.changes.
         */
        streamActiveNotebookChanges() {
          return activeNotebookRef.changes.pipe(Stream.changes);
        },
      };
    }),
  },
) {}
