import type * as vscode from "vscode";
import { throwIfCancelled, unlessCancelled } from "./cancellation";
import { editFlowchart, flowchartStructure, type StructureEdit } from "./flowchartEdits";
import { readGraphItems } from "./graphTool";
import { ItemNames } from "./itemNames";
import type { DiagramPanel } from "./panel";
import { toolInput } from "./text";
import { type Answer, changeResult, drawnWarnings, editFailure } from "./toolResults";

export const EDIT_STRUCTURE_TOOL = "diagram_editStructure";

export interface StructureOperation {
  operation:
    | "rename"
    | "insert"
    | "reconnect"
    | "move"
    | "addNode"
    | "addEdge"
    | "removeNode"
    | "removeEdge";
  id?: string;
  label?: string;
  edge?: string;
  source?: string;
  target?: string;
  group?: string;
}

export type StructureInput = Partial<StructureOperation> & {
  revision: number;
  operations?: StructureOperation[];
};

const OPERATION_KEYS = ["operation", "id", "label", "edge", "source", "target", "group"];

export function structureOperation(value: unknown): StructureOperation {
  const input = toolInput(value, OPERATION_KEYS);
  const fields = {
    rename: { required: ["id", "label"], optional: [] },
    insert: { required: ["id", "label", "edge"], optional: [] },
    reconnect: { required: ["edge"], optional: ["source", "target"] },
    move: { required: ["id", "group"], optional: [] },
    addNode: { required: ["id", "label"], optional: ["group"] },
    addEdge: { required: ["source", "target"], optional: ["label"] },
    removeNode: { required: ["id"], optional: [] },
    removeEdge: { required: ["edge"], optional: [] },
  } as Record<string, { required: string[]; optional: string[] }>;
  const allowed = typeof input.operation === "string" ? fields[input.operation] : undefined;
  if (!allowed) throw new Error(`"operation" must be one of ${Object.keys(fields).join(", ")}.`);
  for (const field of allowed.required) {
    if (typeof input[field] !== "string" || !input[field].trim())
      throw new Error(`Give a nonempty "${field}".`);
  }
  for (const [key, value] of Object.entries(input)) {
    if (key === "operation") continue;
    if (!allowed.required.includes(key) && !allowed.optional.includes(key))
      throw new Error(`"${key}" does not apply to ${input.operation}.`);
    if (typeof value !== "string" || !value.trim())
      throw new Error(`"${key}" must be a nonempty string.`);
  }
  if (input.operation === "reconnect" && input.source === undefined && input.target === undefined)
    throw new Error('Give "source", "target" or both to reconnect an edge.');
  return input as unknown as StructureOperation;
}

export function structureOperations(value: unknown): StructureOperation[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50)
    throw new Error('"operations" must contain 1–50 structural operations.');
  return value.map(structureOperation);
}

function structureInput(value: unknown): { revision: number; operations: StructureOperation[] } {
  const input = toolInput(value, [...OPERATION_KEYS, "revision", "operations"]);
  if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0)
    throw new Error('Give the current nonnegative "revision" from diagram_getState.');
  const { revision, operations, ...single } = input;
  if (operations !== undefined && Object.keys(single).length)
    throw new Error('Give either "operations" or a single operation, not both.');
  return {
    revision: Number(revision),
    operations:
      operations === undefined ? [structureOperation(single)] : structureOperations(operations),
  };
}

/** Prepare the entire batch before changing the panel. Edge ids follow their original edges. */
export async function prepareStructure(
  panel: DiagramPanel,
  operations: readonly StructureOperation[],
  revision: number,
  token: vscode.CancellationToken,
): Promise<{ source: string; removedNodes: string[] }> {
  const state = panel.current;
  if (revision !== panel.revision)
    throw new Error(
      `The diagram changed since revision ${revision}. Read diagram_getState and retry.`,
    );
  if (state?.language !== "mermaid" || state.source === undefined)
    throw new Error("Structural edits require a Mermaid flowchart.");
  if (panel.rendering)
    throw new Error("Wait for the diagram to finish rendering before editing it.");
  if (state.error)
    throw new Error(`Fix the current render error with diagram_edit first: ${state.error}`);
  let source = state.source;
  let model = flowchartStructure(source);
  let nextId = 0;
  let edgeIds = model.edges.map(() => `batch-edge:${nextId++}`);
  const labels = new Map<string, string>();
  if (operations.some(({ edge }) => edge !== undefined)) {
    const graph = await readGraphItems(panel, token);
    for (const item of graph) {
      const relation = item.relationship;
      if (relation?.kind !== "edge" || relation.linkStyle === undefined) continue;
      const edge = model.edges[relation.linkStyle];
      if (
        !edge ||
        edge.source !== relation.source ||
        edge.target !== relation.target ||
        edge.direction !== relation.direction
      )
        throw new Error(
          "The rendered edge does not match the source structure. Use diagram_edit for this syntax.",
        );
      edgeIds[relation.linkStyle] = item.id;
      labels.set(item.id, relation.text ?? "");
    }
  }
  const removedNodes = new Set<string>();
  for (const operation of operations) {
    throwIfCancelled(token);
    let edit: StructureEdit;
    if (operation.edge !== undefined) {
      const names = new ItemNames({
        nodeIds: model.nodes,
        relationships: model.edges.map((edge, index) => ({
          id: edgeIds[index] as string,
          label: labels.get(edgeIds[index] as string) ?? edge.label,
          relationship: {
            kind: "edge",
            source: edge.source,
            target: edge.target,
            direction: edge.direction,
            text: labels.get(edgeIds[index] as string) ?? edge.label,
          },
        })),
      });
      const resolved = names.resolve(operation.edge);
      if (resolved.ids.length !== 1)
        throw new Error(
          `The edge ${JSON.stringify(operation.edge)} is unknown or ambiguous. Use an exact edge id or a unique endpoint alias.`,
        );
      const edgeIndex = edgeIds.indexOf(resolved.ids[0] as string);
      if (edgeIndex < 0) throw new Error("The selected item is not an edge.");
      if (operation.operation === "insert") {
        edit = {
          operation: "insert",
          edgeIndex,
          id: operation.id as string,
          label: operation.label as string,
        };
        const continuation = `batch-edge:${nextId++}`;
        edgeIds.splice(edgeIndex + 1, 0, continuation);
        labels.set(continuation, "");
      } else if (operation.operation === "removeEdge") {
        edit = { operation: "removeEdge", edgeIndex };
        edgeIds.splice(edgeIndex, 1);
      } else {
        edit = {
          operation: "reconnect",
          edgeIndex,
          source: operation.source,
          target: operation.target,
        };
      }
    } else {
      edit = operation as StructureEdit;
      if (operation.operation === "addEdge") {
        const id = `batch-edge:${nextId++}`;
        edgeIds.push(id);
        labels.set(id, operation.label ?? "");
      }
      if (operation.operation === "removeNode") {
        removedNodes.add(operation.id as string);
        edgeIds = edgeIds.filter((_, index) => {
          const edge = model.edges[index];
          return edge?.source !== operation.id && edge?.target !== operation.id;
        });
      }
    }
    source = editFlowchart(source, edit);
    if (source.length > 50_000)
      throw new Error("The edited source would exceed the 50,000-character Mermaid limit.");
    model = flowchartStructure(source);
  }
  if (panel.revision !== revision)
    throw new Error(
      "The diagram changed while its structure was read. Read diagram_getState and retry.",
    );
  return { source, removedNodes: [...removedNodes] };
}

export class StructureDiagramTool implements vscode.LanguageModelTool<StructureInput> {
  constructor(private readonly panel: DiagramPanel) {}

  prepareInvocation(): vscode.PreparedToolInvocation {
    return { invocationMessage: "Editing the diagram's structure" };
  }

  invoke(
    options: vscode.LanguageModelToolInvocationOptions<StructureInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    return changeResult(
      this.panel,
      token,
      "Nothing was changed",
      EDIT_STRUCTURE_TOOL,
      () => structureInput(options.input),
      (input) => this.edit(input, token),
    );
  }

  private async edit(
    input: { revision: number; operations: StructureOperation[] },
    token: vscode.CancellationToken,
  ): Promise<Answer> {
    const { source, removedNodes } = await prepareStructure(
      this.panel,
      input.operations,
      input.revision,
      token,
    );
    const state = this.panel.current;
    if (!state || state.source === undefined) throw new Error("No diagram is shown.");
    if (source === state.source)
      return { paragraphs: ["The structure already matches the request."] };
    const links =
      state.links &&
      Object.fromEntries(Object.entries(state.links).filter(([id]) => !removedNodes.includes(id)));
    const outcome = await unlessCancelled(
      () => this.panel.editByAgent({ source, title: state.title, links }, input.revision),
      token,
    );
    const note = state.document
      ? "The change is in the panel; writing it to its Markdown block still requires the user's confirmation."
      : "";
    return outcome.ok
      ? {
          paragraphs: [
            `Applied ${input.operations.length === 1 ? `the ${input.operations[0]?.operation} operation` : `${input.operations.length} operations`} to the flowchart.`,
            ...drawnWarnings(this.panel),
            note,
          ],
          drawn: outcome.revision,
        }
      : {
          paragraphs: [...editFailure(outcome, "diagram", "edited", source, state.source), note],
          drawn: outcome.revision,
        };
  }
}
