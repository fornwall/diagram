import * as vscode from "vscode";
import { throwIfCancelled, unlessCancelled } from "./cancellation";
import {
  type DiagramEvidence,
  type EvidenceInput,
  evidenceHash,
  evidenceIdentity,
  evidenceInput,
  mergeEvidence,
} from "./evidence";
import type { DiagramPanel } from "./panel";
import { type DiagramNode, errorMessage } from "./protocol";
import { checkedRevision, fitsToolResult, fitWholeRecords } from "./toolContracts";
import { textResult } from "./toolResults";
import { boundary, readWorkspaceText, resolveWorkspaceFile } from "./workspaceTools";

const MIB = 1024 * 1024;
const NOTE =
  "Locations and assumptions are supplied by the agent, not verified claims. " +
  "A changed file may require reviewing the claim; unchanged content does not prove it.";

type FileContent = { text: string; hash: string; unsaved: boolean };

/** One invocation reads at most eight distinct files and uses the editor's unsaved contents. */
class EvidenceFiles {
  private readonly roots = vscode.workspace.workspaceFolders ?? [];
  private readonly check: (uri: vscode.Uri) => Promise<void>;
  private readonly files = new Map<string, Promise<FileContent>>();

  constructor(private readonly token: vscode.CancellationToken) {
    this.check = boundary(this.roots, token);
  }

  read(file: string): Promise<FileContent> {
    const uri = resolveWorkspaceFile(file, this.roots);
    const key = uri.toString();
    let content = this.files.get(key);
    if (!content) {
      if (this.files.size >= 8)
        throw new Error("Read at most 8 distinct files per call; use fewer items.");
      content = (async () => {
        const content = await readWorkspaceText(uri, this.check, this.token, MIB);
        if ("error" in content) throw new Error(content.error);
        throwIfCancelled(this.token);
        return {
          text: content.text,
          hash: evidenceHash(content.text),
          unsaved: content.unsaved === true,
        };
      })();
      this.files.set(key, content);
    }
    return content;
  }
}

function range(
  text: string,
  startLine: number,
  endLine: number,
): { lines: string[]; total: number } {
  const lines = text.split(/\r\n|\r|\n/);
  if (endLine > lines.length)
    throw new Error(`The range ends at line ${endLine}, but the file has ${lines.length} lines.`);
  return { lines: lines.slice(startLine - 1, endLine), total: lines.length };
}

/** Attach and revisit the evidence for an item without asserting that it proves the diagram. */
export class EvidenceTool implements vscode.LanguageModelTool<unknown> {
  constructor(private readonly panel: DiagramPanel) {}

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<unknown>,
  ): vscode.PreparedToolInvocation {
    const invocationMessage = "Reading or updating diagram evidence";
    try {
      const input = evidenceInput(options.input);
      if (vscode.workspace.isTrusted || input.action === "clear") return { invocationMessage };
      const files =
        input.action === "set"
          ? input.items?.flatMap((item) => item.locations.map(({ file }) => file))
          : this.panel.current?.evidence
              ?.filter((item) => !input.ids || input.ids.includes(item.id))
              .slice(input.startItem - 1, input.startItem - 1 + input.maxItems)
              .flatMap((item) => item.locations.map(({ file }) => file));
      if (input.action === "set" && !files?.length) return { invocationMessage };
      const message = new vscode.MarkdownString(
        "Allow the diagram agent to read evidence files in this untrusted workspace?",
      ).appendCodeblock(
        [...new Set(files ?? [])].join("\n") || "Attached workspace evidence",
        "text",
      );
      return {
        invocationMessage,
        confirmationMessages: { title: "Read workspace files?", message },
      };
    } catch {
      return { invocationMessage };
    }
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<unknown>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      throwIfCancelled(token);
      const input = evidenceInput(options.input);
      const state = this.panel.current;
      const revision = checkedRevision(input.revision, this.panel.revision);
      if (!state) throw new Error("Draw a diagram before attaching or reading evidence.");
      const current = () => {
        throwIfCancelled(token);
        if (this.panel.revision !== revision) {
          throw new Error(
            "The diagram changed while reading evidence. Read diagram_getState and retry.",
          );
        }
      };
      if (input.action === "clear") {
        const kept = input.ids
          ? state.evidence?.filter(({ id }) => !input.ids?.includes(id))
          : undefined;
        const appliedRevision = await this.panel.setEvidence(
          kept?.length ? kept : undefined,
          revision,
        );
        return textResult(
          JSON.stringify({
            revision: appliedRevision,
            action: "clear",
            items: kept?.length ?? 0,
          }),
        );
      }
      const files = new EvidenceFiles(token);
      if (input.action === "set") {
        const attachments = input.items ?? [];
        const known = await this.identities(
          attachments.map(({ id }) => id),
          token,
        );
        current();
        const added: DiagramEvidence = [];
        for (const item of attachments) {
          const node = known?.items.get(item.id);
          if (!node)
            throw new Error(
              `${JSON.stringify(item.id)} is not a known exact item id. Read diagram_getState with detail:"items".`,
            );
          const locations = [];
          for (const location of item.locations) {
            const content = await files.read(location.file);
            const { lines } = range(content.text, location.startLine, location.endLine);
            locations.push({
              ...location,
              hash: content.hash,
              rangeHash: evidenceHash(lines.join("\n")),
            });
          }
          added.push({
            ...item,
            locations,
            ...((known?.labelsKnown || node.relationship) && { identity: evidenceIdentity(node) }),
            ...(state.language === "echarts" &&
              state.source !== undefined && { sourceHash: evidenceHash(state.source) }),
          });
        }
        current();
        const appliedRevision = await this.panel.setEvidence(
          mergeEvidence(state.evidence, added),
          revision,
        );
        return textResult(
          JSON.stringify({
            revision: appliedRevision,
            action: "set",
            items: added.length,
            note: NOTE,
          }),
        );
      }
      const all = state.evidence ?? [];
      const matched = input.ids ? all.filter(({ id }) => input.ids?.includes(id)) : all;
      if (input.startItem > Math.max(1, matched.length))
        throw new Error('"startItem" is past the evidence items.');
      const page = matched.slice(input.startItem - 1, input.startItem - 1 + input.maxItems);
      const known = page.length
        ? await this.identities(
            page.map(({ id }) => id),
            token,
          )
        : undefined;
      current();
      const reports = [];
      for (const item of page) {
        const locations = [];
        for (const { hash, rangeHash, ...location } of item.locations) {
          try {
            const content = await files.read(location.file);
            const status = content.hash === hash ? "unchanged" : "changed";
            let lines: string[];
            try {
              lines = range(content.text, location.startLine, location.endLine).lines;
            } catch (error) {
              locations.push({
                ...location,
                status,
                rangeStatus: "unavailable",
                unsaved: content.unsaved,
                snippet: [],
                reason: errorMessage(error),
              });
              continue;
            }
            let chars = 0;
            const snippet: { line: number; text: string }[] = [];
            let truncated = false;
            for (const [index, line] of lines.entries()) {
              if (chars + line.length > 3000 || line.length > 1000) {
                truncated = true;
                break;
              }
              snippet.push({ line: location.startLine + index, text: line });
              chars += line.length;
            }
            locations.push({
              ...location,
              status,
              rangeStatus:
                rangeHash === undefined
                  ? "unverified"
                  : evidenceHash(lines.join("\n")) === rangeHash
                    ? "unchanged"
                    : "changed",
              unsaved: content.unsaved,
              snippet,
              ...(truncated && { truncated: true }),
            });
          } catch (error) {
            if (error instanceof vscode.CancellationError) throw error;
            locations.push({
              ...location,
              status:
                error instanceof Error &&
                "code" in error &&
                ["FileNotFound", "ENOENT", "ENOTDIR"].includes(String(error.code))
                  ? "missing"
                  : "unavailable",
              rangeStatus: "unavailable",
              reason: errorMessage(error),
            });
          }
        }
        const node = known?.items.get(item.id);
        const itemStatus = !known
          ? (item.itemStatus ?? "unavailable")
          : !node
            ? "missing"
            : item.itemStatus ||
                (item.sourceHash && item.sourceHash !== evidenceHash(state.source ?? ""))
              ? "changed"
              : !item.identity
                ? "unverified"
                : !known.labelsKnown && !node.relationship
                  ? "unavailable"
                  : item.identity === evidenceIdentity(node)
                    ? "unchanged"
                    : "changed";
        reports.push({ id: item.id, itemStatus, locations, assumptions: item.assumptions });
      }
      current();
      const report = await fitReports(
        reports,
        matched.length,
        input,
        revision,
        options.tokenizationOptions,
        token,
      );
      current();
      return textResult(report);
    } catch (error) {
      if (error instanceof vscode.CancellationError) throw error;
      return textResult(`Evidence was not read or changed: ${errorMessage(error)}`);
    }
  }

  private async identities(
    ids: string[],
    token: vscode.CancellationToken,
  ): Promise<{ items: Map<string, DiagramNode>; labelsKnown: boolean } | undefined> {
    await unlessCancelled(() => this.panel.itemIds(), token);
    if (this.panel.current?.language === "mermaid") {
      const snapshot = this.panel.snapshot();
      return (
        snapshot.items && {
          items: new Map(snapshot.items.map((item) => [item.id, item])),
          labelsKnown: snapshot.labelsKnown !== false,
        }
      );
    }
    const items = new Map<string, DiagramNode>();
    let startItem = 1;
    while (startItem <= ids.length) {
      const page = await unlessCancelled(
        () => this.panel.readItems({ itemIds: ids, includeData: true, startItem, maxItems: 100 }),
        token,
      );
      if (typeof page === "string") return undefined;
      for (const item of page.items) items.set(item.id, item);
      if (page.nextItem === undefined) return { items, labelsKnown: true };
      if (page.nextItem <= startItem || !page.items.length) return undefined;
      startItem = page.nextItem;
    }
    return undefined;
  }
}

async function fitReports(
  reports: unknown[],
  totalItems: number,
  input: EvidenceInput,
  revision: number,
  options: vscode.LanguageModelToolTokenizationOptions | undefined,
  token: vscode.CancellationToken,
): Promise<string> {
  const result = await fitWholeRecords(
    reports.length ? 1 : 0,
    reports.length,
    (count) => {
      const nextItem = input.startItem + count;
      return JSON.stringify({
        revision,
        note: NOTE,
        totalItems,
        startItem: input.startItem,
        items: reports.slice(0, count),
        ...(nextItem <= totalItems && { nextItem }),
      });
    },
    (text) => fitsToolResult(text, options, token),
  );
  if (result !== undefined) return result;
  const message =
    "Evidence result exceeds the budget. Read fewer locations or use a larger budget.";
  return (await fitsToolResult(message, options, token)) ? message : "";
}
