// The diagram_guide tool: an agent workflow and examples for drawing each kind of diagram well,
// shared by ordinary chat and the Diagram agent.

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
  summary: "Draw, inspect and revise with the right tools",
  text: `workflow: Draw, inspect and revise with the right tools.

1. Draw. Use ${RENDER_TOOL} for new source: Mermaid for structure and flow, ECharts for quantitative data. Use ${CHART_TOOL} for files, command output or tables. Read ${GUIDE_TOOL} for unfamiliar syntax. The panel supplies theme and sizing; omit colors and fonts unless requested.

2. Revise. Start follow-ups with ${GET_STATE_TOOL}, detail:"summary", for settings, errors and selection. Read needed source with startLine/endLine or query (literal search). Use ${EDIT_TOOL} with unique oldText copied exactly from current source. Preserve ids, links and user edits. Pass revision to drawing changes; await each result and reuse its revision. On a revision conflict, reread and adapt; keep the revision guard. To start separately, pass newDiagram:true to ${RENDER_TOOL} or ${CHART_TOOL}; this detaches the Markdown block and export location.

3. Inspect data. ${INSPECT_DATA_TOOL} reports columns, types and samples; sampleRows:0 reads schema only. Omit the source for loaded chart data. Give data, file or command only to read anew: inspection and charting execute a command separately. ${UPDATE_CHART_TOOL} changes settings using loaded data. Use ${EDIT_TOOL} for generated-chart styling, ${RENDER_TOOL} for callbacks or full option control.

4. Check. Repair render errors and warnings using returned context or current source. If the panel is unavailable, inspect state before changing syntax. Use ${GET_IMAGE_TOOL} for dense drawings to check overlap, clipping and labels; request nearby item ids to zoom in. Fix layout and check again, preserving requested content.

5. Explain. ${GET_STATE_TOOL} with detail:"items" and optional query finds exact ids and labels for marks or image crops; continue at nextItem with startItem. ${PICK_NODES_TOOL} waits for a user choice. ${ANNOTATE_TOOL} replaces temporary marks; {} clears them. Explain marks in chat. Images omit selection and marks. Use ${STYLE_TOOL} for requested Mermaid colors.

6. Read code with ${FIND_FILES_TOOL}, ${SEARCH_TEXT_TOOL} (literal text) and ${READ_FILE_TOOL}; follow definitions and imports. Link nodes only to paths and lines you read. Apply writes user edits to bound Markdown as an unsaved, undoable change. Agent changes need confirmation before writing.

7. Share. ${EXPORT_HTML_TOOL} saves to file:"report.html". Pass revision; overwrite defaults to false. Source/data are embedded; opening needs internet for the CDN renderer. Keep replies brief; do not repeat source.`,
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
  let closest = contained ?? WORKFLOW.name;
  if (!contained) {
    let distance = Infinity;
    for (const each of keys) {
      const candidate = editDistance(wanted, each);
      if (candidate < distance) {
        closest = each;
        distance = candidate;
      }
    }
  }
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
  if (topic.length > 1000) {
    return `"topic" must be at most 1,000 characters.\n\n${guideIndex()}`;
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
