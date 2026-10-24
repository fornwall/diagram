import type { ChartSpec } from "./chartSpec";
import type { DataTable } from "./data";

type DataSource = Pick<ChartSpec, "data" | "file" | "command" | "format">;

export interface Dataset {
  id: string;
  table: DataTable;
  source: DataSource;
  warning?: string;
}

const MAX_DATASETS = 8;
const MAX_BYTES = 16 * 1024 * 1024;
const sessions = new WeakMap<object, Datasets>();

/** Parsed data is reused only by explicit handle; giving a source always reads it anew. */
export class Datasets {
  private readonly entries = new Map<string, { dataset: Dataset; bytes: number }>();
  private bytes = 0;

  save(table: DataTable, spec: ChartSpec, warning?: string): Dataset | undefined {
    const { data, file, command, format } = spec;
    const source = {
      ...(data !== undefined && { data }),
      ...(file !== undefined && { file }),
      ...(command !== undefined && { command }),
      ...(format !== undefined && { format }),
    };
    const bytes = Buffer.byteLength(JSON.stringify({ table, source, warning }), "utf8");
    if (bytes > MAX_BYTES) return undefined;
    while (this.entries.size >= MAX_DATASETS || this.bytes + bytes > MAX_BYTES) {
      const first = this.entries.entries().next().value;
      if (!first) break;
      this.entries.delete(first[0]);
      this.bytes -= first[1].bytes;
    }
    const dataset = structuredClone({
      id: crypto.randomUUID(),
      table,
      source,
      ...(warning && { warning }),
    });
    this.entries.set(dataset.id, { dataset, bytes });
    this.bytes += bytes;
    return dataset;
  }

  get(id: unknown): Dataset {
    if (typeof id !== "string" || !id.trim() || id.length > 200)
      throw new Error('"datasetId" must be a nonempty snapshot id from diagram_inspectData.');
    const dataset = this.entries.get(id)?.dataset;
    if (!dataset)
      throw new Error(
        "Unknown or expired datasetId. Inspect the explicit source again to reload it.",
      );
    return dataset;
  }
}

export function datasets(owner: object): Datasets {
  let session = sessions.get(owner);
  if (!session) {
    session = new Datasets();
    sessions.set(owner, session);
  }
  return session;
}

export function checkDatasetSource(input: Record<string, unknown>): void {
  if (
    input.datasetId !== undefined &&
    ["data", "file", "command", "format"].some((key) => input[key] !== undefined)
  )
    throw new Error('Give "datasetId" alone, without data, file, command or format.');
}
