import { createHash } from "node:crypto";
import { type DiagramNode, isPlainObject } from "./protocol";
import { toolInput } from "./text";

export interface EvidenceLocation {
  file: string;
  startLine: number;
  endLine: number;
  /** Hash of the whole decoded file, including unsaved edits. */
  hash: string;
  /** Hash of the cited lines, normalized to LF. Older attachments lack this. */
  rangeHash?: string;
}

export interface EvidenceItem {
  id: string;
  locations: EvidenceLocation[];
  assumptions: string[];
  identity?: string;
  sourceHash?: string;
  itemStatus?: "changed" | "missing";
}

export type DiagramEvidence = EvidenceItem[];
export type EvidenceAttachment = Pick<EvidenceItem, "id" | "assumptions"> & {
  locations: Omit<EvidenceLocation, "hash" | "rangeHash">[];
};

export interface EvidenceInput {
  action: "set" | "read" | "clear";
  revision?: number;
  items?: EvidenceAttachment[];
  ids?: string[];
  startItem: number;
  maxItems: number;
}

const MAX_ITEMS = 50;

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new Error(`"${name}" must contain from 1 to ${max} characters, without NUL.`);
  }
  return value;
}

function integer(value: unknown, name: string, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) {
    throw new Error(`"${name}" must be an integer from 1 to ${max}.`);
  }
  return Number(value);
}

function items(value: unknown, saved: boolean): DiagramEvidence {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ITEMS) {
    throw new Error(`"items" must contain from 1 to ${MAX_ITEMS} entries.`);
  }
  const seen = new Set<string>();
  return value.map((given) => {
    const item = toolInput(
      given,
      saved
        ? ["id", "locations", "assumptions", "identity", "sourceHash", "itemStatus"]
        : ["id", "locations", "assumptions"],
    );
    const id = text(item.id, "id", 1000);
    if (seen.has(id)) throw new Error(`${JSON.stringify(id)} occurs more than once.`);
    seen.add(id);
    const locations = item.locations ?? [];
    const assumptions = item.assumptions ?? [];
    if (!Array.isArray(locations) || locations.length > 4) {
      throw new Error('"locations" must be an array of at most 4 file ranges.');
    }
    if (!Array.isArray(assumptions) || assumptions.length > 8) {
      throw new Error('"assumptions" must be an array of at most 8 strings.');
    }
    if (locations.length === 0 && assumptions.length === 0) {
      throw new Error("An evidence item needs at least one location or assumption.");
    }
    for (const key of ["identity", "sourceHash"] as const) {
      if (item[key] !== undefined && !isHash(item[key]))
        throw new Error(`Invalid evidence ${key}.`);
    }
    if (item.itemStatus !== undefined && !["changed", "missing"].includes(String(item.itemStatus)))
      throw new Error("Invalid evidence item status.");
    return {
      id,
      ...(typeof item.identity === "string" && { identity: item.identity }),
      ...(typeof item.sourceHash === "string" && { sourceHash: item.sourceHash }),
      ...(item.itemStatus !== undefined && {
        itemStatus: item.itemStatus as "changed" | "missing",
      }),
      locations: locations.map((given) => {
        const location = toolInput(
          given,
          saved
            ? ["file", "startLine", "endLine", "hash", "rangeHash"]
            : ["file", "startLine", "endLine"],
        );
        const file = text(location.file, "file", 4096);
        const startLine = integer(location.startLine ?? 1, "startLine", 10_000_000);
        const endLine = integer(location.endLine ?? startLine, "endLine", 10_000_000);
        if (endLine < startLine || endLine - startLine >= 100) {
          throw new Error("A file range must contain from 1 to 100 lines.");
        }
        if (saved && !isHash(location.hash)) {
          throw new Error("Invalid evidence file hash.");
        }
        if (location.rangeHash !== undefined && !isHash(location.rangeHash))
          throw new Error("Invalid evidence range hash.");
        return {
          file,
          startLine,
          endLine,
          hash: saved ? (location.hash as string) : "",
          ...(typeof location.rangeHash === "string" && { rangeHash: location.rangeHash }),
        };
      }),
      assumptions: assumptions.map((assumption) => text(assumption, "assumptions", 500)),
    };
  });
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function evidenceHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Rendering positions are not identity; endpoints, direction and labels are. */
export function evidenceIdentity(item: DiagramNode): string {
  const relation = item.relationship;
  const endpoints = relation ? [relation.source, relation.target] : [];
  if (relation && relation.direction !== "forward") endpoints.sort();
  return evidenceHash(
    JSON.stringify([
      item.label,
      relation && [relation.kind, ...endpoints, relation.direction, relation.text ?? ""],
      item.chart,
    ]),
  );
}

/** Invalidated attachments require an explicit set, even if an id is reused later. */
export function reconcileEvidence(
  evidence: DiagramEvidence | undefined,
  items: readonly DiagramNode[] | undefined,
  source?: string,
): DiagramEvidence | undefined {
  if (!evidence) return undefined;
  const known = items && new Map(items.map((item) => [item.id, item]));
  const sourceHash = source === undefined ? undefined : evidenceHash(source);
  let changed = false;
  const result = evidence.map((entry): EvidenceItem => {
    const item = known?.get(entry.id);
    let status = entry.itemStatus;
    if (known) {
      if (!item) status = "missing";
      else if (status || (entry.identity && entry.identity !== evidenceIdentity(item)))
        status = "changed";
    }
    if (sourceHash && entry.sourceHash && sourceHash !== entry.sourceHash) status = "changed";
    if (status === undefined || status === entry.itemStatus) return entry;
    changed = true;
    return { ...entry, itemStatus: status };
  });
  return changed ? result : evidence;
}

export function evidenceInput(value: unknown): EvidenceInput {
  const input = toolInput(value, ["action", "revision", "items", "ids", "startItem", "maxItems"]);
  const action = input.action ?? "read";
  if (action !== "set" && action !== "read" && action !== "clear") {
    throw new Error('"action" must be "set", "read" or "clear".');
  }
  if (
    input.revision !== undefined &&
    (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0)
  ) {
    throw new Error('"revision" must be a nonnegative integer from diagram_getState.');
  }
  if (action !== "read" && input.revision === undefined) {
    throw new Error('Pass "revision" from diagram_getState when changing evidence.');
  }
  if (action === "set" ? input.ids !== undefined : input.items !== undefined) {
    throw new Error('"items" is only for set; "ids" is only for read or clear.');
  }
  if (action !== "read" && (input.startItem !== undefined || input.maxItems !== undefined)) {
    throw new Error("Paging is only for reading evidence.");
  }
  let ids: string[] | undefined;
  if (input.ids !== undefined) {
    if (!Array.isArray(input.ids) || input.ids.length === 0 || input.ids.length > MAX_ITEMS) {
      throw new Error(`"ids" must contain from 1 to ${MAX_ITEMS} item ids.`);
    }
    ids = [...new Set(input.ids.map((id) => text(id, "ids", 1000)))];
  }
  return {
    action,
    ...(input.revision !== undefined && { revision: Number(input.revision) }),
    ...(action === "set" && {
      items: items(input.items, false).map((item) => ({
        ...item,
        locations: item.locations.map(({ hash: _, ...location }) => location),
      })),
    }),
    ...(ids && { ids }),
    startItem: integer(input.startItem ?? 1, "startItem", MAX_ITEMS),
    maxItems: integer(input.maxItems ?? 5, "maxItems", 10),
  };
}

/** Ignore malformed saved metadata; no file is read during restoration. */
export function restoredEvidence(value: unknown): DiagramEvidence | undefined {
  if (!Array.isArray(value) || value.some((item) => !isPlainObject(item))) return undefined;
  try {
    return items(value, true);
  } catch {
    return undefined;
  }
}

export function mergeEvidence(
  previous: DiagramEvidence | undefined,
  added: DiagramEvidence,
): DiagramEvidence {
  const entries = new Map(previous?.map((item) => [item.id, item]));
  for (const item of added) entries.set(item.id, item);
  if (entries.size > MAX_ITEMS)
    throw new Error(`Evidence is limited to ${MAX_ITEMS} items; clear old entries first.`);
  return [...entries.values()];
}
