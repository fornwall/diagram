// The diagram_guide tool: an agent workflow and examples for drawing each kind of diagram well,
// so that the tool descriptions and the prompt can stay short.

import type * as vscode from "vscode";
import { throwIfCancelled } from "./cancellation";
import { GUIDE_TOPICS, type GuideTopic } from "./guideTopics";
import {
  ANNOTATE_TOOL,
  CHART_TOOL,
  EDIT_TOOL,
  EXPORT_HTML_TOOL,
  errorMessage,
  FIND_FILES_TOOL,
  GET_IMAGE_TOOL,
  GET_STATE_TOOL,
  GUIDE_TOOL,
  INSPECT_DATA_TOOL,
  PICK_NODES_TOOL,
  READ_FILE_TOOL,
  RENDER_TOOL,
  SEARCH_TEXT_TOOL,
  STYLE_TOOL,
  UPDATE_CHART_TOOL,
} from "./protocol";
import { editDistance, quote, toolInput } from "./text";
import { textResult } from "./toolResults";

interface GuideInput {
  topic?: string;
}

/** A name as topics are looked up by: lowercase letters and digits, e.g. "sequencediagram". */
const key = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Workflow guidance has no drawing example: keep it separate from validated diagram topics. */
const WORKFLOW = {
  name: "workflow",
  aliases: ["tools", "getting-started", "agent-workflow"],
  summary: "Choose tools, inspect evidence, draw, check and revise",
  text: `workflow: Choose tools, inspect evidence, draw, check and revise.

1. Choose tools. Use ${RENDER_TOOL} with complete source for a new diagram or substantial rewrite: Mermaid for structure and flow, ECharts for quantitative data. For files, command output or tables, use ${CHART_TOOL}. Read a ${GUIDE_TOOL} topic for unfamiliar syntax. The panel supplies theme and sizing; omit colors and fonts unless requested.

2. Revise. Read ${GET_STATE_TOOL} for unknown or stale context: detail:"summary" for metadata, detail:"source" or startLine/endLine for source, detail:"full" for relationships. Use ${EDIT_TOOL} with short, unique oldText copied exactly from current source; replacements run in order and all must apply. Preserve ids, code links and unrelated edits. Pass revision from state or the last drawing result to edit, update and style tools, and to ${RENDER_TOOL}/${CHART_TOOL} when replacing a drawing. On a revision conflict, reread and adapt; keep the revision guard. Await each drawing change before the next.

3. Inspect unfamiliar data. ${INSPECT_DATA_TOOL} reports columns, types, row count and samples. Give exactly one of data, file or command; omit all three for the current chart's loaded data. ${CHART_TOOL} reads its source again, so inspection and charting execute a command separately. Use ${UPDATE_CHART_TOOL} for type, columns, grouping, filters or title: it reuses loaded data. Omitted settings stay where compatible; null clears a nullable setting. Use ${EDIT_TOOL} only for generated-chart styling, ${CHART_TOOL} to reload/change data, and ${RENDER_TOOL} for callbacks or full option control.

4. Check results. Repair render errors and warnings. Failed syntax can remain in the panel: use returned error context or current source. For an unavailable panel, inspect state before changing syntax. If you can view images, use ${GET_IMAGE_TOOL} for dense drawings; inspect overlap, clipping and labels. If text is too small, request ids of nearby items. Fix layout and check again; preserve requested content.

5. Explain and select. ${GET_STATE_TOOL} identifies selected items and disambiguates repeated names and relationships. ${PICK_NODES_TOOL} waits for a user choice; use it when needed. ${ANNOTATE_TOOL} adds temporary marks; each call replaces all marks, and {} clears them. Explain marks in chat. Images omit selection and marks. Use ${STYLE_TOOL} for requested Mermaid colors.

6. Ground code diagrams. Use ${FIND_FILES_TOOL}, ${SEARCH_TEXT_TOOL} (literal text) and ${READ_FILE_TOOL}; follow definitions and imports. Link Mermaid node ids only to paths and lines you read. Panel edits do not write the originating Markdown file; the user can Apply or Write to.

7. Share. ${EXPORT_HTML_TOOL} saves the current drawing to file:"report.html". Pass revision; overwrite defaults to false. Source/data are embedded; opening needs internet for the CDN renderer. Explain results briefly without repeating source.`,
} as const;

const WORKFLOW_KEYS = [WORKFLOW.name, ...WORKFLOW.aliases].map(key);
const isWorkflow = (name: string) => WORKFLOW_KEYS.includes(key(name));

/** Every topic by the keys of its name and aliases. */
const TOPICS_BY_KEY = new Map(
  GUIDE_TOPICS.flatMap((topic) => [topic.name, ...topic.aliases].map((name) => [key(name), topic])),
);

/**
 * The topic of a name or alias, ignoring case and punctuation, and a leading "mermaid" or a
 * trailing "chart" or "diagram", as in "Mermaid sequence diagram" or "bar chart".
 */
export function findTopic(name: string): GuideTopic | undefined {
  const wanted = key(name);
  const bare = wanted.replace(/^mermaid(?=.)/, "").replace(/(?<=.)(?:charts?|diagrams?)$/, "");
  return TOPICS_BY_KEY.get(wanted) ?? TOPICS_BY_KEY.get(bare);
}

/**
 * The topic whose name or alias is closest to a name that none matches: the longest that the name
 * contains, as "flowchart" in "flowchart with subgraphs", or else the fewest edits away.
 */
function closestTopic(name: string): string {
  const wanted = key(name);
  const keys = [...TOPICS_BY_KEY.keys(), ...WORKFLOW_KEYS];
  const contained = keys
    .filter((each) => each.length >= 3 && wanted.includes(each))
    .sort((a, b) => b.length - a.length)[0];
  const closest =
    contained ??
    keys.reduce((best, each) =>
      editDistance(wanted, each) < editDistance(wanted, best) ? each : best,
    );
  return TOPICS_BY_KEY.get(closest)?.name ?? WORKFLOW.name;
}

const LANGUAGE_NAMES = { mermaid: "Mermaid", echarts: "ECharts" } as const;

/** The index: a line per topic, under what each language is for. */
export function guideIndex(): string {
  const lines = (language: GuideTopic["language"]) =>
    GUIDE_TOPICS.filter((topic) => topic.language === language)
      .map(({ name, summary }) => `- ${name}: ${summary}`)
      .join("\n");
  return (
    `Call ${GUIDE_TOOL} with "workflow" for tool selection and a draw/check/revise workflow, or a diagram topic for a working example, syntax rules and layout tips.\n\n` +
    `Tools and workflow:\n- ${WORKFLOW.name}: ${WORKFLOW.summary}\n\n` +
    `Mermaid, for structure and flow (${RENDER_TOOL} with language "mermaid"):\n${lines("mermaid")}\n\n` +
    `ECharts, for quantitative data (${RENDER_TOOL} with language "echarts"; ${CHART_TOOL} for data in files, command output or tables):\n${lines("echarts")}`
  );
}

/** A topic as the tool gives it: its summary, its example and its notes. */
export function topicText({ name, summary, language, example, notes }: GuideTopic): string {
  return `${name} (${LANGUAGE_NAMES[language]}): ${summary}.\n\n\`\`\`${language}\n${example}\n\`\`\`\n\n${notes}`;
}

/** What the tool answers: the topic asked for, or else the index, with the closest topic. */
export function guideText(input: unknown): string {
  let topic: unknown;
  try {
    ({ topic } = toolInput(input ?? {}, ["topic"]));
  } catch (error) {
    return `${errorMessage(error)}\n\n${guideIndex()}`;
  }
  if (topic === undefined || (typeof topic === "string" && !topic.trim())) {
    return guideIndex();
  }
  if (typeof topic !== "string") {
    return `"topic" must be a string, such as "flowchart".\n\n${guideIndex()}`;
  }
  if (isWorkflow(topic)) return WORKFLOW.text;
  const found = findTopic(topic);
  if (found) {
    return topicText(found);
  }
  return `There is no topic ${quote(topic)}; the closest is "${closestTopic(topic)}".\n\n${guideIndex()}`;
}

export class DiagramGuideTool implements vscode.LanguageModelTool<GuideInput> {
  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<GuideInput>,
  ): vscode.PreparedToolInvocation {
    const { topic } = (options.input ?? {}) as GuideInput;
    const found = typeof topic === "string" ? findTopic(topic) : undefined;
    return {
      invocationMessage:
        typeof topic === "string" && isWorkflow(topic)
          ? "Reading the guide to the diagram workflow"
          : found
            ? `Reading the guide to ${found.name}`
            : "Reading the guide to diagram types",
    };
  }

  invoke(
    options: vscode.LanguageModelToolInvocationOptions<GuideInput>,
    token: vscode.CancellationToken,
  ): vscode.LanguageModelToolResult {
    throwIfCancelled(token);
    return textResult(guideText(options.input));
  }
}
