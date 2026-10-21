// Full replacements need the same stale-state protection as incremental edits. The captured
// revision also guards asynchronous source loading when the caller did not supply one.

import { GET_STATE_TOOL, isPlainObject } from "./protocol";

export function renderOptions(
  input: unknown,
  current: number,
): { revision: number; newDiagram: boolean } {
  const revision = isPlainObject(input) ? input.revision : undefined;
  const newDiagram = isPlainObject(input) ? input.newDiagram : undefined;
  if (newDiagram != null && typeof newDiagram !== "boolean") {
    throw new Error('"newDiagram" must be true or false.');
  }
  // As for optional properties of the other tools, null means omitted.
  if (revision !== undefined && revision !== null) {
    if (!Number.isSafeInteger(revision) || Number(revision) < 0) {
      throw new Error(`"revision" must be a nonnegative integer from ${GET_STATE_TOOL}.`);
    }
    if (revision !== current) {
      throw new Error(
        `The diagram changed since revision ${revision}. Read ${GET_STATE_TOOL} and adapt the replacement to its current source, keeping the revision guard.`,
      );
    }
  }
  return { revision: current, newDiagram: newDiagram === true };
}
