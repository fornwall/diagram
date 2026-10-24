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

1. Draw. Use ${RENDER_TOOL} for Mermaid structure/flow or ECharts options; ${CHART_TOOL} for files, command output or tables. Read ${GUIDE_TOOL} for unfamiliar syntax. Omit colors and fonts unless requested; the panel supplies theme and sizing.

2. Revise. Start with ${GET_STATE_TOOL}, detail:"summary", for settings, errors, selection and current capabilities. Read source ranges or literal query matches. Use ${EDIT_TOOL} with unique oldText copied exactly from current source; diagram_editStructure for supported flowchart items and atomic operations batches; ${STYLE_TOOL} for Mermaid colors; ${UPDATE_CHART_TOOL} for generated chart settings. Preserve ids, links and user edits. Pass revision; await each result and reuse its revision. On a revision conflict, reread and adapt; keep the revision guard. sinceRevision reads changes from session history. newDiagram:true detaches Markdown and export location.

3. Inspect data. ${INSPECT_DATA_TOOL} reports schema and samples; sampleRows:0 reads schema. Omit sources to reuse loaded chart data, or pass datasetId from an earlier inspection to page and chart that snapshot without I/O. Explicit sources read anew and commands rerun. Session snapshots keep eight datasets within 16 MiB; an expired id requires inspecting the source again. ids or selection:true finds contributing rows; filters and summary inspect them without changing the chart. ${UPDATE_CHART_TOOL} changes settings; ${EDIT_TOOL} changes generated-chart styling.

4. Check. Fix render errors and warnings. For an unavailable panel, inspect state before changing syntax. ${GET_IMAGE_TOOL} checks dense layouts; crop with ids and pass revision. Preserve requested content. Save a checkpoint before alternatives. diagram_draft validates source, edits, operations or chartUpdate offscreen with shared application checks; apply its id at the base revision.

5. Explain. ${GET_STATE_TOOL} with detail:"items" finds exact ids and labels for marks or crops; page with nextItem. ${PICK_NODES_TOOL} waits for a choice. ${ANNOTATE_TOOL} replaces temporary marks; {} clears them. Pass revision when using ids from state. text adds callouts; steps creates a walkthrough. Images omit selection and marks. ${STYLE_TOOL} sets requested Mermaid colors.

6. Read code with ${FIND_FILES_TOOL}, ${SEARCH_TEXT_TOOL} and ${READ_FILE_TOOL}. Link nodes only to paths and lines you read. diagram_evidence records sources and assumptions; read itemStatus and rangeStatus after changes. Apply writes user edits to bound Markdown; agent changes need confirmation before writing.

7. Share. ${EXPORT_HTML_TOOL} saves file:"report.html", guarded by revision; overwrite defaults false. Source/data are embedded; opening needs internet for the CDN renderer. Keep replies brief; do not repeat source.

Read topic:"agent-tools" for graph queries, structural edits, checkpoints, drafts, evidence and walkthroughs.`,
} as const;

const AGENT_TOOLS = {
  name: "agent-tools",
  aliases: ["explore", "checkpoints", "drafts", "evidence", "walkthroughs"],
  summary: "Inspect selections, edit structure, compare alternatives and explain with evidence",
  text: `agent-tools: Extend the conversation using exact item ids and current revisions.

- diagram_queryGraph finds upstream/downstream nodes, shortest paths, directed cycles or weak components. focus:true marks the result when at most 50 items match; {} to diagram_annotate clears it. Sequence messages are excluded. Page with nextItem at the same revision.
- diagram_editStructure renames flowchart labels, inserts, reconnects or moves items, and adds/removes nodes and edges. operations batches up to 50 changes atomically; removeNode removes incident edges and its code link. Pass revision and exact ids. Unsupported or ambiguous syntax is refused; use diagram_edit for those sources.
- diagram_inspectData with ids or selection:true returns contributing rows, original row numbers and optional summary statistics. filters narrow those rows. No source is reloaded. Treemap/sunburst descendants and Sankey nodes/links have row mappings; do not infer contributors from labels. Custom options that change data or structure prevent mapping.
- diagram_checkpoint saves named alternatives, lists ids, compares sources/metadata/known structure and modified labels, and restores snapshots without rerunning commands. Checkpoints survive restart (20 within 8 MB); restoring detaches Markdown. Save before trying an alternative, then compare or restore by id.
- diagram_draft action:validate accepts exactly one of source, edits, operations or chartUpdate and renders offscreen, optionally returning image:true. Shared preflight checks reject inapplicable changes before returning a draft id. preserveNodes and preservePaths check explicit Mermaid constraints, not semantic equivalence. apply uses the returned id while the base revision is current. ECharts drafts cannot execute JavaScript. The last four valid drafts are kept for the session.
- diagram_evidence action:set attaches workspace locations and explicit assumptions to exact item ids. Read sources first. action:read reports snippets, file status, rangeStatus and itemStatus. Changed/missing item identities stay flagged until set after review; unchanged files do not prove a claim. set/clear require revision.
- diagram_annotate marks may have text callouts and focus:true. steps:[{text,marks,dim,focus}] creates a walkthrough the user advances with Previous/Next. State reports the active step. Keep each callout short; longer explanations belong in chat.
- diagram_getState with sinceRevision returns source and metadata changes. History is bounded to 32 revisions within 4 MB for this session; reread current state when the base is unavailable.`,
} as const;

const TOOL_GUIDES = [WORKFLOW, AGENT_TOOLS];
const TOOL_GUIDE_KEYS = TOOL_GUIDES.flatMap((topic) => [topic.name, ...topic.aliases]).map(key);
const toolGuide = (name: string) =>
  TOOL_GUIDES.find((topic) =>
    [topic.name, ...topic.aliases].some((alias) => key(alias) === key(name)),
  );

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
 * Prefer a close spelling; otherwise use a topic named in the phrase, or the nearest spelling.
 */
function closestTopic(name: string): string {
  const wanted = key(name);
  const keys = [...TOPICS_BY_KEY.keys(), ...TOOL_GUIDE_KEYS];
  const contained = keys
    .filter((each) => each.length >= 3 && wanted.includes(each))
    .sort((a, b) => b.length - a.length)[0];
  let closest: string = WORKFLOW.name;
  let distance = Infinity;
  for (const each of keys) {
    if (Math.abs(wanted.length - each.length) >= distance) continue;
    const candidate = editDistance(wanted, each);
    if (candidate < distance) {
      closest = each;
      distance = candidate;
    }
  }
  if (distance > 2 && contained) closest = contained;
  return TOPICS_BY_KEY.get(closest)?.name ?? toolGuide(closest)?.name ?? WORKFLOW.name;
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
    `Tools and workflow:\n${TOOL_GUIDES.map(({ name, summary }) => `- ${name}: ${summary}`).join("\n")}\n\n` +
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
  const guidance = toolGuide(topic);
  if (guidance) return guidance.text;
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
        typeof topic === "string" && toolGuide(topic)
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
