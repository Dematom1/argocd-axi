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

/**
 * Render next-step suggestions as an indented block. `encode()` inlines
 * primitive arrays on one comma-joined line, which is hard to read for
 * sentences, so help is formatted by hand like other AXI tools do.
 */
export function renderHelp(lines: string[]): string {
  return renderTextBlock("help", lines);
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
