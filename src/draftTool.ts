import * as vscode from "vscode";
import { guessTitle } from "./blocks";
import { throwIfCancelled, unlessCancelled } from "./cancellation";
import type { ChartUpdateInput } from "./chartOptions";
import { EditDiagramTool, type EditInput, prepareSourceEdit, validateEditInput } from "./editTool";
import { pngBytes } from "./export";
import type { DiagramPanel } from "./panel";
import {
  type DiagramLanguage,
  type DiagramNode,
  errorMessage,
  isDiagramLanguage,
  isPlainObject,
} from "./protocol";
import { renderOptions } from "./renderOptions";
import {
  prepareStructure,
  StructureDiagramTool,
  type StructureOperation,
  structureOperations,
} from "./structureTool";
import { toolInput } from "./text";
import { fitsToolResult } from "./toolContracts";
import { drawnResult, textResult } from "./toolResults";
import { runsCode } from "./webview/optionSource";
import { shortestPath } from "./webview/relationships";

interface DraftInput {
  action: "validate" | "apply" | "discard";
  source?: string;
  edits?: EditInput["edits"];
  operations?: StructureOperation[];
  chartUpdate?: ChartUpdateInput;
  language?: DiagramLanguage;
  title?: string;
  revision?: number;
  id?: string;
  image?: boolean;
  preserveNodes?: string[];
  preservePaths?: { source: string; target: string }[];
}

interface Draft {
  source: string;
  language: DiagramLanguage;
  title: string;
  revision: number;
  operations?: StructureOperation[];
  chartUpdate?: ChartUpdateInput;
}

export function draftConstraints(
  input: Pick<DraftInput, "preserveNodes" | "preservePaths">,
  items: readonly DiagramNode[],
): string[] {
  const nodes = new Set(items.filter((item) => !item.relationship).map(({ id }) => id));
  const errors = (input.preserveNodes ?? [])
    .filter((id) => !nodes.has(id))
    .map((id) => `Missing node ${JSON.stringify(id)}.`);
  for (const path of input.preservePaths ?? []) {
    if (!shortestPath(items, path.source, path.target))
      errors.push(
        `No directed path from ${JSON.stringify(path.source)} to ${JSON.stringify(path.target)}.`,
      );
  }
  return errors;
}

function parseInput(value: unknown): DraftInput {
  const input = toolInput(value, [
    "action",
    "source",
    "edits",
    "operations",
    "chartUpdate",
    "language",
    "title",
    "revision",
    "id",
    "image",
    "preserveNodes",
    "preservePaths",
  ]);
  if (!["validate", "apply", "discard"].includes(String(input.action)))
    throw new Error('"action" must be validate, apply or discard.');
  if (input.action !== "validate") {
    if (typeof input.id !== "string" || !input.id)
      throw new Error('Give the validated draft "id".');
    if (Object.keys(input).some((key) => !["action", "id", "revision"].includes(key)))
      throw new Error("Apply and discard accept only id and revision.");
    return input as unknown as DraftInput;
  }
  if (input.id !== undefined) throw new Error("Validation creates a new draft id.");
  if (
    ["source", "edits", "operations", "chartUpdate"].filter((key) => input[key] !== undefined)
      .length !== 1
  )
    throw new Error('Give exactly one of "source", "edits", "operations" or "chartUpdate".');
  if (
    input.source !== undefined &&
    (typeof input.source !== "string" || !input.source.trim() || input.source.length > 1_000_000)
  )
    throw new Error('Give "source" as 1–1,000,000 characters.');
  if (input.source === undefined && input.language !== undefined)
    throw new Error('"language" is only for source drafts.');
  if (input.operations !== undefined) structureOperations(input.operations);
  if (
    (input.operations !== undefined || input.chartUpdate !== undefined) &&
    input.title !== undefined
  )
    throw new Error(
      'Use "title" with source or edits; chart updates take their title inside chartUpdate.',
    );
  if (
    input.chartUpdate !== undefined &&
    (!isPlainObject(input.chartUpdate) || input.chartUpdate.revision !== undefined)
  )
    throw new Error('"chartUpdate" must contain chart settings without a nested revision.');
  if (input.language !== undefined && !isDiagramLanguage(input.language))
    throw new Error('"language" must be mermaid or echarts.');
  if (
    input.title !== undefined &&
    (typeof input.title !== "string" || !input.title.trim() || input.title.length > 200)
  )
    throw new Error('"title" must contain 1–200 characters.');
  if (input.image !== undefined && typeof input.image !== "boolean")
    throw new Error('"image" must be true or false.');
  if (
    input.preserveNodes !== undefined &&
    (!Array.isArray(input.preserveNodes) ||
      input.preserveNodes.length > 100 ||
      !input.preserveNodes.every(
        (id) => typeof id === "string" && id.length > 0 && id.length <= 1000,
      ))
  )
    throw new Error('"preserveNodes" must contain at most 100 exact node ids.');
  if (
    input.preservePaths !== undefined &&
    (!Array.isArray(input.preservePaths) ||
      input.preservePaths.length > 100 ||
      !input.preservePaths.every(
        (path) =>
          isPlainObject(path) &&
          Object.keys(path).every((key) => ["source", "target"].includes(key)) &&
          [path.source, path.target].every(
            (id) => typeof id === "string" && id.length > 0 && id.length <= 1000,
          ),
      ))
  )
    throw new Error('"preservePaths" must contain at most 100 {source,target} pairs.');
  return input as unknown as DraftInput;
}

export class DraftTool implements vscode.LanguageModelTool<DraftInput> {
  private readonly drafts = new Map<string, Draft>();
  constructor(private readonly panel: DiagramPanel) {}

  prepareInvocation(): vscode.PreparedToolInvocation {
    return { invocationMessage: "Working with a diagram draft" };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<DraftInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      throwIfCancelled(token);
      const input = parseInput(options.input);
      const { revision } = renderOptions(input, this.panel.revision);
      if (input.action !== "validate") {
        const id = input.id as string;
        const draft = this.drafts.get(id);
        if (!draft) throw new Error("Unknown or expired draft. Validate the source again.");
        if (input.action === "discard") {
          this.drafts.delete(id);
          return textResult(`Discarded draft ${id}.`);
        }
        if (draft.revision !== revision)
          throw new Error(
            "The diagram changed since validation. Validate against its current revision before applying.",
          );
        if (draft.chartUpdate) {
          const outcome = await this.panel.updateChart({ ...draft.chartUpdate, revision }, token);
          this.drafts.delete(id);
          return drawnResult(
            outcome.ok
              ? "Applied the validated chart update."
              : `The draft could not be drawn: ${outcome.error}`,
            outcome.revision,
          );
        }
        if (draft.operations) {
          const result = await new StructureDiagramTool(this.panel).invoke(
            { ...options, input: { operations: draft.operations, revision } },
            token,
          );
          if (this.panel.revision !== revision) this.drafts.delete(id);
          return result;
        }
        const current = this.panel.current;
        if (current?.language === draft.language && current.source) {
          const result = await new EditDiagramTool(this.panel).invoke(
            {
              ...options,
              input: {
                edits: [{ oldText: current.source, newText: draft.source }],
                ...(current.title !== draft.title && { title: draft.title }),
                revision,
              },
            },
            token,
          );
          if (this.panel.revision !== revision) this.drafts.delete(id);
          return result;
        }
        const outcome = await unlessCancelled(
          () => this.panel.render(draft, "tool", undefined, { newDiagram: true }),
          token,
        );
        this.drafts.delete(id);
        return drawnResult(
          outcome.ok
            ? "Applied the validated draft."
            : `The draft could not be drawn: ${outcome.error}`,
          outcome.revision,
        );
      }
      const draft = await this.prepare(input, revision, token);
      const { source, language, title } = draft;
      if (language === "echarts" && runsCode(source))
        throw new Error("Drafts accept ECharts options without executable JavaScript.");
      if (language !== "mermaid" && (input.preserveNodes?.length || input.preservePaths?.length))
        throw new Error("Graph constraints require a Mermaid diagram.");
      const result = await this.panel.validateDraft(
        { source, language, title, image: input.image === true },
        token,
      );
      throwIfCancelled(token);
      if (revision !== this.panel.revision)
        throw new Error("The diagram changed during validation. Read its state and retry.");
      if (result.error || !result.diagramType)
        throw new Error(result.error ?? "The renderer returned no draft result.");
      const reportFits = (text: string) => fitsToolResult(text, options.tokenizationOptions, token);
      const tooLarge = () =>
        textResult(
          "The draft validation report exceeds the result budget. Increase it and validate again.",
        );
      const violations = draftConstraints(input, result.items ?? []);
      if (violations.length) {
        const report = JSON.stringify({
          valid: false,
          revision,
          violations,
          warnings: result.warnings ?? [],
        });
        return (await reportFits(report)) ? textResult(report) : tooLarge();
      }
      const id = crypto.randomUUID();
      const text = JSON.stringify({
        valid: true,
        id,
        revision,
        diagramType: result.diagramType,
        warnings: result.warnings ?? [],
        constraintsChecked: (input.preserveNodes?.length ?? 0) + (input.preservePaths?.length ?? 0),
      });
      if (!(await reportFits(text))) {
        return tooLarge();
      }
      if (revision !== this.panel.revision)
        throw new Error(
          "The diagram changed while preparing the validation report. Read its state and retry.",
        );
      this.drafts.set(id, draft);
      while (this.drafts.size > 4) this.drafts.delete(this.drafts.keys().next().value as string);
      const png = result.image && pngBytes(result.image);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(text),
        ...(png ? [vscode.LanguageModelDataPart.image(png, "image/png")] : []),
      ]);
    } catch (error) {
      if (error instanceof vscode.CancellationError) throw error;
      return textResult(`Draft operation failed: ${errorMessage(error)}`);
    }
  }

  private async prepare(
    input: DraftInput,
    revision: number,
    token: vscode.CancellationToken,
  ): Promise<Draft> {
    if (input.chartUpdate) {
      const { state } = this.panel.prepareChartUpdate({ ...input.chartUpdate, revision });
      if (state.source === undefined) throw new Error("The chart source is unavailable.");
      return {
        source: state.source,
        language: state.language,
        title: state.title,
        revision,
        chartUpdate: input.chartUpdate,
      };
    }
    if (input.operations) {
      const operations = structureOperations(input.operations);
      const { source } = await prepareStructure(this.panel, operations, revision, token);
      return {
        source,
        language: "mermaid",
        title: this.panel.current?.title ?? "Diagram",
        revision,
        operations,
      };
    }
    const current = this.panel.current;
    const language =
      input.source !== undefined
        ? (input.language ?? (input.source.trimStart().startsWith("{") ? "echarts" : "mermaid"))
        : current?.language;
    if (!language) throw new Error("Draw a diagram before drafting edits.");
    if (input.edits !== undefined && (!current || current.source === undefined))
      throw new Error("The current source is unavailable for edits.");
    let source = input.source;
    let title = input.title ?? current?.title;
    if (current?.language === language && current.source !== undefined) {
      const change = validateEditInput({
        edits: input.edits ?? [{ oldText: current.source, newText: source }],
        ...(title !== undefined && title !== current.title && { title }),
      });
      const prepared = prepareSourceEdit(current, change);
      if (!("source" in prepared)) throw new Error(prepared.paragraphs.join("\n\n"));
      source = prepared.source;
      title = prepared.title;
    }
    if (source === undefined || !source.trim()) throw new Error("The draft source is empty.");
    if (language === "mermaid" && source.length > 50_000)
      throw new Error("The draft exceeds the 50,000-character Mermaid limit.");
    return { source, language, title: title ?? guessTitle({ language, source }), revision };
  }
}
