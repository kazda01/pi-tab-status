import type { TemplateVariableName, TemplateVariables } from "./types.js";

const VARIABLE_NAMES = new Set<TemplateVariableName>([
  "state",
  "loader",
  "statusIcon",
  "indicator",
  "description"
]);
const TOKEN_RE = /{{([#/]?)([A-Za-z][A-Za-z0-9]*)}}/g;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

type TextNode = { type: "text"; value: string };
type VariableNode = { type: "variable"; name: TemplateVariableName };
type SectionNode = { type: "section"; name: TemplateVariableName; children: Array<TextNode | VariableNode> };
export type TemplateNode = TextNode | VariableNode | SectionNode;

export interface CompiledTemplate {
  source: string;
  nodes: TemplateNode[];
  variables: ReadonlySet<TemplateVariableName>;
}

export function compileTemplate(source: string): CompiledTemplate {
  const nodes: TemplateNode[] = [];
  const variables = new Set<TemplateVariableName>();
  let openSection: SectionNode | undefined;
  let cursor = 0;

  const append = (node: TextNode | VariableNode): void => {
    if (openSection) openSection.children.push(node);
    else nodes.push(node);
  };

  TOKEN_RE.lastIndex = 0;
  for (let match = TOKEN_RE.exec(source); match; match = TOKEN_RE.exec(source)) {
    const before = source.slice(cursor, match.index);
    if (before.includes("{{") || before.includes("}}")) throw new Error("Malformed template token");
    if (before) append({ type: "text", value: before });

    const marker = match[1] ?? "";
    const rawName = match[2] ?? "";
    if (!VARIABLE_NAMES.has(rawName as TemplateVariableName)) {
      throw new Error(`Unknown template variable: ${rawName}`);
    }
    const name = rawName as TemplateVariableName;
    variables.add(name);

    if (marker === "#") {
      if (openSection) throw new Error("Nested template sections are not supported");
      openSection = { type: "section", name, children: [] };
    } else if (marker === "/") {
      if (!openSection || openSection.name !== name) {
        throw new Error(`Unexpected closing template section: ${name}`);
      }
      nodes.push(openSection);
      openSection = undefined;
    } else {
      append({ type: "variable", name });
    }
    cursor = match.index + match[0].length;
  }

  const tail = source.slice(cursor);
  if (tail.includes("{{") || tail.includes("}}")) throw new Error("Malformed template token");
  if (tail) append({ type: "text", value: tail });
  if (openSection) throw new Error(`Unclosed template section: ${openSection.name}`);

  return { source, nodes, variables };
}

export function templateUses(compiled: CompiledTemplate, name: TemplateVariableName): boolean {
  return compiled.variables.has(name);
}

export function renderTemplate(compiled: CompiledTemplate, values: TemplateVariables): string {
  const renderNode = (node: TemplateNode): string => {
    if (node.type === "text") return node.value;
    if (node.type === "variable") return values[node.name];
    if (!values[node.name]) return "";
    return node.children.map(renderNode).join("");
  };
  return compiled.nodes.map(renderNode).join("");
}

export function stripTerminalControls(value: string): string {
  return value.replace(CONTROL_RE, " ");
}

export function truncateGraphemes(value: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const segments = [...segmenter.segment(value)];
  if (segments.length <= maxLength) return value;
  return segments.slice(0, maxLength).map((segment) => segment.segment).join("");
}

export function safeTitle(value: string, maxLength: number): string {
  return truncateGraphemes(stripTerminalControls(value).trimEnd(), maxLength);
}
