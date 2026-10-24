import { isDeepStrictEqual } from "node:util";
import type { DataTable } from "./data";
import { lineDiff } from "./lineDiff";
import type { DiagramState } from "./panel";
import { restoredState } from "./panelState";
import { type DiagramNode, isFromWebview, isPlainObject } from "./protocol";

export interface DiagramSnapshot {
  revision: number;
  state: DiagramState;
  items?: DiagramNode[];
  labelsKnown?: boolean;
}

export interface Checkpoint extends DiagramSnapshot {
  id: string;
  name: string;
  table?: DataTable;
}

const MAX_REVISIONS = 32;
const MAX_HISTORY = 4_000_000;
const MAX_CHECKPOINTS = 20;
const MAX_SAVED = 8_000_000;

/** Session history is bounded; explicit checkpoints are kept separately. */
export class DiagramHistory {
  private readonly revisions = new Map<number, { snapshot: DiagramSnapshot; size: number }>();
  private readonly checkpoints = new Map<string, Checkpoint>();
  private historySize = 0;

  constructor(saved?: unknown) {
    if (!Array.isArray(saved) || saved.length > MAX_CHECKPOINTS) return;
    try {
      if (serializedSize(saved) > MAX_SAVED) return;
    } catch {
      return;
    }
    for (const entry of saved) {
      if (!isPlainObject(entry)) continue;
      const state = restoredState(entry.state);
      if (
        !state ||
        typeof entry.id !== "string" ||
        !entry.id ||
        entry.id.length > 200 ||
        typeof entry.name !== "string" ||
        !entry.name.trim() ||
        entry.name.length > 100 ||
        !Number.isSafeInteger(entry.revision) ||
        Number(entry.revision) < 0 ||
        (entry.table !== undefined && !isTable(entry.table))
      )
        continue;
      this.checkpoints.set(entry.id, {
        id: entry.id,
        name: entry.name,
        revision: Number(entry.revision),
        state,
        ...(isTable(entry.table) ? { table: entry.table } : {}),
        ...(isItems(entry.items) ? { items: entry.items } : {}),
        labelsKnown: entry.labelsKnown === true,
      });
    }
  }

  record(snapshot: DiagramSnapshot): void {
    this.historySize -= this.revisions.get(snapshot.revision)?.size ?? 0;
    const size = serializedSize(snapshot);
    this.revisions.set(snapshot.revision, { snapshot, size });
    this.historySize += size;
    while (this.revisions.size > MAX_REVISIONS || this.historySize > MAX_HISTORY) {
      const first = this.revisions.entries().next().value;
      if (!first) break;
      this.historySize -= first[1].size;
      this.revisions.delete(first[0]);
    }
  }

  at(revision: number): DiagramSnapshot | undefined {
    return this.revisions.get(revision)?.snapshot;
  }

  list(): Omit<Checkpoint, "state" | "table" | "items">[] {
    return [...this.checkpoints.values()].map(({ id, name, revision }) => ({ id, name, revision }));
  }

  get(id: string): Checkpoint {
    const checkpoint = this.checkpoints.get(id);
    if (!checkpoint)
      throw new Error(`Unknown checkpoint ${JSON.stringify(id)}. List checkpoints first.`);
    return checkpoint;
  }

  save(snapshot: DiagramSnapshot, name: string, table?: DataTable): Checkpoint {
    if (!name.trim() || name.length > 100)
      throw new Error("A checkpoint name must contain 1–100 characters.");
    if (this.checkpoints.size >= MAX_CHECKPOINTS) {
      throw new Error(
        `There are already ${MAX_CHECKPOINTS} checkpoints. Delete one before saving another.`,
      );
    }
    const checkpoint: Checkpoint = {
      ...snapshot,
      id: crypto.randomUUID(),
      name: name.trim(),
      ...(table && { table }),
    };
    if (serializedSize([...this.checkpoints.values(), checkpoint]) > MAX_SAVED) {
      throw new Error(
        "The checkpoints would exceed 8 MB. Delete a checkpoint or use a smaller dataset.",
      );
    }
    const saved = structuredClone(checkpoint);
    this.checkpoints.set(saved.id, saved);
    return saved;
  }

  delete(id: string): void {
    this.get(id);
    this.checkpoints.delete(id);
  }

  saved(): Checkpoint[] {
    return [...this.checkpoints.values()];
  }
}

function serializedSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function isItems(value: unknown): value is DiagramNode[] {
  return (
    Array.isArray(value) &&
    value.length <= 10_000 &&
    isFromWebview({ type: "selectionChanged", requestId: 0, nodes: value })
  );
}

function isTable(value: unknown): value is DataTable {
  if (
    !isPlainObject(value) ||
    !Array.isArray(value.columns) ||
    !Array.isArray(value.rows) ||
    typeof value.header !== "boolean" ||
    value.rows.length * value.columns.length > 1_000_000 ||
    (value.note !== undefined && typeof value.note !== "string")
  )
    return false;
  const columns = value.columns;
  return (
    columns.every(
      (column) =>
        isPlainObject(column) &&
        typeof column.name === "string" &&
        typeof column.numeric === "boolean" &&
        (column.unit === undefined || ["bytes", "seconds", "%"].includes(String(column.unit))),
    ) &&
    value.rows.every(
      (row) =>
        Array.isArray(row) &&
        row.length === columns.length &&
        row.every(
          (cell) =>
            cell === null ||
            typeof cell === "string" ||
            (typeof cell === "number" && Number.isFinite(cell)),
        ),
    )
  );
}

/** Missing source is different from an empty source; never infer a deletion from eviction. */
export function compareSnapshots(before: DiagramSnapshot, after: DiagramSnapshot): object {
  const metadata: Record<string, { before: unknown; after: unknown }> = {};
  for (const key of [
    "language",
    "title",
    "clickPrompt",
    "links",
    "chart",
    "error",
    "editedByUser",
    "document",
    "evidence",
  ] as const) {
    if (!isDeepStrictEqual(before.state[key], after.state[key])) {
      metadata[key] = { before: before.state[key] ?? null, after: after.state[key] ?? null };
    }
  }
  const a = before.state.source;
  const b = after.state.source;
  const diff = a === undefined || b === undefined ? undefined : lineDiff(a, b);
  return {
    fromRevision: before.revision,
    revision: after.revision,
    sourceChanged: a !== b,
    ...(diff !== undefined
      ? { diff }
      : { sourceNotice: "Exact source diff unavailable; read the current source." }),
    metadata,
    ...(before.items && after.items
      ? {
          structure: compareItems(
            before.items,
            after.items,
            before.labelsKnown !== false && after.labelsKnown !== false,
          ),
        }
      : {}),
  };
}

function compareItems(before: DiagramNode[], after: DiagramNode[], labelsKnown: boolean): object {
  const key = (item: DiagramNode) => {
    const relation = item.relationship;
    if (!relation) return `node:${item.id}`;
    const endpoints = [relation.source, relation.target];
    if (relation.direction !== "forward") endpoints.sort();
    return JSON.stringify([relation.kind, ...endpoints, relation.direction, relation.text ?? ""]);
  };
  const changes = (from: DiagramNode[], to: DiagramNode[]) => {
    const counts = new Map<string, number>();
    for (const item of from) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
    return to.filter((item) => {
      const count = counts.get(key(item)) ?? 0;
      if (count > 0) {
        counts.set(key(item), count - 1);
        return false;
      }
      return true;
    });
  };
  const oldNodes = new Map(
    before.filter((item) => !item.relationship).map((item) => [item.id, item]),
  );
  const modified = labelsKnown
    ? after
        .filter(
          (item) =>
            !item.relationship &&
            oldNodes.has(item.id) &&
            oldNodes.get(item.id)?.label !== item.label,
        )
        .map((item) => ({ id: item.id, before: oldNodes.get(item.id), after: item }))
    : [];
  return { added: changes(before, after), removed: changes(after, before), modified };
}
