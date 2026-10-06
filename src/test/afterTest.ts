import * as vscode from "vscode";

/** What to undo once the current test ends, such as a replaced VS Code API. */
const cleanups: (() => unknown)[] = [];

// At the top level, this runs after each test of every suite: the last change is undone first,
// and every one is, also when the test or another cleanup fails.
teardown(async () => {
  let failure: unknown;
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
});

/** Runs the cleanup once the current test ends, whether it passes or fails. */
export function afterTest(cleanup: () => unknown): void {
  cleanups.push(cleanup);
}

/** Replaces a property, such as a VS Code API, also one with a getter, until the current test ends. */
export function replace<T extends object, K extends keyof T>(object: T, key: K, value: T[K]): void {
  const original = Object.getOwnPropertyDescriptor(object, key);
  Object.defineProperty(object, key, { value, configurable: true, writable: true });
  afterTest(() => {
    if (original) Object.defineProperty(object, key, original);
    else delete object[key];
  });
}

type MessageKind = "showInformationMessage" | "showWarningMessage" | "showErrorMessage";

/**
 * The messages that VS Code shows as the kind says until the current test ends, instead of
 * showing them, each answered as `answer` says: by default as if the user closed it.
 */
export function recordMessages(
  kind: MessageKind,
  answer: (message: string, ...rest: unknown[]) => unknown = () => undefined,
): string[] {
  const messages: string[] = [];
  const show = async (message: string, ...rest: unknown[]) => {
    messages.push(message);
    return answer(message, ...rest);
  };
  replace(vscode.window, kind, show as (typeof vscode.window)[MessageKind]);
  return messages;
}
