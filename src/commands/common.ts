import {
  CONTEXT_FLAG,
  getString,
  renderCommandHelp,
  type CommandSpec,
  type ParsedArgs,
} from "../args.js";
import { validateContextName } from "../context.js";
import { CODES, axiError } from "../errors.js";
import { redactionNotice, type Redactor } from "../redact.js";
import { PLANNED_WRITES, REFUSALS } from "../registry.js";
import {
  encodeObject,
  renderBlocks,
  renderHelp,
  renderHelpBlock,
} from "../toon.js";

export { CONTEXT_FLAG };

export interface Subcommand {
  spec: CommandSpec;
  run: (args: string[]) => Promise<string>;
}

/** The `--context` flag, validated, ready for `runArgocd` options. */
export function contextOption(parsed: ParsedArgs): { context?: string } {
  const context = getString(parsed, "--context");
  return context === undefined ? {} : { context: validateContextName(context) };
}

/** ` --context <name>` to carry into suggested commands (AXI principle 9). */
export function contextSuffix(parsed: ParsedArgs): string {
  const context = getString(parsed, "--context");
  return context === undefined ? "" : ` --context ${context}`;
}

/** The flags the user gave, minus `omit`, rendered for a suggested command with `--context` last. */
export function carriedFlags(parsed: ParsedArgs, omit: string[] = []): string {
  const parts: string[] = [];
  for (const [name, value] of parsed.flags) {
    if (name === "--context" || omit.includes(name)) continue;
    if (value === true) parts.push(name);
    else if (typeof value === "string") parts.push(name, shellWord(value));
    else if (Array.isArray(value)) parts.push(name, shellWord(value.join(",")));
  }
  return parts.map((part) => ` ${part}`).join("") + contextSuffix(parsed);
}

function shellWord(value: string): string {
  return /^[\w./:=,@%+-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}

export function refuse(key: string): never {
  const refusal = PLANNED_WRITES[key] ?? REFUSALS[key];
  if (!refusal) {
    throw axiError(`${key} is not supported`, CODES.REFUSED);
  }
  throw axiError(refusal.reason, CODES.REFUSED, refusal.help);
}

/**
 * Dispatch `<noun> [verb] ...`: a known subcommand, a planned or refused
 * verb, or the noun's default (list) command.
 */
export async function dispatch(
  noun: string,
  args: string[],
  subcommands: Record<string, Subcommand>,
  fallback: Subcommand,
): Promise<string> {
  const verb = args[0];
  if (verb !== undefined && !verb.startsWith("-")) {
    // Own properties only: `apps constructor` must not reach Object.prototype.
    const sub = Object.hasOwn(subcommands, verb)
      ? subcommands[verb]
      : undefined;
    if (sub) {
      if (args.includes("--help")) return renderCommandHelp(sub.spec);
      return sub.run(args.slice(1));
    }
    const key = `${noun} ${verb}`;
    if (PLANNED_WRITES[key] || REFUSALS[key]) refuse(key);
  }
  if (args.includes("--help"))
    return renderGroupHelp(fallback.spec, subcommands);
  return fallback.run(args);
}

function renderGroupHelp(
  spec: CommandSpec,
  subcommands: Record<string, Subcommand>,
): string {
  return renderBlocks([
    renderCommandHelp(spec),
    renderHelpBlock(
      "subcommands",
      Object.values(subcommands).map(
        (sub) => `${sub.spec.path}: ${sub.spec.summary}`,
      ),
    ),
    Object.keys(subcommands).length > 0
      ? renderHelp([
          `Run \`argocd-axi ${spec.path} <subcommand> --help\` for subcommand flags`,
        ])
      : undefined,
  ]);
}

/** Final rendering: data blocks, the redaction notice, then next steps. */
export function finish(
  blocks: Array<string | undefined | false>,
  redactor: Redactor | undefined,
  help: string[] = [],
): string {
  const notice = redactor ? redactionNotice(redactor.count) : undefined;
  return renderBlocks([
    ...blocks,
    notice ? encodeObject({ redacted: notice }) : undefined,
    renderHelp(help),
  ]);
}

/** Truncate long text per AXI principle 3, reporting the total size. */
export function preview(
  text: string,
  max: number,
  full: boolean,
): { text: string; truncated: boolean } {
  if (full || text.length <= max) return { text, truncated: false };
  return {
    text: `${text.slice(0, max)}... (truncated, ${text.length} chars total)`,
    truncated: true,
  };
}
