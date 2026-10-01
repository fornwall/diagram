import * as assert from "node:assert";
import * as vscode from "vscode";
import { DiagramPanel } from "../panel";
import { createParticipantHandler } from "../participant";

type Part = vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart;
/** A model's reply, or a function giving it, e.g. after doing what a tool call would. */
type Reply = Part[] | (() => Promise<Part[]>);

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
async function ask(
  panel: DiagramPanel,
  replies: Reply[],
  { history = [], ...overrides }: Partial<vscode.ChatRequest & vscode.ChatContext> = {},
) {
  const sent: {
    messages: vscode.LanguageModelChatMessage[];
    options: vscode.LanguageModelChatRequestOptions;
  }[] = [];
  const model = {
    sendRequest: async (
      messages: vscode.LanguageModelChatMessage[],
      options: vscode.LanguageModelChatRequestOptions,
    ) => {
      sent.push({ messages: [...messages], options });
      const reply = replies.shift() ?? [];
      const parts = typeof reply === "function" ? await reply() : reply;
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
    ...overrides,
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
  const result = await createParticipantHandler(panel)(request, { history }, stream, token);
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
      assert.match(messageText(sent[1]?.messages.at(-1)), /failed to render with this error/);
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

  test("adopts a diagram that a tool drew for the request, but not one drawn for another", async () => {
    const panel = newPanel();
    try {
      const diagram = {
        language: "mermaid",
        source: "flowchart TD\n  A --> B",
        title: "A",
      } as const;
      const drawFor = (requestId: string) => async () => {
        assert.ok((await panel.render(diagram, "tool", { requestId })).ok);
        return [text("Done.")];
      };
      const toolInvocationToken = { requestId: "this" } as never;
      const other = await ask(panel, [drawFor("other")], { toolInvocationToken });
      assert.strictEqual(other.result, undefined);
      assert.strictEqual(panel.current?.origin, "tool");
      const own = await ask(panel, [drawFor("this")], { toolInvocationToken });
      assert.deepStrictEqual(own.result?.metadata, {
        language: "mermaid",
        source: diagram.source,
      });
      assert.strictEqual(panel.current?.origin, "participant");
    } finally {
      panel.dispose();
    }
  });

  test("makes the model call the tools that the user attached first", async () => {
    const panel = newPanel();
    try {
      const { sent } = await ask(
        panel,
        [[new vscode.LanguageModelToolCallPart("1", "diagram_getState", {})], [text(valid)]],
        { toolReferences: [{ name: "diagram_getState" }] },
      );
      const toolNames = sent.map(({ options }) => options.tools?.map((tool) => tool.name).sort());
      assert.deepStrictEqual(toolNames, [
        ["diagram_getState"],
        ["diagram_chart", "diagram_getState"],
      ]);
      assert.deepStrictEqual(
        sent.map(({ options }) => options.toolMode),
        [vscode.LanguageModelChatToolMode.Required, undefined],
      );
      assert.match(
        messageText(sent[1]?.messages.at(-1)),
        /currently shown in the diagram panel|No diagram has been rendered/,
      );
    } finally {
      panel.dispose();
    }
  });

  test("does not run tools that the model was not given", async () => {
    const panel = newPanel();
    try {
      const call = new vscode.LanguageModelToolCallPart("1", "diagram_getState", {});
      const { sent } = await ask(panel, [[call], [text("Sorry.")]]);
      assert.strictEqual(
        messageText(sent[1]?.messages.at(-1)),
        "There is no tool named diagram_getState. Use only the tools you were given.",
      );
    } finally {
      panel.dispose();
    }
  });

  test("attaches referenced files, selections and text in prompt order", async () => {
    const panel = newPanel();
    try {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
      assert.ok(folder);
      const file = vscode.Uri.joinPath(folder, "sizes.tsv");
      const references = [
        { id: "folder", value: folder },
        { id: "selection", value: new vscode.Location(file, new vscode.Range(1, 0, 2, 0)) },
        { id: "text", value: "some text", modelDescription: "The terminal selection" },
      ].reverse();
      const { sent } = await ask(panel, [[text("Hm.")]], { references });
      const attached = sent[0]?.messages.map(messageText).filter((m) => m.startsWith("Attached"));
      assert.deepStrictEqual(
        attached?.map((message) => message.split("\n")[0]),
        [
          `Attached by the user: ${vscode.workspace.asRelativePath(folder)}, which is not a text file.`,
          "Attached by the user: sizes.tsv:2",
          "Attached by the user: text (The terminal selection)",
        ],
      );
    } finally {
      panel.dispose();
    }
  });

  test("gives the model earlier turns, with their diagrams and attachments", async () => {
    const panel = newPanel();
    try {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
      assert.ok(folder);
      const references = [{ id: "file", value: vscode.Uri.joinPath(folder, "sizes.tsv") }];
      // The constructors are hidden from the API, but not at runtime.
      type Constructor<T> = new (...args: unknown[]) => T;
      const RequestTurn = vscode.ChatRequestTurn as unknown as Constructor<vscode.ChatRequestTurn>;
      const ResponseTurn =
        vscode.ChatResponseTurn as unknown as Constructor<vscode.ChatResponseTurn>;
      const history = [
        new RequestTurn("Draw #file:sizes.tsv", undefined, references, "diagram.participant", []),
        new ResponseTurn(
          [new vscode.ChatResponseMarkdownPart("Here it is.")],
          { metadata: { language: "mermaid", source: "flowchart TD\n  A --> B" } },
          "diagram.participant",
        ),
      ];
      const { sent } = await ask(panel, [[text("Hm.")]], { history, references });
      const messages = sent[0]?.messages.map(messageText).slice(1) ?? [];
      assert.deepStrictEqual(
        messages.map((message) => message.split("\n")[0]),
        ["Draw #file:sizes.tsv", "Here it is.", "Attached by the user: sizes.tsv", "Draw it"],
      );
      assert.strictEqual(messages[1], "Here it is.\n\n```mermaid\nflowchart TD\n  A --> B\n```");
    } finally {
      panel.dispose();
    }
  });
});
