// What a language model is told about the diagram panel: the current diagram and what the user
// did with it.

import { codeFence } from "./blocks";
import { dataOrigin } from "./chartSpec";
import { documentName } from "./documentDiagram";
import { linkText } from "./links";
import type { DiagramState } from "./panel";
import {
  ANNOTATE_TOOL,
  type Annotation,
  CHART_TOOL,
  type DiagramNode,
  nodeNoun,
  RENDER_TOOL,
} from "./protocol";

/** Longer diagram sources are left out of the description. */
const MAX_SOURCE_LENGTH = 30_000;

/** Describes a diagram, how it is marked up and the user's interactions with it, for a language model. */
export function describeDiagram(
  state: DiagramState,
  selection: readonly DiagramNode[],
  annotation?: Annotation,
): string {
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
  const links = Object.entries(state.links ?? {}).map(([id, link]) => `${id} → ${linkText(link)}`);
  if (links.length > 0) {
    lines.push(
      `These nodes link to code, which a click in the panel opens: ${links.join(", ")}. ` +
        `Pass the same links to ${RENDER_TOOL} to keep them when changing the diagram.`,
    );
  }
  if (state.document) {
    lines.push(
      `It was opened from a code block in ${documentName(state.document)} and belongs to that file, which the user's Apply in the panel writes it back to. What you render replaces the diagram in the panel only, never the file.`,
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
  const parts = `${nodeNoun(state.language)}s`;
  const marked = describeMarks(annotation, parts);
  if (marked) {
    lines.push(marked);
  }
  lines.push(
    selection.length > 0
      ? `The user has selected these ${parts} in the panel: ${nodeList(selection)}.`
      : `The user has no ${parts} selected in the panel.`,
  );
  return lines.join("\n");
}

/** What the user is looking at on the diagram, as the last call to the annotate tool left it. */
function describeMarks(annotation: Annotation | undefined, parts: string): string | undefined {
  if (!annotation || (annotation.marks.length === 0 && annotation.caption === undefined)) {
    return undefined;
  }
  const { marks, caption, dim } = annotation;
  const lines: string[] = [];
  if (caption !== undefined) {
    lines.push(`The caption above the diagram, which you wrote, reads: ${caption}`);
  }
  if (marks.length > 0) {
    const listed = marks.map(
      ({ id, kind, note }) => `${id} (${kind}${note === undefined ? "" : `: ${note}`})`,
    );
    lines.push(
      `You have marked these ${parts} in the panel: ${listed.join(", ")}.` +
        (dim ? " Everything else is faded." : "") +
        ` Call ${ANNOTATE_TOOL} to move the marks on, or without marks to clear them.`,
    );
  }
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
