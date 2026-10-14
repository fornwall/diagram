import { type ChartOptionsState, unusableSettings } from "../chartOptions";
import { AGGREGATIONS, CHART_TYPES, type ChartFilter, type ChartType } from "../chartSpec";
import type { Column } from "../data";
import type { FromWebview } from "../protocol";
import { inWords, plural } from "../text";

function button(text: string, className = "secondary"): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = text;
  return element;
}

/** A list box of the choices: [text, value], or a value that is its own text. */
function select(choices: readonly (string | readonly [string, string])[]): HTMLSelectElement {
  const element = document.createElement("select");
  for (const choice of choices) {
    const [text, value] = typeof choice === "string" ? [choice, choice] : choice;
    element.add(new Option(text, value));
  }
  return element;
}

/** A name in camel case, such as "horizontalBar", in words as the other choices read: "Horizontal bar". */
function words(name: string): string {
  const spaced = inWords(name);
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Whether the selects list the same columns for both, as they show only names and numeric. */
const sameColumns = (a: readonly Column[], b: readonly Column[]): boolean =>
  a.length === b.length &&
  a.every((column, index) => column.name === b[index]?.name && column.numeric === b[index].numeric);

/** Whether the element can take the focus: shown, and enabled if a control. */
const focusable = (element: Element | null | undefined): element is HTMLElement =>
  element instanceof HTMLElement && element.checkVisibility() && !element.matches(":disabled");

/** The indices of the children that lead from the container down to the element. */
function pathTo(container: Element, element: Element): number[] {
  const path: number[] = [];
  for (let at = element; at !== container && at.parentElement; at = at.parentElement) {
    path.unshift(Array.prototype.indexOf.call(at.parentElement.children, at));
  }
  return path;
}

/** Removes a row of a list, moving focus to the row after it, the one before it or `fallback`. */
function removeRow(row: Element, fallback: HTMLElement): void {
  const next = row.nextElementSibling?.querySelector("select");
  const previous = row.previousElementSibling?.querySelector("select");
  row.remove();
  (next ?? previous ?? fallback).focus();
}

/** A compact form inside the diagram view, opened by the native editor action. */
export class ChartOptionsForm {
  private state: ChartOptionsState | undefined;
  private readonly fields = document.createElement("fieldset");
  private readonly type = select(CHART_TYPES.map((type) => [words(type), type] as const));
  private readonly labels = document.createElement("div");
  private readonly values = document.createElement("div");
  private readonly aggregate = select([
    ["None", ""],
    ...AGGREGATIONS.map((aggregation) => [words(aggregation), aggregation] as const),
  ]);
  private readonly sort = select([
    ["Data order", ""],
    ["Ascending", "ascending"],
    ["Descending", "descending"],
  ]);
  private readonly limit = document.createElement("input");
  private readonly bins = document.createElement("input");
  private readonly facet = document.createElement("select");
  private readonly facetColumns = select([["Automatic", ""], "1", "2", "3", "4"]);
  private readonly facetScales = select([
    ["Shared", ""],
    ["Independent", "independent"],
  ]);
  private readonly filters = document.createElement("div");
  /** The filter rows, in order, with what sets and reads each. */
  private readonly filterRows = new Map<
    HTMLElement,
    { set: (filter: ChartFilter) => void; read: () => ChartFilter }
  >();
  /** The columns of the data, kept while others the same come, to tell which selects list them. */
  private columns: readonly Column[] = [];
  private columnNames = new Set<string>();
  /** The columns that each select lists. */
  private readonly filled = new WeakMap<HTMLSelectElement, readonly Column[]>();
  private readonly fillLabels = this.columnList(this.labels);
  private readonly fillValues = this.columnList(this.values);
  private readonly fillFilters = this.filterList(this.filters);
  private readonly status = document.createElement("p");
  private readonly error = document.createElement("p");
  private readonly replace = document.createElement("input");
  private readonly replaceLabel = document.createElement("label");
  private readonly apply = button("Apply", "");
  private readonly reset = button("Reset styling");
  /** The fields of the settings that some chart types cannot use. */
  private readonly settings = {
    labelColumn: this.labels,
    aggregate: this.aggregate,
    sort: this.sort,
    limit: this.limit,
    bins: this.bins,
    facetColumn: this.facet,
    facetColumns: this.facetColumns,
    facetScales: this.facetScales,
  };

  constructor(
    private readonly container: HTMLElement,
    private readonly post: (message: FromWebview) => void,
    private readonly closeFocus: () => void,
  ) {
    const heading = document.createElement("strong");
    heading.textContent = "Chart Options";
    const close = button("Close");
    close.addEventListener("click", () => this.close());
    const header = document.createElement("div");
    header.className = "chart-options-heading";
    header.append(heading, close);
    this.error.setAttribute("role", "alert");
    this.error.className = "chart-options-error";
    this.error.hidden = true;
    Object.assign(this.limit, { type: "number", min: "1", step: "1", placeholder: "All rows" });
    Object.assign(this.bins, {
      type: "number",
      min: "1",
      max: "200",
      step: "1",
      placeholder: "Automatic",
    });
    this.facetColumns.title =
      "More when the panels would take over 4 rows, or be too short to read";
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
      for (const key of unusableSettings(this.type.value as ChartType)) {
        if (key === "labelColumn") this.fillLabels([]);
        else this.settings[key].value = "";
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
    this.reset.title = "Remove manual styling changes and return to the generated chart";
    this.reset.addEventListener("click", () => {
      if (this.state && !this.applying) {
        this.error.hidden = true;
        this.setApplying(true);
        this.post({
          type: "applyChartOptions",
          revision: this.state.revision,
          replaceSource: this.replace.checked,
        });
      }
    });
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(this.apply, this.reset);
    const form = document.createElement("form");
    form.append(this.fields, this.replaceLabel, this.error, actions);
    // Apply is the form's submit button, for Enter in a field to apply the options too. They go
    // to the extension rather than anywhere the form would send them.
    this.apply.type = "submit";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      // The browser has checked the fields before it submits.
      if (!this.state || this.applying) return;
      const labels = this.selected(this.labels);
      const values = this.selected(this.values);
      this.error.hidden = true;
      this.setApplying(true);
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
          filters: this.filterRows.size
            ? Array.from(this.filterRows.values(), ({ read }) => read())
            : undefined,
        },
        replaceSource: this.replace.checked,
      });
    });
    // Enter submits from text fields alone, but the other fields are fields as well.
    form.addEventListener("keydown", (event) => {
      const field =
        event.target instanceof Element && event.target.matches("select, [type=checkbox]");
      if (!event.isComposing && field && event.key === "Enter" && !this.apply.disabled) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    container.append(header, this.status, form);
    container.addEventListener("keydown", (event) => {
      if (!event.isComposing && event.key === "Escape") {
        event.stopPropagation();
        this.close();
      }
    });
  }

  update(state: ChartOptionsState | undefined): void {
    const opening = this.container.hidden && state !== undefined;
    const focused = document.activeElement;
    const hadFocus = focused !== null && this.container.contains(focused);
    // Where the focus is in the form, which rows made anew below for other columns no longer say.
    const focusPath = hadFocus ? pathTo(this.container, focused) : [];
    this.state = state;
    this.container.hidden = state === undefined;
    if (!state) {
      if (hadFocus) this.closeFocus();
      return;
    }
    const { controls } = state;
    this.type.value = controls.type;
    if (!sameColumns(this.columns, state.columns)) {
      this.columns = state.columns;
      this.columnNames = new Set(state.columns.map((column) => column.name));
    }
    this.fillLabels(
      controls.labelColumn === undefined
        ? []
        : typeof controls.labelColumn === "string"
          ? [controls.labelColumn]
          : controls.labelColumn,
    );
    this.fillValues(controls.valueColumns ?? []);
    this.aggregate.value = controls.aggregate ?? "";
    this.sort.value = controls.sort ?? "";
    this.limit.value = controls.limit?.toString() ?? "";
    this.bins.value = controls.bins?.toString() ?? "";
    this.fillColumnSelect(this.facet, controls.facetColumn, "None");
    this.facetColumns.value = controls.facetColumns?.toString() ?? "";
    // Shared is the default, which a stored "shared" only spells out.
    this.facetScales.value = controls.facetScales === "independent" ? "independent" : "";
    this.fillFilters(controls.filters ?? []);
    this.updateAvailability();
    this.fields.disabled = state.unavailable !== undefined;
    this.apply.disabled = state.unavailable !== undefined;
    this.setApplying(false);
    this.reset.textContent = state.unavailable ? "Reset styling and reload data" : "Reset styling";
    this.status.textContent =
      state.unavailable ??
      `${plural(state.rowCount, "row")} · ${plural(state.columns.length, "column")}. Columns are inferred unless selected.${state.refreshable ? " Refresh reloads the data." : ""}`;
    this.replace.checked = false;
    this.replaceLabel.hidden = !state.edited;
    this.error.hidden = true;
    if (opening) this.type.focus();
    else if (hadFocus && !this.keeps(document.activeElement) && document.hasFocus()) {
      // The rows of columns and filters are made anew for other columns, or fewer remain, as when
      // the chart that the options applied comes back, and the fields are disabled while its data
      // is not loaded, which takes the focus from them only later. Keep the focus on the same place
      // in the form, or else on the first control that takes it; not from elsewhere in VS Code,
      // where the user went meanwhile.
      let same: Element | undefined = this.container;
      for (const index of focusPath) same = same?.children[index];
      const fallback = [this.type, ...this.container.querySelectorAll("button")].find(focusable);
      (focusable(same) ? same : fallback)?.focus();
    }
  }

  showError(message: string): void {
    this.error.textContent = message;
    this.error.hidden = false;
    // Below the fields, which the form scrolls, as when Enter in the first applied the options.
    this.error.scrollIntoView({ block: "nearest" });
    this.setApplying(false);
  }

  /** Whether the form keeps the focus that the element has: shown, and enabled if a control. */
  private keeps(element: Element | null): boolean {
    return this.container.contains(element) && focusable(element);
  }

  private get applying(): boolean {
    return this.apply.getAttribute("aria-disabled") === "true";
  }

  /**
   * Shows Apply and Reset as disabled until what one sent is applied or fails to. Not disabled
   * indeed, which would move the focus from the button, when pressed, to the page's body.
   */
  private setApplying(applying: boolean): void {
    for (const button of [this.apply, this.reset]) {
      if (applying) button.setAttribute("aria-disabled", "true");
      else button.removeAttribute("aria-disabled");
    }
  }

  private close(): void {
    this.container.hidden = true;
    this.post({ type: "closeChartOptions" });
    this.closeFocus();
  }

  private selected(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll("select"), (select) => select.value);
  }

  /**
   * Hides the fields that the chart type cannot use, such as the aggregation and row limit of a box
   * plot, which summarizes every row itself, and disables the facets of a type without panels.
   */
  private updateAvailability(): void {
    const unusable = new Set<string>(unusableSettings(this.type.value as ChartType));
    for (const [key, control] of Object.entries(this.settings)) {
      if (!key.startsWith("facet") && control.parentElement) {
        control.parentElement.hidden = unusable.has(key);
      }
    }
    this.facet.disabled = unusable.has("facetColumn");
    this.facetColumns.disabled = this.facetScales.disabled =
      this.facet.disabled || !this.facet.value;
  }

  /**
   * Preserve stored spelling and missing columns so opening the form never rewrites predicates. A
   * select keeps its options while the columns stay the same, as making thousands anew is slow.
   */
  private fillColumnSelect(select: HTMLSelectElement, selected?: string, empty?: string): void {
    const { columns } = this;
    const listed = columns.length + (empty === undefined ? 0 : 1);
    if (this.filled.get(select) === columns) {
      // All but a missing column that was selected before.
      while (select.length > listed) select.remove(listed);
    } else {
      select.replaceChildren();
      if (empty !== undefined) select.add(new Option(empty, ""));
      for (const column of columns) {
        select.add(new Option(`${column.name}${column.numeric ? " (numeric)" : ""}`, column.name));
      }
      this.filled.set(select, columns);
    }
    if (selected === undefined) {
      select.selectedIndex = 0;
    } else {
      if (!this.columnNames.has(selected) && (empty === undefined || selected !== "")) {
        select.add(new Option(selected, selected));
      }
      select.value = selected;
    }
  }

  /** Makes the container a list of filter rows, returning what fills it, keeping the rows there. */
  private filterList(container: HTMLElement): (filters: ChartFilter[]) => void {
    const add = button("Add filter");
    const append = (filter?: ChartFilter): HTMLSelectElement => {
      const row = document.createElement("div");
      row.className = "chart-filter-row";
      const column = document.createElement("select");
      column.setAttribute("aria-label", "Filter column");
      const operator = select([
        ["Equals", "eq"],
        ["Does not equal", "neq"],
        ["Less than", "lt"],
        ["At most", "lte"],
        ["Greater than", "gt"],
        ["At least", "gte"],
        ["Contains", "contains"],
      ]);
      operator.setAttribute("aria-label", "Filter operator");
      const valueType = select([
        ["Text", "string"],
        ["Number", "number"],
        ["Missing value", "null"],
      ]);
      valueType.setAttribute("aria-label", "Filter value type");
      const columnValueType = (): string =>
        this.columns.find((entry) => entry.name === column.value)?.numeric ? "number" : "string";
      const value = document.createElement("input");
      value.setAttribute("aria-label", "Filter value");
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
      const set = (filter?: ChartFilter): void => {
        this.fillColumnSelect(column, filter?.column);
        operator.value = filter?.op ?? "eq";
        valueType.value = filter
          ? filter.value === null
            ? "null"
            : typeof filter.value
          : columnValueType();
        updateOperator();
        // Once the input has the type of the value, as a number input would drop text.
        value.value = filter?.value === null ? "" : String(filter?.value ?? "");
      };
      set(filter);
      const remove = button("−");
      remove.setAttribute("aria-label", "Remove filter");
      remove.addEventListener("click", () => {
        this.filterRows.delete(row);
        add.disabled = false;
        removeRow(row, add);
      });
      row.append(column, operator, valueType, value, remove);
      container.insertBefore(row, add);
      this.filterRows.set(row, {
        set,
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
      add.disabled = this.filterRows.size >= 50;
      return column;
    };
    add.addEventListener("click", () => append().focus());
    container.append(add);
    return (filters) => {
      const rows = Array.from(this.filterRows);
      for (const [row] of rows.slice(filters.length)) {
        row.remove();
        this.filterRows.delete(row);
      }
      filters.forEach((filter, index) => {
        const row = rows[index];
        if (row) row[1].set(filter);
        else append(filter);
      });
      add.disabled = this.filterRows.size >= 50;
    };
  }

  /**
   * Makes the container a list of column rows, returning what fills it with the columns selected,
   * keeping the rows there.
   */
  private columnList(container: HTMLElement): (selected: string[]) => void {
    const add = button("");
    const rows = () => container.querySelectorAll(".chart-column-row");
    const update = (): void => {
      for (const [index, row] of rows().entries()) {
        const name = `${container === this.labels ? "Label" : "Value"} column ${index + 1}`;
        row.querySelector("select")?.setAttribute("aria-label", name);
        row.querySelector("button")?.setAttribute("aria-label", `Remove ${name.toLowerCase()}`);
      }
      add.textContent = rows().length > 0 ? "Add column" : "Automatic · choose column";
    };
    const append = (name?: string): HTMLSelectElement => {
      const row = document.createElement("div");
      row.className = "chart-column-row";
      const select = document.createElement("select");
      this.fillColumnSelect(select, name);
      const remove = button("−");
      remove.addEventListener("click", () => {
        removeRow(row, add);
        update();
      });
      row.append(select, remove);
      container.insertBefore(row, add);
      return select;
    };
    add.addEventListener("click", () => {
      const select = append();
      update();
      select.focus();
    });
    container.append(add);
    return (selected) => {
      const shown = Array.from(rows());
      for (const row of shown.slice(selected.length)) row.remove();
      selected.forEach((name, index) => {
        const select = shown[index]?.querySelector("select");
        if (select) this.fillColumnSelect(select, name);
        else append(name);
      });
      update();
    };
  }
}
