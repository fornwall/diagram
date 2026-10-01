import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext): void {
  const participant = vscode.chat.createChatParticipant("diagram.participant", handleChatRequest);
  context.subscriptions.push(participant);
}

export function deactivate(): void {}

const handleChatRequest: vscode.ChatRequestHandler = async (request, _context, stream, _token) => {
  stream.markdown(`Hello from **@diagram**! You said: ${request.prompt}`);
};
