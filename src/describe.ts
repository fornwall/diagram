// What a language model is told about the diagram panel: the current diagram and what the user
// did with it.

import { codeFence } from "./blocks";
import { dataOrigin } from "./chartSpec";
import type { DiagramState } from "./panel";
import { CHART_TOOL, type DiagramNode } from "./protocol";

/** Longer diagram sources are left out of the description. */
const MAX_SOURCE_LENGTH = 30_000;

/** Describes a diagram and the user's interactions with it, for a language model. */
export function describeDiagram(state: DiagramState, selection: readonly DiagramNode[]): string {
  const what =
    state.language === "echarts" ? "chart, as an Apache ECharts option," : "Mermaid diagram";
  const lines = [
    `The ${what} currently shown in the diagram panel ("${state.title}"):`,
    "",
    describeSource(state),
    "",
  ];
  if (state.chart) {
    lines.push(
      `It was drawn with ${CHART_TOOL} from ${dataOrigin(state.chart)}, with these parameters: ${JSON.stringify(state.chart)}. The user can reload the data with Refresh. To change the chart, call ${CHART_TOOL} again rather than editing the generated option.`,
    );
  }
  if (state.error) {
    lines.push(`It currently fails to render with this error: ${state.error}`);
  }
  if (state.editedByUser) {
    lines.push(
      "The user has edited this source by hand since it was last generated. Keep their edits unless asked otherwise.",
    );
  }
  const parts = state.language === "echarts" ? "chart items" : "nodes";
  lines.push(
    selection.length > 0
      ? `The user has selected these ${parts} in the panel: ${nodeList(selection)}.`
      : `The user has no ${parts} selected in the panel.`,
  );
  return lines.join("\n");
}

function describeSource({ source, language }: DiagramState): string {
  if (source === undefined) {
    return "(Not drawn: the option was too large to keep when VS Code closed. The panel asks the user to press Refresh.)";
  }
  // A chart of a large file or command output can be too large for the model's context.
  return source.length <= MAX_SOURCE_LENGTH
    ? codeFence(source, language)
    : `(The source is ${source.length} characters long, too long to show here.)`;
}

/** Lists nodes for a language model, e.g. `"Parser" (id: A), "Checker" (id: B)`. */
export function nodeList(nodes: readonly DiagramNode[]): string {
  return nodes.map((node) => `"${node.label}" (id: ${node.id})`).join(", ");
}
