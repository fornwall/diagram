import * as vscode from "vscode";
import { throwIfCancelled, unlessCancelled } from "./cancellation";
import { compareSnapshots } from "./diagramHistory";
import type { DiagramPanel } from "./panel";
import { errorMessage } from "./protocol";
import { renderOptions } from "./renderOptions";
import { toolInput } from "./text";
import { fitsToolResult } from "./toolContracts";
import { drawnResult, textResult } from "./toolResults";

interface CheckpointInput {
  action: "save" | "list" | "compare" | "restore" | "delete";
  name?: string;
  id?: string;
  otherId?: string;
  revision?: number;
}

export class CheckpointTool implements vscode.LanguageModelTool<CheckpointInput> {
  constructor(private readonly panel: DiagramPanel) {}

  prepareInvocation(): vscode.PreparedToolInvocation {
    return { invocationMessage: "Working with diagram checkpoints" };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<CheckpointInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      throwIfCancelled(token);
      const input = toolInput(options.input, ["action", "name", "id", "otherId", "revision"]);
      const { action } = input;
      if (!["save", "list", "compare", "restore", "delete"].includes(String(action))) {
        throw new Error('"action" must be save, list, compare, restore or delete.');
      }
      const { revision } = renderOptions(input, this.panel.revision);
      let report: unknown;
      let completed: string | undefined;
      if (action === "list") {
        report = { revision, checkpoints: this.panel.history.list() };
      } else if (action === "save") {
        if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 100) {
          throw new Error('Give a checkpoint "name" of 1–100 characters.');
        }
        const saved = await unlessCancelled(
          () => this.panel.saveCheckpoint(String(input.name).trim()),
          token,
        );
        report = saved;
        completed = `Saved checkpoint ${saved.id} at revision ${saved.revision}.`;
      } else {
        if (typeof input.id !== "string" || !input.id)
          throw new Error('Give a checkpoint "id" from list or save.');
        const checkpoint = this.panel.history.get(input.id);
        if (action === "compare") {
          if (input.otherId !== undefined && typeof input.otherId !== "string")
            throw new Error('"otherId" must be a checkpoint id.');
          const other =
            input.otherId === undefined
              ? this.panel.snapshot()
              : this.panel.history.get(input.otherId as string);
          report = {
            id: checkpoint.id,
            ...(input.otherId !== undefined && { otherId: input.otherId }),
            ...compareSnapshots(checkpoint, other),
          };
        } else if (action === "restore") {
          const outcome = await unlessCancelled(
            () => this.panel.restoreCheckpoint(checkpoint.id, revision),
            token,
          );
          return drawnResult(
            outcome.ok
              ? `Restored checkpoint ${JSON.stringify(checkpoint.name)}. It is detached from Markdown; no file was written.`
              : `The checkpoint could not be drawn: ${outcome.error}`,
            outcome.revision,
          );
        } else {
          await unlessCancelled(() => this.panel.deleteCheckpoint(checkpoint.id), token);
          report = { deleted: checkpoint.id, revision };
          completed = `Deleted checkpoint ${checkpoint.id}.`;
        }
      }
      const text = JSON.stringify(report);
      const room = options.tokenizationOptions;
      throwIfCancelled(token);
      const fits = await fitsToolResult(text, room, token);
      throwIfCancelled(token);
      return textResult(
        fits
          ? text
          : `${completed ? `${completed} ` : ""}The checkpoint result exceeds the tool budget. Increase the budget or read the current source in ranges.`,
      );
    } catch (error) {
      if (error instanceof vscode.CancellationError) throw error;
      return textResult(`Checkpoint operation failed: ${errorMessage(error)}`);
    }
  }
}
