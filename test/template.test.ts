import { describe, expect, it } from "vitest";
import {
  compileTemplate,
  renderTemplate,
  safeTitle,
  stripTerminalControls,
  templateUses,
  truncateGraphemes
} from "../src/template.js";

const values = {
  state: "working",
  loader: "⠋",
  statusIcon: "●",
  indicator: "⠋",
  description: "Fix Tests"
};

describe("terminal title templates", () => {
  it("renders variables and truthy sections while preserving whitespace", () => {
    const template = compileTemplate("π{{#indicator}} {{indicator}}{{/indicator}} :: {{description}}");
    expect(renderTemplate(template, values)).toBe("π ⠋ :: Fix Tests");
    expect(templateUses(template, "description")).toBe(true);
    expect(templateUses(template, "state")).toBe(false);
  });

  it("omits false sections and supports all variables", () => {
    const template = compileTemplate("{{state}}|{{loader}}|{{statusIcon}}|{{indicator}}{{#description}} {{description}}{{/description}}");
    expect(renderTemplate(template, { ...values, indicator: "", description: "" })).toBe("working|⠋|●|");
  });

  it.each([
    ["{{wat}}", "Unknown template variable"],
    ["{{description", "Malformed template token"],
    ["{{#description}}x", "Unclosed template section"],
    ["{{/description}}", "Unexpected closing"],
    ["{{#description}}{{#state}}x{{/state}}{{/description}}", "Nested"]
  ])("rejects malformed template %s", (source, message) => {
    expect(() => compileTemplate(source)).toThrow(message);
  });

  it("strips terminal controls and truncates grapheme clusters", () => {
    expect(stripTerminalControls("ok\u001b]2;bad\u0007x")).toBe("ok ]2;bad x");
    expect(truncateGraphemes("A👨‍👩‍👧‍👦B", 2)).toBe("A👨‍👩‍👧‍👦");
    expect(truncateGraphemes("abc", 10)).toBe("abc");
    expect(truncateGraphemes("abc", 0)).toBe("");
    expect(safeTitle("A\nB", 3)).toBe("A B");
    expect(safeTitle("A  ", 3)).toBe("A");
  });
});
