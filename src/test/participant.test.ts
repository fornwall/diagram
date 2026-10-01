import * as assert from "node:assert";
import * as vscode from "vscode";
import type { DiagramPanel } from "../panel";
import { createParticipantHandler } from "../participant";
import { newPanel } from "./newPanel";

type Part = vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart;
/** A model's reply, or a function giving it, e.g. after doing what a tool call would. */
type Reply = Part[] | (() => Promise<Part[]>);

const text = (value: string) => new vscode.LanguageModelTextPart(value);
const valid = "```mermaid\nflowchart TD\n  A --> B\n```";
const invalid = "```mermaid\nflowchart TD\n  A --> --> B[\n```";

// The constructors are hidden from the API, but not at runtime.
type Constructor<T> = new (...args: unknown[]) => T;
const RequestTurn = vscode.ChatRequestTurn as unknown as Constructor<vscode.ChatRequestTurn>;
const ResponseTurn = vscode.ChatResponseTurn as unknown as Constructor<vscode.ChatResponseTurn>;

/** The fake model's token count: about one token per four characters. */
const tokenCount = (text: string) => Math.ceil(text.length / 4);

/**
 * Sends a request to the participant, with a model that gives the replies in turn and takes
 * `maxInputTokens`.
 */
async function ask(
  panel: DiagramPanel,
  replies: Reply[],
  {
    history = [],
    maxInputTokens = 100_000,
    token = new vscode.CancellationTokenSource().token,
    ...overrides
  }: Partial<
    vscode.ChatRequest &
      vscode.ChatContext & { maxInputTokens: number; token: vscode.CancellationToken }
  > = {},
) {
  const sent: {
    messages: vscode.LanguageModelChatMessage[];
    options: vscode.LanguageModelChatRequestOptions;
  }[] = [];
  let counted = 0;
  const model = {
    name: "Fake",
    maxInputTokens,
    countTokens: async (text: string) => {
      counted++;
      return tokenCount(text);
    },
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
  const result = await createParticipantHandler(panel)(request, { history }, stream, token);
  return { result: result || undefined, shown, sent, counted };
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

  test("a cancelled request does not contact the model", async () => {
    const panel = newPanel();
    const cancellation = new vscode.CancellationTokenSource();
    cancellation.cancel();
    try {
      const { result, shown, sent } = await ask(panel, [[text(valid)]], {
        token: cancellation.token,
      });
      assert.strictEqual(result, undefined);
      assert.strictEqual(shown, "");
      assert.deepStrictEqual(sent, []);
      assert.strictEqual(panel.current, undefined);
    } finally {
      cancellation.dispose();
      panel.dispose();
    }
  });

  test("ignores model output arriving after cancellation", async () => {
    const panel = newPanel();
    const cancellation = new vscode.CancellationTokenSource();
    try {
      const { result, shown, sent } = await ask(
        panel,
        [
          async () => {
            cancellation.cancel();
            return [
              text(`Here it is:\n${valid}`),
              new vscode.LanguageModelToolCallPart("1", "diagram_getState", {}),
            ];
          },
        ],
        { token: cancellation.token },
      );
      assert.strictEqual(result, undefined);
      assert.strictEqual(shown, "");
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(panel.current, undefined);
    } finally {
      cancellation.dispose();
      panel.dispose();
    }
  });

  test("cancellation during rendering does not start a repair request", async () => {
    const panel = newPanel();
    const cancellation = new vscode.CancellationTokenSource();
    panel.render = async () => {
      cancellation.cancel();
      return { ok: false, kind: "invalid", error: "Invalid diagram" };
    };
    try {
      const { result, shown, sent } = await ask(panel, [[text(invalid)], [text(valid)]], {
        token: cancellation.token,
      });
      assert.strictEqual(result, undefined);
      assert.strictEqual(shown, "");
      assert.strictEqual(sent.length, 1);
    } finally {
      cancellation.dispose();
      panel.dispose();
    }
  });

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

  test("shortens tool results that don't fit the model's input, and says so", async () => {
    const panel = newPanel();
    try {
      // The tools show the extension's own panel.
      const source = `flowchart TD\n  A --> B\n%% ${"y".repeat(20_000)}`;
      const input = { input: { source }, toolInvocationToken: undefined };
      await vscode.lm.invokeTool("diagram_render", input);
      const maxInputTokens = 4_000;
      const { sent } = await ask(
        panel,
        [[new vscode.LanguageModelToolCallPart("1", "diagram_getState", {})], [text("Hm.")]],
        { toolReferences: [{ name: "diagram_getState" }], maxInputTokens },
      );
      const messages = sent[1]?.messages.map(messageText) ?? [];
      assert.match(messages.at(-1) ?? "", /y\n\n\[truncated: first \d+ of \d+ characters\]$/);
      const tokens = messages.reduce((sum, message) => sum + tokenCount(message) + 4, 0);
      assert.ok(
        tokens > (maxInputTokens * 3) / 4 && tokens <= (maxInputTokens * 7) / 8,
        `${tokens}`,
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
      const history = [
        new RequestTurn("Draw #file:sizes.tsv", undefined, references, "diagram.participant", []),
        new ResponseTurn(
          [new vscode.ChatResponseMarkdownPart("Here it is.")],
          { metadata: { language: "mermaid", source: "flowchart TD\n  A --> B" } },
          "diagram.participant",
        ),
      ];
      const { sent, counted } = await ask(panel, [[text("Hm.")]], { history, references });
      // A small prompt fits without counting its tokens.
      assert.strictEqual(counted, 0);
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

  test("leaves out the oldest turns, and older diagrams first, to fit the model's input", async () => {
    const panel = newPanel();
    try {
      // Each turn takes about 3000 tokens of text and 10000 of diagram, and the prompt may take
      // 3/4 of 41640 tokens: the last two turns fit with their diagrams, and one more without.
      const history = [1, 2, 3, 4].flatMap((n) => [
        new RequestTurn(`Draw ${n}`, undefined, [], "diagram.participant", []),
        new ResponseTurn(
          [new vscode.ChatResponseMarkdownPart(`Reply ${n}: ${"x".repeat(12_000)}`)],
          { metadata: { language: "mermaid", source: `flowchart TD\n%% ${"y".repeat(40_000)}` } },
          "diagram.participant",
        ),
      ]);
      const { sent } = await ask(panel, [[text("Hm.")]], { history, maxInputTokens: 41_640 });
      const messages = sent[0]?.messages.map(messageText).slice(1) ?? [];
      assert.deepStrictEqual(
        messages.map((message) => message.slice(0, 7)),
        ["Draw 2", "Reply 2", "Draw 3", "Reply 3", "Draw 4", "Reply 4", "Draw it"],
      );
      assert.match(messages[1] ?? "", /x\n\n\(I drew a diagram, left out here\.\)$/);
      assert.match(messages[3] ?? "", /y\n```$/);
      assert.match(messages[5] ?? "", /y\n```$/);
    } finally {
      panel.dispose();
    }
  });

  test("counts prose-only history after leaving out a diagram", async () => {
    const panel = newPanel();
    try {
      const history = [
        new RequestTurn("Earlier question", undefined, [], "diagram.participant", []),
        new ResponseTurn(
          [new vscode.ChatResponseMarkdownPart("x".repeat(12_000))],
          {},
          "diagram.participant",
        ),
        new RequestTurn("Draw it", undefined, [], "diagram.participant", []),
        new ResponseTurn(
          [new vscode.ChatResponseMarkdownPart("Here it is.")],
          { metadata: { language: "mermaid", source: "y".repeat(20_000) } },
          "diagram.participant",
        ),
      ];
      const maxInputTokens = 4_000;
      const { sent } = await ask(panel, [[text("Hm.")]], { history, maxInputTokens });
      const messages = sent[0]?.messages.map(messageText) ?? [];
      assert.ok(messages.some((message) => message.includes("I drew a diagram, left out here")));
      assert.ok(!messages.includes("Earlier question"));
      const tokens = messages.reduce((sum, message) => sum + tokenCount(message) + 4, 0);
      assert.ok(tokens <= (maxInputTokens * 3) / 4, `${tokens}`);
    } finally {
      panel.dispose();
    }
  });

  test("shortens the attachments that don't fit the model's input, and says so", async () => {
    const panel = newPanel();
    try {
      const references = [
        { id: "long", value: "a".repeat(20_000) },
        { id: "short", value: "short text" },
      ];
      const maxInputTokens = 4_000;
      const { sent } = await ask(panel, [[text("Hm.")]], { references, maxInputTokens });
      const messages = sent[0]?.messages.map(messageText) ?? [];
      assert.ok(messages.includes("Attached by the user: text\n\n```\nshort text\n```"));
      const truncated =
        /^Attached by the user: text, truncated to the first \d+ of its 20000 characters\n\n```\na+\n```$/;
      assert.ok(messages.some((message) => truncated.test(message)));
      const tokens = messages.reduce((sum, message) => sum + tokenCount(message) + 4, 0);
      assert.ok(tokens > maxInputTokens / 2 && tokens <= (maxInputTokens * 3) / 4, `${tokens}`);
    } finally {
      panel.dispose();
    }
  });

  test("says what is too large when the request does not fit the model's input", async () => {
    const panel = newPanel();
    try {
      const prompt = "Draw ".repeat(4_000);
      const { result, sent } = await ask(panel, [], { prompt, maxInputTokens: 4_000 });
      assert.strictEqual(sent.length, 0);
      assert.strictEqual(
        result?.errorDetails?.message,
        "This request is too large for Fake, which takes 3000 tokens here (4000 less room for its reply): your message takes 5004 tokens. Shorten your message or pick a model that takes more.",
      );
    } finally {
      panel.dispose();
    }
  });
});
