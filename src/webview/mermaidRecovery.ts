import type { SourceRepair } from "../protocol";

export interface LabelRepair {
  line: number;
  start: number;
  end: number;
  text: string;
}

/** A parser diagnostic with a local correction that can be tried once. */
export class RepairableMermaidError extends Error {
  constructor(
    message: string,
    readonly repair: SourceRepair,
  ) {
    super(message);
  }
}

/** Preserve line endings and all text outside the label. */
export function repairLabel(source: string, edit: LabelRepair): SourceRepair {
  const lines = source.split(/(\r\n|\r|\n)/);
  const index = (edit.line - 1) * 2;
  const line = lines[index] as string;
  lines[index] = line.slice(0, edit.start) + edit.text + line.slice(edit.end);
  return {
    source: lines.join(""),
    description: `Quoted the label on line ${edit.line}: ${edit.text}.`,
  };
}

/** Commit only a successful retry; a second failure keeps the original diagnostic. */
export async function renderWithRecovery(
  source: string,
  render: (source: string) => Promise<string>,
  enabled: boolean,
): Promise<{ diagramType: string; repair?: SourceRepair }> {
  try {
    return { diagramType: await render(source) };
  } catch (error) {
    if (!enabled || !(error instanceof RepairableMermaidError)) throw error;
    const { repair } = error;
    try {
      return { diagramType: await render(repair.source), repair };
    } catch {
      throw new Error(
        `${error.message}\n\nAutomatic repair failed; kept the original source. Tried: ${repair.description}`,
      );
    }
  }
}
