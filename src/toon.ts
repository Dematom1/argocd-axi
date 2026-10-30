import { encode } from "@toon-format/toon";

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (typeof value !== "object" || value === null) return value;
  const clean: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) clean[key] = stripUndefined(entry);
  }
  return clean;
}

/** Encode a structured object as TOON, dropping undefined values at any depth. */
export function encodeObject(value: Record<string, unknown>): string {
  const clean = stripUndefined(value) as Record<string, unknown>;
  if (Object.keys(clean).length === 0) return "";
  return encode(clean);
}

/** Render next-step suggestions as a TOON list. */
export function renderHelp(lines: string[]): string {
  return lines.length === 0
    ? ""
    : `help[${lines.length}]:\n${lines.map((line) => `  - ${line}`).join("\n")}`;
}

/** Render help sections as TOON list items. */
export function renderHelpBlock(label: string, lines: string[]): string {
  if (lines.length === 0) return "";
  const item = label === "help" ? "- " : "";
  return `${label}[${lines.length}]:\n${lines.map((line) => `  ${item}${line}`).join("\n")}`;
}

/** Encode multi-line text (logs, diffs, manifests) as a TOON array. */
export function renderTextBlock(label: string, lines: string[]): string {
  return lines.length === 0 ? "" : encodeObject({ [label]: lines });
}

/** Join non-empty TOON blocks into one output string. */
export function renderBlocks(
  blocks: Array<string | undefined | false | null>,
): string {
  return blocks.filter((block): block is string => Boolean(block)).join("\n");
}
