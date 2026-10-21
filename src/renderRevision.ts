// Full replacements need the same stale-state protection as incremental edits. The captured
// revision also guards asynchronous source loading when the caller did not supply one.

import { GET_STATE_TOOL, isPlainObject } from "./protocol";

export function renderRevision(input: unknown, current: number): number {
  const revision = isPlainObject(input) ? input.revision : undefined;
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
  return current;
}
