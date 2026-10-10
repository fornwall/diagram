// Mermaid lays out flowcharts and most other graphs with elk, its default layout, which is a large
// module of its own that Mermaid loads only once it has loaded the diagram's code and parsed it.

/// <reference path="./elkLayout.d.ts" />

/**
 * The diagrams that Mermaid lays out with its default layout, by the start of their type, as its
 * detectors tell them apart. (flowchart-elk is laid out with elk whatever the default.)
 */
const DEFAULT_LAYOUT_DIAGRAMS =
  /^(?:graph|flowchart|classDiagram|stateDiagram|erDiagram|requirement|agentflow-beta\b|usecase-beta\b)/;

/** A layout that front matter or a directive sets, in YAML or JSON. */
const LAYOUT_SETTING = /\blayout["']?\s*:\s*["']?([\w.-]+)/;

/**
 * The settings that a diagram's front matter and directives may make, and the line after them that
 * names its type, if any.
 */
export function diagramHeader(source: string): { settings: string; typeLine: string | undefined } {
  const lines = source.split(/\r\n?|\n/, 1000);
  let settings = "";
  let i = 0;
  while (i < lines.length && (lines[i] as string).trim() === "") i++;
  if ((lines[i] as string | undefined)?.trim() === "---") {
    const end = lines.findIndex((line, j) => j > i && line.trim() === "---");
    if (end > i) {
      settings = lines.slice(i + 1, end).join("\n");
      i = end + 1;
    }
  }
  for (; i < lines.length; i++) {
    const line = (lines[i] as string).trim();
    if (line.startsWith("%%")) {
      settings += `\n${line}`;
    } else if (line !== "") {
      return { settings, typeLine: line };
    }
  }
  return { settings, typeLine: undefined };
}

/**
 * Whether Mermaid will likely lay out the diagram with elk: a guess from the type of the diagram,
 * after its front matter, directives and comments, and the layout that those may set.
 */
export function laidOutWithElk(source: string): boolean {
  const { settings, typeLine } = diagramHeader(source);
  if (typeLine === undefined) return false;
  const layout = LAYOUT_SETTING.exec(settings)?.[1];
  return layout ? layout.startsWith("elk") : DEFAULT_LAYOUT_DIAGRAMS.test(typeLine);
}

/**
 * Starts loading the elk layout for a diagram that Mermaid will likely lay it out with, alongside
 * Mermaid rather than after it, as Mermaid would.
 */
export function preloadLayout(source: string): void {
  if (laidOutWithElk(source)) {
    import("mermaid-elk-layout").catch(() => {
      // Mermaid loads it again, and reports when that fails.
    });
  }
}
