import * as assert from "node:assert";
import * as vscode from "vscode";

/** The text that a tool's result gives the model. */
export function toolText(result: vscode.LanguageModelToolResult): string {
  return result.content
    .map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : ""))
    .join("");
}

/**
 * Invokes the tool outside a chat request with the input as a model may send it, also one that
 * does not fit the tool's type, and gives the text of its result.
 */
export async function invokeTool(
  tool: vscode.LanguageModelTool<never>,
  input: unknown,
  token = new vscode.CancellationTokenSource().token,
  tokenizationOptions?: vscode.LanguageModelToolTokenizationOptions,
): Promise<string> {
  const result = await tool.invoke(
    {
      input: input as never,
      toolInvocationToken: undefined,
      ...(tokenizationOptions && { tokenizationOptions }),
    },
    token,
  );
  assert.ok(result);
  return toolText(result);
}
