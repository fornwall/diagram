// What a language model is told about the diagram panel.

import { codeFence } from "./blocks";
import { documentName } from "./documentDiagram";
import { type ItemNames, relationshipList } from "./itemNames";
import { lineDiff } from "./lineDiff";
import { linkText } from "./links";
import type { DiagramState } from "./panel";
import { type Annotation, type DiagramNode, nodeNoun, type RepeatedName } from "./protocol";
import { formatCount, quoteAll } from "./text";
import { formatOption } from "./webview/optionSource";

interface Drawing {
  selection?: readonly DiagramNode[];
  annotation?: Annotation | undefined;
  items?: ItemNames | undefined;
  repeatedNames?: readonly RepeatedName[];
  warnings?: readonly string[];
}

export function describeDiagram(
  state: DiagramState,
  { selection = [], annotation, items, repeatedNames = [], warnings = [] }: Drawing = {},
): string {
  const what = state.language === "echarts" ? "ECharts chart" : "Mermaid diagram";
  const lines = [
    `Current ${what}: ${JSON.stringify(state.title)}`,
    "",
    codeFence(state.source, state.language),
    "",
  ];
  const links = Object.entries(state.links ?? {}).map(([id, link]) => `${id} → ${linkText(link)}`);
  if (links.length > 0) lines.push(`Code links: ${links.join(", ")}.`);
  if (state.document) {
    lines.push(
      `Opened from a code block in ${documentName(state.document)}. Only the user's Apply writes to that file.`,
    );
  }
  if (state.error) lines.push(`It fails to render: ${state.error}`);
  const diff = userDiff(state);
  if (diff) {
    lines.push(
      `The user changed the source since an agent drew it. Preserve their changes unless asked otherwise:\n${codeFence(diff, "diff")}`,
    );
  } else if (state.editedByUser) {
    lines.push("The user edited this source. Preserve their edits unless asked otherwise.");
  }
  lines.push(...warnings);
  const relationships = items?.drawn.relationships.filter(({ id }) => !items.named(id));
  if (relationships?.length) {
    lines.push(
      `Name edges and messages by their ends' ids, as in "A --> B", or by id these that their ends and labels do not tell apart: ${relationshipList(relationships)}.`,
    );
  }
  if (repeatedNames.length > 0) {
    lines.push(`Chart items that share a name, by id: ${repeatedList(repeatedNames)}.`);
  }
  const marked = annotation && describeMarks(annotation, (id) => items?.name(id) ?? id);
  if (marked) lines.push(marked);
  const nodes = `${nodeNoun(state.language)}s`;
  lines.push(
    selection.length > 0
      ? `The user has selected: ${nodeList(selection)}.`
      : `The user has no ${nodes} selected.`,
  );
  return lines.join("\n");
}

/** The user's changes as a diff from the agent's source, unless they rewrote it. */
function userDiff({ userEdit, source, language }: DiagramState): string | undefined {
  if (!userEdit || userEdit.to !== source) return undefined;
  // The user edits a one-line option as the source view formats it.
  const from = language === "echarts" ? formatOption(userEdit.from) : userEdit.from;
  const diff = lineDiff(from, source);
  return diff && diff.length <= Math.max(source.length, 1_000) ? diff : undefined;
}

function describeMarks(annotation: Annotation, name: (id: string) => string): string | undefined {
  const { marks, dim } = annotation;
  if (marks.length === 0) return undefined;
  const listed = marks.map(
    ({ id, kind, text }) =>
      `${JSON.stringify(name(id))} (${kind})${text ? `: ${JSON.stringify(text)}` : ""}`,
  );
  return `Marked: ${listed.join(", ")}.${dim ? " Everything else is faded." : ""}`;
}

/** E.g. `"Parser" (id: "A"), "Checker" (id: "B")`, quoted as JSON as chart ids may hold commas. */
export function nodeList(nodes: readonly DiagramNode[]): string {
  return nodes
    .map(({ label, id, relationship: relation }) => {
      const details = relation
        ? `; ${relation.kind}; from: ${JSON.stringify(relation.source)}; to: ${JSON.stringify(relation.target)}`
        : "";
      return `${JSON.stringify(label)} (id: ${JSON.stringify(id)}${details})`;
    })
    .join(", ");
}

/** E.g. `"Yes" (ids: "Yes (q1)", "Yes (q2)")`. */
export function repeatedList(repeated: readonly RepeatedName[]): string {
  return repeated
    .map(({ name, ids, count }) => {
      const more = count > ids.length ? ` and ${formatCount(count - ids.length)} more` : "";
      return `${JSON.stringify(name)} (ids: ${quoteAll(ids)}${more})`;
    })
    .join(", ");
}
