// Mermaid loads elk, its default layout, only after loading and parsing the diagram's code.

/// <reference path="./elkLayout.d.ts" />

// By type prefix. flowchart-elk always uses elk.
const DEFAULT_LAYOUT_DIAGRAMS =
  /^(?:graph|flowchart|classDiagram|stateDiagram|erDiagram|requirement|agentflow-beta\b|usecase-beta\b)/;

// In YAML or JSON.
const LAYOUT_SETTING = /\blayout["']?\s*:\s*["']?([\w.-]+)/;

// Mermaid reads directives anywhere.
const DIRECTIVE = /%%\{[\s\S]*?\}%%/g;

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
      const later =
        lines
          .slice(i + 1)
          .join("\n")
          .match(DIRECTIVE) ?? [];
      return { settings: [settings, ...later].join("\n"), typeLine: line };
    }
  }
  return { settings, typeLine: undefined };
}

// A guess.
export function laidOutWithElk(source: string): boolean {
  const { settings, typeLine } = diagramHeader(source);
  if (typeLine === undefined) return false;
  const layout = LAYOUT_SETTING.exec(settings)?.[1];
  return layout ? layout.startsWith("elk") : DEFAULT_LAYOUT_DIAGRAMS.test(typeLine);
}

// Alongside Mermaid rather than after it.
export function preloadLayout(source: string): void {
  if (laidOutWithElk(source)) {
    import("mermaid-elk-layout").catch(() => {
      // Mermaid loads it again, and reports when that fails.
    });
  }
}
