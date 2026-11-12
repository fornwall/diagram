import * as assert from "node:assert";
import { suitePage, UNTIL } from "./webviewHarness";

suite("webview annotations", function () {
  this.timeout(20_000);
  const { draw, evaluate } = suitePage();

  test("shows safe callouts without intercepting drawing clicks and clears them on replacement", async () => {
    await draw({ source: "flowchart LR\n A[Request] --> B[Service]" });
    const text = "<img src=x onerror=alert(1)>";
    assert.deepStrictEqual(
      await evaluate(`(async () => {
      receive({type: "annotate", marks: [{id: "A", kind: "info", text: ${JSON.stringify(text)}}], dim: false});
      ${UNTIL}
      await until(() => document.querySelector('.explanation-callout')?.textContent,
        "the callout to be placed");
      const layer = document.getElementById("explanation-callouts");
      const callout = layer.firstElementChild;
      return { list: document.getElementById("explanation-marks").textContent,
        html: layer.querySelector("img") !== null,
        pointer: getComputedStyle(layer).pointerEvents,
        visible: !callout.hidden,
        marked: !!document.querySelector('[data-diagram-id="A"].diagram-marked') };
    })()`),
      { list: `Request: ${text}`, html: false, pointer: "none", visible: true, marked: true },
    );
    await draw({ source: "flowchart LR\n C --> D" });
    assert.deepStrictEqual(
      await evaluate(`({
      hidden: document.getElementById("explanation").hidden,
      callouts: document.getElementById("explanation-callouts").children.length
    })`),
      { hidden: true, callouts: 0 },
    );
  });

  test("focuses offscreen Mermaid items without replacing a draft or selecting them", async () => {
    const source = `flowchart TD\n${Array.from({ length: 35 }, (_, i) => `A${i} --> A${i + 1}`).join("\n")}`;
    await draw({ source });
    try {
      assert.deepStrictEqual(
        await evaluate(`(async () => {
      document.getElementById("view-source").click();
      const input = document.getElementById("source");
      input.value += "\\n%% draft";
      input.dispatchEvent(new Event("input", {bubbles:true}));
      receive({type: "annotate", marks: [{id: "A30", kind: "info", text: "Late step"}],
        dim: false, focus: true});
      ${UNTIL}
      await until(() => document.getElementById("canvas").scrollTop > 0, "the focused item");
      const canvas = document.getElementById("canvas").getBoundingClientRect();
      const item = document.querySelector('[data-diagram-id="A30"]').getBoundingClientRect();
      return {split: document.getElementById("panes").classList.contains("view-split"),
        draft: input.value.endsWith("%% draft"), visible: item.top < canvas.bottom && item.bottom > canvas.top,
        selected: document.getElementById("selection-label").textContent};
    })()`),
        { split: true, draft: true, visible: true, selected: "" },
      );
    } finally {
      await evaluate(
        '(() => { document.getElementById("revert").click(); document.getElementById("view-visual").click(); })()',
      );
    }
  });

  test("anchors callouts to chart items and removes explanations when marks are cleared", async () => {
    await draw({
      language: "echarts",
      source: JSON.stringify({
        xAxis: { type: "category", data: ["A", "B"] },
        yAxis: {},
        series: [
          {
            type: "bar",
            data: [
              { name: "A", value: 2 },
              { name: "B", value: 5 },
            ],
          },
        ],
      }),
    });
    assert.deepStrictEqual(
      await evaluate(`(async () => {
      receive({type: "annotate", marks: [{id: "B", kind: "info", text: "Largest value"}], dim: false});
      ${UNTIL}
      await until(() => document.querySelector('.explanation-callout')?.textContent,
        "the chart callout");
      const visible = !document.querySelector('.explanation-callout').hidden;
      receive({type: "annotate", marks: [], dim: false});
      await until(() => document.getElementById("explanation").hidden, "cleared explanations");
      return {visible, count: document.getElementById("explanation-callouts").children.length};
    })()`),
      { visible: true, count: 0 },
    );
  });

  test("keeps callouts legible in light and dark themes", async () => {
    await draw({ source: "flowchart LR\n A --> B" });
    assert.deepStrictEqual(
      await evaluate(`(async () => {
      receive({type: "annotate", marks: [{id:"A",kind:"info",text:"A callout"}], dim: false});
      ${UNTIL}
      await until(() => document.querySelector('.explanation-callout')?.textContent, "the callout");
      const style = document.body.style;
      const keys = ["--vscode-editorWidget-background", "--vscode-editorWidget-foreground"];
      const saved = keys.map(key => style.getPropertyValue(key));
      const results = [];
      try {
        for (const [background, foreground] of [["#f3f3f3", "#202020"], ["#252526", "#cccccc"]]) {
          style.setProperty(keys[0], background); style.setProperty(keys[1], foreground);
          const colors = getComputedStyle(document.querySelector('.explanation-callout'));
          results.push([colors.backgroundColor, colors.color]);
        }
        return results;
      } finally { keys.forEach((key,index) => saved[index] ? style.setProperty(key,saved[index]) : style.removeProperty(key)); }
    })()`),
      [
        ["rgb(243, 243, 243)", "rgb(32, 32, 32)"],
        ["rgb(37, 37, 38)", "rgb(204, 204, 204)"],
      ],
    );
  });

  test("replacing an unfocused explanation does not take keyboard focus from chat", async () => {
    await draw({ source: "flowchart LR\n A --> B" });
    assert.strictEqual(
      await evaluate(`(async () => {
      receive({type:"annotate",marks:[{id:"A",kind:"info",text:"Old explanation"}],dim:false});
      ${UNTIL}
      await until(() => document.querySelector('#explanation-marks button'), "the old explanation");
      document.querySelector('#explanation-marks button').focus();
      const descriptor = Object.getOwnPropertyDescriptor(document, "hasFocus");
      const canvas = document.getElementById("canvas");
      const oldFocus = canvas.focus;
      let focused = false;
      canvas.focus = () => { focused = true; };
      Object.defineProperty(document, "hasFocus", {configurable:true, value:()=>false});
      try {
        receive({type:"annotate",marks:[],dim:false});
        await until(() => document.getElementById("explanation").hidden, "cleared explanations");
        return focused;
      } finally {
        canvas.focus = oldFocus;
        if (descriptor) Object.defineProperty(document, "hasFocus", descriptor);
        else delete document.hasFocus;
      }
    })()`),
      false,
    );
  });
});
