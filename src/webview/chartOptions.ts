import type { ChartOptionsState } from "../chartOptions";
import { AGGREGATIONS, CHART_TYPES, type ChartFilter } from "../chartSpec";
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
  private readonly bins = document.createElement("input");
  private readonly facet = document.createElement("select");
  private readonly facetColumns = document.createElement("select");
  private readonly facetScales = document.createElement("select");
  private readonly filters = document.createElement("div");
  private filterRows: Array<{ row: HTMLElement; read: () => ChartFilter }> = [];
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
    this.bins.type = "number";
    this.bins.min = "1";
    this.bins.max = "200";
    this.bins.step = "1";
    this.bins.placeholder = "Automatic";
    this.facetColumns.add(new Option("Automatic", ""));
    for (let count = 1; count <= 4; count++) {
      this.facetColumns.add(new Option(String(count), String(count)));
    }
    this.facetScales.add(new Option("Shared (default)", ""));
    this.facetScales.add(new Option("Shared", "shared"));
    this.facetScales.add(new Option("Independent", "independent"));
    this.fields.className = "chart-options-fields";
    for (const [name, control] of [
      ["Chart type", this.type],
      ["Label columns (in order)", this.labels],
      ["Value columns (in order)", this.values],
      ["Aggregation", this.aggregate],
      ["Sort by first value", this.sort],
      ["Row limit", this.limit],
      ["Bins", this.bins],
      ["Facet column", this.facet],
      ["Panels per row", this.facetColumns],
      ["Axis scales", this.facetScales],
      ["Filters (all must match)", this.filters],
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
    this.filters.parentElement?.classList.add("chart-filter-field");
    this.type.addEventListener("change", () => {
      if (this.type.value === "histogram") {
        this.fillColumns(this.labels, []);
        this.aggregate.value = "";
        this.sort.value = "";
        this.limit.value = "";
      } else {
        this.bins.value = "";
      }
      if (!this.canFacet()) {
        this.facet.value = "";
        this.facetColumns.value = "";
        this.facetScales.value = "";
      }
      this.updateAvailability();
    });
    this.facet.addEventListener("change", () => {
      if (!this.facet.value) {
        this.facetColumns.value = "";
        this.facetScales.value = "";
      }
      this.updateAvailability();
    });
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
          bins: this.bins.value === "" ? undefined : Number(this.bins.value),
          facetColumn: this.facet.value || undefined,
          facetColumns:
            this.facetColumns.value === "" ? undefined : Number(this.facetColumns.value),
          facetScales: this.facetScales.value || undefined,
          filters: this.filterRows.length ? this.filterRows.map(({ read }) => read()) : undefined,
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
    this.bins.value = controls.bins?.toString() ?? "";
    this.fillColumnSelect(this.facet, controls.facetColumn, "None");
    this.facetColumns.value = controls.facetColumns?.toString() ?? "";
    this.facetScales.value = controls.facetScales ?? "";
    this.fillFilters(controls.filters ?? []);
    this.updateAvailability();
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

  private canFacet(): boolean {
    return [
      "bar",
      "horizontalBar",
      "stackedBar",
      "line",
      "area",
      "stackedArea",
      "scatter",
      "histogram",
    ].includes(this.type.value);
  }

  private updateAvailability(): void {
    const histogram = this.type.value === "histogram";
    for (const control of [this.labels, this.aggregate, this.sort, this.limit]) {
      if (control.parentElement) control.parentElement.hidden = histogram;
    }
    if (this.bins.parentElement) this.bins.parentElement.hidden = !histogram;
    this.facet.disabled = !this.canFacet();
    this.facetColumns.disabled = this.facetScales.disabled = !this.canFacet() || !this.facet.value;
  }

  /** Preserve stored spelling and missing columns so opening the form never rewrites predicates. */
  private fillColumnSelect(select: HTMLSelectElement, selected?: string, empty?: string): void {
    select.replaceChildren();
    if (empty !== undefined) select.add(new Option(empty, ""));
    for (const column of this.state?.columns ?? []) {
      select.add(new Option(`${column.name}${column.numeric ? " (numeric)" : ""}`, column.name));
    }
    if (selected !== undefined) {
      if (!Array.from(select.options).some((option) => option.value === selected)) {
        select.add(new Option(selected, selected));
      }
      select.value = selected;
    }
  }

  private fillFilters(filters: ChartFilter[]): void {
    this.filters.replaceChildren();
    this.filterRows = [];
    const add = document.createElement("button");
    add.type = "button";
    add.className = "secondary";
    add.textContent = "Add filter";
    const append = (filter?: ChartFilter): void => {
      const row = document.createElement("div");
      row.className = "chart-filter-row";
      const column = document.createElement("select");
      column.setAttribute("aria-label", "Filter column");
      this.fillColumnSelect(column, filter?.column);
      const operator = document.createElement("select");
      operator.setAttribute("aria-label", "Filter operator");
      for (const [value, label] of [
        ["eq", "Equals"],
        ["neq", "Does not equal"],
        ["lt", "Less than"],
        ["lte", "At most"],
        ["gt", "Greater than"],
        ["gte", "At least"],
        ["contains", "Contains"],
      ]) {
        operator.add(new Option(label, value));
      }
      operator.value = filter?.op ?? "eq";
      const valueType = document.createElement("select");
      valueType.setAttribute("aria-label", "Filter value type");
      valueType.add(new Option("Text", "string"));
      valueType.add(new Option("Number", "number"));
      valueType.add(new Option("Missing value", "null"));
      const columnValueType = (): string =>
        this.state?.columns.find((entry) => entry.name === column.value)?.numeric
          ? "number"
          : "string";
      valueType.value = filter
        ? filter.value === null
          ? "null"
          : typeof filter.value
        : columnValueType();
      const value = document.createElement("input");
      value.setAttribute("aria-label", "Filter value");
      value.value = filter?.value === null ? "" : String(filter?.value ?? "");
      const updateValue = (): void => {
        value.type = valueType.value === "number" ? "number" : "text";
        value.step = "any";
        value.required = valueType.value === "number";
        value.disabled = valueType.value === "null";
        value.hidden = value.disabled;
      };
      const updateOperator = (): void => {
        const numeric = ["lt", "lte", "gt", "gte"].includes(operator.value);
        if (numeric) valueType.value = "number";
        if (operator.value === "contains") valueType.value = "string";
        valueType.disabled = numeric || operator.value === "contains";
        updateValue();
      };
      operator.addEventListener("change", updateOperator);
      valueType.addEventListener("change", updateValue);
      column.addEventListener("change", () => {
        if (operator.value === "eq" || operator.value === "neq") {
          valueType.value = columnValueType();
          updateValue();
        }
      });
      updateOperator();
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "secondary";
      remove.textContent = "−";
      remove.setAttribute("aria-label", "Remove filter");
      remove.addEventListener("click", () => {
        row.remove();
        this.filterRows = this.filterRows.filter((entry) => entry.row !== row);
        add.disabled = false;
        add.focus();
      });
      row.append(column, operator, valueType, value, remove);
      this.filters.insertBefore(row, add);
      this.filterRows.push({
        row,
        read: () => ({
          column: column.value,
          op: operator.value as ChartFilter["op"],
          value:
            valueType.value === "null"
              ? null
              : valueType.value === "number"
                ? Number(value.value)
                : value.value,
        }),
      });
      add.disabled = this.filterRows.length >= 50;
    };
    add.addEventListener("click", () => append());
    this.filters.append(add);
    for (const filter of filters) append(filter);
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
