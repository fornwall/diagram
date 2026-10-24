import type * as vscode from "vscode";
import { throwIfCancelled, unlessCancelled } from "./cancellation";

export function checkedRevision(value: unknown, current: number): number {
  if (value != null) {
    if (!Number.isSafeInteger(value) || Number(value) < 0)
      throw new Error('"revision" must be a nonnegative integer from diagram_getState.');
    if (value !== current)
      throw new Error(
        `The diagram changed since revision ${value}. Read diagram_getState and retry with its current revision, keeping the revision guard.`,
      );
  }
  return current;
}

/** Bound complete results and honor cancellation even when counting tokens yields. */
export async function fitsToolResult(
  text: string,
  options: vscode.LanguageModelToolTokenizationOptions | undefined,
  token: vscode.CancellationToken,
  maxChars = 24_000,
): Promise<boolean> {
  throwIfCancelled(token);
  if (text.length > maxChars) return false;
  if (!options) return true;
  const fits =
    (await unlessCancelled(async () => options.countTokens(text, token), token)) <=
    options.tokenBudget;
  throwIfCancelled(token);
  return fits;
}

/** Fit whole entries, bounding token-counting calls with binary search. */
export async function fitWholeRecords(
  first: number,
  last: number,
  response: (end: number) => string,
  fits: (text: string) => Promise<boolean>,
): Promise<string | undefined> {
  const complete = response(last);
  if (await fits(complete)) return complete;
  let low = first;
  let high = last - 1;
  let fitting: string | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const text = response(middle);
    if (await fits(text)) {
      fitting = text;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return fitting;
}
