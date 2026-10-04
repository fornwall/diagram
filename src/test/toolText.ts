import * as vscode from "vscode";

/** The text that a tool's result gives the model. */
export function toolText(result: vscode.LanguageModelToolResult): string {
  return result.content
    .map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : ""))
    .join("");
}
