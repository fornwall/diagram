// What a language model is told about the diagram panel: the current diagram and what the user
// did with it.

import { codeFence } from "./blocks";
import { describeUnits } from "./chartColumns";
import type { DataTable } from "./data";
import { documentName } from "./documentDiagram";
import { linkText } from "./links";
import type { DiagramState } from "./panel";
import {
  ANNOTATE_TOOL,
  type Annotation,
  CHART_TOOL,
  type DiagramNode,
  diagramNoun,
  GET_STATE_TOOL,
  INSPECT_DATA_TOOL,
  isPlainObject,
  nodeNoun,
  RENDER_TOOL,
  type RepeatedName,
  UPDATE_CHART_TOOL,
} from "./protocol";
import { formatCount, plural, quoteAll } from "./text";

/**
 * How much of a long source and list of relationships to give: "brief" leaves them out of every
 * chat request, "full" gives them, as {@link GET_STATE_TOOL} does, and "summary" leaves out even a
 * short source, when the full description has no room in the model's input.
 */
export type Detail = "brief" | "full" | "summary";

/** Longer diagram sources are left out of the description, unless it is asked for in full. */
const MAX_SOURCE_LENGTH = 30_000;
/**
 * A longer list of relationships is left out in the same way. Each takes about 100 characters, so a
 * large diagram's list could take more of every request than its source.
 */
const MAX_RELATIONSHIPS_LENGTH = 5_000;

/** What the panel knows of the drawing and of the user's interactions with it. */
interface Drawing {
  selection?: readonly DiagramNode[];
  annotation?: Annotation | undefined;
  relationships?: readonly DiagramNode[];
  repeatedNames?: readonly RepeatedName[];
  warnings?: readonly string[];
  /**
   * The generated chart's data, if loaded, which diagram_inspectData can show, for the units that
   * filters and "max" are given in.
   */
  chartTable?: DataTable | undefined;
  detail?: Detail;
  /** Whether the model calls tools, and so is told which ones to call. */
  callsTools?: boolean;
}

/** Describes a diagram, its marks and the user's interactions with it, for a language model. */
export function describeDiagram(
  state: DiagramState,
  {
    selection = [],
    annotation,
    relationships = [],
    repeatedNames = [],
    warnings = [],
    chartTable,
    detail = "brief",
    callsTools = true,
  }: Drawing = {},
): string {
  const what = state.language === "echarts" ? "ECharts chart" : "Mermaid diagram";
  const lines = [
    `Current ${what}: ${JSON.stringify(state.title)}`,
    "",
    describeSource(state, detail, callsTools),
    "",
  ];
  // A model that calls no tools can still change a generated chart's option as a whole.
  if (state.chart && callsTools) {
    const { file, command } = state.chart;
    const refresh = file !== undefined || command !== undefined;
    lines.push(
      `${CHART_TOOL} parameters: ${describeChartParameters(state.chart)}.` +
        (refresh ? " Refresh reloads the data." : "") +
        (chartTable ? ` ${INSPECT_DATA_TOOL} shows its columns and sample rows.` : ""),
    );
    const units = chartTable && describeUnits(chartTable);
    if (units) lines.push(units);
    if (state.chartPresentation?.blocked) {
      lines.push(state.chartPresentation.blocked);
    } else if (state.chartPresentation?.edits.length) {
      lines.push(
        `${UPDATE_CHART_TOOL} preserves supported manual styling. Replacing the chart with ${CHART_TOOL} or ${RENDER_TOOL} must preserve those source customizations too.`,
      );
    }
    // Not the kept edits that the chart shows already, such as a scale that it has too.
    if (!state.chartPresentation?.blocked && state.chartPresentation?.kept?.some((e) => !e.shown)) {
      lines.push(
        `Manual styling that this ${chartTypeName(state.chart.type)} chart cannot show comes back with a chart that can; replacing the chart with ${CHART_TOOL} or ${RENDER_TOOL} drops it.`,
      );
    }
    // The table of a file or command is not kept when VS Code restarts.
    lines.push(
      refresh && !chartTable
        ? `Its data is not loaded, and ${UPDATE_CHART_TOOL} never rereads files or reruns commands. To change this generated chart's type, columns, grouping, sort or limit, ask the user to press Refresh in the diagram panel first. Use ${CHART_TOOL} to change its data source.`
        : `To change this generated chart's type, columns, grouping, sort or limit, use ${UPDATE_CHART_TOOL} with the loaded data. Use ${CHART_TOOL} to change or reload its data source.`,
    );
  }
  const links = Object.entries(state.links ?? {}).map(([id, link]) => `${id} → ${linkText(link)}`);
  if (links.length > 0) {
    lines.push(
      `Code links: ${links.join(", ")}.` +
        (callsTools ? ` Pass them to ${RENDER_TOOL} when changing the diagram.` : ""),
    );
  }
  if (state.document) {
    lines.push(
      `Opened from a code block in ${documentName(state.document)}. Only the user's Apply or Write to action writes to that file; rendering changes the panel.`,
    );
  }
  if (state.error) {
    lines.push(`It currently fails to render with this error: ${state.error}`);
  }
  if (state.editedByUser) {
    lines.push("The user edited this source. Preserve their edits unless asked otherwise.");
  }
  lines.push(...warnings);
  const listed = nodeList(relationships);
  if (listed && (detail === "full" || listed.length <= MAX_RELATIONSHIPS_LENGTH)) {
    lines.push(
      `Selectable relationships${callsTools ? ` (use these exact ids for ${ANNOTATE_TOOL})` : ""}: ${listed}.`,
    );
  } else if (listed && callsTools) {
    const many = plural(relationships.length, "selectable relationship");
    lines.push(
      detail === "summary"
        ? `It has ${many}, too many to list in the room left in your input.`
        : `It has ${many}, too many to list in every request; ${GET_STATE_TOOL} lists their ids.`,
    );
  }
  if (repeatedNames.length > 0 && callsTools) {
    lines.push(
      `Chart items that share a name (mark them by these exact ids with ${ANNOTATE_TOOL}): ${repeatedList(repeatedNames)}.`,
    );
  }
  const parts = selection.some((node) => node.relationship)
    ? "items"
    : `${nodeNoun(state.language)}s`;
  const marked = describeMarks(annotation, parts, callsTools);
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

/** E.g. "horizontal bar" for "horizontalBar". */
export function chartTypeName(type: string): string {
  return type.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
}

/** Inline data is already represented by the chart; don't repeat it in every chat turn. */
export function describeChartParameters(chart: unknown): string {
  if (!isPlainObject(chart)) return "(unavailable)";
  const { data, ...parameters } = chart;
  const json = JSON.stringify(parameters);
  const description =
    json.length <= MAX_SOURCE_LENGTH
      ? json
      : `(parameters omitted: ${plural(json.length, "character")})`;
  return typeof data === "string"
    ? `${description} (inline data: ${plural(data.length, "character")})`
    : description;
}

/** What the user is looking at on the diagram, as the last call to the annotate tool left it. */
function describeMarks(
  annotation: Annotation | undefined,
  parts: string,
  callsTools: boolean,
): string | undefined {
  if (!annotation || (annotation.marks.length === 0 && annotation.caption === undefined)) {
    return undefined;
  }
  const { marks, caption, dim } = annotation;
  const lines: string[] = [];
  if (caption !== undefined) {
    lines.push(`Annotation caption: ${caption}`);
  }
  if (marks.length > 0) {
    const listed = marks.map(
      ({ id, kind, note }) =>
        `${JSON.stringify(id)} (${kind}${note === undefined ? "" : `: ${JSON.stringify(note)}`})`,
    );
    lines.push(
      `Marked ${parts}: ${listed.join(", ")}.` +
        (dim ? " Everything else is faded." : "") +
        (callsTools
          ? ` ${ANNOTATE_TOOL} replaces the marks; call without marks to clear them.`
          : ""),
    );
  }
  return lines.join("\n");
}

/**
 * A long source is left out of every chat request, but given in full when asked for, as a model has
 * to read a source to change it. A chart generated from a large file or command output is the
 * exception: it can be too large for the model's context, and the chart tools change it instead.
 * A model that calls no tools is not told to read it with {@link GET_STATE_TOOL}.
 */
function describeSource(
  { source, language, chart }: DiagramState,
  detail: Detail,
  callsTools: boolean,
): string {
  if (source === undefined) {
    return "(Not drawn: the option was too large to keep when VS Code closed. The panel asks the user to press Refresh.)";
  }
  if (detail === "summary") {
    // Part of a source would be of no use to change it.
    const length = `The source, ${formatCount(source.length)} characters long, is left out, as the room left in your input is too small for it.`;
    return chart
      ? `(${length})`
      : `(${length} Without it, you cannot change the ${diagramNoun(language)}: tell the user, who can edit it in the source view of the diagram panel, or continue in a new chat.)`;
  }
  if (source.length <= MAX_SOURCE_LENGTH || (detail === "full" && !chart)) {
    return codeFence(source, language);
  }
  return chart || !callsTools
    ? `(The source is ${formatCount(source.length)} characters long, too long to show here.)`
    : `(The source is ${formatCount(source.length)} characters long, too long to repeat in every request; ${GET_STATE_TOOL} gives it in full.)`;
}

/**
 * Lists nodes for a language model, e.g. `"Parser" (id: "A"), "Checker" (id: "B")`. Labels and ids
 * are quoted as JSON, as chart item ids may contain parentheses, commas and outer spaces.
 */
export function nodeList(nodes: readonly DiagramNode[]): string {
  return nodes
    .map(({ label, id, relationship: relation }) => {
      const details = relation
        ? `; ${relation.kind}; from: ${JSON.stringify(relation.source)}; to: ${JSON.stringify(relation.target)}; direction: ${relation.direction}`
        : "";
      return `${JSON.stringify(label)} (id: ${JSON.stringify(id)}${details})`;
    })
    .join(", ");
}

/** Lists repeated chart item names with their ids, e.g. `"Yes" (ids: "Yes (q1)", "Yes (q2)")`. */
export function repeatedList(repeated: readonly RepeatedName[]): string {
  return repeated
    .map(({ name, ids, count }) => {
      const more = count > ids.length ? ` and ${formatCount(count - ids.length)} more` : "";
      return `${JSON.stringify(name)} (ids: ${quoteAll(ids)}${more})`;
    })
    .join(", ");
}
