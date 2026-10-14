// The diagram_guide tool: on request, how to draw each kind of diagram well in the panel, from
// the topics of guideTopics.ts, so that the tool descriptions and the prompt can stay short.

import type * as vscode from "vscode";
import { throwIfCancelled } from "./cancellation";
import { GUIDE_TOPICS, type GuideTopic } from "./guideTopics";
import { CHART_TOOL, errorMessage, RENDER_TOOL } from "./protocol";
import { quote, toolInput } from "./text";
import { textResult } from "./tools";

interface GuideInput {
  topic?: string;
}

/** A name as topics are looked up by: lowercase letters and digits, e.g. "sequencediagram". */
const key = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

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

/** The edit distance between two words. */
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] as number;
}

/**
 * The topic whose name or alias is closest to a name that none matches: the longest that the name
 * contains, as "flowchart" in "flowchart with subgraphs", or else the fewest edits away.
 */
export function closestTopic(name: string): GuideTopic {
  const wanted = key(name);
  const keys = [...TOPICS_BY_KEY.keys()];
  const contained = keys
    .filter((each) => each.length >= 3 && wanted.includes(each))
    .sort((a, b) => b.length - a.length)[0];
  const closest =
    contained ??
    keys.reduce((best, each) => (distance(wanted, each) < distance(wanted, best) ? each : best));
  return TOPICS_BY_KEY.get(closest) as GuideTopic;
}

const LANGUAGE_NAMES = { mermaid: "Mermaid", echarts: "ECharts" } as const;

/** The index: a line per topic, under what each language is for. */
export function guideIndex(): string {
  const lines = (language: GuideTopic["language"]) =>
    GUIDE_TOPICS.filter((topic) => topic.language === language)
      .map(({ name, summary }) => `- ${name}: ${summary}`)
      .join("\n");
  return (
    "Call diagram_guide with one of these topics for an example that renders in the panel, the rules models get wrong, layout tips and what the panel does already.\n\n" +
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
  const found = findTopic(topic);
  if (found) {
    return topicText(found);
  }
  return `There is no topic ${quote(topic)}; the closest is "${closestTopic(topic).name}".\n\n${guideIndex()}`;
}

export class DiagramGuideTool implements vscode.LanguageModelTool<GuideInput> {
  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<GuideInput>,
  ): vscode.PreparedToolInvocation {
    const { topic } = (options.input ?? {}) as GuideInput;
    const found = typeof topic === "string" ? findTopic(topic) : undefined;
    return {
      invocationMessage: found
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
