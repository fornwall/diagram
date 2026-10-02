import * as vscode from "vscode";

/** Starts only while active, and stops waiting when the token is cancelled. */
export async function unlessCancelled<T>(
  operation: () => Promise<T>,
  token: vscode.CancellationToken,
): Promise<T> {
  if (token.isCancellationRequested) {
    throw new vscode.CancellationError();
  }
  let listener: vscode.Disposable | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    listener = token.onCancellationRequested(() => reject(new vscode.CancellationError()));
  });
  try {
    return await Promise.race([operation(), cancelled]);
  } finally {
    listener?.dispose();
  }
}
