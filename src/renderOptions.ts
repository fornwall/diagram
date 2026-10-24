// Full replacements need the same stale-state protection as incremental edits. The captured
// revision also guards asynchronous source loading when the caller did not supply one.

import { isPlainObject } from "./protocol";
import { checkedRevision } from "./toolContracts";

export function renderOptions(
  input: unknown,
  current: number,
): { revision: number; newDiagram: boolean } {
  const revision = isPlainObject(input) ? input.revision : undefined;
  const newDiagram = isPlainObject(input) ? input.newDiagram : undefined;
  if (newDiagram != null && typeof newDiagram !== "boolean") {
    throw new Error('"newDiagram" must be true or false.');
  }
  return { revision: checkedRevision(revision, current), newDiagram: newDiagram === true };
}
