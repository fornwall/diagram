import * as assert from "node:assert";
import { validateAnnotation } from "../annotations";
import type { Diagram } from "../panel";
import { DRAG_IMAGE, MERMAID, suitePage, UNTIL } from "./webviewHarness";

suite("images in the webview", function () {
  // The first render loads the webview and the libraries, which can take a while.
  this.timeout(20_000);

  const page = suitePage();
  const { evaluate, draw } = page;

  test("exports chart dimensions while its rendering is hidden in Source view", async () => {
    await draw({
      language: "echarts",
      source: '{"series": [{"type": "pie", "data": [1, 2]}]}',
    });
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        const chart = document.querySelector("#chart svg");
        const width = chart.width.baseVal.value;
        const height = chart.height.baseVal.value;
        document.getElementById("view-source").click();
        try {
          ${DRAG_IMAGE}
          const svg = (await dragImage()).getData("image/svg+xml");
          const image = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
          return {
            hidden: chart.getBoundingClientRect().width === 0,
            sized: width > 0 && height > 0 && Number(image.getAttribute("width")) === width &&
              Number(image.getAttribute("height")) === height,
            viewBox: image.getAttribute("viewBox") === "0 0 " + width + " " + height
          };
        } finally {
          document.getElementById("view-visual").click();
        }
      })()`),
      { hidden: true, sized: true, viewBox: true },
    );
  });

  test("exports complete chart items while their entrance animations are pending", async () => {
    const option = {
      animation: true,
      animationDelay: 60_000,
      xAxis: { type: "category", data: ["A", "B"] },
      yAxis: {},
      series: [{ type: "bar", data: [10, 20], itemStyle: { color: "#123456" } }],
    };
    const paths: unknown[] = [];
    for (const animation of [true, false]) {
      await draw({ language: "echarts", source: JSON.stringify({ ...option, animation }) });
      paths.push(
        await evaluate(`(async () => {
          ${DRAG_IMAGE}
          const svg = (await dragImage({shiftKey: true})).getData("image/svg+xml");
          const image = new DOMParser().parseFromString(svg, "image/svg+xml");
          return [...image.querySelectorAll('path[fill="#123456"]')].map(path => path.getAttribute("d"));
        })()`),
      );
    }
    assert.ok(Array.isArray(paths[1]) && paths[1].length === 2);
    assert.deepStrictEqual(paths[0], paths[1]);
  });

  test("exports chart labels that are still fading in", async () => {
    await draw({
      language: "echarts",
      source: JSON.stringify({
        animationDuration: 60_000,
        series: [{ type: "pie", data: [{ name: "Fading label", value: 1 }] }],
      }),
    });
    const labels = await evaluate(`(async () => {
      ${DRAG_IMAGE}
      const svg = (await dragImage({shiftKey: true})).getData("image/svg+xml");
      const image = new DOMParser().parseFromString(svg, "image/svg+xml");
      return [...image.querySelectorAll("text")].map(text =>
        text.textContent + " " + (text.getAttribute("fill-opacity") ?? text.getAttribute("opacity") ?? 1));
    })()`);
    assert.deepStrictEqual(labels, ["Fading label 1"]);
  });

  test("leaves out of chart images what the pointer shows on the chart", async () => {
    await draw({
      language: "echarts",
      source: JSON.stringify({
        animation: false,
        tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
        xAxis: { type: "category", data: ["A", "B"] },
        yAxis: {},
        series: [
          {
            type: "bar",
            data: [10, 20],
            itemStyle: { color: "#0000ff" },
            emphasis: { itemStyle: { color: "#ff0000" } },
          },
        ],
      }),
    });
    page.panel.annotate(validateAnnotation({ marks: [{ id: "A" }] }));
    const images = await evaluate(`(async () => {
      ${DRAG_IMAGE}
      ${UNTIL}
      // What is drawn, without the ids that ECharts numbers anew in each drawing.
      const image = async () => (await dragImage({shiftKey: true})).getData("image/svg+xml")
        .replace(/ (id|clip-path)="[^"]*"/g, "");
      const red = () => document.querySelectorAll('#chart svg path[fill="#ff0000"]').length;
      const marked = await until(() => red() === 1);
      const before = await image();
      // As when exporting from the context menu by keyboard, with the pointer left on the chart.
      const bar = document.querySelectorAll('#chart svg path[fill="#0000ff"]')[0];
      const box = bar.getBoundingClientRect();
      bar.dispatchEvent(new MouseEvent("mousemove", {bubbles: true,
        clientX: box.x + box.width / 2, clientY: box.y + box.height / 2}));
      const hovered = await until(() => red() === 2);
      return {marked, hovered, same: (await image()) === before};
    })()`);
    assert.deepStrictEqual(images, { marked: true, hovered: true, same: true });
  });

  test("leaves the toolbox out of chart images, but not out of the panel", async () => {
    const chart = {
      animation: false,
      xAxis: { type: "category", data: ["A", "B"] },
      yAxis: {},
      series: [{ type: "bar", data: [1, 2] }],
    };
    const drawn = [];
    for (const toolbox of [undefined, { feature: { saveAsImage: {}, restore: {} } }]) {
      await draw({ language: "echarts", source: JSON.stringify({ ...chart, toolbox }) });
      drawn.push(
        await evaluate(`(async () => {
          ${DRAG_IMAGE}
          const svg = (await dragImage({shiftKey: true})).getData("image/svg+xml");
          const image = new DOMParser().parseFromString(svg, "image/svg+xml");
          await new Promise(requestAnimationFrame);
          return {
            image: image.querySelectorAll("path").length,
            panel: document.querySelectorAll("#chart svg path").length,
          };
        })()`),
      );
    }
    const [plain, withToolbox] = drawn as { image: number; panel: number }[];
    assert.strictEqual(withToolbox?.image, plain?.image);
    assert.ok((withToolbox?.panel ?? 0) > (plain?.panel ?? 0));
  });

  test("exports the current chart size before the resize observer runs", async () => {
    await draw({
      language: "echarts",
      source: '{"series": [{"type": "pie", "data": [1, 2]}]}',
    });
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        const chart = document.getElementById("chart");
        try {
          chart.style.width = "321px";
          chart.style.height = "234px";
          const expected = [chart.clientWidth, chart.clientHeight];
          ${DRAG_IMAGE}
          const svg = (await dragImage({shiftKey: true})).getData("image/svg+xml");
          const image = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
          return {expected, actual: [Number(image.getAttribute("width")), Number(image.getAttribute("height"))]};
        } finally {
          chart.style.width = "";
          chart.style.height = "";
        }
      })()`),
      { expected: [321, 234], actual: [321, 234] },
    );
  });

  const svgDrags = {
    "the browser cannot create a PNG": [
      "null",
      "Dragging the drawing as SVG, as the PNG failed: The browser could not create a PNG at this image size.",
    ],
    // Chromium does not download a file to drop from a data URL of over 2 MB.
    "the PNG is too large to drop": [
      'new Blob([new Uint8Array(1_600_000)], {type: "image/png"})',
      "The PNG is too large to drop as a file. Dragging the drawing as SVG instead.",
    ],
  };
  for (const [name, [blob, hint]] of Object.entries(svgDrags)) {
    test(`drags SVG and says why when ${name}`, async () => {
      await draw({
        language: "echarts",
        source: '{"series": [{"type": "pie", "data": [1, 2]}]}',
        // Which names the file after what it is.
        title: "",
      });
      const download = (await evaluate(`(async () => {
        const original = HTMLCanvasElement.prototype.toBlob;
        HTMLCanvasElement.prototype.toBlob = (callback) => callback(${blob});
        const label = document.getElementById("selection-label");
        try {
          ${DRAG_IMAGE}
          ${UNTIL}
          // Without Shift, which an earlier drag may have held, to ask for a PNG.
          let dataTransfer = await dragImage({shiftKey: false});
          await until(() => {
            dataTransfer = new DataTransfer();
            document.getElementById("drag-out")
              .dispatchEvent(new DragEvent("dragstart", {dataTransfer, cancelable: true}));
            return label.textContent === ${JSON.stringify(hint)};
          });
          return {url: dataTransfer.getData("DownloadURL"), hint: label.textContent};
        } finally {
          HTMLCanvasElement.prototype.toBlob = original;
        }
      })()`)) as { url: string; hint: string };
      assert.match(download.url, /^image\/svg\+xml:chart\.svg:data:image\/svg\+xml/);
      assert.strictEqual(download.hint, hint);
    });
  }

  test("keeps SVG export and rendering available while PNG decoding stalls", async () => {
    await draw({
      language: "echarts",
      source:
        '{"animation": false, "series": [{"type": "pie", "data": [{"name": "Original", "value": 1}]}]}',
    });
    assert.deepStrictEqual(
      await evaluate(`(async () => {
      const original = HTMLImageElement.prototype.decode;
      let release;
      let decoding = false;
      const pending = new Promise(resolve => { release = resolve; });
      HTMLImageElement.prototype.decode = function () {
        decoding = true;
        return pending.then(() => original.call(this));
      };
      const handle = document.getElementById("drag-out");
      ${UNTIL}
      try {
        handle.dispatchEvent(new PointerEvent("pointerenter"));
        await until(() => decoding);
        const dataTransfer = new DataTransfer();
        handle.dispatchEvent(new DragEvent("dragstart", {dataTransfer, cancelable: true}));
        const svgAvailable = dataTransfer.getData("image/svg+xml").includes("Original");
        window.dispatchEvent(new MessageEvent("message", {data: {
          type: "render", language: "echarts", requestId: -1, title: "Incoming",
          source: JSON.stringify({animation: false, series: [{type: "pie", data: [{name: "Incoming", value: 1}]}]})
        }}));
        const rendered = await until(() =>
          document.querySelector("#chart svg")?.textContent.includes("Incoming"));
        return {svgAvailable, rendered};
      } finally {
        HTMLImageElement.prototype.decode = original;
        release();
      }
    })()`),
      { svgAvailable: true, rendered: true },
    );
  });

  test("exports Mermaid images that draw the same without their style sheets", async () => {
    const sources = [
      ...Object.values(MERMAID),
      // Classes, styles of nodes and edges, and an animated edge, which keeps its keyframes.
      `flowchart LR
        A e1@--> B --> C
        e1@{ animate: true }
        classDef hot fill:#f96,stroke:#333,stroke-width:4px
        class B hot
        style C fill:#bbf,stroke-dasharray: 5 5
        linkStyle 1 stroke:#ff3`,
      // Hollow arrowheads, which Mermaid fills in a transparent color.
      "classDiagram\n  Animal o-- Leg\n  Animal <|-- Duck",
    ];
    for (const source of sources) {
      await draw({ source });
      const drawn = (await evaluate(`(async () => {
        ${DRAG_IMAGE}
        const svg = (await dragImage({shiftKey: true})).getData("image/svg+xml");
        const pixels = async (markup) => {
          const image = new Image();
          image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(markup);
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext("2d");
          context.drawImage(image, 0, 0);
          return context.getImageData(0, 0, canvas.width, canvas.height).data;
        };
        const styled = await pixels(svg);
        const unstyled = await pixels(svg.replace(/<style[^]*?<\\/style>/g, ""));
        return {
          same: styled.every((value, index) => value === unstyled[index]),
          // Such as a quoted url() or a transparent color, which not every application reads.
          portable: !/url\\("|rgba\\(/.test(svg),
          // A style sheet is left only for the keyframes of an animation.
          keyframes: /<style>@keyframes/.test(svg) === svg.includes("animation-name"),
        };
      })()`)) as { same: boolean; portable: boolean; keyframes: boolean };
      assert.deepStrictEqual(drawn, { same: true, portable: true, keyframes: true }, source);
    }
  });

  test("exports Mermaid labels as SVG text despite diagram configuration", async () => {
    const exported = async (source: string) => {
      await draw({ source });
      return evaluate(`(async () => {
        ${DRAG_IMAGE}
        const svg = (await dragImage()).getData("image/svg+xml");
        const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
        return {
          htmlLabels: parsed.querySelectorAll("foreignObject").length,
          text: Array.from(parsed.querySelectorAll("text"), node => node.textContent).join("").replace(/\\s/g, "")
        };
      })()`);
    };
    assert.deepStrictEqual(
      await exported(
        "---\nconfig:\n  htmlLabels: true\n---\nflowchart LR\n A[Exported label] --> B[Other label]",
      ),
      { htmlLabels: 0, text: "ExportedlabelOtherlabel" },
    );
    // User journeys draw task names as HTML with a text fallback.
    const journey = (await exported("journey\n  section Work\n    Brew tea: 5: Me")) as {
      htmlLabels: number;
      text: string;
    };
    assert.strictEqual(journey.htmlLabels, 0);
    assert.match(journey.text, /Brewtea/);
  });

  test("exports text fallbacks of Mermaid labels in the colors of their labels", async () => {
    await draw({ source: "journey\n  section Work\n    Brew tea: 5: Me" });
    const colors = await evaluate(`(async () => {
      const shown = document.querySelector("#diagram switch .label");
      ${DRAG_IMAGE}
      const host = document.createElement("div");
      host.innerHTML = (await dragImage()).getData("image/svg+xml");
      document.body.append(host);
      try {
        const text = Array.from(host.querySelectorAll("switch > text"))
          .find(text => text.textContent === shown.textContent);
        return {
          label: getComputedStyle(shown).color,
          text: getComputedStyle(text).fill,
          box: getComputedStyle(text.closest("g").querySelector("rect")).fill,
        };
      } finally {
        host.remove();
      }
    })()`);
    const { label, text, box } = colors as Record<string, string>;
    assert.strictEqual(text, label);
    assert.notStrictEqual(text, box);
  });

  test("centers Mermaid labels that Mermaid leaves to CSS, in images and in the panel", async () => {
    // Mermaid starts these labels at the middle of the node, or at the left of a state's least
    // width, for CSS that only flowcharts have.
    for (const source of [
      "mindmap\n  root((Central idea with long text))\n    sq[Square node text]\n    hx{{Hexagon node text}}\n    Default node text",
      'usecase-beta\n  actor Customer\n  Customer --> "Place an order with a long name"',
      "flowchart LR\n  A((Circle label)) --> B[Rectangle label]",
      'stateDiagram-v2\n  [*] --> Idle\n  state "A state with a long name" as Long\n  Idle --> Long',
    ]) {
      await draw({ source });
      const offCenter = await evaluate(`(async () => {
        ${DRAG_IMAGE}
        const host = document.createElement("div");
        host.innerHTML = (await dragImage()).getData("image/svg+xml");
        document.body.append(host);
        const center = (box) => (box.left + box.right) / 2;
        const problems = Array.from(host.querySelectorAll("g.node:has(text)"), node => {
          const text = node.querySelector("text").getBoundingClientRect();
          const shape = node.querySelector(":scope > :is(circle, ellipse, path, polygon, rect)").getBoundingClientRect();
          // Mermaid itself places some labels, like those under use case actors, a few pixels off.
          return Math.abs(center(text) - center(shape)) > 8 ? node.textContent : undefined;
        }).filter(Boolean);
        host.remove();
        return problems;
      })()`);
      assert.deepStrictEqual(offCenter, [], source);
    }
    // The panel too, for a diagram that asks for SVG labels.
    await draw({
      source:
        "---\nconfig:\n  htmlLabels: false\n---\nmindmap\n  root((Central idea with long text))",
    });
    const offset = await evaluate(`(() => {
      const node = document.querySelector("#diagram g.node:has(text)");
      const [text, shape] = [node.querySelector("text"), node.querySelector("circle")].map(e => e.getBoundingClientRect());
      return Math.round(Math.abs(text.left + text.right - shape.left - shape.right) / 2);
    })()`);
    assert.ok((offset as number) <= 8, `${offset}`);
  });

  test("exports well-formed XML whatever the labels hold", async () => {
    const drawings: [Partial<Diagram>, string][] = [
      // HTML labels, which formulas keep, with a line break and a no-break space.
      ['flowchart LR\n  A["$$x^2$$"] --> B["one<br>two&nbsp;three"]', "two three"],
      ["sequenceDiagram\n  A->>B: $$x^2$$\n  B->>A: one<br/>two three", "two three"],
      // Control characters, which XML does not allow even as references.
      ['flowchart LR\n  A["one\u0001two"] --> B', "onetwo"],
    ].map(([source, text]) => [{ source }, text] as [Partial<Diagram>, string]);
    drawings.push([
      {
        language: "echarts",
        source: '{"series": [{"type": "pie", "data": [{"name": "one\\u0001two", "value": 1}]}]}',
      },
      "onetwo",
    ]);
    for (const [drawing, text] of drawings) {
      await draw(drawing);
      const image = await evaluate(`(async () => {
        ${DRAG_IMAGE}
        const svg = (await dragImage({shiftKey: true})).getData("image/svg+xml");
        const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
        return {
          error: parsed.querySelector("parsererror")?.textContent ?? null,
          text: parsed.documentElement.textContent.includes(${JSON.stringify(text)}),
        };
      })()`);
      assert.deepStrictEqual(image, { error: null, text: true }, drawing.source);
    }
  });

  test("exports the text of HTML in Mermaid labels, without its tags", async () => {
    const source = [
      "flowchart LR",
      '  A["<b>Bold</b> and <i>italic</i>"] -->|"<u>edge</u>"| B["<a href=\'https://example.com\'>Link</a>"]',
      '  B --> C["First<br>second"]',
      "  C --> D[\"1 &lt; 2 <span style='color: red'>red</span>\"]",
    ].join("\n");
    await draw({ source });
    const exported = await evaluate(`(async () => {
      ${DRAG_IMAGE}
      const image = (await dragImage()).getData("image/svg+xml");
      const parsed = new DOMParser().parseFromString(image, "image/svg+xml");
      return Array.from(parsed.querySelectorAll("text"), text =>
        Array.from(text.querySelectorAll(".text-outer-tspan"), line => line.textContent.replace(/\\s+/g, " ").trim()).join("|"));
    })()`);
    assert.deepStrictEqual(exported, [
      "edge",
      "Bold and italic",
      "Link",
      "First|second",
      "1 < 2 red",
    ]);
  });

  test("shows formulas whole, beyond the boxes Mermaid sizes to their line boxes", async () => {
    // Italic letters and limits draw beyond those boxes, which would clip them.
    await draw({ source: "sequenceDiagram\n  A->>B: $$\\sum_{i=1}^{n} x_i$$" });
    const overflow = await evaluate(`(async () => {
      const shown = getComputedStyle(document.querySelector("#diagram foreignObject")).overflow;
      ${DRAG_IMAGE}
      const host = document.createElement("div");
      host.innerHTML = (await dragImage()).getData("image/svg+xml");
      document.body.append(host);
      const exported = Array.from(host.querySelectorAll("foreignObject"), box => getComputedStyle(box).overflow);
      host.remove();
      return {shown, exported};
    })()`);
    assert.deepStrictEqual(overflow, { shown: "visible", exported: ["visible"] });
  });

  test("draws formulas as in the panel, also in images and in participant boxes", async () => {
    const sources = [
      'flowchart LR\n  A["$$x^2$$"] -->|"$$\\alpha$$"| B[Plain]',
      "stateDiagram-v2\n  s1 : $$\\sqrt{x}$$\n  s1 --> s2 : $$\\beta$$",
      'classDiagram\n  class C["$$\\gamma$$"]\n  C <|-- D : $$\\delta$$',
      // Mermaid leaves the labels of both boxes of the participant empty.
      "sequenceDiagram\n  participant A as $$\\alpha_1$$\n  A->>B: $$\\int x$$",
    ];
    for (const source of sources) {
      await draw({ source });
      const formulas = await evaluate(`(async () => {
        const formulas = root => Array.from(root.querySelectorAll("math"), math => math.textContent).sort();
        const shown = formulas(document.querySelector("#diagram svg"));
        ${DRAG_IMAGE}
        const image = (await dragImage()).getData("image/svg+xml");
        const parsed = new DOMParser().parseFromString(image, "image/svg+xml");
        // A formula's text fallback in a switch is its TeX.
        const tex = Array.from(parsed.querySelectorAll("text"))
          .some(text => !text.closest("switch") && text.textContent.includes("$$"));
        return {shown, exported: formulas(parsed), tex};
      })()`);
      const expected = (
        {
          "flowchart LR": ["x2", "α"],
          "stateDiagram-v2": ["β", "x"],
          classDiagram: ["δ", "γ"],
          sequenceDiagram: ["α1", "α1", "∫x"],
        }[source.split("\n")[0] as string] as string[]
      ).sort();
      assert.deepStrictEqual(formulas, { shown: expected, exported: expected, tex: false }, source);
    }
  });

  test("gives each Mermaid image its own ids, which its styles and arrowheads go by", async () => {
    const ids: { id: string; scoped: boolean }[] = [];
    // Drawn again, as the same diagram in another session would be.
    for (const _ of [1, 2]) {
      await draw({ source: "flowchart LR\n A --> B" });
      const svg = (await evaluate(`(async () => {
        ${DRAG_IMAGE}
        return (await dragImage()).getData("image/svg+xml");
      })()`)) as string;
      const id = /<svg[^>]* id="([^"]+)"/.exec(svg)?.[1] ?? "";
      const references = [...svg.matchAll(/url\(#([^)]+)\)/g)].map((match) => match[1] ?? "");
      ids.push({
        id,
        scoped: references.length > 0 && references.every((name) => name.startsWith(id)),
      });
    }
    assert.deepStrictEqual(
      ids.map(({ scoped }) => scoped),
      [true, true],
    );
    assert.notStrictEqual(ids[0]?.id, ids[1]?.id);
  });

  test("keeps a prepared Mermaid image across hovers, but takes a chart's again", async () => {
    const images = [];
    for (const diagram of [
      { source: "flowchart LR\n A[Kept] --> B" },
      { language: "echarts" as const, source: '{"series": [{"type": "pie", "data": [1, 2]}]}' },
    ]) {
      await draw(diagram);
      images.push(
        await evaluate(`(async () => {
          const original = XMLSerializer.prototype.serializeToString;
          let images = 0;
          XMLSerializer.prototype.serializeToString = function (node) {
            if (node.localName === "svg") images++;
            return original.call(this, node);
          };
          try {
            ${DRAG_IMAGE}
            await dragImage();
            await dragImage();
            return images;
          } finally {
            XMLSerializer.prototype.serializeToString = original;
          }
        })()`),
      );
    }
    assert.deepStrictEqual(images, [1, 2]);
  });

  test("keeps Mermaid image export separate from an incoming render", async () => {
    await draw({ source: "flowchart LR\n A[Original label] --> B" });
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        let exported;
        // The image is drawn where Mermaid lays out its drawings.
        const observer = new MutationObserver(records => {
          for (const svg of records.flatMap(record => [...record.addedNodes])) {
            if (svg.id?.startsWith("diagram-image-")) {
              exported = {
                htmlLabels: svg.querySelectorAll("foreignObject").length,
                originalLabel: svg.textContent.includes("Original label")
              };
            }
          }
        });
        observer.observe(document.body, {childList: true, subtree: true});
        try {
          document.getElementById("drag-out").dispatchEvent(new PointerEvent("pointerenter"));
          window.dispatchEvent(new MessageEvent("message", {data: {
            type: "render", language: "mermaid", requestId: -1,
            source: "flowchart LR\\n C[Incoming label] --> D", title: "Incoming"
          }}));
          ${UNTIL}
          await until(() => exported && document.querySelector("#diagram").textContent.includes("Incoming label"));
          return exported;
        } finally {
          observer.disconnect();
        }
      })()`),
      { htmlLabels: 0, originalLabel: true },
    );
  });
});
