import * as assert from "node:assert";
import * as vscode from "vscode";
import { DiagramPanel } from "../panel";
import { createParticipantHandler } from "../participant";

type Part = vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart;

const text = (value: string) => new vscode.LanguageModelTextPart(value);
const valid = "```mermaid\nflowchart TD\n  A --> B\n```";
const invalid = "```mermaid\nflowchart TD\n  A --> --> B[\n```";

function newPanel(): DiagramPanel {
  const extension = vscode.extensions.getExtension("fornwall.diagram");
  assert.ok(extension);
  const values = new Map<string, unknown>();
  const workspaceState = {
    get: (key: string) => values.get(key),
    update: async (key: string, value: unknown) => void values.set(key, value),
  };
  const context = { extensionUri: extension.extensionUri, workspaceState };
  return new DiagramPanel(context as unknown as vscode.ExtensionContext);
}

/** Sends a request to the participant, with a model that gives the replies in turn. */
async function ask(panel: DiagramPanel, replies: Part[][]) {
  const sent: vscode.LanguageModelChatMessage[][] = [];
  const model = {
    sendRequest: async (messages: vscode.LanguageModelChatMessage[]) => {
      sent.push([...messages]);
      const parts = replies.shift() ?? [];
      return {
        stream: (async function* () {
          yield* parts;
        })(),
      };
    },
  };
  const request = {
    prompt: "Draw it",
    command: undefined,
    references: [],
    toolReferences: [],
    toolInvocationToken: undefined,
    model,
  } as unknown as vscode.ChatRequest;
  let shown = "";
  const stream = new Proxy({} as vscode.ChatResponseStream, {
    get: (_target, method) => (value: unknown) => {
      if (method === "markdown") {
        shown += value;
      }
    },
  });
  const token = new vscode.CancellationTokenSource().token;
  const result = await createParticipantHandler(panel)(request, { history: [] }, stream, token);
  return { result: result || undefined, shown, sent };
}

/** The text of a message, including tool results. */
function messageText(message: vscode.LanguageModelChatMessage | undefined): string {
  return (message?.content ?? [])
    .flatMap((part) => (part instanceof vscode.LanguageModelToolResultPart ? part.content : [part]))
    .map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : ""))
    .join("");
}

suite("participant", function () {
  // The first render loads the webview, which can take a while.
  this.timeout(10_000);

  test("renders a diagram written next to a tool call, without showing its source", async () => {
    const panel = newPanel();
    try {
      const { result, shown, sent } = await ask(panel, [
        [
          text(`Here it is:\n${valid}\n`),
          new vscode.LanguageModelToolCallPart("1", "diagram_getState", {}),
        ],
        [text("It has two nodes.")],
      ]);
      assert.deepStrictEqual(result?.metadata, {
        language: "mermaid",
        source: "flowchart TD\n  A --> B",
      });
      assert.strictEqual(panel.current?.source, "flowchart TD\n  A --> B");
      assert.strictEqual(shown, "Here it is:\nIt has two nodes.");
      assert.strictEqual(sent.length, 2);
    } finally {
      panel.dispose();
    }
  });

  test("asks the model to fix a diagram that fails to render", async () => {
    const panel = newPanel();
    try {
      const { result, sent } = await ask(panel, [[text(invalid)], [text(`Fixed it.\n${valid}`)]]);
      assert.match(messageText(sent[1]?.at(-1)), /failed to render with this error/);
      assert.strictEqual(result?.metadata?.source, "flowchart TD\n  A --> B");
      assert.strictEqual(panel.current?.error, undefined);
    } finally {
      panel.dispose();
    }
  });

  test("gives up on a diagram that still fails to render, and says so", async () => {
    const panel = newPanel();
    try {
      const gaveUp = await ask(panel, [[text(invalid)], [text("I can't fix it.")]]);
      assert.match(gaveUp.shown, /failed to render: .*Edit source/s);
      assert.strictEqual(gaveUp.result?.metadata?.source, "flowchart TD\n  A --> --> B[");

      const keepsFailing = await ask(panel, [
        [text(invalid)],
        [text(invalid)],
        [text(invalid)],
        [text(valid)],
      ]);
      assert.strictEqual(keepsFailing.sent.length, 3);
      assert.match(keepsFailing.shown, /failed to render: .*Edit source/s);
    } finally {
      panel.dispose();
    }
  });
});
