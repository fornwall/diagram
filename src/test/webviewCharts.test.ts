import * as assert from "node:assert";
import * as vscode from "vscode";
import { validateAnnotation } from "../annotations";
import { SETTLE_DELAY } from "../webview/echartsRenderer";
import { afterTest, recordMessages } from "./afterTest";
import { DRAG_IMAGE, suitePage, UNTIL } from "./webviewHarness";

/**
 * A chart that counts its draws in `window.chartDraws`: how often each task that drew it did so,
 * which tells what one layout drew apart from what drew it again later.
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
      await draw({ language: "echarts", source: JSON.stringify({ animation: false, ...chart }) });
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
        const settle = async () => {
          for (let frame = 0; frame < 2; frame++) await new Promise(requestAnimationFrame);
        };
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
      assert.deepStrictEqual(dimmed, { marked: true, left: true }, chart.series[0]?.type);
    }
  });

  test("lays out a chart drawn in a hidden tab at an initial size, and for the tab once shown", async () => {
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
    try {
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
          const chart = document.getElementById("chart");
          const svg = chart.querySelector("svg");
          ${UNTIL}
          return until(() => chart.clientWidth > 0 && svg.width.baseVal.value === chart.clientWidth &&
            svg.height.baseVal.value === chart.clientHeight, "the chart to take the size of its container");
        })()`),
        true,
      );
    } finally {
      await evaluate('document.getElementById("view-visual").click()');
    }
  });

  test("reports a chart option it cannot draw as invalid, with the reason", async () => {
    const outcome = await render({
      language: "echarts",
      source: '{"series": [{"type": "map"}]}',
    });
    assert.ok(!outcome.ok && outcome.kind === "invalid");
    assert.match(outcome.error, /unsupported type "map"/);
  });

  test("selects and marks chart names with surrounding spaces without conflating them", async () => {
    await draw({
      language: "echarts",
      source: JSON.stringify({
        animation: false,
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
      }),
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
    await draw({
      language: "echarts",
      source: JSON.stringify({
        animation: false,
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
      }),
    });
    assert.strictEqual(
      await evaluate(`(() => {
        ${CLICK_CHART}
        clickChart(document.querySelectorAll('#chart svg path[fill="#0000ff"]')[2]);
        return document.getElementById("selection-label").textContent;
      })()`),
      "Selected: “A”",
    );
    assert.match(
      page.panel.describeForModel() ?? "",
      /selected these chart items in the panel: "A" \(id: "A \(item 3\)"\)/,
    );
    const ambiguous = page.panel.annotate({ marks: [{ id: "A", kind: "info" }], dim: false });
    assert.ok(ambiguous.ok);
    assert.deepStrictEqual(ambiguous.repeated, [
      { name: "A", ids: ["A (item 1)", "A (item 3)"], count: 2 },
    ]);
    page.panel.annotate({ marks: [{ id: "A (item 3)", kind: "info" }], dim: false });
    assert.strictEqual(await redHalf(), "right");
  });

  test("highlights the right unnamed or slash-named chart series", async () => {
    for (const names of [
      [undefined, undefined],
      ["Sales", "Sales/EU"],
    ]) {
      await draw({
        language: "echarts",
        source: JSON.stringify({
          animation: false,
          series: names.map((name, index) => ({
            name,
            type: "pie",
            center: [index === 0 ? "25%" : "75%", "50%"],
            radius: 30,
            data: [{ name: "A", value: 1 }],
            itemStyle: { color: "#0000ff" },
            emphasis: { scale: false, itemStyle: { color: "#ff0000" } },
          })),
        }),
      });
      page.panel.annotate({
        marks: [{ id: `${names[1] ?? "Series 2"}/A`, kind: "info" }],
        dim: false,
      });
      assert.strictEqual(await redHalf(), "right", `${names[1] ?? "Unnamed"} series`);
    }
  });

  test("clears every selected chart item together", async () => {
    await draw({
      language: "echarts",
      source: JSON.stringify({
        animation: false,
        series: [
          {
            type: "pie",
            data: ["A", "B", "C"].map((name) => ({ name, value: 1 })),
            itemStyle: { color: "#0000ff" },
            select: { itemStyle: { color: "#ff0000" } },
            emphasis: { disabled: true },
          },
        ],
      }),
    });
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
    const empty = "Click chart items to select them (Ctrl/Cmd/Shift+click for several).";
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
      await draw({
        language: "echarts",
        source: JSON.stringify({
          animation: false,
          xAxis: { type: "category", data: ["A", "B"] },
          yAxis: {},
          series: [{ type: "bar", data: [1, 2] }],
          ...extra,
        }),
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
        // Let an earlier layout change, should one still be on its way, resize the chart first.
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

  /** A bar chart whose layout turns its category labels to fit them in, as it does when narrow. */
  const ROTATING_CHART = JSON.stringify({
    animation: false,
    xAxis: { type: "category", data: ["Alpha category", "Beta category"] },
    yAxis: {},
    series: [{ type: "bar", data: [1, 2] }],
  });
  /**
   * Webview code defining `rotated()`, whether the chart's category labels are turned,
   * `rotatesAtOnce()`, whether they turn within a few frames: well before the layout that follows
   * `SETTLE_DELAY` after the size stops changing, and `settled()`, which waits for that layout.
   */
  const ROTATED = `
    const rotated = () => [...document.querySelectorAll("#chart svg text")].some((text) =>
      /^matrix\\((?!1,0,0,1,)/.test(text.getAttribute("transform") ?? ""));
    // Past the layout once the size settled since the chart was drawn, which the resize
    // observer schedules in the frame after the one in which it sees the new drawing.
    const settled = async () => {
      for (let frame = 0; frame < 3; frame++) await nextFrame();
      await new Promise((resolve) => setTimeout(resolve, ${SETTLE_DELAY + 50}));
    };
    const rotatesAtOnce = async () => {
      for (let frame = 0; frame < 5 && !rotated(); frame++) await new Promise(requestAnimationFrame);
      return rotated();
    };`;

  test("lays a chart out for a new size at once, rather than only resizing it", async () => {
    await draw({ language: "echarts", source: ROTATING_CHART });
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        ${CHART_FITTED}
        ${ROTATED}
        const canvas = document.getElementById("canvas");
        await chartFitted();
        await settled();
        const wide = rotated();
        Object.assign(canvas.style, {width: "250px", flex: "none"});
        try {
          return {wide, narrow: await rotatesAtOnce()};
        } finally {
          Object.assign(canvas.style, {width: "", flex: ""});
          await chartFitted();
        }
      })()`),
      { wide: false, narrow: true },
    );
  });

  test("lays a chart out for a new size at once after an image was taken while resizing", async () => {
    await draw({ language: "echarts", source: ROTATING_CHART });
    assert.strictEqual(
      await evaluate(`(async () => {
        ${CHART_FITTED}
        ${ROTATED}
        ${DRAG_IMAGE}
        const canvas = document.getElementById("canvas");
        await chartFitted();
        await settled();
        // The wait for a new size to settle does not end by itself meanwhile, as on a busy machine.
        const original = window.setTimeout;
        window.setTimeout = (handler, delay, ...rest) =>
          original.call(window, handler, delay === ${SETTLE_DELAY} ? 3600000 : delay, ...rest);
        try {
          // An image taken while waiting for a new size to settle, which it lays the chart out
          // for, ends the wait: the next size is again laid out at once.
          Object.assign(canvas.style, {width: "600px", flex: "none"});
          await chartFitted();
          await dragImage();
          canvas.style.width = "250px";
          return await rotatesAtOnce();
        } finally {
          window.setTimeout = original;
          Object.assign(canvas.style, {width: "", flex: ""});
          await chartFitted();
        }
      })()`),
      true,
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

  test("draws a chart once in the colors of a new theme", async () => {
    await draw({ language: "echarts", source: COUNTED_CHART });
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        ${UNTIL}
        const fill = () => document.querySelector("#chart svg path")?.getAttribute("fill");
        const root = document.documentElement.style;
        const before = window.chartDraws.length;
        root.setProperty("--vscode-charts-blue", "#123456");
        try {
          await until(() => fill() === "#123456", "the theme's color", nextFrame);
          // A layout that is not the theme's, still on its way from rendering, draws once too.
          return [...new Set(window.chartDraws.slice(before))];
        } finally {
          root.removeProperty("--vscode-charts-blue");
          await until(() => fill() !== "#123456", "the default color again", nextFrame);
        }
      })()`),
      [1],
    );
  });

  test("reads theme colors written in other CSS color syntaxes", async () => {
    await draw({ language: "echarts", source: COUNTED_CHART });
    assert.strictEqual(
      await evaluate(`(async () => {
        ${UNTIL}
        const fill = () => document.querySelector("#chart svg path")?.getAttribute("fill");
        const root = document.documentElement.style;
        root.setProperty("--vscode-charts-blue", "color(srgb 0.0706 0.2039 0.3373)");
        try {
          await until(() => fill() === "#123456", "the theme's color", nextFrame);
          return fill();
        } finally {
          root.removeProperty("--vscode-charts-blue");
          await until(() => fill() !== "#123456", "the default color again", nextFrame);
        }
      })()`),
      "#123456",
    );
  });

  test("keeps a selected chart item selected through a theme change", async () => {
    await draw({
      language: "echarts",
      source: JSON.stringify({
        animation: false,
        series: [
          {
            type: "pie",
            data: ["A", "B"].map((name) => ({ name, value: 1 })),
            select: { itemStyle: { color: "#ff0000" } },
            emphasis: { disabled: true },
          },
        ],
      }),
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
          await until(() => fills().includes("#123456"), "the theme's color");
          return fills();
        } finally {
          root.removeProperty("--vscode-charts-blue");
          await until(() => !fills().includes("#123456"), "the default color again");
        }
      })()`),
      ["#123456", "#ff0000"],
    );
  });

  /** Renders a chart of the option, without animation. */
  const renderChart = (option: Record<string, unknown>) =>
    draw({ language: "echarts", source: JSON.stringify({ animation: false, ...option }) });
  const SALES = {
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
      for (let frame = 0; frame < 2; frame++) await nextFrame();
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

  test("picks a chart item with the keyboard", async () => {
    await renderChart(SALES);
    const tokens = new vscode.CancellationTokenSource();
    const picking = page.panel.pickNodes("Pick a day", false, tokens.token);
    await evaluate(`(async () => {
      ${PRESS}
      ${UNTIL}
      await until(() => !document.getElementById("pick").hidden, "the pick prompt");
      press("Home");
      press("ArrowRight");
      press("Enter");
    })()`);
    assert.deepStrictEqual(await picking, {
      picked: true,
      nodes: [{ id: "A/Tue", label: "Tue" }],
    });
    tokens.dispose();
  });

  test("gives the keys to the chart, not the canvas, on a pick and after it or Clear", async () => {
    await renderChart(SALES);
    const tokens = new vscode.CancellationTokenSource();
    const picking = page.panel.pickNodes("Pick days", true, tokens.token);
    const focus = await evaluate(`(async () => {
      ${PRESS}
      ${UNTIL}
      // VS Code, revealing the panel for the pick, may take the focus out of the page meanwhile.
      await until(() => !document.getElementById("pick").hidden && document.activeElement === chart,
        "the pick prompt, with the focus on the chart");
      const canvas = document.getElementById("canvas");
      const focus = () => [document.activeElement === chart, chart.getAttribute("aria-describedby")];
      // As VS Code focuses the panel: the focus leaves the page, and comes back to the page alone.
      chart.blur();
      window.dispatchEvent(new FocusEvent("focus"));
      const picking = focus();
      press("Home");
      press("Enter");
      const done = document.getElementById("pick-done");
      done.focus();
      done.click();
      const picked = focus();
      press("Enter");
      const clear = document.getElementById("clear-selection");
      clear.focus();
      clear.click();
      return {canvas: [canvas.tabIndex, canvas.getAttribute("aria-label")], picking, picked,
        cleared: focus()};
    })()`);
    assert.deepStrictEqual(await picking, { picked: true, nodes: [{ id: "A/Mon", label: "Mon" }] });
    tokens.dispose();
    assert.deepStrictEqual(focus, {
      canvas: [-1, "Chart preview"],
      picking: [true, "pick-prompt chart-drawing"],
      picked: [true, "chart-drawing"],
      cleared: [true, "chart-drawing"],
    });
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
