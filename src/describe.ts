// What a language model is told about the diagram panel: the current diagram and what the user
// did with it.

import { codeFence } from "./blocks";
import { describeUnits } from "./chartColumns";
import type { ChartPresentation } from "./chartPresentation";
import type { DataTable } from "./data";
import { documentName } from "./documentDiagram";
import { type ItemNames, relationshipList } from "./itemNames";
import { lineDiff } from "./lineDiff";
import { linkText } from "./links";
import type { DiagramState } from "./panel";
import {
  ANNOTATE_TOOL,
  type Annotation,
  CHART_TOOL,
  type DiagramNode,
  diagramNoun,
  EDIT_TOOL,
  GET_IMAGE_TOOL,
  GET_STATE_TOOL,
  INSPECT_DATA_TOOL,
  isPlainObject,
  nodeNoun,
  RENDER_TOOL,
  type RepeatedName,
  UPDATE_CHART_TOOL,
} from "./protocol";
import { formatCount, inWords, joinWords, plural, quoteAll } from "./text";
import { formatOption } from "./webview/optionSource";

/**
 * How much of a long source and list of relationships to give: "brief" leaves them out of every
 * chat request, "full" gives them, as {@link GET_STATE_TOOL} does, "source" gives the source but
 * not a long list, when the full description has no room in the model's input, and "summary"
 * leaves out even a short source, when that has none either.
 */
export type Detail = "brief" | "full" | "source" | "summary";

/** Longer diagram sources are left out of the description, unless it is asked for in full. */
const MAX_SOURCE_LENGTH = 30_000;
/**
 * A longer list of relationships is left out in the same way. Each takes about 50 characters, so a
 * large diagram's list could take more of every request than its source.
 */
const MAX_RELATIONSHIPS_LENGTH = 3_000;
/** The most manual edits of a generated chart listed, each in about 40 characters. */
const MAX_LISTED_EDITS = 20;
/** Longer values of manual edits are shortened, as an object of styling may be large. */
const MAX_EDIT_VALUE_LENGTH = 60;
/** A diff of the user's changes this long is given even if longer than the source. */
const SMALL_DIFF_LENGTH = 1_000;
/**
 * An option without its long runs of values is given this long when the full source does not fit:
 * about 3,000 tokens.
 */
const MAX_SUMMARY_SOURCE_LENGTH = 10_000;
/** Longer runs of lines of values alone, such as of the data of a series, are left out of a long option. */
const MAX_VALUE_LINES = 8;

/** What the panel knows of the drawing and of the user's interactions with it. */
interface Drawing {
  selection?: readonly DiagramNode[];
  annotation?: Annotation | undefined;
  /** The nodes and relationships drawn, by the names that the tools take for them. */
  items?: ItemNames | undefined;
  repeatedNames?: readonly RepeatedName[];
  warnings?: readonly string[];
  /**
   * The generated chart's data, if loaded, which diagram_inspectData can show, for the units that
   * filters and "max" are given in.
   */
  chartTable?: DataTable | undefined;
  detail?: Detail;
  /** The tools that the model may call, if not all of them: it is told to call only these. */
  tools?: ReadonlySet<string> | undefined;
}

/** Describes a diagram, its marks and the user's interactions with it, for a language model. */
export function describeDiagram(
  state: DiagramState,
  {
    selection = [],
    annotation,
    items,
    repeatedNames = [],
    warnings = [],
    chartTable,
    detail = "brief",
    tools,
  }: Drawing = {},
): string {
  const has = (tool: string) => !tools || tools.has(tool);
  const what = state.language === "echarts" ? "ECharts chart" : "Mermaid diagram";
  const lines = [
    `Current ${what}: ${JSON.stringify(state.title)}`,
    "",
    describeSource(state, detail, has),
    "",
  ];
  const refresh = state.chart?.file !== undefined || state.chart?.command !== undefined;
  if (state.chart) {
    lines.push(
      `${has(CHART_TOOL) ? CHART_TOOL : "Chart"} parameters: ${describeChartParameters(state.chart)}.` +
        (refresh ? " Refresh reloads the data." : "") +
        (chartTable && has(INSPECT_DATA_TOOL)
          ? ` ${INSPECT_DATA_TOOL} shows its columns and sample rows.`
          : ""),
    );
    const units = chartTable && describeUnits(chartTable);
    if (units) lines.push(units);
  }
  // Which parts of a generated option were made by hand, which the source alone does not tell.
  const presentation = state.chart ? state.chartPresentation : undefined;
  const edits = (!presentation?.blocked && presentation?.edits) || [];
  if (edits.length > 0) {
    lines.push(
      has(UPDATE_CHART_TOOL)
        ? `Manual styling of the generated option, which ${UPDATE_CHART_TOOL} keeps: ${editList(edits)}. Replacing the chart with ${CHART_TOOL} or ${RENDER_TOOL} must make these changes again.`
        : `Manual styling of the generated option: ${editList(edits)}.`,
    );
  }
  // A model that cannot update a generated chart can still change its option as a whole.
  if (state.chart && has(UPDATE_CHART_TOOL)) {
    if (presentation?.blocked) {
      lines.push(presentation.blocked);
    }
    // Not the kept edits that the chart shows already, such as a scale that it has too.
    if (!state.chartPresentation?.blocked && state.chartPresentation?.kept?.some((e) => !e.shown)) {
      lines.push(
        `Manual styling that this ${inWords(state.chart.type)} chart cannot show comes back with a chart that can; replacing the chart with ${CHART_TOOL} or ${RENDER_TOOL} drops it.`,
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
        (has(EDIT_TOOL) ? ` ${EDIT_TOOL} keeps them.` : "") +
        (has(RENDER_TOOL)
          ? ` Pass them to ${RENDER_TOOL} when ${has(EDIT_TOOL) ? "replacing" : "changing"} the diagram.`
          : ""),
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
  const changes = detail === "summary" ? undefined : userChanges(state);
  if (changes) {
    lines.push(
      `The user changed the source since an agent drew it, as this diff from the agent's version shows. Preserve their changes unless asked otherwise.\n${codeFence(changes.diff, "diff")}`,
    );
  } else if (state.editedByUser && edits.length === 0) {
    lines.push("The user edited this source. Preserve their edits unless asked otherwise.");
  }
  lines.push(...warnings);
  const named = items && describeRelationships(items, detail, has);
  if (named) {
    lines.push(named);
  }
  if (repeatedNames.length > 0 && has(ANNOTATE_TOOL)) {
    lines.push(
      `Chart items that share a name (mark them by these exact ids with ${ANNOTATE_TOOL}): ${repeatedList(repeatedNames)}.`,
    );
  }
  const nodes = `${nodeNoun(state.language)}s`;
  const parts = selection.some((node) => node.relationship) ? "items" : nodes;
  const marksRelationships = annotation?.marks.some(({ id }) => items?.relationship(id));
  const marked = describeMarks(
    annotation,
    marksRelationships ? "items" : nodes,
    (id) => items?.name(id) ?? id,
    has(ANNOTATE_TOOL),
  );
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

/**
 * What the user changed of an agent's drawing, as a diff from the agent's source, while the source
 * is the user's edit. A diff longer than a source that is not small tells less than the source:
 * the user rewrote the diagram rather than edit it.
 */
export function userChanges({
  userEdit,
  source,
  language,
}: DiagramState): { from: string; diff: string } | undefined {
  if (!userEdit || userEdit.to !== source) return undefined;
  // The user edits a one-line option as the source view formats it.
  const from = language === "echarts" ? formatOption(userEdit.from) : userEdit.from;
  const diff = lineDiff(from, source);
  return diff &&
    diff.length <= Math.max(source.length, SMALL_DIFF_LENGTH) &&
    diff.length <= MAX_SOURCE_LENGTH
    ? { from: userEdit.from, diff }
    : undefined;
}

/**
 * Lists the manual edits of a generated option by where they are, e.g. `yAxis.name = "Revenue"`,
 * shortening long values, which the source gives in full.
 */
function editList(edits: ChartPresentation["edits"]): string {
  const listed = edits.slice(0, MAX_LISTED_EDITS).map(({ path, value, remove, append }) => {
    const where = path
      .map((key, index) => (typeof key === "number" ? `[${key}]` : index > 0 ? `.${key}` : key))
      .join("");
    if (remove) return `${where} removed`;
    const json = JSON.stringify(value) ?? "undefined";
    const shown =
      json.length > MAX_EDIT_VALUE_LENGTH ? `${json.slice(0, MAX_EDIT_VALUE_LENGTH)}…` : json;
    return append ? `${where} added ${shown}` : `${where} = ${shown}`;
  });
  const more = edits.length - listed.length;
  return listed.join(", ") + (more > 0 ? ` and ${plural(more, "more edit")}` : "");
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

/**
 * How a model names the edges or messages of a drawing for the tools that take item ids: by their
 * ends' ids, which it knows from the source, unlike their ids, and by their ids those between the
 * same nodes as others, in a list that a long one leaves out.
 */
function describeRelationships(
  items: ItemNames,
  detail: Detail,
  has: (tool: string) => boolean,
): string | undefined {
  const { relationships } = items.drawn;
  const tools = [ANNOTATE_TOOL, GET_IMAGE_TOOL].filter(has);
  if (relationships.length === 0 || tools.length === 0) return undefined;
  const kinds = new Set(relationships.map(({ relationship }) => relationship?.kind));
  const [one, many] =
    kinds.size > 1
      ? ["an edge or message", "edges and messages"]
      : kinds.has("message")
        ? ["a message", "messages"]
        : ["an edge", "edges"];
  // An example of the drawing's own, which shows that ids are those of the source.
  const example =
    relationships.map(({ id }) => items.name(id)).find((name) => !items.has(name)) ?? "A --> B";
  const naming = `Name ${one} by its ends' ids, as in ${JSON.stringify(example)}, for ${joinWords(tools, "and")}`;
  const shared = relationships.filter(({ id }) => items.name(id) === id);
  if (shared.length === 0) return `${naming}.`;
  const listed = relationshipList(shared);
  if (detail === "full" || listed.length <= MAX_RELATIONSHIPS_LENGTH) {
    return `${naming}, and by these ids the ${many} between the same nodes as others: ${listed}.`;
  }
  const these = `${plural(shared.length, one.replace(/^an? /, ""), many)} go between the same nodes as others`;
  return detail === "summary" || detail === "source"
    ? `${naming}. ${these}, too many to list their ids in the room left in your input.`
    : has(GET_STATE_TOOL)
      ? `${naming}. ${these}, too many to list their ids in every request; ${GET_STATE_TOOL} lists them.`
      : `${naming}.`;
}

/** What the user is looking at on the diagram, as the last call to the annotate tool left it. */
function describeMarks(
  annotation: Annotation | undefined,
  parts: string,
  name: (id: string) => string,
  annotates: boolean,
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
        `${JSON.stringify(name(id))} (${kind}${note === undefined ? "" : `: ${JSON.stringify(note)}`})`,
    );
    lines.push(
      `Marked ${parts}: ${listed.join(", ")}.` +
        (dim ? " Everything else is faded." : "") +
        (annotates
          ? ` ${ANNOTATE_TOOL} replaces the marks; call without marks to clear them.`
          : ""),
    );
  }
  return lines.join("\n");
}

/**
 * A long source is left out of every chat request, but given in full when asked for, as a model has
 * to read a source to change it, unless the room left in its input is too small for it. A long
 * ECharts option, such as a chart of much data, is given without its long runs of lines of values,
 * which shows a model what to change of the rest. A model without {@link GET_STATE_TOOL} is not
 * told to read it with that.
 */
function describeSource(
  { source, language, chart }: DiagramState,
  detail: Detail,
  has: (tool: string) => boolean,
): string {
  if (source === undefined) {
    return "(Not drawn: the option was too large to keep when VS Code closed. The panel asks the user to press Refresh.)";
  }
  const length = `The source is ${formatCount(source.length)} characters long`;
  if (detail === "summary") {
    const elided = language === "echarts" ? withoutValueRuns(source) : undefined;
    if (elided !== undefined && elided.length <= MAX_SUMMARY_SOURCE_LENGTH) {
      return elidedSource(`${length}, too long for the room left in your input`, elided, has);
    }
    // Part of a source would be of no use to change it.
    const leftOut = `The source, ${formatCount(source.length)} characters long, is left out, as the room left in your input is too small for it.`;
    return chart
      ? `(${leftOut})`
      : `(${leftOut} Without it, you cannot change the ${diagramNoun(language)}: tell the user, who can edit it in the source view of the diagram panel, or continue in a new chat.)`;
  }
  if (source.length <= MAX_SOURCE_LENGTH || detail === "full" || detail === "source") {
    return codeFence(source, language);
  }
  const why = has(GET_STATE_TOOL)
    ? `${length}, too long to repeat in every request; ${GET_STATE_TOOL} gives it in full`
    : `${length}, too long to show here`;
  const elided = language === "echarts" ? withoutValueRuns(source) : undefined;
  return elided !== undefined && elided.length <= MAX_SOURCE_LENGTH
    ? elidedSource(why, elided, has)
    : `(${why}.)`;
}

/** An option without its long runs of lines of values, saying why and which lines stand for them. */
function elidedSource(why: string, elided: string, has: (tool: string) => boolean): string {
  const edits = has(EDIT_TOOL) ? `, which ${EDIT_TOOL}'s oldText must not include` : "";
  return `${why}. Here it is with long runs of lines of values left out, each marked by a line of "…"${edits}:\n${codeFence(elided, "echarts")}`;
}

/** The values of a JSON array, its brackets and commas, of which a line of values consists. */
const VALUE_TOKENS = /"(?:[^"\\]|\\.)*"|[[\],]|[^\s"[\],]+/g;
const VALUE = /^(?:".*"|[[\],]|-?\.?\d[\w.+-]*|true|false|null)$/s;

/**
 * An ECharts option with each run of more than {@link MAX_VALUE_LINES} lines of values alone, as of
 * the data of a series, shortened to its first two lines and its last, around a line of "…" that
 * says how many it leaves out. Other lines stay as they are. Undefined if it shortens no run.
 */
export function withoutValueRuns(source: string): string | undefined {
  const lines = source.split("\n");
  const isValues = (line: string) => line.match(VALUE_TOKENS)?.every((token) => VALUE.test(token));
  const kept: string[] = [];
  let shortened = false;
  for (let start = 0; start < lines.length; start++) {
    let end = start;
    while (end < lines.length && isValues(lines[end] ?? "")) end++;
    const run = lines.slice(start, end);
    if (run.length > MAX_VALUE_LINES) {
      const indent = /^\s*/.exec(run[2] ?? "")?.[0] ?? "";
      const more = `${indent}… ${plural(run.length - 3, "more line")} of values …`;
      kept.push(run[0] ?? "", run[1] ?? "", more, run.at(-1) ?? "");
      shortened = true;
    } else {
      kept.push(...run);
    }
    if (end < lines.length) kept.push(lines[end] ?? "");
    start = end;
  }
  return shortened ? kept.join("\n") : undefined;
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
