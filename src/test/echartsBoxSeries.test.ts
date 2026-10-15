import * as assert from "node:assert";
import { modelOf } from "../webview/echartsItems";
import { disableAnimation } from "../webview/echartsLayout";
import { layout, type Option, svgOf, widthOf, withChart } from "./echartsModel";

suite("echartsBoxSeries", () => {
  test("labels the nodes of a tree beside them, rather than over them and their lines", () => {
    const tree = (extra: Option = {}) =>
      layout({
        series: [
          {
            type: "tree",
            data: [{ name: "root", children: [{ name: "leaf" }] }],
            ...extra,
          },
        ],
      }).series[0];
    const beside = (position: string, align: string) => ({
      position,
      align,
      verticalAlign: "middle",
      // Onto lines past 40% of the width, as the leaves are far enough apart.
      width: 800 * 0.4 - 12,
      overflow: "break",
    });
    const laidOut = tree();
    // Before the nodes with children, toward the root, and after the leaves.
    assert.deepStrictEqual(
      [laidOut.label, laidOut.leaves.label],
      [beside("left", "right"), beside("right", "left")],
    );
    const svg = svgOf({ series: [laidOut] });
    assert.match(svg, /text-anchor="end"[^>]*>root</);
    assert.match(svg, /text-anchor="start"[^>]*>leaf</);
    const mirrored = tree({ orient: "RL", leaves: { label: { color: "red" } } });
    assert.deepStrictEqual(
      [mirrored.label, mirrored.leaves.label],
      [beside("right", "left"), { ...beside("left", "right"), color: "red" }],
    );
    // Cut short where the leaves are too close for lines.
    const leaves = Array.from({ length: 40 }, (_, index) => ({ name: `leaf ${index}` }));
    assert.strictEqual(
      tree({ data: [{ name: "root", children: leaves }] }).leaves.label.overflow,
      "truncate",
    );
    // Not placed by the option, nor from the top down or around the root.
    assert.deepStrictEqual(tree({ label: { position: "top" } }).label, { position: "top" });
    for (const extra of [{ orient: "TB" }, { layout: "radial" }]) {
      assert.strictEqual(tree(extra).label, undefined, JSON.stringify(extra));
    }
  });

  test("keeps series laid out in a box clear of the title, with room for their labels", () => {
    const box = (type: string, extra: Option = {}) => {
      const { top, left, right, bottom } = layout({
        title: { text: "T" },
        series: [{ type, ...extra }],
      }).series[0];
      return [top, left, right, bottom];
    };
    assert.deepStrictEqual(box("treemap"), [44, 12, 12, 36]);
    assert.deepStrictEqual(box("treemap", { breadcrumb: { show: false } }), [44, 12, 12, 12]);
    assert.deepStrictEqual(box("treemap", { breadcrumb: { top: 40 } }), [68, 12, 12, 12]);
    assert.deepStrictEqual(box("treemap", { breadcrumb: { top: "top" } }), [68, 12, 12, 12]);
    assert.deepStrictEqual(box("treemap", { breadcrumb: { top: "90%" } }), [44, 12, 12, 36]);
    assert.deepStrictEqual(box("treemap", { breadcrumb: { top: "middle" } }), [44, 12, 12, 12]);
    assert.deepStrictEqual(box("tree"), [44, 96, 96, 12]);
    // The labels at the ends of a tree, of its root and of the deepest level it shows, which
    // the panel places beside their nodes: the leaves' after them.
    const leaf = "a leaf with a long name, and on";
    const tree = {
      data: [
        { name: "root", children: [{ name: "a", children: [{ name: leaf }] }, { name: "b" }] },
      ],
    };
    const whole = Math.round(widthOf(leaf) + 12);
    assert.deepStrictEqual(box("tree", tree), [44, 96, whole, 12]);
    assert.deepStrictEqual(box("tree", { ...tree, orient: "RL" }), [44, whole, 96, 12]);
    // Centered on their nodes, half of them.
    const half = Math.round(widthOf(leaf) / 2 + 12);
    assert.deepStrictEqual(box("tree", { ...tree, label: { position: "inside" } }), [
      44,
      96,
      Math.max(96, half),
      12,
    ]);
    const right = { leaves: { label: { position: "right" } } };
    assert.deepStrictEqual(box("tree", { ...tree, ...right }), [44, 96, whole, 12]);
    assert.deepStrictEqual(box("tree", { ...tree, ...right, orient: "RL" }), [44, 96, 96, 12]);
    const left = { leaves: { label: { position: "left" } }, orient: "RL" };
    assert.deepStrictEqual(box("tree", { ...tree, ...left }), [44, whole, 96, 12]);
    // Deeper than it shows, or laid out around its root.
    assert.deepStrictEqual(
      box("tree", { ...tree, ...right, initialTreeDepth: 1 }),
      [44, 96, 96, 12],
    );
    assert.deepStrictEqual(box("tree", { ...tree, ...right, layout: "radial" }), [44, 96, 96, 12]);
    assert.deepStrictEqual(box("funnel"), [44, 80, 80, 12]);
    // A funnel's labels beside it on the right, unless placed otherwise, as long as they are.
    const stages = {
      data: [
        { name: "Visited the product page", value: 3 },
        { name: "Paid", value: 3 },
      ],
    };
    const room = Math.round(widthOf("Visited the product page") + 33);
    assert.deepStrictEqual(box("funnel", stages), [44, 80, room, 12]);
    // Less, of a label beside a narrower stage, which ECharts starts further in.
    const narrower = {
      data: [
        { name: "Paid", value: 3 },
        { name: "Visited the product page", value: 1 },
      ],
    };
    assert.ok(box("funnel", narrower)[2] < room);
    assert.deepStrictEqual(box("funnel", { ...stages, label: { position: "leftTop" } }), [
      44,
      room,
      80,
      12,
    ]);
    assert.deepStrictEqual(
      box("funnel", { ...stages, label: { position: "inside" } }),
      [44, 80, 80, 12],
    );
    assert.deepStrictEqual(
      box("funnel", { ...stages, label: { formatter: "{b}: {c}" }, labelLine: { length: 10 } }),
      [44, 80, Math.round(widthOf("Visited the product page: 000.00") + 23), 12],
    );
    assert.deepStrictEqual(box("sankey"), [44, 12, 144, 12]);
    assert.deepStrictEqual(box("chord"), [44, 12, 12, 12]);
  });

  test("fits a graph of placed nodes into the space left, as ECharts fits it to the chart", () => {
    const option = layout({
      title: { text: "T" },
      legend: {},
      series: [
        {
          type: "graph",
          data: [
            { name: "A", x: 0, y: 0 },
            { name: "Bee", x: 300, y: 200 },
          ],
        },
      ],
    });
    // Drawn by ECharts, the nodes keep their aspect, below the title and left of the legend.
    const points = withChart(
      option,
      (chart) => {
        const view = (modelOf(chart).getSeriesByIndex(0) as unknown as Option).coordinateSystem;
        return [...view.dataToPoint([0, 0]), ...view.dataToPoint([300, 200])];
      },
      { width: 800, height: 500 },
    );
    const [ax = 0, ay = 0, bx = 0, by = 0] = points;
    const { top, right } = option.series[0];
    assert.ok(Math.abs((bx - ax) / (by - ay) - 1.5) < 0.01, String(points));
    assert.ok(top > 32 && right > 100, `${top} ${right}`);
    assert.ok(ay >= top && by <= 500 && ax >= 0 && bx <= 800 - right, String(points));
    // Nodes in another coordinate system, or a box of the option's own, stay as they are.
    for (const series of [{ coordinateSystem: "cartesian2d" }, { left: 0 }]) {
      const placed = layout({ title: { text: "T" }, series: [{ type: "graph", ...series }] });
      assert.strictEqual(placed.series[0].top, undefined);
    }
  });

  test("places the nodes of a force layout at rest, the same each time, all in the chart", () => {
    const names = ["extension", "panel", "participant", "tools", "prompt", "charts", "protocol"];
    const pairs = [
      [0, 1],
      [0, 2],
      [2, 4],
      [2, 3],
      [3, 5],
      [1, 6],
      [3, 6],
    ];
    const graph = (nodes: string[], links: number[][], extra: Option = {}): Option => ({
      title: { text: "Modules" },
      series: [
        {
          type: "graph",
          layout: "force",
          label: { show: true, position: "right" },
          data: nodes.map((name, index) => ({ name, symbolSize: 10 + (index % 3) * 10 })),
          links: links.map(([source = 0, target = 0]) => ({
            source: nodes[source],
            target: nodes[target],
          })),
          ...extra,
        },
      ],
    });
    const modules = graph(names, pairs);
    const chain = graph(
      Array.from({ length: 12 }, (_, index) => `a-rather-long-module-${index}`),
      Array.from({ length: 11 }, (_, index) => [index, index + 1]),
    );
    const loose = graph(["one", "two", "three", "four", "five"], []);
    for (const option of [modules, chain, loose]) {
      for (const { width, height } of [
        { width: 404, height: 575 },
        { width: 1184, height: 675 },
      ]) {
        const laidOut = layout(option, { width, height });
        disableAnimation(laidOut);
        const [series] = laidOut.series;
        // Placed, for ECharts to draw where they are.
        assert.strictEqual(series.layout, "none");
        assert.ok(series.data.every((node: Option) => Number.isFinite(node.x + node.y)));
        // Nodes, links and labels are drawn within the chart.
        const outside = withChart(
          laidOut,
          (chart) =>
            (chart.getZr().storage.getDisplayList(true) as Option[]).filter((element) => {
              let owner: Option | undefined;
              for (let at = element; at && !owner; at = at.__hostTarget ?? at.parent) {
                owner = at.__ecComponentInfo;
              }
              const box = element.getBoundingRect().clone();
              box.applyTransform(element.getComputedTransform());
              return (
                owner?.mainType === "series" &&
                (box.x < -1 ||
                  box.y < -1 ||
                  box.x + box.width > width + 1 ||
                  box.y + box.height > height + 1)
              );
            }).length,
          { width, height },
        );
        assert.strictEqual(outside, 0, `${series.data[0].name} at ${width}x${height}`);
      }
    }
    // The same each time, and placed once for the same nodes and links, without changing them.
    const [first, again] = [layout(modules), layout(modules)].map((each) => each.series[0].data);
    assert.strictEqual(first, again);
    assert.strictEqual(modules.series[0].data[0].x, undefined);
    // By the option's edge length and repulsion, as ECharts' force layout would be.
    const placedBy = (force: Option) =>
      layout(graph(names, pairs, { force })).series[0].data.map(({ x }: Option) => x);
    assert.notDeepStrictEqual(placedBy({ repulsion: 80 }), placedBy({ repulsion: 800 }));
  });

  test("spreads the nodes of a force layout it does not place over the space there is", () => {
    const graph = (count: number, force?: Option, node: Option = {}) => ({
      series: [
        {
          type: "graph",
          layout: "force",
          ...(force && { force }),
          data: Array.from({ length: count }, (_, index) => ({ name: `N${index}`, ...node })),
        },
      ],
    });
    // A layout that the option starts or animates itself, or of nodes it places.
    const force = (count: number, size: { width: number; height: number }) =>
      layout(graph(count, { layoutAnimation: true }), size).series[0].force;
    // Longer edges for fewer nodes and more room, and repulsion to match.
    const few = force(4, { width: 1200, height: 800 });
    assert.ok(few.edgeLength > 150 && few.repulsion > 1000, JSON.stringify(few));
    const narrow = force(4, { width: 360, height: 400 });
    assert.ok(narrow.edgeLength < few.edgeLength && narrow.edgeLength > 60, JSON.stringify(narrow));
    assert.ok(layout(graph(250), { width: 360, height: 400 }).series[0].force.edgeLength < 30);
    for (const placed of [graph(4, { initLayout: "circular" }), graph(4, {}, { x: 1, y: 2 })]) {
      assert.strictEqual(layout(placed).series[0].layout, "force");
    }
    assert.deepStrictEqual(layout(graph(4, { repulsion: 80, friction: 0.3 })).series[0].force, {
      repulsion: 80,
      friction: 0.3,
    });
    // Nor of a graph whose nodes the steps of a timeline give, which ECharts merges over those of
    // the base option.
    const nodes = (prefix: string) => ["A", "B", "C"].map((name) => ({ name: `${prefix}${name}` }));
    const stepped = layout({
      baseOption: {
        timeline: { data: ["2025", "2026"] },
        series: [{ type: "graph", layout: "force", data: nodes("") }],
      },
      options: [{ series: [{ data: nodes("") }] }, { series: [{ data: nodes("next ") }] }],
    });
    assert.strictEqual(stepped.baseOption.series[0].layout, "force");
    const drawn = withChart(stepped, (chart) => {
      const data = (modelOf(chart).getSeriesByIndex(0) as Option).getData();
      return Array.from({ length: data.count() }, (_, index) => data.getItemLayout(index));
    });
    assert.ok(drawn.length === 3 && drawn.flat().every(Number.isFinite), JSON.stringify(drawn));
  });
});
