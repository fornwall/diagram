import * as assert from "node:assert";
import * as vscode from "vscode";
import { validateAnnotation } from "../annotations";
import { afterTest, recordMessages, replace } from "./afterTest";
import { within } from "./newPanel";
import { suitePage, UNTIL } from "./webviewHarness";

/**
 * A chart that counts its draws in `window.chartDraws`: how often each task that drew it did so,
 * which tells one drawing apart from the next.
 */
const COUNTED_CHART = `(() => {
  window.chartDraws = [];
  let drawing = false;
  return {animation: false, series: [{type: "custom", coordinateSystem: null, data: [1],
    renderItem: (params, api) => {
      if (!drawing) {
        drawing = true;
        window.chartDraws.push(0);
        queueMicrotask(() => { drawing = false; });
      }
      window.chartDraws[window.chartDraws.length - 1]++;
      return {type: "circle", shape: {cx: 20, cy: 20, r: 10}, style: api.style()};
    }}]};
})()`;

/**
 * Webview code defining `chartFitted()`, which waits for the chart to take the size of its
 * container, and what `UNTIL` defines.
 */
const CHART_FITTED = `
  ${UNTIL}
  const chartFitted = () => {
    const chart = document.getElementById("chart");
    return until(() => {
      const svg = chart.querySelector("svg");
      return svg?.getAttribute("width") === String(chart.clientWidth) &&
        svg.getAttribute("height") === String(chart.clientHeight);
    }, "the chart to take the size of its container", nextFrame);
  };`;

/** Webview code defining `clickChart(element, init)`, which clicks the middle of a chart's element. */
const CLICK_CHART = `
  const clickChart = (element, init) => {
    const box = element.getBoundingClientRect();
    const mouse = {bubbles: true, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, ...init};
    // ZRender takes a click only after a press and a release on the same item.
    for (const type of ["mousedown", "mouseup", "click"]) element.dispatchEvent(new MouseEvent(type, mouse));
  };`;

suite("ECharts in the webview", function () {
  // The first render loads the webview and the libraries, which can take a while.
  this.timeout(20_000);

  const page = suitePage();
  const { evaluate, render, draw } = page;
  /** Draws the chart of the option, without animation. */
  const renderChart = (option: Record<string, unknown>) =>
    draw({ language: "echarts", source: JSON.stringify({ animation: false, ...option }) });
  /** Draws a pie chart of slices of the names, blue, and red once selected. */
  const renderPie = (...names: string[]) =>
    renderChart({
      series: [
        {
          type: "pie",
          data: names.map((name) => ({ name, value: 1 })),
          itemStyle: { color: "#0000ff" },
          select: { itemStyle: { color: "#ff0000" } },
          emphasis: { disabled: true },
        },
      ],
    });
  /** Which half of the chart its one item drawn in red is in, once ECharts draws it so. */
  const redHalf = () =>
    evaluate(`(async () => {
      ${UNTIL}
      const red = () => document.querySelectorAll('#chart svg path[fill="#ff0000"]');
      await until(() => red().length === 1, "one item drawn in red");
      return red()[0].getBBox().x < document.querySelector("#chart svg").clientWidth / 2 ? "left" : "right";
    })()`);

  test("keeps the chart dimmed around its marks while the pointer hovers items and leaves", async () => {
    const colors = ["#0000ff", "#00ff00", "#ff0000"];
    const data = ["A", "B", "C"].map((name, index) => ({
      name,
      value: 10,
      itemStyle: { color: colors[index] },
    }));
    // A bar chart's axis pointer highlights and downplays items as the pointer moves; a pie's
    // items take the emphasis themselves.
    const charts = [
      {
        xAxis: { type: "category", data: ["A", "B", "C"] },
        yAxis: {},
        series: [{ type: "bar", data }],
      },
      { series: [{ type: "pie", data }] },
    ];
    for (const chart of charts) {
      await renderChart(chart);
      page.panel.annotate({ marks: [{ id: "A", kind: "info" }], dim: true });
      const dimmed = await evaluate(`(async () => {
        ${UNTIL}
        const item = (color) => document.querySelector('#chart svg path[fill="' + color + '"]');
        // How opaque each item is drawn: those that are not marked fade.
        const faded = () => {
          const [marked, ...rest] = ${JSON.stringify(colors)}.map((color) => {
            const path = item(color);
            return Number(path?.getAttribute("fill-opacity") ?? path?.getAttribute("opacity") ?? 1);
          });
          return marked === 1 && rest.every((opacity) => opacity < 1);
        };
        const move = (element, x, y) => element.dispatchEvent(new MouseEvent("mousemove",
          {bubbles: true, clientX: x, clientY: y}));
        // ECharts handles the pointer at once, and draws what changed in the next frame.
        const settle = () => nextFrame(2);
        const marked = await until(faded, "the chart dimmed around its marks");
        // Over the unmarked item C, then off it, into the empty corner of the chart.
        const box = item("#ff0000").getBoundingClientRect();
        move(item("#ff0000"), box.x + box.width / 2, box.y + box.height / 2);
        await settle();
        const svg = document.querySelector("#chart svg");
        const corner = svg.getBoundingClientRect();
        move(svg, corner.x + 2, corner.y + 2);
        await settle();
        return {marked, left: faded()};
      })()`);
      assert.deepStrictEqual(dimmed, { marked: true, left: true }, chart.series[0]?.type ?? "");
    }
  });

  test("keeps the marks of an undimmed chart highlighted once the axis pointer leaves them", async () => {
    await renderChart({
      xAxis: { type: "category", data: ["A", "B"] },
      yAxis: {},
      series: [
        {
          type: "bar",
          data: [1, 1],
          itemStyle: { color: "#0000ff" },
          emphasis: { itemStyle: { color: "#ff0000" } },
        },
      ],
    });
    page.panel.annotate({ marks: [{ id: "A", kind: "info" }], dim: false });
    const marked = await evaluate(`(async () => {
      ${UNTIL}
      const red = () => document.querySelectorAll('#chart svg path[fill="#ff0000"]').length;
      await until(() => red() === 1, "the mark highlighted");
      const move = (element, x, y) => element.dispatchEvent(new MouseEvent("mousemove",
        {bubbles: true, clientX: x, clientY: y}));
      // Over the marked item, which the axis pointer highlights and downplays, then off it.
      const bar = document.querySelector('#chart svg path[fill="#ff0000"]');
      const box = bar.getBoundingClientRect();
      move(bar, box.x + box.width / 2, box.y + box.height / 2);
      await nextFrame(2);
      const svg = document.querySelector("#chart svg");
      const corner = svg.getBoundingClientRect();
      move(svg, corner.x + 2, corner.y + 2);
      await nextFrame(2);
      return red();
    })()`);
    assert.strictEqual(marked, 1);
  });

  test("dims the chart around marks in several series, not around the last series' alone", async () => {
    const colors = ["#0000ff", "#00ff00", "#ff0000"];
    await renderChart({
      xAxis: { type: "category", data: ["A", "B"] },
      yAxis: {},
      series: colors.map((color, index) => ({
        name: `S${index}`,
        type: "bar",
        itemStyle: { color },
        data: [10, 10],
      })),
    });
    page.panel.annotate({
      marks: [
        { id: "S0/A", kind: "info" },
        { id: "S1/B", kind: "info" },
      ],
      dim: true,
    });
    const faded = await evaluate(`(async () => {
      ${UNTIL}
      // How many bars of each series fade: a marked bar is drawn in a color of its emphasis.
      const faded = () => ${JSON.stringify(colors)}.map((color) =>
        [...document.querySelectorAll('#chart svg path[fill="' + color + '"]')].filter((path) =>
          Number(path.getAttribute("fill-opacity") ?? path.getAttribute("opacity") ?? 1) < 1).length);
      await until(() => faded()[2] === 2, "the chart dimmed");
      return faded();
    })()`);
    assert.deepStrictEqual(faded, [1, 1, 2]);
  });

  test("draws every item in full again once the marks no longer dim the chart", async () => {
    const colors = ["#0000ff", "#00ff00", "#ff0000"];
    const marks = [{ id: "C", kind: "info" as const }];
    // Without the marks, or with them but no longer dimming the chart around them.
    for (const undimmed of [
      { marks: [], dim: false },
      { marks, dim: false },
    ]) {
      await renderChart({
        xAxis: { type: "category", data: ["A", "B", "C"] },
        yAxis: {},
        series: [
          { type: "bar", data: colors.map((color) => ({ value: 10, itemStyle: { color } })) },
        ],
      });
      const faded = `(${JSON.stringify(colors)}).filter((color) => {
        const path = document.querySelector('#chart svg path[fill="' + color + '"]');
        return Number(path?.getAttribute("fill-opacity") ?? path?.getAttribute("opacity") ?? 1) < 1;
      }).length`;
      page.panel.annotate({ marks, dim: true });
      await evaluate(`(async () => {
        ${UNTIL}
        await until(() => ${faded} === 2, "the chart dimmed around its mark");
      })()`);
      page.panel.annotate(undimmed);
      const left = await evaluate(`(async () => {
        ${UNTIL}
        await until(() => ${faded} === 0, "every item drawn in full").catch(() => {});
        return ${faded};
      })()`);
      assert.strictEqual(left, 0, JSON.stringify(undimmed));
    }
  });

  test("draws a chart in full that replaces one dimmed around its marks", async () => {
    const option = {
      xAxis: { type: "category", data: ["A", "B"] },
      yAxis: {},
      series: [{ type: "bar", data: [10, 20], itemStyle: { color: "#0000ff" } }],
    };
    const faded = `[...document.querySelectorAll('#chart svg path[fill="#0000ff"]')].filter((path) =>
      Number(path.getAttribute("fill-opacity") ?? path.getAttribute("opacity") ?? 1) < 1).length`;
    await renderChart(option);
    page.panel.annotate({ marks: [{ id: "A", kind: "info" }], dim: true });
    await evaluate(`(async () => {
      ${UNTIL}
      await until(() => ${faded} === 1, "the chart dimmed around its mark");
    })()`);
    await renderChart({ ...option, title: { text: "Again" } });
    const left = await evaluate(`(async () => {
      ${UNTIL}
      await until(() => ${faded} === 0, "every item drawn in full").catch(() => {});
      return ${faded};
    })()`);
    assert.strictEqual(left, 0);
  });

  test("sizes a chart drawn in a hidden tab at an initial size, and for the tab once shown", async () => {
    // Mermaid leaves no chart whose size a new one would keep.
    await draw({ source: "flowchart LR\n A --> B" });
    await evaluate('receive({type: "tabVisibility", hidden: true})');
    let shown = false;
    try {
      await draw({ language: "echarts", source: '{"series": [{"type": "pie", "data": [1, 2]}]}' });
      // The page of a hidden tab has the size of an empty frame, which the extension tells it of.
      assert.deepStrictEqual(
        await evaluate(`(() => {
          const svg = document.querySelector("#chart svg");
          return [svg.width.baseVal.value, svg.height.baseVal.value];
        })()`),
        [800, 500],
      );
      await evaluate('receive({type: "tabVisibility", hidden: false})');
      shown = true;
      assert.strictEqual(
        await evaluate(`(async () => { ${CHART_FITTED} return chartFitted(); })()`),
        true,
      );
    } finally {
      if (!shown) await evaluate('receive({type: "tabVisibility", hidden: false})');
    }
  });

  test("sizes a chart first rendered in Source view and resizes it when revealed", async () => {
    await draw({ source: "flowchart LR\n A --> B" });
    await evaluate('document.getElementById("view-source").click()');
    afterTest(() => evaluate('document.getElementById("view-visual").click()'));
    await draw({
      language: "echarts",
      source: '{"series": [{"type": "pie", "data": [1, 2]}]}',
    });
    assert.strictEqual(
      await evaluate(`(() => {
        const svg = document.querySelector("#chart svg");
        return svg.width.baseVal.value > 0 && svg.height.baseVal.value > 0;
      })()`),
      true,
    );
    assert.strictEqual(
      await evaluate(`(async () => {
        document.getElementById("view-visual").click();
        ${CHART_FITTED}
        return chartFitted();
      })()`),
      true,
    );
  });

  test("reports a chart option it cannot draw as invalid, with the reason", async () => {
    const outcome = await render({
      language: "echarts",
      source: '{"series": [{"type": "map"}]}',
    });
    assert.ok(!outcome.ok && outcome.kind === "invalid");
    assert.match(outcome.error, /unsupported type "map"/);
  });

  test("tells what a chart draws other than its option meant", async () => {
    await draw({
      language: "echarts",
      source: JSON.stringify({
        xAxis: { type: "category", data: ["A", "B"] },
        yAxis: { max: 10 },
        series: [{ type: "bar", data: [5, 50] }],
      }),
    });
    assert.deepStrictEqual(page.panel.warnings, [
      'series[0] has values up to 50, above the "max" of yAxis, 10, which ECharts cuts off at the edge of the plot: raise "max", or leave it out.',
    ]);
    await draw({
      language: "echarts",
      source: JSON.stringify({
        xAxis: { type: "category", data: ["A", "B"] },
        yAxis: { max: 100 },
        series: [{ type: "bar", data: [5, 50] }],
      }),
    });
    assert.deepStrictEqual(page.panel.warnings, []);
  });

  test("tells the extension of a callback that throws as the pointer hovers an item", async () => {
    await draw({
      language: "echarts",
      source:
        '{\n  animation: false,\n  xAxis: {type: "category", data: ["A"]},\n  yAxis: {},\n' +
        '  tooltip: {trigger: "item", formatter: (p) => p.nope.x},\n' +
        '  series: [{type: "bar", data: [1], itemStyle: {color: "#0000ff"}}],\n}',
    });
    assert.deepStrictEqual(page.panel.warnings, []);
    await evaluate(`(() => {
      const bar = document.querySelector('#chart svg path[fill="#0000ff"]');
      const box = bar.getBoundingClientRect();
      bar.dispatchEvent(new MouseEvent("mousemove",
        {bubbles: true, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2}));
    })()`);
    assert.ok(
      await within(() => page.panel.warnings.length > 0),
      "The extension hears of the warning.",
    );
    assert.deepStrictEqual(page.panel.warnings, [
      'The ECharts option\'s "formatter" threw while the chart was used: Cannot read properties ' +
        "of undefined (reading 'x') (line 5, column 55). Check what it reads of its arguments, " +
        `or leave it out.\n5 |   tooltip: {trigger: "item", formatter: (p) => p.nope.x},\n  | ${" ".repeat(54)}^`,
    ]);
  });

  test("selects and marks chart names with surrounding spaces without conflating them", async () => {
    await renderChart({
      series: [
        {
          type: "pie",
          data: [
            { name: "A", value: 1 },
            { name: " A ", value: 1 },
          ],
          itemStyle: { color: "#0000ff" },
          emphasis: { scale: false, itemStyle: { color: "#ff0000" } },
        },
      ],
    });
    assert.strictEqual(
      await evaluate(`(() => {
        ${CLICK_CHART}
        clickChart(document.querySelectorAll('#chart svg path[fill="#0000ff"]')[1]);
        return document.getElementById("selection-label").textContent;
      })()`),
      "Selected: “ A ”",
    );
    page.panel.annotate(validateAnnotation({ marks: [{ id: " A " }] }));
    assert.strictEqual(await redHalf(), "left");
  });

  test("tells apart chart items of the same name when selecting and marking them", async () => {
    await renderChart({
      xAxis: { type: "category", data: ["A", "B", "A"] },
      yAxis: {},
      series: [
        {
          type: "bar",
          data: [1, 1, 1],
          itemStyle: { color: "#0000ff" },
          emphasis: { itemStyle: { color: "#ff0000" } },
        },
      ],
    });
    assert.strictEqual(
      await evaluate(`(() => {
        ${CLICK_CHART}
        clickChart(document.querySelectorAll('#chart svg path[fill="#0000ff"]')[2]);
        return document.getElementById("selection-label").textContent;
      })()`),
      "Selected: “A”",
    );
    assert.match(page.panel.describeForModel() ?? "", /has selected: "A" \(id: "A \(item 3\)"\)/);
    const ambiguous = page.panel.annotate({ marks: [{ id: "A", kind: "info" }], dim: false });
    assert.ok(ambiguous.ok);
    assert.deepStrictEqual(ambiguous.repeated, [
      { name: "A", ids: ["A (item 1)", "A (item 3)"], count: 2 },
    ]);
    page.panel.annotate({ marks: [{ id: "A (item 3)", kind: "info" }], dim: false });
    assert.strictEqual(await redHalf(), "right");
  });

  test("shows only the chart items selected as selected, not others of the same name", async () => {
    // A heatmap names its cells by their column.
    await renderChart({
      xAxis: { type: "category", data: ["A", "B"] },
      yAxis: { type: "category", data: ["x", "y", "z"] },
      visualMap: { min: 0, max: 9, show: false },
      series: [
        {
          type: "heatmap",
          data: [0, 1, 2, 3, 4, 5].map((index) => [Math.floor(index / 3), index % 3, index]),
          itemStyle: { borderColor: "#0000ff", borderWidth: 1 },
          select: { itemStyle: { borderColor: "#ff0000", borderWidth: 3 } },
          emphasis: { disabled: true },
        },
      ],
    });
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        ${UNTIL}
        ${CLICK_CHART}
        const cells = [...document.querySelectorAll('#chart svg path[stroke="#0000ff"]')];
        // By where they are, as ECharts may draw a cell anew.
        const places = cells.map((cell) => cell.getAttribute("d"));
        const selected = async (count) => {
          const red = () => [...document.querySelectorAll('#chart svg path[stroke="#ff0000"]')];
          await until(() => red().length === count, count + " cells drawn selected");
          return red().map((cell) => places.indexOf(cell.getAttribute("d"))).sort();
        };
        clickChart(cells[1]);
        const one = await selected(1);
        clickChart(cells[2], {ctrlKey: true});
        const two = await selected(2);
        clickChart(cells[1], {ctrlKey: true});
        return [one, two, await selected(1), document.getElementById("selection-label").textContent];
      })()`),
      [[1], [1, 2], [2], "Selected: “A, z”"],
    );
  });

  test("highlights the right unnamed or slash-named chart series", async () => {
    for (const names of [
      [undefined, undefined],
      ["Sales", "Sales/EU"],
    ]) {
      await renderChart({
        series: names.map((name, index) => ({
          name,
          type: "pie",
          center: [index === 0 ? "25%" : "75%", "50%"],
          radius: 30,
          data: [{ name: "A", value: 1 }],
          itemStyle: { color: "#0000ff" },
          emphasis: { scale: false, itemStyle: { color: "#ff0000" } },
        })),
      });
      page.panel.annotate({
        marks: [{ id: `${names[1] ?? "Series 2"}/A`, kind: "info" }],
        dim: false,
      });
      assert.strictEqual(await redHalf(), "right", `${names[1] ?? "Unnamed"} series`);
    }
  });

  test("acts once on a double click on a chart item, keeping it selected", async () => {
    await renderPie("A", "B");
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        ${CLICK_CHART}
        const slice = document.querySelector('#chart svg path[fill="#0000ff"]');
        // As a browser sends a double click: a click of each press, counting them.
        for (const detail of [1, 2]) clickChart(slice, {detail});
        // Drawn in the next frame, or the one after.
        for (let frame = 0; frame < 2; frame++) await new Promise(requestAnimationFrame);
        return {selected: document.querySelectorAll('#chart svg path[fill="#ff0000"]').length,
          label: document.getElementById("selection-label").textContent};
      })()`),
      { selected: 1, label: "Selected: “A”" },
    );
    await evaluate(`document.getElementById("clear-selection").click()`);
  });

  test("selects a chart item with a click that the hand shakes a little", async () => {
    await renderPie("A", "B");
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        const slice = document.querySelector('#chart svg path[fill="#0000ff"]');
        const box = slice.getBoundingClientRect();
        const [x, y] = [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)];
        const at = dx => ({bubbles: true, cancelable: true, clientX: x + dx, clientY: y, detail: 1,
          pointerType: "mouse", button: 0, isPrimary: true});
        // Pressed in one place and released some pixels further.
        const click = async (dx) => {
          slice.dispatchEvent(new PointerEvent("pointerdown", at(0)));
          slice.dispatchEvent(new MouseEvent("mousedown", at(0)));
          slice.dispatchEvent(new PointerEvent("pointerup", at(dx)));
          slice.dispatchEvent(new MouseEvent("mouseup", at(dx)));
          slice.dispatchEvent(new MouseEvent("click", at(dx)));
          await new Promise(requestAnimationFrame);
          const label = document.getElementById("selection-label").textContent;
          document.getElementById("clear-selection").click();
          return label;
        };
        // As far as ECharts takes for a click, and further, which it does not.
        return [await click(3), await click(4), await click(10)];
      })()`),
      ["Selected: “A”", "Selected: “A”", ""],
    );
  });

  test("clears every selected chart item together", async () => {
    await renderPie("A", "B", "C");
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        ${CLICK_CHART}
        for (const slice of document.querySelectorAll('#chart svg path[fill="#0000ff"]')) {
          clickChart(slice, {ctrlKey: true});
        }
        const count = () => document.querySelectorAll('#chart svg path[fill="#ff0000"]').length;
        ${UNTIL}
        await until(() => count() === 3, "three items selected");
        const selected = count();
        document.getElementById("clear-selection").click();
        await until(() => count() === 0, "no item selected");
        const cleared = count();
        return {selected, cleared, clearHidden: document.getElementById("clear-selection").hidden};
      })()`),
      { selected: 3, cleared: 0, clearHidden: true },
    );
  });

  test("keeps the chart selection through the toolbox's restore", async () => {
    await renderChart({
      toolbox: { feature: { restore: {} } },
      series: [
        {
          type: "pie",
          label: { show: false },
          data: ["A", "B"].map((name) => ({ name, value: 1 })),
          itemStyle: { color: "#0000ff" },
          select: { itemStyle: { color: "#ff0000" } },
          emphasis: { disabled: true },
        },
      ],
    });
    const selected = await evaluate(`(async () => {
      ${UNTIL}
      ${CLICK_CHART}
      const count = () => document.querySelectorAll('#chart svg path[fill="#ff0000"]').length;
      clickChart(document.querySelector('#chart svg path[fill="#0000ff"]'));
      await until(() => count() === 1, "an item selected");
      // The restore icon, the only path drawn without a fill.
      clickChart(document.querySelector('#chart svg path[fill="none"]'));
      await nextFrame(2);
      return [count(), document.getElementById("selection-label").textContent];
    })()`);
    assert.deepStrictEqual(selected, [1, "Selected: “A”"]);
  });

  test("keeps the chart selection through zooming out and drilling up", async () => {
    const color = (color: string) => ({ itemStyle: { color } });
    const charts = {
      treemap: {
        itemStyle: { gapWidth: 20 },
        breadcrumb: color("#00aa00"),
        data: [
          { name: "A", value: 1, ...color("#0000aa") },
          { name: "B", value: 1, ...color("#0000bb") },
        ],
      },
      sunburst: {
        data: [
          { name: "A", ...color("#0000aa"), children: [{ name: "a", value: 1 }] },
          { name: "B", value: 1, ...color("#0000bb") },
        ],
      },
    };
    const shown: Record<string, unknown> = {};
    for (const [type, series] of Object.entries(charts)) {
      const source = JSON.stringify({ animation: false, series: [{ type, ...series }] });
      await draw({ language: "echarts", source });
      shown[type] = await evaluate(`(async () => {
        const label = document.getElementById("selection-label");
        const svg = document.querySelector("#chart svg");
        // ECharts draws what changed in the next frame.
        const drawn = async () => {
          for (let frame = 0; frame < 2; frame++) await new Promise(requestAnimationFrame);
        };
        const all = async fill => {
          await drawn();
          return [...svg.querySelectorAll('[fill="' + fill + '"]')];
        };
        const center = element => {
          const box = element.getBoundingClientRect();
          return [box.x + box.width / 2, box.y + box.height / 2];
        };
        const click = ([clientX, clientY]) => {
          for (const type of ["mousedown", "mouseup", "click"]) {
            svg.dispatchEvent(new MouseEvent(type, {bubbles: true, clientX, clientY}));
          }
          return label.textContent;
        };
        const shown = {selected: click(center((await all("#0000aa"))[0]))};
        if (${JSON.stringify(type)} === "treemap") {
          // Zoomed in on A, which hides B, until a click on the breadcrumb of the root.
          shown.breadcrumb = click(center((await all("#00aa00"))[0]));
          // Between A and B, the root shows.
          const [a, b] = [(await all("#0000aa"))[0], (await all("#0000bb"))[0]].map(center);
          shown.root = click([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
        } else {
          // Drilled down into A, the root shows in the middle, inside A.
          shown.root = click(center((await all("#0000aa"))[0]));
          shown.drilledUp = (await all("#0000bb")).length === 1;
        }
        const box = svg.getBoundingClientRect();
        shown.empty = click([box.x + 2, box.y + 2]);
        return shown;
      })()`);
    }
    const selected = "Selected: “A”";
    const empty = "";
    assert.deepStrictEqual(shown, {
      treemap: { selected, breadcrumb: selected, root: selected, empty },
      sunburst: { selected, root: selected, drilledUp: true, empty },
    });
  });

  test("renders custom shapes without a coordinate system", async () => {
    assert.deepStrictEqual(
      await render({
        language: "echarts",
        source:
          '{series: [{type: "custom", coordinateSystem: null, data: [1], ' +
          'renderItem: () => ({type: "circle", shape: {cx: 20, cy: 20, r: 10}})}]}',
      }),
      { ok: true, diagramType: "custom" },
    );
    assert.ok(await evaluate('document.querySelector("#chart svg path") !== null'));
  });

  test("draws no brush buttons for a brush component", async () => {
    const paths = async (extra: object) => {
      // Away from the chart, which would draw an axis pointer at the item it focuses: also when
      // VS Code, giving the page the focus again, has the page give it back to the chart that an
      // earlier test focused last.
      await evaluate('document.getElementById("ask-input").focus()');
      await renderChart({
        xAxis: { type: "category", data: ["A", "B"] },
        yAxis: {},
        series: [{ type: "bar", data: [1, 2] }],
        ...extra,
      });
      return evaluate('document.querySelectorAll("#chart svg path").length');
    };
    assert.strictEqual(await paths({ brush: {} }), await paths({}));
  });

  test("does not redraw a chart when a resize observation leaves its dimensions unchanged", async () => {
    await draw({ language: "echarts", source: COUNTED_CHART });
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        ${CHART_FITTED}
        // Let an earlier resize, should one still be on its way, finish first.
        await chartFitted();
        const chart = document.getElementById("chart");
        const width = chart.clientWidth;
        const height = chart.clientHeight;
        // The panel handles resize observations in an animation frame: count what those draw.
        const requestFrame = window.requestAnimationFrame;
        let redraws = 0;
        window.requestAnimationFrame = (callback) => requestFrame((time) => {
          const before = window.chartDraws.length;
          callback(time);
          redraws += window.chartDraws.length - before;
        });
        try {
          await new Promise((resolve) => {
            // Observed after the panel's observer, so this observer hears of the same resize
            // after it, and its frame follows the panel's.
            const observer = new ResizeObserver(() => {
              observer.disconnect();
              requestFrame(resolve);
            });
            // Content-box changes trigger ResizeObserver, but the chart uses client dimensions.
            chart.style.padding = "1px";
            observer.observe(chart);
          });
          return {sameSize: chart.clientWidth === width && chart.clientHeight === height, redraws};
        } finally {
          window.requestAnimationFrame = requestFrame;
          chart.style.padding = "";
        }
      })()`),
      { sameSize: true, redraws: 0 },
    );
  });

  test("fits a chart drawn while its container briefly had another size or was hidden", async () => {
    await draw({ language: "echarts", source: COUNTED_CHART });
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        ${CHART_FITTED}
        const chart = document.getElementById("chart");
        const results = window.testRenderResults;
        const send = (requestId, source) =>
          receive({type: "render", requestId, language: "echarts", source, title: "Test"});
        let request = 900010;
        // Draws a new chart in place of one that failed, which hid the chart, between the same
        // two frames, while its container has another size: ResizeObserver, which compares sizes
        // in frames, sees none of it.
        const redraw = async (whileDrawing, afterDrawing) => {
          const failing = ++request;
          const drawn = ++request;
          const push = results.push;
          results.push = (id) => {
            if (id === failing) {
              whileDrawing();
              send(drawn, '{"series": [{"type": "pie", "data": [1]}]}');
            } else if (id === drawn) {
              afterDrawing();
            }
            return push.call(results, id);
          };
          try {
            send(failing, '{"xAxis": null, "yAxis": {}, "series": [{"type": "bar", "data": [1]}]}');
            await until(() => results.includes(drawn), "the chart drawn after the failing one");
          } finally {
            results.push = push;
          }
          return chartFitted();
        };
        const view = (name) => () => document.getElementById("view-" + name).click();
        return {
          fitted: await chartFitted(),
          resized: await redraw(() => { chart.style.bottom = "41px"; },
            () => { chart.style.bottom = ""; }),
          hidden: await redraw(view("source"), view("visual")),
        };
      })()`),
      { fitted: true, resized: true, hidden: true },
    );
  });

  test("draws a chart once in the colors of a new theme, in any CSS color syntax", async () => {
    await draw({ language: "echarts", source: COUNTED_CHART });
    for (const color of ["#123456", "color(srgb 0.0706 0.2039 0.3373)"]) {
      assert.deepStrictEqual(
        await evaluate(`(async () => {
          ${UNTIL}
          const fill = () => document.querySelector("#chart svg path")?.getAttribute("fill");
          const root = document.documentElement.style;
          const before = window.chartDraws.length;
          root.setProperty("--vscode-charts-blue", ${JSON.stringify(color)});
          try {
            await until(() => fill() === "#123456", "the theme's color", nextFrame);
            return [...new Set(window.chartDraws.slice(before))];
          } finally {
            root.removeProperty("--vscode-charts-blue");
            await until(() => fill() !== "#123456", "the default color again", nextFrame);
          }
        })()`),
        [1],
        color,
      );
    }
  });

  test("draws series in the theme's chart colors made opaque, and in an orange where it has none", async () => {
    await renderChart({
      xAxis: { type: "category", data: ["Mon"] },
      yAxis: {},
      // Not lightened where the pointer rests.
      series: [1, 2].map((value) => ({
        type: "bar",
        data: [value],
        emphasis: { disabled: true },
      })),
    });
    const [translucent, missing] = (await evaluate(`(async () => {
        ${UNTIL}
        const second = () =>
          document.querySelectorAll("#chart svg path:not([fill='none'])")[1]?.getAttribute("fill");
        const root = document.documentElement.style;
        // As Dark and Light Modern set it.
        const original = root.getPropertyValue("--vscode-charts-orange");
        const kind = document.body.dataset.vscodeThemeKind;
        const drawn = second();
        root.setProperty("--vscode-charts-orange", "rgba(234, 92, 0, 0.33)");
        try {
          // Not the brown that it makes over the background. Reading it back rounds it a little.
          const translucent = await until(
            () => /^#e[9ab]5[a-c]00$/.test(second()) && second(), "the opaque orange", nextFrame);
          // As the high contrast themes leave it out.
          root.setProperty("--vscode-charts-orange", "");
          document.body.dataset.vscodeThemeKind = "vscode-high-contrast";
          const missing = await until(() => second() !== translucent && second(), "another orange", nextFrame);
          return [translucent, missing];
        } finally {
          document.body.dataset.vscodeThemeKind = kind;
          root.setProperty("--vscode-charts-orange", original);
          await until(() => second() === drawn, "the theme's orange again", nextFrame);
        }
      })()`)) as string[];
    assert.match(translucent ?? "", /^#e[9ab]5[a-c]00$/);
    // VS Code's own orange.
    assert.strictEqual(missing, "#d18616");
  });

  test("keeps a selected chart item selected through a theme change", async () => {
    await renderChart({
      series: [
        {
          type: "pie",
          data: ["A", "B"].map((name) => ({ name, value: 1 })),
          select: { itemStyle: { color: "#ff0000" } },
          emphasis: { disabled: true },
        },
      ],
    });
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        const fills = () => [...document.querySelectorAll("#chart svg path")]
          .map(path => path.getAttribute("fill")).filter(fill => fill !== "none").sort();
        ${UNTIL}
        ${CLICK_CHART}
        clickChart(document.querySelectorAll("#chart svg path")[1]);
        await until(() => fills().includes("#ff0000"), "the selected item's color");
        const root = document.documentElement.style;
        root.setProperty("--vscode-charts-blue", "#123456");
        try {
          await until(() => fills().includes("#123456") && fills().includes("#ff0000"), "the theme's color");
          return fills();
        } finally {
          root.removeProperty("--vscode-charts-blue");
          await until(() => !fills().includes("#123456"), "the default color again");
        }
      })()`),
      ["#123456", "#ff0000"],
    );
  });

  test("keeps the chart items selected through an agent's edit that keeps them", async () => {
    // Two items of the same name, told apart by their ids.
    const chart = (color: string) =>
      JSON.stringify({
        animation: false,
        xAxis: { type: "category", data: ["A", "B", "A"] },
        yAxis: {},
        series: [
          {
            type: "bar",
            data: [1, 2, 3],
            itemStyle: { color },
            select: { itemStyle: { color: "#ff0000" } },
            emphasis: { disabled: true },
          },
        ],
      });
    await draw({ language: "echarts", source: chart("#0000ff") });
    await evaluate(`(async () => {
      ${UNTIL}
      ${CLICK_CHART}
      clickChart(document.querySelectorAll('#chart svg path[fill="#0000ff"]')[2]);
      await until(() => document.querySelector('#chart svg path[fill="#ff0000"]'), "the item selected");
    })()`);
    const edited = await page.panel.editByAgent({ source: chart("#00ff00") }, page.panel.revision);
    assert.ok(edited.ok, edited.ok ? "" : edited.error);
    const shown = await evaluate(`(async () => {
      ${UNTIL}
      await nextFrame(2);
      const bars = [...document.querySelectorAll('#chart svg path[fill="#00ff00"], #chart svg path[fill="#ff0000"]')]
        .sort((a, b) => a.getBBox().x - b.getBBox().x);
      return {bars: bars.map((bar) => bar.getAttribute("fill")),
        label: document.getElementById("selection-label").textContent};
    })()`);
    assert.deepStrictEqual(shown, {
      bars: ["#00ff00", "#00ff00", "#ff0000"],
      label: "Selected: “A”",
    });
    assert.deepStrictEqual(
      page.panel.selectedItems.map(({ id }) => id),
      ["A (item 3)"],
    );
    await evaluate(`document.getElementById("clear-selection").click()`);
  });

  const SALES = {
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: ["Mon", "Tue", "Wed"] },
    yAxis: {},
    series: ["A", "B", "C"].map((name, n) => ({ name, type: "bar", data: [n + 1, n + 2, n + 3] })),
  };
  /** Webview code defining `press(key, init)`, which says what the chart's focus announces. */
  const PRESS = `
    const chart = document.getElementById("chart");
    const press = (key, init) => {
      chart.dispatchEvent(new KeyboardEvent("keydown", {key, bubbles: true, cancelable: true, ...init}));
      return document.getElementById("chart-status").textContent;
    };
    const ring = () => {
      const ring = document.getElementById("chart-focus");
      return !ring.hidden && ring.getBoundingClientRect();
    };
    const tooltip = () => [...document.getElementById("chart-drawing").children]
      .find(child => !child.querySelector("svg") && child.style.display !== "none")?.textContent;`;

  test("opens the links in a chart's tooltip through the extension, which checks them", async () => {
    // What the page asks the extension to open, which asks first once a chart of an earlier test
    // ran code in the page.
    const opened: string[] = [];
    const listener = page.webview.onDidReceiveMessage((message) => {
      if (message.type === "openUrl") opened.push(message.url);
    });
    afterTest(() => listener.dispose());
    const errors = recordMessages("showErrorMessage");
    // Which the extension opens, rather than a browser.
    recordMessages("showWarningMessage", () => "Open");
    replace(vscode.env, "openExternal", async () => true);
    // A JSON option, which runs no code, writes the tooltip's HTML.
    await renderChart({
      ...SALES,
      tooltip: {
        enterable: true,
        formatter:
          '<a href="https://example.com/docs">Docs</a> <a href="vscode://file/etc/passwd">File</a> <a href="#top">Top</a> <a>None</a> <svg><a xlink:href="https://example.com/svg"><text>SVG</text></a></svg>',
      },
    });
    const clicked = await evaluate(`(async () => {
      ${UNTIL}
      ${PRESS}
      chart.focus();
      press("Home");
      const shown = await until(() => [...document.getElementById("chart-drawing").children]
        .find(child => child.querySelector("a")), "the tooltip");
      // What VS Code's listener on the window would see of the clicks.
      let seen = 0;
      const see = (event) => { if (event.composedPath().some(target => target.localName === "a")) seen++; };
      for (const type of ["click", "auxclick"]) window.addEventListener(type, see);
      try {
        const links = [...shown.querySelectorAll("a")];
        const click = (link, type = "click", init) =>
          !link.dispatchEvent(new MouseEvent(type, {bubbles: true, cancelable: true, ...init}));
        const prevented = links.map(link => click(link));
        prevented.push(click(links[0], "auxclick", {button: 1}));
        return {prevented, seen};
      } finally {
        for (const type of ["click", "auxclick"]) window.removeEventListener(type, see);
        chart.blur();
      }
    })()`);
    // A link without an href is no link, and is left alone.
    assert.deepStrictEqual(clicked, { prevented: [true, true, true, false, true, true], seen: 1 });
    assert.deepStrictEqual(opened, [
      "https://example.com/docs",
      "vscode://file/etc/passwd",
      "https://example.com/svg",
    ]);
    // Which the extension does not open.
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0] ?? "", /^Cannot open "vscode:\/\/file\/etc\/passwd"/);
  });

  test("leaves the chart under the toolbox's data view to itself, which fits it and Escape closes", async () => {
    await renderChart({ ...SALES, toolbox: { feature: { dataView: {} } } });
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        ${UNTIL}
        ${PRESS}
        ${CLICK_CHART}
        const dataView = () => document.querySelector("#chart-drawing > .chart-data-view");
        // The toolbox's one icon, at the top right.
        const box = chart.getBoundingClientRect();
        const icon = [...chart.querySelectorAll("svg path")].find(path => {
          const { top, right } = path.getBoundingClientRect();
          return top < box.top + 40 && right > box.right - 40;
        });
        chart.focus();
        // As a click presses the pointer first.
        icon.dispatchEvent(new PointerEvent("pointerdown", {bubbles: true}));
        clickChart(icon, {});
        await until(dataView, "the data view");
        // Its data between its heading and its Close button, for the chart as it is now.
        const canvas = document.getElementById("canvas");
        const fits = async (height) => {
          canvas.style.height = height;
          await nextFrame();
          const view = dataView();
          const data = view.children[1].getBoundingClientRect();
          const close = view.lastElementChild.getBoundingClientRect();
          return data.bottom <= close.top && close.top - data.bottom < 40;
        };
        const fitted = [await fits("250px"), await fits("600px")];
        canvas.style.height = "";
        const moved = [press("ArrowRight"), press("Enter"), ring()];
        const escape = new KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true});
        chart.dispatchEvent(escape);
        return {fitted, moved, selected: document.getElementById("selection-label").textContent,
          closed: !dataView(), handled: escape.defaultPrevented, focused: document.activeElement === chart};
      })()`),
      {
        fitted: [true, true],
        moved: ["", "", false],
        selected: "",
        closed: true,
        handled: true,
        focused: true,
      },
    );
  });

  test("tells the data view apart from a tooltip written like it", async () => {
    const opened: string[] = [];
    const listener = page.webview.onDidReceiveMessage((message) => {
      if (message.type === "openUrl") opened.push(message.url);
    });
    afterTest(() => listener.dispose());
    // A heading, a part and a last part that ends in a link, as the data view ends in its button.
    await renderChart({
      ...SALES,
      toolbox: { feature: { dataView: {} } },
      tooltip: {
        trigger: "item",
        formatter:
          '<h4>Day</h4><div>Sales</div><div><a href="https://example.com/more">More</a></div>',
      },
    });
    const keys = await evaluate(`(async () => {
      ${PRESS}
      chart.focus();
      const moves = [press("Home"), press("ArrowRight")];
      const escape = new KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true});
      chart.dispatchEvent(escape);
      await new Promise(requestAnimationFrame);
      return {moves, ring: Boolean(ring()), handled: escape.defaultPrevented,
        dataView: Boolean(document.querySelector(".chart-data-view"))};
    })()`);
    assert.deepStrictEqual(
      { keys, opened },
      {
        keys: {
          moves: ["Mon: 1, series A, 1 of 3", "Tue: 2, series A, 2 of 3"],
          ring: true,
          handled: false,
          dataView: false,
        },
        opened: [],
      },
    );
  });

  test("keeps tooltip links reachable by keyboard and touch, and hides them after focus leaves", async () => {
    await renderChart({
      ...SALES,
      tooltip: { formatter: '<a href="https://example.com/docs">Docs</a>' },
    });
    const states = await evaluate(`(async () => {
      ${UNTIL}
      ${PRESS}
      chart.focus();
      press("Home");
      const tip = await until(() => [...document.getElementById("chart-drawing").children]
        .find(child => child.querySelector("a")), "the tooltip");
      const link = tip.querySelector("a");
      const reachable = () => link.checkVisibility({visibilityProperty: true});
      // Longer than the tooltip's transition, after which a hidden one takes no focus.
      const settled = () => new Promise(resolve => setTimeout(resolve, 400));
      const state = () => ({focused: document.activeElement === link || document.activeElement.id,
        reachable: reachable(), status: Boolean(document.getElementById("chart-status").textContent)});
      // As Tab from the chart does.
      link.focus();
      await settled();
      const onLink = state();
      // Touch has no mouseenter to tell ECharts to keep its tooltip under the pointer.
      link.dispatchEvent(new PointerEvent("pointerdown", {pointerType: "touch", bubbles: true}));
      await settled();
      const pressedLink = state();
      link.dispatchEvent(new PointerEvent("pointerup", {pointerType: "touch", bubbles: true}));
      document.getElementById("ask-input").focus();
      await until(() => !reachable(), "the tooltip to hide");
      return [onLink, pressedLink, state()];
    })()`);
    assert.deepStrictEqual(states, [
      { focused: true, reachable: true, status: true },
      { focused: true, reachable: true, status: true },
      { focused: "ask-input", reachable: false, status: false },
    ]);
  });

  test("moves the focus between chart items with arrow keys from one tab stop", async () => {
    await renderChart(SALES);
    const shown = (await evaluate(`(() => {
      ${PRESS}
      chart.focus();
      try {
        press("Home");
        const moves = [press("ArrowRight")];
        const first = ring();
        moves.push(press("ArrowDown"), press("ArrowRight"));
        const second = ring();
        moves.push(press("ArrowUp"), press("End"));
        const shownTooltip = tooltip();
        moves.push(press("Home"), press("ArrowLeft"));
        const selected = [];
        for (const [key, init] of [["Enter"], ["ArrowRight"], [" ", {shiftKey: true}], ["Enter"]]) {
          press(key, init);
          selected.push(document.getElementById("selection-label").textContent);
        }
        return {tabStop: chart.tabIndex, role: chart.getAttribute("role"), moves,
          ringMoved: Boolean(first && second && second.x > first.x), tooltip: shownTooltip,
          focused: document.activeElement === chart, selected};
      } finally {
        document.getElementById("clear-selection").click();
      }
    })()`)) as Record<string, unknown>;
    assert.match(String(shown.tooltip), /Wed.*C/s);
    assert.deepStrictEqual(
      { ...shown, tooltip: undefined },
      {
        tabStop: 0,
        role: "application",
        moves: [
          "Tue: 2, series A, 2 of 3",
          "Tue: 3, series B, 2 of 3",
          "Wed: 4, series B, 3 of 3",
          "Wed: 3, series A, 3 of 3",
          "Wed: 5, series C, 3 of 3",
          "Mon: 1, series A, 1 of 3",
          // Nothing is left of the first item.
          "Mon: 1, series A, 1 of 3",
        ],
        ringMoved: true,
        tooltip: undefined,
        focused: true,
        selected: [
          "Selected: “Mon”",
          "Selected: “Mon”",
          "Selected: “Mon”, “Tue”",
          "Selected: “Tue”",
        ],
      },
    );
  });

  test("shows no focus on a chart that lost the focus while it was drawn anew", async () => {
    await renderChart({ series: [{ type: "pie", data: [3, 7] }] });
    await evaluate('document.getElementById("chart").focus()');
    await renderChart(SALES);
    const state = `(async () => {
      ${PRESS}
      await nextFrame(2);
      return {ring: Boolean(ring()), status: document.getElementById("chart-status").textContent};
    })()`;
    const UNSHOWN = { ring: false, status: "" };
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        ${UNTIL}
        document.getElementById("chart").blur();
        return ${state};
      })()`),
      UNSHOWN,
    );
    await renderChart({ ...SALES, yAxis: { max: 20 } });
    assert.deepStrictEqual(await evaluate(`(async () => {${UNTIL} return ${state}; })()`), UNSHOWN);
  });

  test("empties the announcement while the chart is not focused, for find not to match it", async () => {
    await renderChart(SALES);
    const announced = await evaluate(`(() => {
      ${PRESS}
      const status = () => document.getElementById("chart-status").textContent;
      chart.focus();
      press("Home");
      const moved = press("ArrowRight");
      chart.blur();
      const blurred = status();
      chart.focus();
      const refocused = status();
      chart.dispatchEvent(new PointerEvent("pointerdown", {bubbles: true}));
      const clicked = status();
      chart.blur();
      return [moved, blurred, refocused, clicked];
    })()`);
    assert.deepStrictEqual(announced, [
      "Tue: 2, series A, 2 of 3",
      "",
      "Tue: 2, series A, 2 of 3",
      "",
    ]);
  });

  test("takes the axis pointer and the emphasis it shows off a chart that loses the focus", async () => {
    await renderChart({
      tooltip: { trigger: "axis" },
      xAxis: { type: "category", data: ["Mon", "Tue"] },
      yAxis: {},
      series: [
        {
          type: "bar",
          data: [1, 2],
          itemStyle: { color: "#0000ff" },
          emphasis: { itemStyle: { color: "#ff0000" } },
        },
      ],
    });
    const emphasized = await evaluate(`(async () => {
      ${UNTIL}
      ${PRESS}
      const red = () => document.querySelectorAll('#chart svg path[fill="#ff0000"]').length;
      chart.focus();
      press("Home");
      const focused = await until(red, "the focused item emphasized");
      chart.blur();
      await nextFrame(2);
      return [focused, red()];
    })()`);
    assert.deepStrictEqual(emphasized, [1, 0]);
  });

  test("shows the selected node of a graph selected, and no edge, after an image for a model", async () => {
    await renderChart({
      series: [
        {
          type: "graph",
          layout: "none",
          data: [
            { name: "a", x: 0, y: 0 },
            { name: "b", x: 100, y: 0 },
            { name: "c", x: 50, y: 100 },
          ],
          // The edge of the same index as the node.
          links: [
            { source: "b", target: "c" },
            { source: "a", target: "b" },
          ],
          symbolSize: 40,
          itemStyle: { color: "#0000ff" },
          lineStyle: { color: "#00ff00", width: 4, opacity: 1 },
          select: { itemStyle: { color: "#ff0000" }, lineStyle: { color: "#ff0000" } },
          emphasis: { disabled: true },
        },
      ],
    });
    const selected = `(async () => {
      ${UNTIL}
      await nextFrame(2);
      return [...document.querySelectorAll("#chart svg path")].flatMap((path) =>
        path.getAttribute("fill") === "#ff0000" ? ["node"] :
          path.getAttribute("stroke") === "#ff0000" ? ["edge"] : []);
    })()`;
    await evaluate(`(() => {
      ${PRESS}
      chart.focus();
      press("Home");
      press("Enter");
      chart.blur();
    })()`);
    assert.deepStrictEqual(await evaluate(selected), ["node"]);
    const image = await page.panel.captureImage({ maxSide: 800, maxPixels: 800 * 800 });
    if (typeof image === "string") assert.fail(image);
    assert.deepStrictEqual(await evaluate(selected), ["node"]);
  });

  test("focuses, marks and selects the items of a theme river where they are, in their layers", async () => {
    await renderChart({
      color: ["#0000ff", "#00ff00"],
      singleAxis: { type: "time" },
      series: [
        {
          type: "themeRiver",
          emphasis: { itemStyle: { color: "#ff0000" } },
          select: { itemStyle: { color: "#ffff00" } },
          data: [
            ["2026-01-01", 10, "a"],
            ["2026-01-02", 20, "a"],
            ["2026-01-03", 10, "a"],
            ["2026-01-01", 5, "b"],
            ["2026-01-02", 10, "b"],
            ["2026-01-03", 5, "b"],
          ],
        },
      ],
    });
    const result = (await evaluate(`(() => {
      ${PRESS}
      const [a, b] = ["#0000ff", "#00ff00"].map((color) =>
        document.querySelector('#chart svg path[fill="' + color + '"]'));
      /** The layer that the middle of the focus ring is in. */
      const ringIn = () => {
        const box = ring();
        const at = document.elementsFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return at.includes(a) ? "a" : at.includes(b) ? "b" : "none";
      };
      chart.focus();
      press("Home");
      const moves = ["ArrowRight", "ArrowDown"].map((key) => [press(key), ringIn()]);
      chart.blur();
      return moves;
    })()`)) as string[][];
    assert.deepStrictEqual(result, [
      ["2026-01-02: (20, a), 2 of 6", "a"],
      ["2026-01-02: (10, b), 5 of 6", "b"],
    ]);
    page.panel.annotate({ marks: [{ id: "2026-01-02 (item 5)", kind: "info" }], dim: false });
    const marked = await evaluate(`(async () => {
      ${UNTIL}
      const fills = () => [...document.querySelectorAll("#chart svg path")].map((path) => path.getAttribute("fill"));
      await until(() => fills().includes("#ff0000"), "a layer highlighted");
      return ["#0000ff", "#00ff00", "#ff0000"].map((color) => fills().includes(color));
    })()`);
    // Layer b, red, and layer a as it was.
    assert.deepStrictEqual(marked, [true, false, true]);
    page.panel.annotate({ marks: [], dim: false });
    const selected = await evaluate(`(async () => {
      ${UNTIL}
      ${CLICK_CHART}
      const fills = () => [...document.querySelectorAll("#chart svg path")].map((path) => path.getAttribute("fill"));
      await until(() => fills().includes("#00ff00"), "layer b as it was");
      clickChart(document.querySelector('#chart svg path[fill="#00ff00"]'));
      await until(() => fills().includes("#ffff00"), "a layer selected");
      return [fills().includes("#00ff00"), document.getElementById("selection-label").textContent];
    })()`);
    assert.deepStrictEqual(selected, [false, "Selected: “2026-01-02”"]);
    assert.deepStrictEqual(
      page.panel.selectedItems.map(({ id }) => id),
      ["2026-01-02 (item 5)"],
    );
    await evaluate(`document.getElementById("clear-selection").click()`);
  });

  test("announces pie slices, tree nodes and sankey flows as the focus moves", async () => {
    const charts: [Record<string, unknown>, string[]][] = [
      [
        {
          series: [
            {
              type: "pie",
              data: [
                { name: "Dogs", value: 3 },
                { name: "Cats", value: 2 },
              ],
            },
          ],
        },
        ["ArrowRight", "ArrowRight", "ArrowUp"],
      ],
      [
        {
          series: [
            {
              type: "treemap",
              data: [
                {
                  name: "src",
                  children: [
                    { name: "a.ts", value: 2 },
                    { name: "b.ts", value: 1 },
                  ],
                },
              ],
            },
          ],
        },
        ["ArrowRight", "ArrowDown", "ArrowLeft"],
      ],
      [
        {
          series: [
            {
              type: "sankey",
              data: [{ name: "In" }, { name: "Out" }],
              links: [{ source: "In", target: "Out", value: 2 }],
            },
          ],
        },
        ["ArrowRight", "ArrowRight", "ArrowLeft"],
      ],
    ];
    const announced = [];
    for (const [option, keys] of charts) {
      await renderChart(option);
      announced.push(
        await evaluate(`(() => {
          ${PRESS}
          chart.focus();
          press("Home");
          return ${JSON.stringify(keys)}.map(key => press(key));
        })()`),
      );
    }
    assert.deepStrictEqual(announced, [
      ["Cats: 2, 2 of 2", "Dogs: 3, 1 of 2", "Cats: 2, 2 of 2"],
      ["a.ts: 2, 1 of 2", "b.ts: 1, 2 of 2", "src: 3, 1 of 1"],
      ["In → Out: 2, 1 of 1", "Out, 2 of 2", "In → Out: 2, 1 of 1"],
    ]);
  });

  test("moves the focus over lines of parallel coordinates, leaving the chart able to draw", async () => {
    await renderChart({
      parallelAxis: [{ dim: 0 }, { dim: 1 }],
      series: [
        {
          type: "parallel",
          data: [
            [1, 2],
            [3, 4],
          ],
        },
      ],
    });
    const announced = await evaluate(`(() => {
      ${PRESS}
      chart.focus();
      return [press("Home"), press("ArrowRight")];
    })()`);
    assert.deepStrictEqual(announced, ["(1, 2), 1 of 2", "(3, 4), 2 of 2"]);
    // ECharts throws for the tooltip of a line shown by its index, which would leave it stuck.
    await renderChart(SALES);
  });

  test("drills into hierarchies with Enter, as a click does, and up with Backspace", async () => {
    const color = (color: string) => ({ itemStyle: { color } });
    const data = [
      { name: "A", ...color("#0000aa"), children: [{ name: "a", value: 1, ...color("#0000ab") }] },
      { name: "B", value: 1, ...color("#0000bb") },
    ];
    const shown: Record<string, unknown> = {};
    for (const type of ["treemap", "sunburst", "tree"]) {
      await renderChart({
        series: [{ type, data: type === "tree" ? [{ name: "R", children: data }] : data }],
      });
      shown[type] = await evaluate(`(async () => {
        ${PRESS}
        ${UNTIL}
        const tree = ${JSON.stringify(type)} === "tree";
        // Whether B is in sight, which a treemap zoomed in on A moves out of the chart's area.
        const inSight = () => {
          const box = chart.getBoundingClientRect();
          return [...chart.querySelectorAll('svg [fill="#0000bb"]')].some(element => {
            const { x, y } = element.getBoundingClientRect();
            return x >= box.x && x < box.right && y >= box.y && y < box.bottom;
          });
        };
        const frame = () => new Promise(requestAnimationFrame);
        chart.focus();
        const steps = [press("Home")];
        // A tree's root, R, comes first, and its first child is A.
        if (tree) steps.push(press("ArrowRight"));
        press("Enter");
        if (!tree) await until(() => !inSight(), "B out of sight", frame);
        steps.push(document.getElementById("chart-status").textContent);
        // Collapsed, A of a tree has no child to go to.
        steps.push(press("ArrowRight"));
        press("Backspace");
        if (!tree) await until(inSight, "B in sight again", frame);
        chart.blur();
        return steps;
      })()`);
    }
    assert.deepStrictEqual(shown, {
      treemap: ["A: 1, 1 of 2", "A: 1, 1 of 2", "a: 1, 1 of 1"],
      sunburst: ["A: 1, 1 of 2", "A: 1, 1 of 2", "a: 1, 1 of 1"],
      tree: ["R, 1 of 1", "A, 1 of 2", "A, 1 of 2", "A, 1 of 2"],
    });
  });

  test("hides the focused series or slice with H, as its legend entry does, and shows all with Shift+H", async () => {
    const pie = {
      legend: {},
      series: [{ type: "pie", data: ["X", "Y", "Z"].map((name, n) => ({ name, value: n + 1 })) }],
    };
    const announced = [];
    for (const option of [{ ...SALES, legend: {} }, pie]) {
      await renderChart(option);
      announced.push(
        await evaluate(`(async () => {
          ${PRESS}
          ${UNTIL}
          const status = () => document.getElementById("chart-status").textContent;
          chart.focus();
          const steps = [press("Home"), press("ArrowRight"), press("h", {code: "KeyH"})];
          // On to an item still shown, at the same place in another series, once the chart is
          // drawn without the hidden one.
          steps.push(await until(() => status() !== steps[2] && status(), "the next item", nextFrame));
          steps.push(press("H", {code: "KeyH", shiftKey: true}));
          // The focused item stays, and the hidden series is there again to go to.
          await nextFrame(2);
          steps.push(press("ArrowUp"));
          chart.blur();
          return steps;
        })()`),
      );
    }
    assert.deepStrictEqual(announced, [
      [
        "Mon: 1, series A, 1 of 3",
        "Tue: 2, series A, 2 of 3",
        "A hidden",
        "Tue: 3, series B, 2 of 3",
        "All shown",
        "Tue: 2, series A, 2 of 3",
      ],
      ["X: 1, 1 of 3", "Y: 2, 2 of 3", "Y hidden", "X: 1, 1 of 2", "All shown", "Z: 3, 3 of 3"],
    ]);
    // Without a legend shown, nothing hides.
    await renderChart({ ...SALES, legend: { show: false } });
    assert.deepStrictEqual(
      await evaluate(`(() => {
        ${PRESS}
        chart.focus();
        const steps = [press("Home"), press("h", {code: "KeyH"})];
        chart.blur();
        return steps;
      })()`),
      ["Mon: 1, series A, 1 of 3", "Mon: 1, series A, 1 of 3"],
    );
  });

  test("hides the focused series when a category shares another series' name", async () => {
    await renderChart({
      legend: {},
      xAxis: { type: "category", data: ["B"] },
      yAxis: {},
      series: [
        { name: "A", type: "bar", data: [1] },
        { name: "B", type: "bar", data: [2] },
      ],
    });
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        ${PRESS}
        ${UNTIL}
        chart.focus();
        const steps = [press("Home"), press("h", {code: "KeyH"})];
        steps.push(await until(() => {
          const text = document.getElementById("chart-status").textContent;
          return text !== steps[1] && text;
        }, "the remaining series", nextFrame));
        chart.blur();
        return steps;
      })()`),
      ["B: 1, series A, 1 of 1", "A hidden", "B: 2, series B, 1 of 1"],
    );
  });

  test("drills into a treemap's leaves of leafDepth with Enter only as nodeClick allows", async () => {
    const roots = [];
    for (const nodeClick of [undefined, false]) {
      await renderChart({
        series: [
          {
            type: "treemap",
            leafDepth: 1,
            nodeClick,
            data: [
              { name: "A", children: [{ name: "a", value: 1 }] },
              { name: "B", value: 1 },
            ],
          },
        ],
      });
      roots.push(
        await evaluate(`(async () => {
          ${PRESS}
          ${UNTIL}
          chart.focus();
          press("Home");
          press("Enter");
          // Drawn as the root, A shows its child, which the right arrow then leads to, within a
          // few frames, as the chart is drawn without animation.
          let to;
          let frames = 0;
          do {
            await nextFrame();
            to = press("ArrowRight");
          } while (to.startsWith("A") && ++frames < 10);
          chart.blur();
          return to;
        })()`),
      );
    }
    assert.deepStrictEqual(roots, ["a: 1, 1 of 1", "A: 1, 1 of 2"]);
  });

  test("keeps the last series shown with H, by the key's place, and shows all from none", async () => {
    await renderChart({
      legend: {},
      series: [
        {
          type: "pie",
          label: { show: false },
          data: ["X", "Y"].map((name, n) => ({ name, value: n + 1 })),
        },
      ],
    });
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        ${PRESS}
        ${UNTIL}
        ${CLICK_CHART}
        const status = () => document.getElementById("chart-status").textContent;
        // A click on the legend's entry, which the pie's labels, left out, do not share a name with.
        const clickLegend = name =>
          clickChart([...chart.querySelectorAll("svg text")].find(text => text.textContent === name));
        chart.focus();
        // Where H is on a Russian keyboard.
        const steps = [press("Home"), press("р", {code: "KeyH"})];
        steps.push(await until(() => status() !== steps[1] && status(), "the next item", nextFrame));
        steps.push(press("р", {code: "KeyH"}));
        // Not said with the focus unshown, as after a click, for find not to match it.
        chart.dispatchEvent(new PointerEvent("pointerdown", {bubbles: true}));
        steps.push(press("р", {code: "KeyH"}));
        // With no slice shown, as a click on the legend can leave it.
        clickLegend("Y");
        await nextFrame(2);
        steps.push(press("Home"), press("H", {code: "KeyH", shiftKey: true}));
        await nextFrame(2);
        steps.push(press("Home"));
        chart.blur();
        return steps;
      })()`),
      [
        "X: 1, 1 of 2",
        "X hidden",
        "Y: 2, 1 of 1",
        "Y is the last one shown",
        "",
        "",
        "",
        "X: 1, 1 of 2",
      ],
    );
  });

  test("keeps the focus on a chart item through a theme change and a new rendering", async () => {
    await renderChart(SALES);
    const focus = (await evaluate(`(async () => {
      ${PRESS}
      ${UNTIL}
      const themed = () => document.querySelector('#chart svg path[fill="#123456"]');
      chart.focus();
      press("Home");
      press("ArrowRight");
      press("ArrowDown");
      const root = document.documentElement.style;
      root.setProperty("--vscode-charts-blue", "#123456");
      try {
        await until(themed, "the theme's color", nextFrame);
        // The tooltip follows once ECharts has drawn the chart anew.
        await until(() => /Tue/.test(tooltip()), "the tooltip", nextFrame);
        return {focused: document.activeElement === chart, ring: Boolean(ring()), tooltip: tooltip(),
          next: press("ArrowRight")};
      } finally {
        root.removeProperty("--vscode-charts-blue");
        await until(() => !themed(), "the default color again", nextFrame);
      }
    })()`)) as Record<string, unknown>;
    assert.match(String(focus.tooltip), /Tue.*B/s);
    assert.deepStrictEqual(
      { ...focus, tooltip: undefined },
      { focused: true, ring: true, tooltip: undefined, next: "Wed: 4, series B, 3 of 3" },
    );
    await renderChart(SALES);
    assert.deepStrictEqual(
      await evaluate(`(() => {
        ${PRESS}
        return {focused: document.activeElement === chart, ring: Boolean(ring()), next: press("ArrowLeft")};
      })()`),
      { focused: true, ring: true, next: "Tue: 3, series B, 2 of 3" },
    );
  });

  test("starts the focus at the first item of another chart, not where it was in the last", async () => {
    await renderChart(SALES);
    assert.strictEqual(
      await evaluate(`(() => {
        ${PRESS}
        chart.focus();
        press("Home");
        press("ArrowRight");
        return press("ArrowDown");
      })()`),
      "Tue: 3, series B, 2 of 3",
    );
    // Another title makes another diagram, which keeps the focus and starts it over once drawn.
    await draw({
      language: "echarts",
      source: JSON.stringify({ animation: false, ...SALES }),
      title: "Another",
    });
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        ${PRESS}
        ${UNTIL}
        const status = () => document.getElementById("chart-status").textContent;
        await until(() => status() === "Mon: 1, series A, 1 of 3", "the focus at the first item");
        return {focused: document.activeElement === chart, ring: Boolean(ring()), next: press("ArrowRight")};
      })()`),
      { focused: true, ring: true, next: "Tue: 2, series A, 2 of 3" },
    );
  });

  test("draws a graph in the view coordinate system after a chart that failed", async () => {
    const invalid = await render({
      language: "echarts",
      source: '{"xAxis": null, "yAxis": {}, "series": [{"type": "bar", "data": [1]}]}',
    });
    assert.ok(!invalid.ok);
    assert.match(invalid.error, /needs "xAxis" and "yAxis"/);
    const graph = await render({
      language: "echarts",
      source: JSON.stringify({
        series: [
          {
            type: "graph",
            coordinateSystem: "view",
            layout: "circular",
            data: [{ name: "A" }, { name: "B" }],
            links: [{ source: 0, target: 1 }],
          },
        ],
      }),
    });
    assert.deepStrictEqual(graph, { ok: true, diagramType: "graph" });
  });
});
