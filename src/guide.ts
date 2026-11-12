// diagram_guide: a working example and syntax notes for each kind of diagram.

import type * as vscode from "vscode";
import { GUIDE_TOPICS, type GuideTopic } from "./guideTopics";
import { RENDER_TOOL } from "./protocol";
import { editDistance, quote } from "./text";
import { textResult } from "./toolResults";

interface GuideInput {
  topic?: string;
}

/** A name as topics are looked up by: lowercase letters and digits, e.g. "sequencediagram". */
const key = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

const TOPICS_BY_KEY = new Map(
  GUIDE_TOPICS.flatMap((topic) => [topic.name, ...topic.aliases].map((name) => [key(name), topic])),
);

/** Ignores case, punctuation, a leading "mermaid" and a trailing "chart" or "diagram". */
export function findTopic(name: string): GuideTopic | undefined {
  const wanted = key(name);
  const bare = wanted.replace(/^mermaid(?=.)/, "").replace(/(?<=.)(?:charts?|diagrams?)$/, "");
  return TOPICS_BY_KEY.get(wanted) ?? TOPICS_BY_KEY.get(bare);
}

/** A close spelling, else the longest topic named in the phrase, else the nearest spelling. */
function closestTopic(name: string): string {
  const wanted = key(name);
  let closest = GUIDE_TOPICS[0];
  let distance = Infinity;
  for (const [each, topic] of TOPICS_BY_KEY) {
    const candidate = editDistance(wanted, each);
    if (candidate < distance) {
      closest = topic;
      distance = candidate;
    }
  }
  const contained = [...TOPICS_BY_KEY.keys()]
    .filter((each) => each.length >= 3 && wanted.includes(each))
    .sort((a, b) => b.length - a.length)[0];
  if (distance > 2 && contained) closest = TOPICS_BY_KEY.get(contained);
  return closest?.name ?? "flowchart";
}

export function guideIndex(): string {
  const lines = (language: GuideTopic["language"]) =>
    GUIDE_TOPICS.filter((topic) => topic.language === language)
      .map(({ name, summary }) => `- ${name}: ${summary}`)
      .join("\n");
  return `Give a topic for a working example and syntax notes. Render with ${RENDER_TOOL}.\n\nMermaid:\n${lines("mermaid")}\n\nECharts:\n${lines("echarts")}`;
}

export function topicText({ name, summary, language, example, notes }: GuideTopic): string {
  return `${name}: ${summary}.\n\n\`\`\`${language}\n${example}\n\`\`\`\n\n${notes}`;
}

export function guideText(input: unknown): string {
  const topic = (input as GuideInput | undefined)?.topic;
  if (typeof topic !== "string" || !topic.trim()) return guideIndex();
  const found = findTopic(topic);
  if (found) return topicText(found);
  return `There is no topic ${quote(topic)}; the closest is "${closestTopic(topic)}".\n\n${guideIndex()}`;
}

export class DiagramGuideTool implements vscode.LanguageModelTool<GuideInput> {
  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<GuideInput>,
  ): vscode.PreparedToolInvocation {
    const topic = options.input?.topic;
    const found = typeof topic === "string" ? findTopic(topic) : undefined;
    return {
      invocationMessage: found ? `Reading the guide to ${found.name}` : "Reading the diagram guide",
    };
  }

  invoke(
    options: vscode.LanguageModelToolInvocationOptions<GuideInput>,
  ): vscode.LanguageModelToolResult {
    return textResult(guideText(options.input));
  }
}
