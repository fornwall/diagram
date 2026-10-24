import * as vscode from "vscode";
import { throwIfCancelled, unlessCancelled } from "./cancellation";
import { GRAPH_OPERATIONS, type GraphOperation, type GraphQuery, queryGraph } from "./graphQuery";
import type { DiagramPanel } from "./panel";
import { type DiagramNode, errorMessage } from "./protocol";
import { toolInput } from "./text";
import { checkedRevision, fitsToolResult, fitWholeRecords } from "./toolContracts";
import { textResult } from "./toolResults";

export const QUERY_GRAPH_TOOL = "diagram_queryGraph";

export interface GraphInput extends GraphQuery {
  revision?: number;
  startItem?: number;
  maxItems?: number;
  focus?: boolean;
}

function graphInput(
  value: unknown,
): Required<Pick<GraphInput, "startItem" | "maxItems" | "focus">> & GraphInput {
  const input = toolInput(value, [
    "operation",
    "id",
    "target",
    "maxDepth",
    "revision",
    "startItem",
    "maxItems",
    "focus",
  ]);
  if (!GRAPH_OPERATIONS.includes(input.operation as GraphOperation)) {
    throw new Error(`"operation" must be one of ${GRAPH_OPERATIONS.join(", ")}.`);
  }
  const operation = input.operation as GraphOperation;
  const needsId = ["upstream", "downstream", "path"].includes(operation);
  for (const key of ["id", "target"] as const) {
    if (input[key] !== undefined && (typeof input[key] !== "string" || !input[key].trim())) {
      throw new Error(`"${key}" must be an exact, nonempty node id.`);
    }
  }
  if (needsId !== (input.id !== undefined))
    throw new Error(needsId ? 'Give "id" for this query.' : 'This query takes no "id".');
  if ((operation === "path") !== (input.target !== undefined))
    throw new Error(
      operation === "path" ? 'Give "target" for a path.' : 'Only a path takes "target".',
    );
  for (const [key, min, max] of [
    ["revision", 0, Number.MAX_SAFE_INTEGER],
    ["startItem", 1, Number.MAX_SAFE_INTEGER],
    ["maxItems", 1, 100],
    ["maxDepth", 0, 10_000],
  ] as const) {
    if (
      input[key] !== undefined &&
      (!Number.isSafeInteger(input[key]) || Number(input[key]) < min || Number(input[key]) > max)
    ) {
      throw new Error(`"${key}" must be an integer from ${min} to ${max}.`);
    }
  }
  if (!needsId && input.maxDepth !== undefined)
    throw new Error('"maxDepth" applies only to reachability and path queries.');
  if (input.focus !== undefined && typeof input.focus !== "boolean")
    throw new Error('"focus" must be true or false.');
  return {
    ...(input as unknown as GraphInput),
    startItem: Number(input.startItem ?? 1),
    maxItems: Number(input.maxItems ?? 50),
    focus: input.focus === true,
  };
}

/** Captures all item pages from one revision; never queries a partial graph. */
export async function readGraphItems(
  panel: DiagramPanel,
  token: vscode.CancellationToken,
): Promise<DiagramNode[]> {
  const revision = panel.revision;
  if (panel.current?.language !== "mermaid")
    throw new Error("Graph queries require a Mermaid diagram.");
  const items: DiagramNode[] = [];
  let totalItems: number | undefined;
  let startItem = 1;
  for (;;) {
    throwIfCancelled(token);
    const page = await unlessCancelled(() => panel.readItems({ startItem, maxItems: 100 }), token);
    throwIfCancelled(token);
    if (panel.revision !== revision)
      throw new Error(
        "The diagram changed while reading its graph. Read diagram_getState and retry.",
      );
    if (typeof page === "string") throw new Error(page);
    if (page.totalItems > 10_000)
      throw new Error(
        "Graph queries support at most 10,000 items. Focus the source on a smaller diagram first.",
      );
    totalItems ??= page.totalItems;
    if (
      page.totalItems !== totalItems ||
      page.matchedItems !== totalItems ||
      page.startItem !== startItem
    )
      throw new Error("The panel returned an inconsistent graph. Reopen it and retry.");
    items.push(...page.items);
    if (page.nextItem === undefined && items.length === totalItems) return items;
    if (page.nextItem !== items.length + 1 || items.length >= totalItems || page.items.length === 0)
      throw new Error("The panel returned an incomplete graph. Reopen it and retry.");
    startItem = page.nextItem;
  }
}

export class GraphDiagramTool implements vscode.LanguageModelTool<GraphInput> {
  constructor(private readonly panel: DiagramPanel) {}

  prepareInvocation(): vscode.PreparedToolInvocation {
    return { invocationMessage: "Inspecting the diagram's relationships" };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GraphInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      throwIfCancelled(token);
      const input = graphInput(options.input);
      const revision = checkedRevision(input.revision, this.panel.revision);
      const graph = await readGraphItems(this.panel, token);
      const result = queryGraph(graph, input);
      const offset = input.startItem - 1;
      if (offset >= Math.max(1, result.matches.length))
        throw new Error(`"startItem" is outside the ${result.matches.length} matching items.`);
      const focus = input.focus && result.matches.length > 0 && result.matches.length <= 50;
      const note =
        input.focus && !focus
          ? result.matches.length === 0
            ? "No matches to focus."
            : "Focus was not applied: more than 50 items match. Use a smaller maxDepth."
          : undefined;
      const count = Math.min(input.maxItems, result.matches.length - offset);
      const response = await fitWholeRecords(
        count ? 1 : 0,
        count,
        (count) => {
          const items = result.matches
            .slice(offset, offset + count)
            .map(({ item, ...metadata }) => ({ ...item, ...metadata }));
          return JSON.stringify({
            revision,
            operation: input.operation,
            totalItems: result.matches.length,
            groupCount: result.groupCount,
            ignoredUndirected: result.ignoredUndirected,
            startItem: input.startItem,
            items,
            ...(offset + count < result.matches.length && { nextItem: offset + count + 1 }),
            ...(input.focus && { focused: focus }),
            ...(note && { note }),
          });
        },
        async (text) => {
          const fits = await fitsToolResult(text, options.tokenizationOptions, token);
          checkedRevision(revision, this.panel.revision);
          return fits;
        },
      );
      if (response === undefined)
        return textResult(
          `Revision: ${revision}. A graph item does not fit the result budget; request a larger budget.`,
        );
      if (focus) {
        const focused = this.panel.annotate({
          marks: result.matches.map(({ item }) => ({ id: item.id, kind: "current" })),
          dim: true,
        });
        if (!focused.ok) throw new Error(focused.reason);
      }
      return textResult(response);
    } catch (error) {
      if (error instanceof vscode.CancellationError) throw error;
      return textResult(
        `Graph query failed: ${errorMessage(error)} Revision: ${this.panel.revision}.`,
      );
    }
  }
}
