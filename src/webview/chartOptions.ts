import type { ChartOptionsState } from "../chartOptions";
import { AGGREGATIONS, CHART_TYPES } from "../chartSpec";
import type { FromWebview } from "../protocol";

/** A compact form inside the diagram view, opened by the native editor action. */
export class ChartOptionsForm {
  private state: ChartOptionsState | undefined;
  private readonly form = document.createElement("form");
  private readonly fields = document.createElement("fieldset");
  private readonly type = document.createElement("select");
  private readonly labels = document.createElement("div");
  private readonly values = document.createElement("div");
  private readonly aggregate = document.createElement("select");
  private readonly sort = document.createElement("select");
  private readonly limit = document.createElement("input");
  private readonly status = document.createElement("p");
  private readonly error = document.createElement("p");
  private readonly replace = document.createElement("input");
  private readonly replaceLabel = document.createElement("label");
  private readonly apply = document.createElement("button");
  private readonly reset = document.createElement("button");

  constructor(
    private readonly container: HTMLElement,
    private readonly post: (message: FromWebview) => void,
    private readonly closeFocus: () => void,
  ) {
    const heading = document.createElement("strong");
    heading.textContent = "Chart Options";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "secondary";
    close.textContent = "Close";
    close.addEventListener("click", () => this.close());
    const header = document.createElement("div");
    header.className = "chart-options-heading";
    header.append(heading, close);
    this.status.className = "note";
    this.error.setAttribute("role", "alert");
    this.error.className = "chart-options-error";
    this.error.hidden = true;
    for (const type of CHART_TYPES) {
      this.type.add(new Option(type.replace(/([a-z])([A-Z])/g, "$1 $2"), type));
    }
    this.aggregate.add(new Option("None", ""));
    for (const aggregate of AGGREGATIONS) {
      this.aggregate.add(new Option(aggregate, aggregate));
    }
    this.sort.add(new Option("Data order", ""));
    this.sort.add(new Option("Ascending", "ascending"));
    this.sort.add(new Option("Descending", "descending"));
    this.limit.type = "number";
    this.limit.min = "1";
    this.limit.step = "1";
    this.limit.placeholder = "All rows";
    this.fields.className = "chart-options-fields";
    for (const [name, control] of [
      ["Chart type", this.type],
      ["Label columns (in order)", this.labels],
      ["Value columns (in order)", this.values],
      ["Aggregation", this.aggregate],
      ["Sort by first value", this.sort],
      ["Row limit", this.limit],
    ] as const) {
      const field = document.createElement("div");
      const label = document.createElement("label");
      label.textContent = name;
      control.id = `chart-option-${name.split(" ")[0]?.toLowerCase()}`;
      if (control instanceof HTMLSelectElement || control instanceof HTMLInputElement) {
        label.htmlFor = control.id;
      } else {
        control.setAttribute("role", "group");
        control.setAttribute("aria-label", name);
      }
      field.append(label, control);
      this.fields.append(field);
    }
    this.replace.type = "checkbox";
    this.replaceLabel.append(this.replace, " Replace manual source edits with the generated chart");
    this.replaceLabel.hidden = true;
    this.apply.type = "button";
    this.apply.textContent = "Apply";
    const reset = this.reset;
    reset.type = "button";
    reset.className = "secondary";
    reset.textContent = "Reset styling";
    reset.title = "Remove manual styling changes and return to the generated chart";
    reset.addEventListener("click", () => {
      if (this.state) {
        this.post({
          type: "resetChartStyling",
          revision: this.state.revision,
          replaceSource: this.replace.checked,
        });
      }
    });
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(this.apply, reset);
    this.form.append(this.fields, this.replaceLabel, this.error, actions);
    const apply = (event: Event): void => {
      event.preventDefault();
      if (!this.state || !this.form.reportValidity()) return;
      const labels = this.selected(this.labels);
      const values = this.selected(this.values);
      this.error.hidden = true;
      this.apply.disabled = true;
      this.post({
        type: "applyChartOptions",
        revision: this.state.revision,
        controls: {
          type: this.type.value,
          labelColumn: labels.length ? labels : undefined,
          valueColumns: values.length ? values : undefined,
          aggregate: this.aggregate.value || undefined,
          sort: this.sort.value || undefined,
          limit: this.limit.value === "" ? undefined : Number(this.limit.value),
        },
        replaceSource: this.replace.checked,
      });
    };
    this.apply.addEventListener("click", apply);
    this.form.addEventListener("submit", apply);
    container.append(header, this.status, this.form);
    container.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        this.close();
      }
    });
  }

  update(state: ChartOptionsState | undefined, visible: boolean): void {
    const opening = this.container.hidden && visible;
    const hadFocus = this.container.contains(document.activeElement);
    this.state = state;
    this.container.hidden = !visible || state === undefined;
    if (this.container.hidden) {
      if (hadFocus) this.closeFocus();
      return;
    }
    if (!state) return;
    const { controls } = state;
    this.type.value = controls.type;
    this.fillColumns(
      this.labels,
      controls.labelColumn === undefined
        ? []
        : typeof controls.labelColumn === "string"
          ? [controls.labelColumn]
          : controls.labelColumn,
    );
    this.fillColumns(this.values, controls.valueColumns ?? []);
    this.aggregate.value = controls.aggregate ?? "";
    this.sort.value = controls.sort ?? "";
    this.limit.value = controls.limit?.toString() ?? "";
    this.fields.disabled = state.unavailable !== undefined;
    this.apply.disabled = state.unavailable !== undefined;
    this.reset.textContent = state.unavailable ? "Reset styling and reload data" : "Reset styling";
    this.status.textContent =
      state.unavailable ??
      `${state.rowCount.toLocaleString()} rows · ${state.columns.length} columns. Leave columns automatic to infer them for the chart type. Changes use the loaded data; Refresh reloads the source.`;
    this.replace.checked = false;
    this.replaceLabel.hidden = !state.edited;
    this.error.hidden = true;
    if (opening) this.type.focus();
  }

  showError(message: string): void {
    this.error.textContent = message;
    this.error.hidden = false;
    this.apply.disabled = false;
  }

  private close(): void {
    this.container.hidden = true;
    this.post({ type: "closeChartOptions" });
    this.closeFocus();
  }

  private selected(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll("select"), (select) => select.value);
  }

  private fillColumns(container: HTMLElement, selected: string[]): void {
    container.replaceChildren();
    const add = document.createElement("button");
    add.type = "button";
    add.className = "secondary";
    add.textContent = selected.length ? "Add column" : "Automatic · choose column";
    const append = (name?: string): void => {
      const row = document.createElement("div");
      row.className = "chart-column-row";
      const select = document.createElement("select");
      select.setAttribute(
        "aria-label",
        `${container === this.labels ? "Label" : "Value"} column ${container.querySelectorAll("select").length + 1}`,
      );
      for (const column of this.state?.columns ?? []) {
        select.add(new Option(`${column.name}${column.numeric ? " (numeric)" : ""}`, column.name));
      }
      if (name !== undefined) {
        // Column lookup on the host accepts case differences; preserve the original spelling.
        const match = Array.from(select.options).find(
          (option) => option.value.trim().toLowerCase() === name.trim().toLowerCase(),
        );
        select.value = match?.value ?? name;
      }
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "secondary";
      remove.textContent = "−";
      remove.setAttribute("aria-label", "Remove column");
      remove.addEventListener("click", () => {
        row.remove();
        add.textContent = container.querySelector("select")
          ? "Add column"
          : "Automatic · choose column";
        add.focus();
      });
      row.append(select, remove);
      container.insertBefore(row, add);
      add.textContent = "Add column";
    };
    add.addEventListener("click", () => append());
    container.append(add);
    for (const name of selected) append(name);
  }
}
