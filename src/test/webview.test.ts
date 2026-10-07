import * as assert from "node:assert";
import * as vscode from "vscode";
import type { Diagram, DiagramPanel, RenderOutcome } from "../panel";
import { afterTest } from "./afterTest";
import { newPanel, openWebviewPanel, recordChat, within } from "./newPanel";
import { instrumentWebview, MERMAID, suitePage, UNTIL } from "./webviewHarness";

suite("webview", function () {
  // The first render loads the webview and the libraries, which can take a while.
  this.timeout(20_000);

  const page = suitePage();
  const { evaluate, nextRender, render, draw } = page;

  test("skips superseded queued renders and their annotations", async () => {
    await draw({ source: "flowchart LR\n A --> B" });
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        window.testRenderResults = [];
        receive({type: "render", requestId: 900001, language: "mermaid",
          source: "invalid obsolete diagram", title: "Obsolete"});
        receive({type: "annotate", marks: [], dim: false, caption: "Obsolete annotation"});
        receive({type: "render", requestId: 900002, language: "mermaid",
          source: "flowchart LR\\n C --> D", title: "Intermediate"});
        receive({type: "render", requestId: 900003, language: "mermaid",
          source: "flowchart LR\\n E --> F", title: "Latest"});
        receive({type: "annotate", marks: [], dim: false, caption: "Latest annotation"});
        ${UNTIL}
        await until(() => document.getElementById("annotation-caption").textContent === "Latest annotation",
          "the latest diagram's annotation");
        return {results: window.testRenderResults,
          title: document.getElementById("title").textContent,
          errorHidden: document.getElementById("error").hidden};
      })()`),
      { results: [900003], title: "Latest", errorHidden: true },
    );
  });

  test("resizes the source pane to its limits and resets it with the keyboard", async () => {
    await draw({ source: MERMAID["flowchart-v2"] });
    assert.deepStrictEqual(
      await evaluate(`(() => {
        document.getElementById("view-split").click();
        const splitter = document.getElementById("splitter");
        splitter.focus();
        const values = [];
        try {
          for (const key of ["Home", "End", "Enter"]) {
            const event = new KeyboardEvent("keydown", {key, bubbles: true, cancelable: true});
            splitter.dispatchEvent(event);
            values.push({
              value: splitter.getAttribute("aria-valuenow"),
              prevented: event.defaultPrevented,
              focused: document.activeElement === splitter
            });
          }
          return values;
        } finally {
          document.getElementById("view-visual").click();
        }
      })()`),
      [
        { value: "15", prevented: true, focused: true },
        { value: "85", prevented: true, focused: true },
        { value: "40", prevented: true, focused: true },
      ],
    );
  });

  test("shows why an action is disabled on hover", async () => {
    await draw({ source: MERMAID["flowchart-v2"] });
    assert.deepStrictEqual(
      await evaluate(`(() => {
        const button = document.getElementById("highlight-path");
        return {disabled: button.disabled, title: button.title, hoverable: getComputedStyle(button).pointerEvents !== "none"};
      })()`),
      {
        disabled: true,
        title: "Select two flowchart nodes, first the start and then the destination",
        hoverable: true,
      },
    );
  });

  test("only enables sending to chat when the message contains text", async () => {
    assert.deepStrictEqual(
      await evaluate(`(() => {
        const input = document.getElementById("ask-input");
        const submit = document.querySelector('#ask-form button[type="submit"]');
        const original = input.value;
        try {
          return ["", "   ", "Explain this node", ""].map(value => {
            input.value = value;
            input.dispatchEvent(new Event("input"));
            return submit.disabled;
          });
        } finally {
          input.value = original;
          input.dispatchEvent(new Event("input"));
        }
      })()`),
      [true, true, false, true],
    );
  });

  test("sends a message to chat from the button and from Enter", async () => {
    await draw({ source: MERMAID["flowchart-v2"] });
    const chat = recordChat();
    // The page submits the form as a user does, which a webview without forms would drop.
    await evaluate(`(() => {
      const input = document.getElementById("ask-input");
      input.value = "From the button";
      input.dispatchEvent(new Event("input"));
      document.getElementById("ask-submit").click();
      input.value = "From Enter";
      input.dispatchEvent(new Event("input"));
      document.getElementById("ask-form").requestSubmit();
    })()`);
    // If both requests do not come, the assertion shows which did.
    await within(() => chat.requests.length >= 2);
    assert.deepStrictEqual(
      chat.requests.map((request) => request.query),
      ["Regarding the diagram: From the button", "Regarding the diagram: From Enter"],
    );
  });

  test("returns keyboard focus to visible content after clearing the selection", async () => {
    await draw({ source: MERMAID["flowchart-v2"] });
    assert.deepStrictEqual(
      await evaluate(`(() => {
        const node = document.querySelector("#diagram .diagram-node[tabindex]");
        const clear = document.getElementById("clear-selection");
        try {
          return ["visual", "source"].map(view => {
            node.dispatchEvent(new MouseEvent("click", {bubbles: true}));
            document.getElementById("view-" + view).click();
            const selected = !clear.hidden;
            clear.focus();
            clear.click();
            return {
              selected,
              cleared: clear.hidden && !document.querySelector("#diagram .diagram-selected"),
              focused: document.activeElement === document.getElementById(view === "source" ? "source" : "canvas")
            };
          });
        } finally {
          document.getElementById("view-visual").click();
        }
      })()`),
      [
        { selected: true, cleared: true, focused: true },
        { selected: true, cleared: true, focused: true },
      ],
    );
  });

  test("reveals node picks without losing source edits, describes the canvas by the prompt, and restores focus when finished", async () => {
    await draw({ source: MERMAID["flowchart-v2"] });
    assert.deepStrictEqual(
      await evaluate(`(() => {
        try {
          const source = document.getElementById("source");
          return ["visual", "source"].flatMap(view => {
            return ["pick-done", "pick-cancel"].map(id => {
              document.getElementById("view-" + view).click();
              const draft = source.value + "\\n%% Unapplied edit";
              source.value = draft;
              source.dispatchEvent(new Event("input"));
              receive({type: "startPick", pickId: 90000, prompt: "Pick a node", multiple: true});
              const canvas = document.getElementById("canvas");
              const visible = canvas.getBoundingClientRect().height > 0;
              const focused = document.activeElement === canvas &&
                canvas.getAttribute("aria-describedby") === "pick-prompt";
              const preserved = source.value === draft;
              document.querySelector("#diagram .diagram-node[tabindex]")
                .dispatchEvent(new MouseEvent("click", {bubbles: true}));
              const button = document.getElementById(id);
              button.focus();
              button.click();
              return visible && focused && preserved && document.getElementById("pick").hidden &&
                document.activeElement === canvas && !canvas.hasAttribute("aria-describedby") &&
                canvas.tabIndex === 0 && canvas.getAttribute("aria-label") === "Diagram preview";
            });
          });
        } finally {
          document.getElementById("revert").click();
          document.getElementById("view-visual").click();
          document.getElementById("clear-selection").click();
        }
      })()`),
      [true, true, true, true],
    );
  });

  test("zooms with Ctrl/Cmd and +, - and 0, and fits a new diagram but not a revision", async () => {
    const zoom = () => evaluate(`document.getElementById("zoom-reset").textContent`);
    /** Presses the key, with Cmd on macOS or Ctrl elsewhere, for whether VS Code saw it. */
    const press = (key: string, modifier = true) =>
      evaluate(`(() => {
        const mac = navigator.userAgent.includes("Mac");
        const event = new KeyboardEvent("keydown", {key: ${JSON.stringify(key)},
          metaKey: ${modifier} && mac, ctrlKey: ${modifier} && !mac, bubbles: true, cancelable: true});
        let forwarded = false;
        const listener = () => { forwarded = true; };
        window.addEventListener("keydown", listener);
        document.getElementById("canvas").dispatchEvent(event);
        window.removeEventListener("keydown", listener);
        return {prevented: event.defaultPrevented, forwarded};
      })()`);
    const source = MERMAID["flowchart-v2"];
    await draw({ source, title: "Zoom" });
    assert.strictEqual(await zoom(), "100%");
    assert.deepStrictEqual(await press("="), { prevented: true, forwarded: false });
    assert.strictEqual(await zoom(), "125%");
    assert.deepStrictEqual(await press("-", false), { prevented: false, forwarded: true });
    assert.strictEqual(await zoom(), "125%");
    await press("-");
    assert.strictEqual(await zoom(), "100%");
    await press("+");
    await press("0");
    assert.strictEqual(await zoom(), "100%", "0 fits the diagram to the panel again.");

    await press("+");
    await draw({ source: `${source}\n  B --> C`, title: "Zoom" });
    assert.strictEqual(await zoom(), "125%", "A revision keeps the zoom.");
    await draw({ source, title: "Another" });
    assert.strictEqual(await zoom(), "100%", "A new diagram fits the panel.");
  });

  test("zooms at the pointer in proportion to Ctrl+scrolling, and as much as a pinch", async () => {
    const chain = Array.from({ length: 30 }, (_, i) => `n${i} --> n${i + 1}`).join("\n  ");
    await draw({ source: `flowchart LR\n  ${chain}` });
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        const frame = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve)));
        const canvas = document.getElementById("canvas");
        const zoom = () => document.getElementById("zoom-reset").textContent;
        const wheel = (deltaY, deltaMode = 0, deltaX = 0, wheelDeltaY = 0) => {
          const box = document.querySelector('[data-diagram-id="n15"][tabindex]').getBoundingClientRect();
          const x = box.left + box.width / 2;
          const y = box.top + box.height / 2;
          canvas.dispatchEvent(new WheelEvent("wheel", {deltaX, deltaY, deltaMode, wheelDeltaY, clientX: x, clientY: y,
            ctrlKey: true, bubbles: true, cancelable: true}));
          return {x, y};
        };
        // Sideways, the drawing keeps fitting the panel.
        const fitting = document.getElementById("zoom-reset").title;
        wheel(0, 0, 100);
        await frame();
        const sideways = document.getElementById("zoom-reset").title === fitting;
        document.getElementById("zoom-reset").click();
        if (zoom() !== "100%") document.getElementById("zoom-reset").click();
        canvas.scrollLeft = (canvas.scrollWidth - canvas.clientWidth) / 2;
        await frame();
        // Trackpad scrolling: many small deltas in one frame, which add up to one notch.
        const anchor = wheel(-25);
        for (let i = 0; i < 3; i++) wheel(-25);
        await frame();
        const scrolled = zoom();
        const box = document.querySelector('[data-diagram-id="n15"][tabindex]').getBoundingClientRect();
        // The diagram is taller than the canvas only once zoomed in, so only scrolling left keeps up.
        const moved = Math.abs(box.left + box.width / 2 - anchor.x);
        // A pinch, as Chromium reports it, by as much as the fingers spread: twice by 1.1.
        for (let i = 0; i < 2; i++) wheel(-100 * Math.log(1.1), 0, 0, 120);
        await frame();
        const pinched = zoom();
        // Mouse wheel notches, as Chromium reports them on Windows and Linux, in pixels, lines
        // and, with Windows set to scroll a screen at a time, pages.
        wheel(100, 0, 0, -120);
        await frame();
        wheel(3, WheelEvent.DOM_DELTA_LINE, 0, -120);
        await frame();
        wheel(1, WheelEvent.DOM_DELTA_PAGE, 0, -120);
        await frame();
        return {sideways, scrolled, steady: moved < 2, pinched, notches: zoom()};
      })()`),
      { sideways: true, scrolled: "120%", steady: true, pinched: "145%", notches: "84%" },
    );
  });

  test("keeps a zoom made while fitting the diagram to a resized panel is pending", async () => {
    const chain = Array.from({ length: 30 }, (_, i) => `n${i} --> n${i + 1}`).join("\n  ");
    await draw({ source: `flowchart LR\n  ${chain}` });
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        const frame = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve)));
        const canvas = document.getElementById("canvas");
        const zoom = () => document.getElementById("zoom-reset").textContent;
        await frame();
        try {
          // The resize observer runs after this frame, and fits the diagram in the next one.
          canvas.style.paddingRight = "60px";
          await frame();
          document.getElementById("zoom-in").click();
          const zoomed = zoom();
          await frame();
          await frame();
          return zoom() === zoomed;
        } finally {
          canvas.style.paddingRight = "";
        }
      })()`),
      true,
    );
  });

  test("ends panning when released outside the canvas or pointer capture is lost", async () => {
    await draw({ source: MERMAID["flowchart-v2"] });
    assert.deepStrictEqual(
      await evaluate(`(() => {
        const canvas = document.getElementById("canvas");
        const captured = [];
        let pointer;
        // Synthetic pointer events cannot acquire native pointer capture.
        canvas.setPointerCapture = id => { pointer = id; captured.push(id); };
        canvas.hasPointerCapture = id => pointer === id;
        canvas.releasePointerCapture = () => { pointer = undefined; };
        Object.defineProperty(canvas, "scrollWidth", {value: canvas.clientWidth + 100, configurable: true});
        const send = (target, type, pointerId, clientX = 100) => target.dispatchEvent(
          new PointerEvent(type, {pointerId, clientX, clientY: 100, pointerType: "mouse",
            button: 0, isPrimary: true, bubbles: true})
        );
        try {
          send(canvas, "pointerdown", 1);
          send(document.body, "pointerup", 1);
          send(canvas, "pointermove", 1, 90);
          const released = !canvas.classList.contains("panning") && captured.length === 0;
          send(canvas, "pointerdown", 2);
          send(canvas, "pointermove", 2, 90);
          const restarted = canvas.classList.contains("panning") && captured.at(-1) === 2;
          send(document.body, "pointerup", 3);
          const unrelated = canvas.classList.contains("panning");
          send(canvas, "lostpointercapture", 2);
          const lostCapture = !canvas.classList.contains("panning");
          const click = new MouseEvent("click", {bubbles: true, cancelable: true});
          canvas.dispatchEvent(click);
          send(canvas, "pointerdown", 4);
          send(canvas, "pointermove", 4, 90);
          send(canvas, "pointerup", 4);
          const keyboardClick = new MouseEvent("click", {bubbles: true, cancelable: true, detail: 0});
          canvas.dispatchEvent(keyboardClick);
          const panClick = new MouseEvent("click", {bubbles: true, cancelable: true, detail: 1});
          canvas.dispatchEvent(panClick);
          // A release outside the canvas may have no click here. The next gesture still works,
          // including when a new diagram fits and no longer needs panning.
          send(canvas, "pointerdown", 5);
          send(canvas, "pointermove", 5, 90);
          send(document.body, "pointerup", 5);
          Object.defineProperty(canvas, "scrollWidth", {value: canvas.clientWidth, configurable: true});
          Object.defineProperty(canvas, "scrollHeight", {value: canvas.clientHeight, configurable: true});
          send(canvas, "pointerdown", 6);
          send(canvas, "pointerup", 6);
          const nextClick = new MouseEvent("click", {bubbles: true, cancelable: true, detail: 1});
          canvas.dispatchEvent(nextClick);
          return {released, restarted, unrelated, lostCapture, clickAllowed: !click.defaultPrevented,
            keyboardAllowed: !keyboardClick.defaultPrevented, panSuppressed: panClick.defaultPrevented,
            nextAllowed: !nextClick.defaultPrevented};
        } finally {
          send(canvas, "pointercancel", 1);
          send(canvas, "pointercancel", 2);
          delete canvas.setPointerCapture;
          delete canvas.hasPointerCapture;
          delete canvas.releasePointerCapture;
          delete canvas.scrollWidth;
          delete canvas.scrollHeight;
        }
      })()`),
      {
        released: true,
        restarted: true,
        unrelated: true,
        lostCapture: true,
        clickAllowed: true,
        keyboardAllowed: true,
        panSuppressed: true,
        nextAllowed: true,
      },
    );
  });

  test("keeps unapplied source edits across view changes and incoming diagrams", async () => {
    await draw({ source: "flowchart LR\n A --> B" });
    await evaluate(`(() => {
      document.getElementById("view-split").click();
      const source = document.getElementById("source");
      source.value = "flowchart LR\\n A --> Draft";
      source.dispatchEvent(new Event("input"));
      document.getElementById("view-visual").click();
      document.getElementById("view-split").click();
    })()`);
    assert.strictEqual(
      await evaluate('document.getElementById("source").value'),
      "flowchart LR\n A --> Draft",
    );
    await evaluate('document.getElementById("view-visual").click()');
    await draw({ source: "flowchart LR\n A --> New" });
    await evaluate('document.getElementById("view-source").click()');
    assert.deepStrictEqual(
      await evaluate(`({
        source: document.getElementById("source").value,
        stale: !document.getElementById("stale-note").hidden
      })`),
      { source: "flowchart LR\n A --> Draft", stale: true },
    );
    await evaluate('document.getElementById("revert").click()');
    assert.strictEqual(
      await evaluate('document.getElementById("source").value'),
      "flowchart LR\n A --> New",
    );
    await evaluate('document.getElementById("view-visual").click()');
  });

  test("reuses formatted source and only persists changed editor state", async () => {
    await evaluate('document.getElementById("view-visual").click()');
    const source = '{"series":[{"type":"pie","data":[3,7]}]}';
    await draw({ language: "echarts", source });
    assert.deepStrictEqual(
      await evaluate(`(() => {
        const parse = JSON.parse;
        let parses = 0;
        JSON.parse = function (text, ...args) {
          if (text === ${JSON.stringify(source)}) parses++;
          return parse.call(this, text, ...args);
        };
        window.testStateWrites = 0;
        try {
          for (const view of ["source", "source", "visual", "split", "split"]) {
            document.getElementById("view-" + view).click();
          }
          const viewWrites = window.testStateWrites;
          const input = document.getElementById("source");
          input.value += " ";
          input.dispatchEvent(new Event("input"));
          input.dispatchEvent(new Event("input"));
          return {parses, viewWrites, editWrites: window.testStateWrites - viewWrites,
            saved: window.readTestState().editor.source === input.value};
        } finally {
          JSON.parse = parse;
        }
      })()`),
      { parses: 1, viewWrites: 3, editWrites: 1, saved: true },
    );
    const incoming = '{"series":[{"type":"pie","data":[9,1]}]}';
    await draw({ language: "echarts", source: incoming });
    assert.deepStrictEqual(
      await evaluate(`(() => {
        const stale = !document.getElementById("stale-note").hidden;
        document.getElementById("revert").click();
        return {stale, source: document.getElementById("source").value,
          draft: window.readTestState().editor ?? null};
      })()`),
      { stale: true, source: JSON.stringify(JSON.parse(incoming), null, 2), draft: null },
    );
    await evaluate('document.getElementById("view-visual").click()');
  });

  test("acknowledges Apply when the edit matches the original unformatted chart source", async () => {
    const source = '{"series":[{"type":"pie","data":[1,2]}]}';
    await draw({ language: "echarts", source });
    await evaluate(`(() => {
      document.getElementById("view-source").click();
      const input = document.getElementById("source");
      input.value = ${JSON.stringify(source)};
      input.dispatchEvent(new Event("input"));
    })()`);
    assert.strictEqual(await evaluate('document.getElementById("apply").disabled'), false);
    await nextRender(() => evaluate('document.getElementById("apply").click()'));
    assert.deepStrictEqual(
      await evaluate(`({
        source: document.getElementById("source").value,
        applyDisabled: document.getElementById("apply").disabled,
        draft: window.readTestState().editor ?? null
      })`),
      { source: JSON.stringify(JSON.parse(source), null, 2), applyDisabled: true, draft: null },
    );
    await evaluate('document.getElementById("view-visual").click()');
  });

  test("restores unapplied source edits after a webview reload", async () => {
    const original = "flowchart LR\n A --> Original";
    const draft = "flowchart LR\n A --> Draft";
    await draw({ source: original });
    await evaluate(`(() => {
      document.getElementById("view-split").click();
      const input = document.getElementById("source");
      input.value = ${JSON.stringify(draft)};
      input.dispatchEvent(new Event("input"));
    })()`);
    assert.deepStrictEqual(await evaluate("window.readTestState().editor"), {
      source: draft,
      base: original,
    });
    await nextRender(() => {
      page.webview.html += "\n<!-- Reload to verify draft restoration. -->";
    });
    assert.deepStrictEqual(
      await evaluate(`({
        source: document.getElementById("source").value,
        stale: !document.getElementById("stale-note").hidden,
        applyDisabled: document.getElementById("apply").disabled
      })`),
      { source: draft, stale: false, applyDisabled: false },
    );
    const incoming = "flowchart LR\n A --> Incoming";
    await draw({ source: incoming });
    assert.deepStrictEqual(
      await evaluate(`({
        source: document.getElementById("source").value,
        stale: !document.getElementById("stale-note").hidden
      })`),
      { source: draft, stale: true },
    );
    await nextRender(() => evaluate('document.getElementById("apply").click()'));
    assert.strictEqual(page.panel.current?.source, draft);
    assert.strictEqual(await evaluate("window.readTestState().editor ?? null"), null);
    await evaluate('document.getElementById("view-visual").click()');
  });

  test("a reload ignores saved values that the page does not use", async () => {
    const source = "flowchart LR\n A --> B";
    await draw({ source });
    await evaluate(
      'window.writeTestState({draft: 1, view: "both", editor: {source: "flowchart LR", base: 2}})',
    );
    await nextRender(() => {
      page.webview.html += "\n<!-- Reload with a state of another shape. -->";
    });
    assert.deepStrictEqual(
      await evaluate(`({
        draft: document.getElementById("ask-input").value,
        visual: document.getElementById("view-visual").getAttribute("aria-pressed"),
        source: document.getElementById("source").value,
        state: window.readTestState()
      })`),
      { draft: "", visual: "true", source: "", state: { draft: "", view: "visual" } },
    );
  });

  test("renders charts, and switches between charts and diagrams", async () => {
    const option = {
      xAxis: { type: "category", data: ["A", "B"] },
      yAxis: {},
      series: [{ type: "bar", data: [1, 2] }],
    };
    const chart = { language: "echarts", source: JSON.stringify(option) } as const;
    const shown = () =>
      evaluate(`["diagram", "chart"].filter(id => document.getElementById(id)?.hidden === false)`);
    await draw({ source: MERMAID["flowchart-v2"] });
    assert.deepStrictEqual(await shown(), ["diagram"]);
    assert.deepStrictEqual(await render(chart), { ok: true, diagramType: "bar" });
    assert.deepStrictEqual(await shown(), ["chart"]);
    await draw({ source: MERMAID["flowchart-v2"] });
    assert.deepStrictEqual(await shown(), ["diagram"]);
  });

  test("keeps recovery controls visible when a render error is long", async () => {
    const outcome = await render({
      language: "echarts",
      source: '(() => { throw new Error("Invalid chart value. ".repeat(2000)); })()',
    });
    assert.ok(!outcome.ok);
    assert.deepStrictEqual(
      await evaluate(`(() => {
        document.getElementById("view-source").click();
        const error = document.getElementById("error");
        const apply = document.getElementById("apply").getBoundingClientRect();
        const footer = document.querySelector("footer").getBoundingClientRect();
        const result = {
          scrolls: error.scrollHeight > error.clientHeight,
          editorVisible: document.getElementById("source").getBoundingClientRect().height > 0,
          applyVisible: apply.top >= 0 && apply.bottom <= innerHeight,
          footerVisible: footer.bottom <= innerHeight
        };
        document.getElementById("view-visual").click();
        return result;
      })()`),
      { scrolls: true, editorVisible: true, applyVisible: true, footerVisible: true },
    );
  });

  test("shows a diagram that it is not to draw as failing, with its source to edit", async () => {
    await draw({ source: "flowchart LR\n A --> B" });
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        window.testRenderResults = [];
        const source = "flowchart LR\\n C --> D";
        receive({type: "render", requestId: 900004,
          language: "mermaid", source, title: "Hanging", notDrawn: "It may hang the panel."});
        ${UNTIL}
        await until(() => window.testRenderResults.length > 0, "the outcome of the render");
        document.getElementById("view-source").click();
        const result = {results: window.testRenderResults,
          error: document.getElementById("error").textContent,
          drawn: document.querySelector("#canvas svg") !== null,
          source: document.getElementById("source").value === source};
        document.getElementById("view-visual").click();
        return result;
      })()`),
      {
        results: [900004],
        error: "This diagram failed to render: It may hang the panel.",
        drawn: false,
        source: true,
      },
    );
  });

  test("disables stale drawing interactions during rendering and restores them after errors", async () => {
    for (const series of ['[{type: "pie", data: [1]}]', "[]"]) {
      const result = await render({
        language: "echarts",
        source: `(() => {
          window.testRenderingBusy = document.getElementById("canvas").getAttribute("aria-busy");
          window.testRenderingStatus = document.getElementById("render-status").textContent;
          window.testRenderingHeight = document.getElementById("canvas").clientHeight;
          return {series: ${series}};
        })()`,
      });
      assert.strictEqual(result.ok, series !== "[]");
      assert.deepStrictEqual(
        await evaluate(`({
          duringBusy: window.testRenderingBusy,
          duringStatus: window.testRenderingStatus,
          // A status shown only while rendering would size the chart for a smaller canvas.
          sameHeight: window.testRenderingHeight === document.getElementById("canvas").clientHeight,
          after: document.getElementById("canvas").inert,
          afterBusy: document.getElementById("canvas").getAttribute("aria-busy"),
          afterStatus: document.getElementById("render-status").textContent,
          idleStatusHeight: document.getElementById("render-status").getBoundingClientRect().height
        })`),
        {
          duringBusy: "true",
          // Only a slow render shows its status.
          duringStatus: "",
          // Unlike the error that follows a failed render.
          sameHeight: series !== "[]",
          after: false,
          afterBusy: "false",
          afterStatus: "",
          idleStatusHeight: 0,
        },
      );
    }
    // The drawing takes no clicks or keys while a render waits, unlike one that never waits, as a
    // chart's does once ECharts has loaded.
    await evaluate(`(() => {
      window.testInert = [];
      const canvas = document.getElementById("canvas");
      new MutationObserver(() => window.testInert.push(canvas.inert))
        .observe(canvas, {attributeFilter: ["inert"]});
    })()`);
    await draw({ source: MERMAID["flowchart-v2"] });
    assert.deepStrictEqual(await evaluate("window.testInert.splice(0)"), [true, false]);
    for (let drawn = 0; drawn < 2; drawn++) {
      await draw({ language: "echarts", source: '{"series": [{"type": "pie", "data": [1]}]}' });
    }
    assert.deepStrictEqual(await evaluate("window.testInert"), []);
  });

  test("keeps the annotation banner a live region, which takes no space without marks", async () => {
    await draw({ source: MERMAID["flowchart-v2"] });
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        const banner = document.getElementById("annotation");
        const shown = () => ({
          live: banner.getAttribute("role") === "status" && getComputedStyle(banner).display !== "none",
          height: banner.getBoundingClientRect().height > 0
        });
        ${UNTIL}
        const annotate = async (caption) => {
          receive({type: "annotate", marks: [], dim: false, caption});
          await until(() => document.getElementById("annotation-caption").hidden === (caption === undefined));
          return shown();
        };
        return [shown(), await annotate("Step 1"), await annotate(undefined)];
      })()`),
      [
        { live: true, height: false },
        { live: true, height: true },
        { live: true, height: false },
      ],
    );
  });

  test("hides the drag handle and other hidden controls whatever their styles", async () => {
    assert.ok(!(await render({ source: "flowchart LR\n A -->" })).ok);
    assert.deepStrictEqual(
      await evaluate(`[...document.querySelectorAll("[hidden]")]
        .filter(element => getComputedStyle(element).display !== "none")
        .map(element => element.id)`),
      [],
    );
    assert.strictEqual(await evaluate(`document.getElementById("drag-out").hidden`), true);
  });
});

suite("webview renderer loading", function () {
  this.timeout(20_000);

  /** A page on which the chunk that the pattern names does not load. */
  async function pageWithout(chunkPattern: RegExp) {
    const panel = newPanel();
    afterTest(() => panel.dispose());
    const harness = instrumentWebview(panel);
    const { webview } = harness;
    // Point the import of the chunk at a file that does not exist.
    const extension = vscode.extensions.getExtension("fornwall.diagram");
    assert.ok(extension);
    const chunks = vscode.Uri.joinPath(extension.extensionUri, "dist", "chunks");
    const chunk = (await vscode.workspace.fs.readDirectory(chunks)).find(([name]) =>
      chunkPattern.test(name),
    )?.[0];
    assert.ok(chunk);
    const url = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(chunks, name));
    const imports = JSON.stringify({ imports: { [url(chunk).toString()]: url("missing.js") } });
    const nonce = /nonce="([^"]+)"/.exec(webview.html)?.[1];
    webview.html = webview.html.replace(
      "<script",
      `<script type="importmap" nonce="${nonce}">${imports}</script><script`,
    );
    return { panel, ...harness };
  }

  test("reports at once when a renderer's code does not load", async () => {
    const { panel, evaluate } = await pageWithout(/^mermaidRenderer-\w+\.js$/);
    const flowchart: Diagram = {
      language: "mermaid",
      source: MERMAID["flowchart-v2"],
      title: "Flow",
    };
    const started = Date.now();
    const outcome = await panel.render(flowchart, "tool");
    assert.ok(!outcome.ok && outcome.kind === "unavailable");
    assert.match(
      outcome.error,
      /^Could not load the Mermaid renderer: .+\. Reload the window \(Developer: Reload Window\)\.$/,
    );
    assert.ok(Date.now() - started < 5000);
    assert.strictEqual(
      await evaluate(`document.getElementById("error").textContent`),
      outcome.error,
    );

    // The other renderer still loads, and the next diagram is answered at once too.
    const chart = await panel.render(
      { language: "echarts", source: '{"series": [{"type": "pie", "data": [1]}]}', title: "Pie" },
      "tool",
    );
    assert.ok(chart.ok, chart.ok ? undefined : chart.error);
    const again = await panel.render(flowchart, "tool");
    assert.ok(!again.ok && again.kind === "unavailable");
  });

  test("reports Mermaid not loading as its renderer not loading, not as an error to fix", async () => {
    const { panel } = await pageWithout(/^mermaid\.core-\w+\.js$/);
    const outcome = await panel.render(
      { language: "mermaid", source: MERMAID["flowchart-v2"], title: "Flow" },
      "tool",
    );
    assert.ok(!outcome.ok && outcome.kind === "unavailable", JSON.stringify(outcome));
    assert.match(outcome.error, /^Could not load the Mermaid renderer: /);
  });

  test("reports at once when ECharts does not load, and loads it next time", async () => {
    const panel = newPanel();
    afterTest(() => panel.dispose());
    const { webview, evaluate } = instrumentWebview(panel);
    // The page loads ECharts beside its first script, which this one, from nowhere, now is.
    const extension = vscode.extensions.getExtension("fornwall.diagram");
    assert.ok(extension);
    const missing = webview.asWebviewUri(
      vscode.Uri.joinPath(extension.extensionUri, "missing", "webview.js"),
    );
    const nonce = /nonce="([^"]+)"/.exec(webview.html)?.[1];
    webview.html = webview.html.replace(
      "<script",
      `<script id="decoy" nonce="${nonce}" src="${missing.toString()}"></script><script`,
    );
    const pie: Diagram = {
      language: "echarts",
      source: '{"series": [{"type": "pie", "data": [1]}]}',
      title: "Pie",
    };
    const started = Date.now();
    const outcome = await panel.render(pie, "tool");
    assert.ok(!outcome.ok && outcome.kind === "unavailable", JSON.stringify(outcome));
    assert.match(
      outcome.error,
      /^Could not load the ECharts renderer: Cannot load ECharts from .*missing\/echarts\.js\. Reload the window/,
    );
    assert.ok(Date.now() - started < 5000);
    // The failed script is gone, for the next chart to load it anew.
    assert.strictEqual(
      await evaluate(`document.querySelectorAll('script[src$="echarts.js"]').length`),
      0,
    );

    await evaluate(`document.getElementById("decoy").remove()`);
    const again = await panel.render(pie, "tool");
    assert.ok(again.ok, again.ok ? undefined : again.error);
  });
});

suite("JavaScript in chart options", function () {
  this.timeout(20_000);

  let panel: DiagramPanel;
  let webview: vscode.Webview;
  const messages: string[] = [];
  suiteSetup(() => {
    panel = newPanel();
    ({ webview } = openWebviewPanel(panel));
    webview.onDidReceiveMessage((message: { type: string }) => messages.push(message.type));
  });
  suiteTeardown(() => panel.dispose());

  const render = (source: string): Promise<RenderOutcome> =>
    panel.render({ language: "echarts", source, title: "Test" }, "tool");
  // Code in the option clicks Refresh, which sends the extension a message as if the user had.
  const forging =
    '{series: [{type: "pie", data: [1]}], title: {text: (document.getElementById("refresh").click(), "Forged")}}';

  test("runs in a trusted workspace, with all the power of the page", async () => {
    assert.match(webview.html, /script-src 'nonce-[\w-]+' 'unsafe-eval'/);
    assert.deepStrictEqual(await render(forging), { ok: true, diagramType: "pie" });
    assert.ok(messages.includes("refresh"));
  });

  test("does not run in an untrusted workspace, whose page may not evaluate code", async () => {
    const ready = new Promise<void>((resolve) => {
      const listener = webview.onDidReceiveMessage((message: { type: string }) => {
        if (message.type !== "ready") return;
        listener.dispose();
        resolve();
      });
    });
    // The page that loadWebview makes for an untrusted workspace.
    webview.html = webview.html.replace(" 'unsafe-eval'", "");
    await ready;
    messages.length = 0;
    const outcome = await render(forging);
    assert.ok(!outcome.ok);
    assert.match(
      outcome.error,
      /^The ECharts option has JavaScript code \(line 1, column 52\), which the panel runs only in a trusted workspace\./,
    );
    assert.ok(!messages.includes("refresh"), "the code in the option ran");
    // Object literals need no evaluation.
    assert.deepStrictEqual(await render("{series: [{type: 'pie', data: [1,],}],}"), {
      ok: true,
      diagramType: "pie",
    });
  });
});
