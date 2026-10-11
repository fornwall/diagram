// diagram_style: colors the items of the Mermaid diagram in the panel by editing its style lines.

import * as vscode from "vscode";
import { throwIfCancelled } from "./cancellation";
import { documentName } from "./documentDiagram";
import {
  type AppliedStyle,
  applyStyles,
  compositeStateIds,
  diagramKind,
  ITEM_NOUNS,
  isStyleableId,
  STYLEABLE_IDS,
  sourceIds,
  subgraphIds,
} from "./mermaidStyle";
import type { DiagramPanel } from "./panel";
import {
  CHART_TOOL,
  errorMessage,
  GET_STATE_TOOL,
  RENDER_TOOL,
  STYLE_TOOL,
  UPDATE_CHART_TOOL,
} from "./protocol";
import { type StyleChange, type StyleInput, validateStyleInput } from "./styleInput";
import { plural, quoteAll } from "./text";
import { drawnResult, idList, textResult } from "./tools";

/** Ids that name the panel rather than an item, unless the diagram has an item by that id. */
const BACKGROUND_IDS = /^(?:background|bg|canvas|panel|page|diagram|chart|theme)$/i;
/** Ids that ask for every item, unless the diagram has an item by that id. */
const EVERYTHING_IDS = /^(?:all|everything|\*)$/i;

const BACKGROUND_FIXED = "The panel background follows the VS Code theme and can't be changed.";

/** What styling did: the paragraphs of the answer, and the revision it drew, if it drew. */
interface Styled {
  paragraphs: [string, ...string[]];
  drawn?: number;
}

export class StyleDiagramTool implements vscode.LanguageModelTool<StyleInput> {
  constructor(private readonly panel: DiagramPanel) {}

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<StyleInput>,
  ): vscode.PreparedToolInvocation {
    try {
      const { styles } = validateStyleInput(options.input);
      // A few ids say more than their number; many of them would crowd the chat.
      const what =
        styles.length <= 3 ? quoteAll(styles.map(({ id }) => id)) : plural(styles.length, "item");
      const removing = styles.every(
        (style) =>
          style.clear || (style.fill === null && style.stroke === null && style.text === null),
      );
      return {
        invocationMessage: `${removing ? "Removing the colors of" : "Coloring"} ${what} in the diagram`,
      };
    } catch {
      // Reported when the tool is invoked.
      return { invocationMessage: "Coloring the diagram" };
    }
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<StyleInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    throwIfCancelled(token);
    let change: StyleChange;
    try {
      change = validateStyleInput(options.input);
    } catch (error) {
      return this.answer({
        paragraphs: [
          `Nothing was styled, as the input is invalid. Fix it and call ${STYLE_TOOL} again.`,
          errorMessage(error),
        ],
      });
    }
    let styled: Styled;
    try {
      styled = await this.style(change, token);
    } catch (error) {
      if (error instanceof vscode.CancellationError) throw error;
      styled = { paragraphs: [`Nothing was styled: ${errorMessage(error)}`] };
    }
    return this.answer(styled);
  }

  private answer({ paragraphs, drawn }: Styled): vscode.LanguageModelToolResult {
    if (drawn !== undefined) {
      return drawnResult(paragraphs.join("\n\n"), drawn);
    }
    // Every answer gives the revision to pass next, but only a drawing ends with it, which
    // @diagram takes for one that it drew (see revisionDrawn).
    const [first, ...rest] = paragraphs;
    return textResult([`${first} Revision: ${this.panel.revision}.`, ...rest].join("\n\n"));
  }

  private async style(change: StyleChange, token: vscode.CancellationToken): Promise<Styled> {
    const state = this.panel.current;
    if (!state) {
      throw new Error(`There is no diagram to color. Render one with ${RENDER_TOOL} first.`);
    }
    const ids = change.styles.map(({ id }) => id);
    if (state.language !== "mermaid" || state.source === undefined) {
      throw new Error(
        `Coloring isn't supported for charts. Set a chart's colors in its ECharts option: with the "options" of ${UPDATE_CHART_TOOL} for a chart that ${CHART_TOOL} drew, or else with ${RENDER_TOOL}.` +
          (ids.some((id) => BACKGROUND_IDS.test(id)) ? ` ${BACKGROUND_FIXED}` : ""),
      );
    }
    if (change.revision !== undefined && change.revision !== this.panel.revision) {
      throw new Error(
        `The diagram changed since revision ${change.revision}. Read ${GET_STATE_TOOL} and retry with its current revision.`,
      );
    }
    if (state.error) {
      throw new Error(
        `The diagram fails to render, so it cannot be colored. Fix it first. The error is: ${state.error}`,
      );
    }
    const { source } = state;
    const { keyword, kind } = diagramKind(source);
    if (!kind) {
      throw new Error(
        `Coloring isn't supported for ${keyword ? `${keyword} diagrams` : "this diagram"}. ` +
          `${STYLE_TOOL} colors flowchart nodes and subgraphs, classes, states and ER entities.`,
      );
    }
    const stillDrawing = "The diagram is still being drawn. Wait for the current render and retry.";
    if (this.panel.rendering) {
      throw new Error(stillDrawing);
    }

    // The ids are checked against what the panel drew, as a style line for an id that a diagram
    // does not have adds an item.
    const revision = this.panel.revision;
    const drawn = await this.panel.itemIds();
    throwIfCancelled(token);
    if (this.panel.revision !== revision) {
      throw new Error(
        `The diagram changed while it was drawn. Read ${GET_STATE_TOOL} and retry with its current revision.`,
      );
    }
    if (this.panel.rendering) {
      throw new Error(stillDrawing);
    }
    if (!drawn) {
      throw new Error(
        `The panel could not tell which items the diagram has${this.panel.current?.error ? `: ${this.panel.current.error}` : ""}. Show the panel and retry.`,
      );
    }
    const known = new Set([...drawn, ...(kind === "flowchart" ? subgraphIds(source) : [])]);
    const declared = sourceIds(source, kind);
    const composite = new Set(kind === "state" ? compositeStateIds(source) : []);
    const unknown: string[] = [];
    const notes: string[] = [];
    const requests = change.styles.filter(({ id }) => {
      if (!known.has(id)) {
        if (EVERYTHING_IDS.test(id)) {
          notes.push(
            `${JSON.stringify(id)} is not an item: give the ids of the ${ITEM_NOUNS[kind]} to color, as the source that ${GET_STATE_TOOL} gives names them.`,
          );
        } else if (BACKGROUND_IDS.test(id)) {
          notes.push(
            `${JSON.stringify(id)} was not styled: ${BACKGROUND_FIXED} Color the diagram's ${ITEM_NOUNS[kind]} instead.`,
          );
        } else {
          unknown.push(id);
        }
        return false;
      }
      if (!isStyleableId(id, kind) && declared.has(id)) {
        notes.push(
          `${JSON.stringify(id)} is an id that no style line can name, as Mermaid takes only ${STYLEABLE_IDS[kind]} there, so it cannot be colored. Give it such an id with ${RENDER_TOOL} first.`,
        );
        return false;
      }
      if (!isStyleableId(id, kind) || !declared.has(id)) {
        notes.push(
          `${JSON.stringify(id)} is a label, not an id in the source, so no style line can name it. ` +
            (kind === "flowchart"
              ? `Give the subgraph an id with ${RENDER_TOOL} first, e.g. \`subgraph pay [${id}]\`.`
              : "Notes cannot be colored."),
        );
        return false;
      }
      if (composite.has(id)) {
        notes.push(
          `${JSON.stringify(id)} is a composite state, which Mermaid draws without colors; color the states inside it instead.`,
        );
        return false;
      }
      return true;
    });
    if (unknown.length > 0) {
      const styleable = [...known].filter(
        (id) => isStyleableId(id, kind) && declared.has(id) && !composite.has(id),
      );
      notes.unshift(
        `These ids are not ${ITEM_NOUNS[kind]} of the diagram, so they were not styled: ${quoteAll(unknown)}. ` +
          `Its ids are ${idList(styleable)}.`,
      );
    }

    const { source: edited, applied } = applyStyles(source, requests);
    for (const { id, problem } of applied) {
      if (problem) notes.push(`${JSON.stringify(id)} was not styled: ${problem}`);
    }
    const changed = applied.filter(({ problem }) => !problem);
    if (changed.length === 0) {
      return { paragraphs: ["Nothing was styled.", ...notes] };
    }
    if (edited === source) {
      return {
        paragraphs: [
          changed.every((style) => style.unstyled)
            ? `${quoteAll(changed.map(({ id }) => id))} had no style to remove; nothing changed.`
            : "The diagram already has these colors; nothing changed.",
          ...notes,
        ],
      };
    }

    const outcome = await this.panel.editSource(edited, revision, token);
    if (!outcome.ok) {
      return {
        paragraphs: [
          outcome.kind === "invalid"
            ? `Nothing was styled, as the colored diagram failed to render: ${outcome.error}`
            : `Nothing was styled, as the panel could not show the colored diagram: ${outcome.error}`,
          ...notes,
        ],
      };
    }
    const colored = changed.filter((style) => !style.removed && !style.unstyled);
    const removed = changed.filter((style) => style.removed).map(({ id }) => id);
    const unstyled = changed.filter((style) => style.unstyled).map(({ id }) => id);
    const sentences: string[] = [];
    if (colored.length > 0) {
      sentences.push(`Styled ${colored.map(describeStyle).join(", ")}.`);
    }
    if (removed.length > 0) {
      sentences.push(`Removed the style of ${quoteAll(removed)}.`);
    }
    if (unstyled.length > 0) {
      sentences.push(`${quoteAll(unstyled)} had no style to remove.`);
    }
    const translucent = colored.filter((style) => style.autoText === "theme");
    if (translucent.length > 0) {
      notes.push(
        `The fill of ${quoteAll(translucent.map(({ id }) => id))} is translucent, so no text color was written: the panel picks one that reads on the theme.`,
      );
    }
    if (state.document) {
      notes.push(
        `The diagram was opened from a code block in ${documentName(state.document)}. The change is in the panel only, until the user writes it to that file with Apply or Write to.`,
      );
    }
    return { paragraphs: [sentences.join(" "), ...notes], drawn: outcome.revision };
  }
}

/** E.g. `"pay" (fill green, text white for contrast)`. */
function describeStyle({ id, fill, stroke, text, autoText }: AppliedStyle): string {
  const colors = [
    fill && `fill ${fill}`,
    stroke && `stroke ${stroke}`,
    text && `text ${text}${autoText === "contrast" ? " for contrast" : ""}`,
    autoText === "theme" && "text from the theme",
  ].filter(Boolean);
  return colors.length > 0 ? `${JSON.stringify(id)} (${colors.join(", ")})` : JSON.stringify(id);
}
