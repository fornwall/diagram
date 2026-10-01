import * as assert from "node:assert";
import * as vscode from "vscode";
import { DiagramPanel } from "../panel";

/** A panel of its own, with state that is only saved in the given map. */
export function newPanel(values = new Map<string, unknown>()): DiagramPanel {
  const extension = vscode.extensions.getExtension("fornwall.diagram");
  assert.ok(extension);
  const workspaceState: vscode.Memento = {
    keys: () => [...values.keys()],
    get: <T>(key: string, defaultValue?: T) => (values.get(key) as T | undefined) ?? defaultValue,
    update: async (key, value) => void values.set(key, value),
  };
  const context = { extensionUri: extension.extensionUri, workspaceState };
  return new DiagramPanel(context as unknown as vscode.ExtensionContext);
}
